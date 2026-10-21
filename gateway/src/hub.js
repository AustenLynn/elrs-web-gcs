// ControlHub: decides who the pilot is, what reaches crsf-core, and what every browser sees.
//  - Signed-in pages (and relay clients) asking for the pilot role join a queue in join order;
//    everyone else is an observer. One active pilot; only its commands reach the core.
//  - Every queued page gets a fresh random session id; only the active pilot's is sent with
//    SESSION. The first ready queued page is the standby, and the core is told (STANDBY).
//  - The hub never hands the seat over on its own while the core may still act: the core
//    switches to the standby (cmd_timeout or pilot lost) and reports `handover`, and the hub
//    follows it. A free seat goes to the queue head only once the core shows no session.
//  - The core treats a session change while armed as a failsafe, and a closed pilot
//    connection as "pilot lost".
//  - Control messages are validated, de-duplicated and dropped when older than
//    maxCommandAgeMs (age estimated with ClockSync).
import { randomInt } from 'node:crypto';
import { ClockSync } from './clock.js';

const MAX_MSGS_PER_SEC = 120; // the pilot page sends 50 control messages per second

const defaultNow = () => performance.now();
const randomSession = () => randomInt(1, 0xffffffff);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const round1 = (v) => Math.round(v * 10) / 10;

export class ControlHub {
  constructor({ core, maxCommandAgeMs = 200, now = defaultNow, newSession = randomSession }) {
    this.core = core;
    this.maxCommandAgeMs = maxCommandAgeMs;
    this.now = now;
    this.newSession = newSession;
    this.clients = new Map();
    this.pilot = null;           // the active pilot's client
    this.queue = [];             // queued clients waiting for the seat, in join order
    this.awaitingCore = false;   // the active pilot left: the seat waits for the core's verdict
    this.sentStandby = 0;        // the standby session the core last heard from us
    this.lastControl = null;     // last forwarded command, for a promoted standby's takeover
    this.telemetry = {};
    this.lastStatus = null;
    this.staleDropped = 0;
  }

  /** client: { send(obj), close() }; auth: { user: {name, admin} | null, relay } (stored for the queue) */
  attach(client, auth = { user: null, relay: false }) {
    this.clients.set(client, {
      auth, role: null, session: 0, lastSeq: 0, ready: false, position: 0, standby: false, clock: new ClockSync(),
      windowStart: this.now(), windowCount: 0,
    });
  }

  detach(client) {
    const c = this.clients.get(client);
    if (!c) return;
    this.clients.delete(client);
    if (this.pilot === client) {
      this.pilot = null;
      this.core.pilotLost(c.session);
      this.awaitingCore = true;   // a handover event, or a status with no session, decides
    } else if (c.role === 'queued') {
      this.queue.splice(this.queue.indexOf(client), 1);
    } else {
      return;
    }
    this.#changed();
  }

  /** Name of the active pilot, or null. */
  activePilotName() {
    return this.pilot ? this.#name(this.clients.get(this.pilot)) : null;
  }

  /** Closes every socket signed in as `name`, except the active pilot's. */
  dropUser(name) {
    for (const [client, c] of [...this.clients]) {
      if (client === this.pilot || c.auth.user?.name !== name) continue;
      this.detach(client);
      client.close();
    }
  }

