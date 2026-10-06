// ControlHub: decides who the pilot is, what reaches crsf-core, and what every browser sees.
//  - Exactly one pilot; everyone else is an observer. No take-over while a pilot is connected.
//  - Every new pilot gets a fresh random session id; the core treats a session change
//    while armed as a failsafe, and a closed pilot connection as "pilot lost".
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
    this.pilot = null;
    this.telemetry = {};
    this.lastStatus = null;
    this.staleDropped = 0;
  }

  /** client: { send(obj), close() } */
  attach(client) {
    this.clients.set(client, {
      role: null, session: 0, lastSeq: 0, clock: new ClockSync(),
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
      this.#broadcast(this.#statusMsg());
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
      if (typeof msg.id === 'number') client.send({ t: 'pong', id: msg.id, ts: msg.ts, srv: this.now() });
      return;
    }
    if (msg.t === 'tsync_r') {
      if (typeof msg.s0 === 'number' && typeof msg.c1 === 'number') c.clock.add(msg.s0, msg.c1, this.now());
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
    if (!this.pilot) return;
    const c = this.clients.get(this.pilot);
    c.session = this.newSession();
    c.lastSeq = 0;
    this.core.sessionStart(c.session);
    this.pilot.send({ t: 'welcome', role: 'pilot', session: c.session });
  }

  onCoreTelemetry(kind, value) {
    this.telemetry[kind] = value;
    this.#broadcast({ t: 'telem', [kind]: value });
  }

  onCoreEvent(ev) {
    this.#broadcast({ t: 'event', what: ev.what, refused: ev.refused });
  }

  #hello(client, c, msg) {
    if (msg.role === 'pilot' && this.pilot === null) {
      c.role = 'pilot';
      c.session = this.newSession();
      this.pilot = client;
      this.core.sessionStart(c.session);
      client.send({ t: 'welcome', role: 'pilot', session: c.session });
      client.send({ t: 'tsync', s0: this.now() });
    } else {
      c.role = 'observer';
      client.send({ t: 'welcome', role: 'observer', reason: msg.role === 'pilot' ? 'pilot_present' : null });
    }
    for (const [kind, value] of Object.entries(this.telemetry)) client.send({ t: 'telem', [kind]: value });
    client.send(this.#statusMsg());
  }

  #control(c, m) {
    const valid = isInt(m.seq, c.lastSeq + 1, 0xffffffff) && typeof m.ts === 'number' &&
      isInt(m.r, -1000, 1000) && isInt(m.p, -1000, 1000) && isInt(m.y, -1000, 1000) &&
      isInt(m.th, 0, 1000) && isInt(m.m, 0, 2);
    if (!valid) return; // garbage never refreshes the core's failsafe timer
    c.lastSeq = m.seq;
    if (c.clock.ready && c.clock.age(m.ts, this.now()) > this.maxCommandAgeMs) {
      this.staleDropped++;
      return;
    }
    this.core.control(c.session, m.seq, { roll: m.r, pitch: m.p, yaw: m.y, throttle: m.th, mode: m.m });
  }

  #statusMsg() {
    const pc = this.pilot ? this.clients.get(this.pilot) : null;
    const base = { t: 'status', core: this.lastStatus !== null, pilot: this.pilot !== null };
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
