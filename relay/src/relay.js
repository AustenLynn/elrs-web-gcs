// Relay: one Pi gateway ("bridge") per room dials out to this server; remote browsers
// connect here too. The relay never interprets control messages; it multiplexes the
// browsers over the bridge's single connection:
//   to the bridge:   {t:'relay', ev:'open', id}  {t:'relay', ev:'msg', id, msg}  {t:'relay', ev:'close', id}
//   from the bridge: {t:'relay', ev:'send', id, msg}  {t:'relay', ev:'kick', id}
// Nothing is buffered: a message for a peer that is not connected is dropped (FMEA #14).
import { randomUUID, timingSafeEqual } from 'node:crypto';

export const CLOSE = Object.freeze({ BAD_HELLO: 4000, BRIDGE_LOST: 4001, REPLACED: 4002, DENIED: 4003, FULL: 4004 });
const HELLO_TIMEOUT_MS = 5000;
const MAX_CLIENTS = 4;
const MAX_MSGS_PER_SEC = 120;

function tokenOk(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Relay {
  constructor({ rooms, now = () => performance.now(), helloTimeoutMs = HELLO_TIMEOUT_MS }) {
    this.rooms = rooms;              // { name: { bridgeToken, pilotToken } }
    this.now = now;
    this.helloTimeoutMs = helloTimeoutMs;
    this.live = new Map();           // name -> { bridge, clients: Map(id -> conn) }
  }

  /** conn: { send(obj), close(code, reason) }. Returns the per-connection message handler and close handler. */
  connect(conn) {
    const state = { conn, role: null, room: null, id: null, windowStart: this.now(), count: 0 };
    const timer = setTimeout(() => { if (!state.role) conn.close(CLOSE.BAD_HELLO, 'hello timeout'); }, this.helloTimeoutMs);
    return {
      message: (msg) => this.#message(state, msg),
      close: () => {
        clearTimeout(timer);
        this.#closed(state);
      },
    };
  }

  #room(name) {
    if (!this.live.has(name)) this.live.set(name, { bridge: null, clients: new Map() });
    return this.live.get(name);
  }

  #message(state, msg) {
    const now = this.now();
    if (now - state.windowStart >= 1000) {
      state.windowStart = now;
      state.count = 0;
    }
    if (++state.count > MAX_MSGS_PER_SEC || typeof msg !== 'object' || msg === null) return;
    if (state.role === null) return this.#hello(state, msg);
    const room = this.live.get(state.room);
    if (state.role === 'bridge') {
      if (msg.t !== 'relay' || typeof msg.id !== 'string') return;
      const client = room.clients.get(msg.id);
      if (!client) return;
      if (msg.ev === 'send') client.send(msg.msg);
      else if (msg.ev === 'kick') client.close(1000, 'closed by the Pi');
      return;
    }
    room.bridge?.conn.send({ t: 'relay', ev: 'msg', id: state.id, msg });
  }

  #hello(state, msg) {
    const cfg = this.rooms[msg.room];
    const { conn } = state;
    if (msg.t !== 'hello' || !cfg || !['bridge', 'pilot', 'observer'].includes(msg.role)) {
      conn.close(CLOSE.BAD_HELLO, 'bad hello');
      return;
    }
    const expected = msg.role === 'bridge' ? cfg.bridgeToken : cfg.pilotToken;
    if (!tokenOk(msg.token, expected)) {
      conn.close(CLOSE.DENIED, 'denied');
      return;
    }
    const room = this.#room(msg.room);
    if (msg.role === 'bridge') {
      const old = room.bridge;
      state.role = 'bridge';
      state.room = msg.room;
      room.bridge = state;
      if (old) old.conn.close(CLOSE.REPLACED, 'replaced by a newer bridge connection');
      for (const [id, client] of room.clients) {
        conn.send({ t: 'relay', ev: 'open', id });
        conn.send({ t: 'relay', ev: 'msg', id, msg: { t: 'hello', role: client.wantRole } });
      }
      return;
    }
    if (!room.bridge) {
      conn.close(CLOSE.BRIDGE_LOST, 'the Pi is not connected');
      return;
    }
    if (room.clients.size >= MAX_CLIENTS) {
      conn.close(CLOSE.FULL, 'room full');
      return;
    }
    state.role = msg.role;
    state.room = msg.room;
    state.id = randomUUID();
    conn.wantRole = msg.role;
    room.clients.set(state.id, conn);
    room.bridge.conn.send({ t: 'relay', ev: 'open', id: state.id });
    room.bridge.conn.send({ t: 'relay', ev: 'msg', id: state.id, msg: { t: 'hello', role: msg.role } });
  }

  #closed(state) {
    if (!state.role) return;
    const room = this.live.get(state.room);
    if (!room) return;
    if (state.role === 'bridge') {
      if (room.bridge !== state) return;          // an older, replaced bridge
      room.bridge = null;
      for (const client of room.clients.values()) client.close(CLOSE.BRIDGE_LOST, 'the Pi disconnected');
      room.clients.clear();
      return;
    }
    if (room.clients.delete(state.id)) room.bridge?.conn.send({ t: 'relay', ev: 'close', id: state.id });
  }
}
