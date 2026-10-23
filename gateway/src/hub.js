// ControlHub: decides who the pilot is, what reaches crsf-core, and what every browser sees.
//  - Signed-in pages (and relay clients) asking for the pilot role join a queue in join order;
//    everyone else is an observer. One active pilot; only its commands reach the core.
//  - Every queued page gets a fresh random session id; only the active pilot's is sent with
//    SESSION. The queue head is the standby, and the core is told (STANDBY).
//  - The hub never moves the seat on its own while the core may still act: when the pilot is
//    lost the core holds, and the queue head may `take` (or `land`). The core switches to it
//    and reports `taken`, and the hub follows. A free seat goes to the queue head only once
//    the core shows no session.
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
const GAP_LOG_MS = 250;   // a longer silence between the pilot's commands is worth a log line

export class ControlHub {
  constructor({ core, maxCommandAgeMs = 200, now = defaultNow, newSession = randomSession, log = () => {} }) {
    this.core = core;
    this.maxCommandAgeMs = maxCommandAgeMs;
    this.now = now;
    this.newSession = newSession;
    this.log = log;              // called with plain objects (the connection log)
    this.clients = new Map();
    this.pilot = null;           // the active pilot's client
    this.queue = [];             // queued clients waiting for the seat, in join order
    this.awaitingCore = false;   // the active pilot left: the seat waits for the core's verdict
    this.sentStandby = 0;        // the standby session the core last heard from us
    this.telemetry = {};
    this.lastStatus = null;
    this.staleDropped = 0;
    this.lastPilot = { name: null, via: 'local' };   // who last held the seat (for hold events)
  }

  /** client: { send(obj), close() }; auth: { user: {name, admin} | null, relay, via } (stored for the queue) */
  attach(client, auth = { user: null, relay: false }) {
    this.clients.set(client, {
      auth, role: null, session: 0, lastSeq: 0, position: 0, standby: false, clock: new ClockSync(),
      windowStart: this.now(), windowCount: 0, joinedAt: this.now(), lastCmdAt: null,
    });
  }

