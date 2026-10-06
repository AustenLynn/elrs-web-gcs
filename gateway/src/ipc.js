// Twin of core/src/ipc_proto.h: messages between the gateway and crsf-core over a Unix
// stream socket. Each message: u16 little-endian length (type + payload), u8 type, payload.
import { EventEmitter } from 'node:events';
import net from 'node:net';

export const MSG = Object.freeze({
  SESSION: 0x01, CONTROL: 0x02, ARM: 0x03, DISARM: 0x04, ACK: 0x05, PILOT_LOST: 0x06, FAILSAFE: 0x07,
  STATUS: 0x81, LINK: 0x82, BATTERY: 0x83, FLIGHT_MODE: 0x84, DEVICE: 0x85, EVENT: 0x86,
});
export const STATES = ['DISARMED', 'ARMED', 'FAILSAFE'];
export const REASONS = ['none', 'cmd_timeout', 'pilot_lost', 'gateway_lost', 'session_changed', 'manual'];
export const FC_ARM = ['unknown', 'disarmed', 'armed'];
export const REFUSALS = ['none', 'wrong_session', 'not_disarmed', 'not_in_failsafe', 'link_stale',
  'throttle_high', 'fc_still_armed'];

const MAX_MSG = 255;
const NO_CMD_AGE = 0xffffffff;

function frame(type, payload = Buffer.alloc(0)) {
  const out = Buffer.alloc(3 + payload.length);
  out.writeUInt16LE(payload.length + 1, 0);
  out[2] = type;
  payload.copy(out, 3);
  return out;
}

function expectLength(p, n, what) {
  if (p.length !== n) throw new RangeError(`${what} payload must be ${n} bytes, got ${p.length}`);
}

export function encodeSessionMsg(type, session) {
  const p = Buffer.alloc(4);
  p.writeUInt32LE(session >>> 0, 0);
  return frame(type, p);
}

export function encodeControl({ session, seq, roll, pitch, yaw, throttle, mode }) {
  const p = Buffer.alloc(17);
  p.writeUInt32LE(session >>> 0, 0);
  p.writeUInt32LE(seq >>> 0, 4);
  p.writeInt16LE(roll, 8);
  p.writeInt16LE(pitch, 10);
  p.writeInt16LE(yaw, 12);
  p.writeUInt16LE(throttle, 14);
  p.writeUInt8(mode, 16);
  return frame(MSG.CONTROL, p);
}

export function decodeStatus(p) {
  expectLength(p, 80, 'STATUS');
  const cmdAge = p.readUInt32LE(12);
  const channels = [];
  for (let i = 0; i < 16; i++) channels.push(p.readUInt16LE(48 + 2 * i));
  return {
    state: STATES[p[0]] ?? 'UNKNOWN',
    reason: REASONS[p[1]] ?? 'unknown',
    fcArm: FC_ARM[p[2]] ?? 'unknown',
    serialOk: p[3] === 1,
    session: p.readUInt32LE(4),
    lastSeq: p.readUInt32LE(8),
    cmdAgeMs: cmdAge === NO_CMD_AGE ? null : cmdAge,
    framesSent: p.readUInt32LE(16),
    txErrors: p.readUInt32LE(20),
    rxFrames: p.readUInt32LE(24),
    rxCrcErrors: p.readUInt32LE(28),
    periodUs: p.readUInt32LE(32),
    offsetUs: p.readInt32LE(36) / 10,
    timingFrames: p.readUInt32LE(40),
    wakeLateMaxUs: p.readUInt32LE(44),
    channels,
  };
}

export function decodeLink(p) {
  expectLength(p, 11, 'LINK');
  return {
    upRssi1: p.readInt8(0), upRssi2: p.readInt8(1), upLq: p[2], upSnr: p.readInt8(3),
    antenna: p[4], rfMode: p[5], txPowerMw: p.readUInt16LE(6),
    dnRssi: p.readInt8(8), dnLq: p[9], dnSnr: p.readInt8(10),
  };
}

export function decodeBattery(p) {
  expectLength(p, 9, 'BATTERY');
  return {
    voltage: p.readUInt16LE(0) / 10,
    current: p.readUInt16LE(2) / 10,
    capacityMah: p.readUInt32LE(4),
    remainingPct: p[8],
  };
}