  handle(client, msg) {
    const c = this.clients.get(client);
    if (!c || typeof msg !== 'object' || msg === null || !this.#allow(c)) return;
    if (c.role === null) {
      if (msg.t === 'hello') this.#hello(client, c, msg);
      else client.send({ t: 'error', msg: 'send hello first' });
      return;
    }
    if (msg.t === 'ping') {
      if (typeof msg.id === 'number') client.send({ t: 'pong', id: msg.id, ts: typeof msg.ts === 'number' ? msg.ts : null, srv: this.now() });
      return;
    }
    if (msg.t === 'tsync_r') {
      if (typeof msg.s0 === 'number' && typeof msg.c1 === 'number') c.clock.add(msg.s0, msg.c1, this.now());
      return;
    }
    if (msg.t === 'ready' && c.role === 'queued') {
      c.ready = msg.on === true;
      this.#changed();
      return;
    }
    if (client !== this.pilot || msg.t === 'ready') {   // only queued pages can be ready
      client.send({ t: 'error', msg: 'observers cannot send commands' });
      return;
    }
    switch (msg.t) {
      case 'ctl': this.#control(c, msg); break;
      case 'arm': this.core.arm(c.session); break;
      case 'disarm': this.core.disarm(c.session); break;
      case 'ack': this.core.ack(c.session); break;
      case 'failsafe': this.core.failsafe(c.session); break;
      default: {
        const t = typeof msg.t === 'string' ? msg.t.slice(0, 20) : typeof msg.t;   // never String(object)
        client.send({ t: 'error', msg: `unknown message type "${t}"` });
      }
    }
  }

  /** Called every 2 s: refresh the pilot's clock estimate. */
  tick() {
    if (this.pilot) this.pilot.send({ t: 'tsync', s0: this.now() });
  }

  onCoreStatus(status) {
    this.lastStatus = status;
    if (this.awaitingCore && status.session === 0) {   // no handover: the seat is free
      this.awaitingCore = false;
      this.#seatHead();
      this.#changed();
      return;
    }
    this.#broadcast(this.#statusMsg());
  }

  onCoreDown() {
    this.lastStatus = null;
    this.#broadcast(this.#statusMsg());
  }

  /** The core (re)connected. It forgot our session when it lost us (and a pilot who joined
   *  while it was down never registered), so the pilot gets a fresh session. Any latched
   *  failsafe stays: the pilot still has to clear it and re-arm explicitly. */
  onCoreUp() {
    this.sentStandby = 0;          // the core forgot the standby too
    if (this.awaitingCore) {       // a fresh core has no session: the seat is free
      this.awaitingCore = false;
      this.#seatHead();
    } else if (this.pilot) {
      const c = this.clients.get(this.pilot);
      c.session = this.newSession();
      c.lastSeq = 0;
      this.core.sessionStart(c.session);
      this.pilot.send({ t: 'welcome', role: 'pilot', session: c.session });
    }
    this.#syncStandby();           // only after the SESSION, which clears the core's standby
  }

  onCoreTelemetry(kind, value) {
    this.telemetry[kind] = value;
    this.#broadcast({ t: 'telem', [kind]: value });
  }

  onCoreEvent(ev) {
    if (ev.what !== 'handover') {
      this.#broadcast({ t: 'event', what: ev.what, refused: ev.refused });
      return;
    }
    this.#broadcast({ t: 'event', what: 'handover', reason: ev.reason });
    this.#handover(ev.session);
  }

  /** The core made `session` the active one (and cleared its standby). Follow it: never
   *  send SESSION here, the core already switched (a SESSION while armed would fail safe). */
  #handover(session) {
    const old = this.pilot;
    if (old && this.clients.get(old).session === session) return;
    this.sentStandby = 0;
    const next = this.queue.find((q) => this.clients.get(q).session === session) ?? null;
    if (next) this.queue.splice(this.queue.indexOf(next), 1);
    if (old) {                     // cmd_timeout: its page is still open; it goes to the back
      const oc = this.clients.get(old);
      this.queue.push(old);
      Object.assign(oc, { role: 'queued', ready: false, standby: false, position: this.queue.length });
      old.send({ t: 'welcome', role: 'queued', position: oc.position, lost: true });
    }
    this.pilot = null;
    if (next) {
      this.awaitingCore = false;
      const nc = this.clients.get(next);
      Object.assign(nc, { role: 'pilot', ready: false, lastSeq: 0 });
      this.pilot = next;
      next.send({ t: 'welcome', role: 'pilot', session, ...(this.lastControl ? { takeover: this.lastControl } : {}) });
      next.send({ t: 'tsync', s0: this.now() });
    } else {
      // Nobody here owns that session (its page just left): free the core's seat, so the
      // core ends the pending handover and shows no session.
      this.core.pilotLost(session);
      this.awaitingCore = true;
    }
    this.#changed();
  }