  detach(client) {
    const c = this.clients.get(client);
    if (!c) return;
    this.#log('leave', c, { role: c.role, connectedS: round1((this.now() - c.joinedAt) / 1000) });
    this.clients.delete(client);
    if (this.pilot === client) {
      this.pilot = null;
      this.core.pilotLost(c.session);
      this.awaitingCore = true;   // a taken event, or a status with no session, decides
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
    if (msg.t === 'take' || msg.t === 'land') {
      // The core checks the session is its standby and the state allows it; this only keeps
      // other pages from asking.
      if (client === this.queue[0]) this.core[msg.t](c.session);
      else client.send({ t: 'error', msg: 'only the next pilot can take control or land' });
      return;
    }
    if (client !== this.pilot) {
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
    if (this.awaitingCore && status.session === 0) {   // nobody was taken: the seat is free
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
    if (ev.what !== 'taken') this.#logEvent(ev);   // 'taken' is logged once the seat has moved
    switch (ev.what) {
      case 'hold': case 'resumed': case 'landing':
        this.#broadcast({ t: 'event', what: ev.what, reason: ev.reason, session: ev.session });
        break;
      case 'taken':
        this.#broadcast({ t: 'event', what: 'taken', reason: ev.reason, session: ev.session });
        this.#follow(ev.session);
        this.#logEvent(ev);
        break;
      case 'take': case 'land':   // refused: only the one who asked cares
        this.queue[0]?.send({ t: 'event', what: ev.what, refused: ev.refused });
        break;
      default:
        this.#broadcast({ t: 'event', what: ev.what, refused: ev.refused });
    }
  }

  /** The core made `session` the active one (and cleared its standby). Follow it: never
   *  send SESSION here, the core already switched (a SESSION while armed would fail safe). */
  #follow(session) {
    const old = this.pilot;
    if (old && this.clients.get(old).session === session) return;
    this.sentStandby = 0;
    const next = this.queue.find((q) => this.clients.get(q).session === session) ?? null;
    if (next) this.queue.splice(this.queue.indexOf(next), 1);
    if (old) {                     // its page is still open; it goes to the back
      const oc = this.clients.get(old);
      this.queue.push(old);
      // Alone in the queue it is the head, hence the new standby: say so in the same message.
      Object.assign(oc, { role: 'queued', standby: this.queue[0] === old, position: this.queue.length });
      old.send({ t: 'welcome', role: 'queued', position: oc.position, lost: true, ...(oc.standby ? { standby: true } : {}) });
    }
    this.pilot = null;
    if (next) {
      this.awaitingCore = false;
      const nc = this.clients.get(next);
      Object.assign(nc, { role: 'pilot', lastSeq: 0, lastCmdAt: null });
      this.pilot = next;
      this.lastPilot = { name: this.#name(nc), via: nc.auth.via ?? 'local' };
      this.#log('seat', nc, { how: 'taken' });
      const o = this.lastStatus?.out;   // the sticks on the air: the taker's page starts from them
      const takeover = o ? { r: o.roll, p: o.pitch, y: o.yaw, th: o.throttle, m: o.mode, sp: o.speed, tu: o.turtle } : null;
      next.send({ t: 'welcome', role: 'pilot', session, ...(takeover ? { takeover } : {}) });
      next.send({ t: 'tsync', s0: this.now() });
    } else {
      // Nobody here owns that session (its page just left): free the core's seat, so the
      // core ends the pending hold and shows no session.
      this.core.pilotLost(session);
      this.awaitingCore = true;
    }
    this.#changed();
  }

  #hello(client, c, msg) {
    const mayFly = c.auth.user !== null || c.auth.relay;
    this.#log('join', c, { role: msg.role === 'pilot' ? 'pilot' : 'observer' });
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
    Object.assign(c, { role: 'pilot', lastSeq: 0, lastCmdAt: null });
    this.pilot = client;
    this.lastPilot = { name: this.#name(c), via: c.auth.via ?? 'local' };
    this.#log('seat', c, { how: 'free' });
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
      const isStandby = client === standby;
      if (c.position === i + 1 && c.standby === isStandby) return;
      c.position = i + 1;
      c.standby = isStandby;
      client.send({ t: 'welcome', role: 'queued', position: c.position, ...(isStandby ? { standby: true } : {}) });
    });
    this.#broadcast(this.#statusMsg());
  }

  #standby() {
    return this.queue[0] ?? null;
  }

  #syncStandby() {
    const s = this.#standby();
    const session = s ? this.clients.get(s).session : 0;
    if (session === this.sentStandby) return;
    this.sentStandby = session;
    this.core.standby(session);
  }

  #log(ev, c, extra = {}) {
    this.log({ ev, name: this.#name(c), via: c.auth.via ?? 'local', ...extra });
  }

  /** A core event (hold, resumed, taken, landing) with the pilot it concerns. */
  #logEvent(ev) {
    if (!['hold', 'resumed', 'taken', 'landing'].includes(ev.what)) return;
    this.log({ ev: ev.what, name: this.lastPilot.name, via: this.lastPilot.via, reason: ev.reason });
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
    // The gap counts the arrival of any valid-format command, stale or not: a stale one
    // still proves the link delivered something, and a gap of silence is what we look for.
    // Logging comes after the forwarding decision: it never sits in front of core.control.
    const now = this.now();
    const gapMs = c.lastCmdAt === null ? 0 : now - c.lastCmdAt;
    c.lastCmdAt = now;
    const ageMs = c.clock.ready ? c.clock.age(m.ts, now) : 0;
    const stale = ageMs > this.maxCommandAgeMs;
    if (stale) this.staleDropped++;
    else {
      this.core.control(c.session, m.seq,
        { roll: m.r, pitch: m.p, yaw: m.y, throttle: m.th, mode: m.m, speed: m.sp ?? 0, turtle: m.tu ?? 0 });
    }
    if (gapMs > GAP_LOG_MS) this.#log('gap', c, { ms: round1(gapMs) });
    if (stale) this.#log('stale', c, { ageMs: round1(ageMs) });
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