export function decodeFlightMode(p) {
  if (p.length < 1 || 1 + p[0] > p.length) throw new RangeError('bad FLIGHT_MODE payload');
  return p.subarray(1, 1 + p[0]).toString('latin1');
}

export function decodeDevice(p) {
  if (p.length < 9 || 9 + p[8] > p.length) throw new RangeError('bad DEVICE payload');
  return {
    origin: p[0],
    version: `${p[1]}.${p[2]}.${p[3]}`,
    serial: p.readUInt32LE(4),
    name: p.subarray(9, 9 + p[8]).toString('latin1'),
  };
}

export function decodeEvent(p) {
  expectLength(p, 6, 'EVENT');
  return { what: p[0] === 1 ? 'arm' : 'ack', refused: REFUSALS[p[1]] ?? 'unknown', session: p.readUInt32LE(2) };
}

/** Splits the byte stream from the core into messages. */
export class FrameReader {
  #buf = Buffer.alloc(0);

  /** Returns the complete messages so far; throws if the stream is corrupt. */
  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out = [];
    while (this.#buf.length >= 2) {
      const len = this.#buf.readUInt16LE(0);
      if (len < 1 || len > MAX_MSG) throw new Error(`corrupt core stream (length ${len})`);
      if (this.#buf.length < 2 + len) break;
      out.push({ type: this.#buf[2], payload: this.#buf.subarray(3, 2 + len) });
      this.#buf = this.#buf.subarray(2 + len);
    }
    return out;
  }
}

/**
 * Connection to crsf-core. Reconnects forever.
 * Events: 'up', 'down', 'status' (obj), 'telemetry' (kind, obj), 'event' (obj).
 */
export class CoreClient extends EventEmitter {
  #sock = null;
  #timer = null;
  #stopped = false;

  constructor(path, { reconnectMs = 500 } = {}) {
    super();
    this.path = path;
    this.reconnectMs = reconnectMs;
    this.connected = false;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#sock?.destroy();
  }

  #connect() {
    const sock = net.createConnection(this.path);
    const reader = new FrameReader();
    this.#sock = sock;
    sock.on('connect', () => {
      this.connected = true;
      this.emit('up');
    });
    sock.on('data', (chunk) => {
      let msgs;
      try {
        msgs = reader.push(chunk);
      } catch (err) {
        sock.destroy(err);
        return;
      }
      for (const m of msgs) this.#dispatch(m);
    });
    sock.on('error', () => {}); // 'close' always follows
    sock.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.#sock = null;
      if (wasConnected) this.emit('down');
      if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), this.reconnectMs);
    });
  }

  #dispatch({ type, payload }) {
    try {
      switch (type) {
        case MSG.STATUS: this.emit('status', decodeStatus(payload)); break;
        case MSG.LINK: this.emit('telemetry', 'link', decodeLink(payload)); break;
        case MSG.BATTERY: this.emit('telemetry', 'battery', decodeBattery(payload)); break;
        case MSG.FLIGHT_MODE: this.emit('telemetry', 'flightMode', decodeFlightMode(payload)); break;
        case MSG.DEVICE: this.emit('telemetry', 'device', decodeDevice(payload)); break;
        case MSG.EVENT: this.emit('event', decodeEvent(payload)); break;
        default: break; // unknown message from a newer core: ignore
      }
    } catch {
      // malformed message: ignore it, the stream itself is still in sync
    }
  }

  #send(buf) {
    if (this.connected) this.#sock.write(buf);
  }

  sessionStart(session) { this.#send(encodeSessionMsg(MSG.SESSION, session)); }
  control(session, seq, sticks) { this.#send(encodeControl({ session, seq, ...sticks })); }
  arm(session) { this.#send(encodeSessionMsg(MSG.ARM, session)); }
  disarm(session) { this.#send(encodeSessionMsg(MSG.DISARM, session)); }
  ack(session) { this.#send(encodeSessionMsg(MSG.ACK, session)); }
  pilotLost(session) { this.#send(encodeSessionMsg(MSG.PILOT_LOST, session)); }
  failsafe(session) { this.#send(encodeSessionMsg(MSG.FAILSAFE, session)); }
}