  #hello(client, c, msg) {
    const mayFly = c.auth.user !== null || c.auth.relay;
    if (msg.role === 'pilot' && mayFly) {
      c.role = 'queued';
      c.session = this.newSession();
      this.queue.push(client);
      this.#seatHead();
    } else {
      c.role = 'observer';
      client.send({ t: 'welcome', role: 'observer', reason: msg.role === 'pilot' ? 'login_required' : null });
    }
    for (const [kind, value] of Object.entries(this.telemetry)) client.send({ t: 'telem', [kind]: value });
    this.#changed();
  }

  /** A free seat (and the core at no session) goes to the queue head with SESSION. */
  #seatHead() {
    if (this.pilot !== null || this.awaitingCore || this.queue.length === 0) return;
    const client = this.queue.shift();
    const c = this.clients.get(client);
    Object.assign(c, { role: 'pilot', ready: false, lastSeq: 0 });
    this.pilot = client;
    this.core.sessionStart(c.session);
    this.sentStandby = 0;          // SESSION clears the core's standby
    client.send({ t: 'welcome', role: 'pilot', session: c.session });
    client.send({ t: 'tsync', s0: this.now() });
  }

  /** After any change to the seat or the queue: tell the core, the queued pages and everyone. */
  #changed() {
    this.#syncStandby();
    const standby = this.#standby();
    this.queue.forEach((client, i) => {
      const c = this.clients.get(client);
      const isStandby = client === standby;   // the first *ready* page, not necessarily position 1
      if (c.position === i + 1 && c.standby === isStandby) return;
      c.position = i + 1;
      c.standby = isStandby;
      client.send({ t: 'welcome', role: 'queued', position: c.position, ...(isStandby ? { standby: true } : {}) });
    });
    this.#broadcast(this.#statusMsg());
  }

  #standby() {
    return this.queue.find((q) => this.clients.get(q).ready) ?? null;
  }

  #syncStandby() {
    const s = this.#standby();
    const session = s ? this.clients.get(s).session : 0;
    if (session === this.sentStandby) return;
    this.sentStandby = session;
    this.core.standby(session);
  }

  #name(c) {
    return c.auth.user?.name ?? (c.auth.relay ? 'remoto' : null);
  }

  #control(c, m) {
    const optional = (v, hi) => v === undefined || isInt(v, 0, hi);   // older pages omit sp/tu
    const valid = isInt(m.seq, c.lastSeq + 1, 0xffffffff) && typeof m.ts === 'number' &&
      isInt(m.r, -1000, 1000) && isInt(m.p, -1000, 1000) && isInt(m.y, -1000, 1000) &&
      isInt(m.th, 0, 1000) && isInt(m.m, 0, 2) && optional(m.sp, 2) && optional(m.tu, 1);
    if (!valid) return; // garbage never refreshes the core's failsafe timer
    c.lastSeq = m.seq;
    if (c.clock.ready && c.clock.age(m.ts, this.now()) > this.maxCommandAgeMs) {
      this.staleDropped++;
      return;
    }
    this.lastControl = { r: m.r, p: m.p, y: m.y, th: m.th, m: m.m, sp: m.sp ?? 0, tu: m.tu ?? 0 };
    this.core.control(c.session, m.seq,
      { roll: m.r, pitch: m.p, yaw: m.y, throttle: m.th, mode: m.m, speed: m.sp ?? 0, turtle: m.tu ?? 0 });
  }

  #statusMsg() {
    const pc = this.pilot ? this.clients.get(this.pilot) : null;
    const standby = this.#standby();
    const base = { t: 'status', core: this.lastStatus !== null, pilot: this.pilot !== null,
      pilotName: pc ? this.#name(pc) : null, standbyName: standby ? this.#name(this.clients.get(standby)) : null };
    return {
      ...base,
      ...(this.lastStatus ?? {}),
      rttMs: pc?.clock.ready ? round1(pc.clock.rtt) : null,
      staleDropped: this.staleDropped,
    };
  }

  #broadcast(msg) {
    for (const [client, c] of this.clients) if (c.role !== null) client.send(msg);
  }

  #allow(c) {
    const now = this.now();
    if (now - c.windowStart >= 1000) {
      c.windowStart = now;
      c.windowCount = 0;
    }
    return ++c.windowCount <= MAX_MSGS_PER_SEC;
  }
}
