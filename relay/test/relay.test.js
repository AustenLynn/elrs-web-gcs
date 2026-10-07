import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE, Relay } from '../src/relay.js';

const BRIDGE = 'b'.repeat(64);
const PILOT = 'p'.repeat(64);
const ROOMS = { pi1: { bridgeToken: BRIDGE, pilotToken: PILOT } };

function fakeConn() {
  const c = { sent: [], closed: null };
  c.send = (m) => c.sent.push(m);
  c.close = (code, reason) => { c.closed = { code, reason }; };
  return c;
}

function join(relay, hello) {
  const conn = fakeConn();
  const h = relay.connect(conn);
  h.message(hello);
  return { conn, ...h };
}

const bridgeHello = { t: 'hello', role: 'bridge', room: 'pi1', token: BRIDGE };
const pilotHello = { t: 'hello', role: 'pilot', room: 'pi1', token: PILOT };

test('pilot and bridge are paired and messages flow both ways', (t) => {
  const relay = new Relay({ rooms: ROOMS });
  const bridge = join(relay, bridgeHello);
  const pilot = join(relay, pilotHello);
  t.after(() => { bridge.close(); pilot.close(); });
  const [open, hello] = bridge.conn.sent;
  assert.equal(open.ev, 'open');
  assert.deepEqual(hello, { t: 'relay', ev: 'msg', id: open.id, msg: { t: 'hello', role: 'pilot' } });   // token stripped
  pilot.message({ t: 'ctl', seq: 1 });
  assert.deepEqual(bridge.conn.sent.at(-1), { t: 'relay', ev: 'msg', id: open.id, msg: { t: 'ctl', seq: 1 } });
  bridge.message({ t: 'relay', ev: 'send', id: open.id, msg: { t: 'welcome', role: 'pilot' } });
  assert.deepEqual(pilot.conn.sent.at(-1), { t: 'welcome', role: 'pilot' });
  pilot.close();
  assert.deepEqual(bridge.conn.sent.at(-1), { t: 'relay', ev: 'close', id: open.id });
});

test('bad hellos are refused with distinct close codes', (t) => {
  const relay = new Relay({ rooms: ROOMS });
  assert.equal(join(relay, { ...pilotHello, token: 'x'.repeat(64) }).conn.closed.code, CLOSE.DENIED);
  assert.equal(join(relay, { ...pilotHello, token: undefined }).conn.closed.code, CLOSE.DENIED);
  assert.equal(join(relay, { ...pilotHello, room: 'nope' }).conn.closed.code, CLOSE.BAD_HELLO);
  assert.equal(join(relay, { ...pilotHello, role: 'admin' }).conn.closed.code, CLOSE.BAD_HELLO);
  assert.equal(join(relay, { t: 'ctl' }).conn.closed.code, CLOSE.BAD_HELLO);
  assert.equal(join(relay, pilotHello).conn.closed.code, CLOSE.BRIDGE_LOST);    // Pi not connected
  t.after(() => {});
});

test('a pilot token cannot register as the bridge', () => {
  const relay = new Relay({ rooms: ROOMS });
  assert.equal(join(relay, { ...bridgeHello, token: PILOT }).conn.closed.code, CLOSE.DENIED);
});

test('bridge loss closes every remote client', () => {
  const relay = new Relay({ rooms: ROOMS });
  const bridge = join(relay, bridgeHello);
  const a = join(relay, pilotHello);
  const b = join(relay, { ...pilotHello, role: 'observer' });
  bridge.close();
  assert.equal(a.conn.closed.code, CLOSE.BRIDGE_LOST);
  assert.equal(b.conn.closed.code, CLOSE.BRIDGE_LOST);
});

test('a newer bridge replaces the old one and is told about connected clients', () => {
  const relay = new Relay({ rooms: ROOMS });
  const old = join(relay, bridgeHello);
  const pilot = join(relay, pilotHello);
  const fresh = join(relay, bridgeHello);
  assert.equal(old.conn.closed.code, CLOSE.REPLACED);
  old.close();                                   // the old socket closing must not drop clients
  assert.equal(pilot.conn.closed, null);
  assert.deepEqual(fresh.conn.sent.map((m) => m.ev), ['open', 'msg']);
});

test('room capacity and kick', () => {
  const relay = new Relay({ rooms: ROOMS });
  const bridge = join(relay, bridgeHello);
  const clients = [1, 2, 3, 4].map(() => join(relay, { ...pilotHello, role: 'observer' }));
  assert.equal(join(relay, pilotHello).conn.closed.code, CLOSE.FULL);
  const id = bridge.conn.sent.find((m) => m.ev === 'open').id;
  bridge.message({ t: 'relay', ev: 'kick', id });
  assert.equal(clients[0].conn.closed.code, 1000);
  bridge.message({ t: 'relay', ev: 'send', id: 'unknown', msg: {} });   // silently dropped
});

test('no hello in time closes the connection', async () => {
  const relay = new Relay({ rooms: ROOMS, helloTimeoutMs: 20 });
  const conn = fakeConn();
  relay.connect(conn);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(conn.closed.code, CLOSE.BAD_HELLO);
});

test('rate limit drops a flood from one client', () => {
  let now = 0;
  const relay = new Relay({ rooms: ROOMS, now: () => now });
  const bridge = join(relay, bridgeHello);
  const pilot = join(relay, pilotHello);
  const before = bridge.conn.sent.length;
  for (let i = 0; i < 300; i++) pilot.message({ t: 'ctl', seq: i });
  assert.equal(bridge.conn.sent.length - before, 119);   // hello used one of 120
  now = 1001;
  pilot.message({ t: 'ctl', seq: 999 });
  assert.equal(bridge.conn.sent.length - before, 120);
});

test('the bridge carries every client: it is not held to one client\'s rate limit', () => {
  let now = 0;
  const relay = new Relay({ rooms: ROOMS, now: () => now });
  const bridge = join(relay, bridgeHello);
  const clients = [1, 2, 3, 4].map(() => join(relay, { ...pilotHello, role: 'observer' }));
  const ids = bridge.conn.sent.filter((m) => m.ev === 'open').map((m) => m.id);
  for (let i = 0; i < 40; i++) for (const id of ids) bridge.message({ t: 'relay', ev: 'send', id, msg: { t: 'status', i } });
  assert.deepEqual(clients.map((c) => c.conn.sent.length), [40, 40, 40, 40]);
});

test('a client frame over 4 KiB closes that client only', () => {
  const relay = new Relay({ rooms: ROOMS });
  const bridge = join(relay, bridgeHello);
  const pilot = join(relay, pilotHello);
  const before = bridge.conn.sent.length;
  pilot.message({ t: 'ctl', pad: 'x' }, 5000);
  assert.equal(pilot.conn.closed.code, 1009);
  assert.equal(bridge.conn.sent.length, before);
  assert.equal(bridge.conn.closed, null);
});
