import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlHub } from '../src/hub.js';

function fakeCore() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    sessionStart: rec('sessionStart'), control: rec('control'), arm: rec('arm'), disarm: rec('disarm'),
    ack: rec('ack'), pilotLost: rec('pilotLost'), failsafe: rec('failsafe'),
  };
}

function fakeClient() {
  const sent = [];
  return { sent, send: (m) => sent.push(m), close: () => {}, last: (t) => sent.filter((m) => m.t === t).at(-1) };
}

function setup({ maxCommandAgeMs = 200 } = {}) {
  let now = 1000;
  let nextSession = 41;
  const core = fakeCore();
  const hub = new ControlHub({ core, maxCommandAgeMs, now: () => now, newSession: () => ++nextSession });
  return { hub, core, clock: { get: () => now, set: (v) => { now = v; } } };
}

function join(hub, role = 'pilot') {
  const c = fakeClient();
  hub.attach(c);
  hub.handle(c, { t: 'hello', role });
  return c;
}

const ctl = (seq, extra = {}) => ({ t: 'ctl', seq, ts: 0, r: 0, p: 0, y: 0, th: 0, m: 0, ...extra });

test('first pilot gets a session and the core is told', () => {
  const { hub, core } = setup();
  const p = join(hub);
  assert.deepEqual(p.sent[0], { t: 'welcome', role: 'pilot', session: 42 });
  assert.equal(p.sent[1].t, 'tsync');
  assert.deepEqual(core.calls, [['sessionStart', 42]]);
});

test('a second pilot becomes an observer and cannot send commands', () => {
  const { hub, core } = setup();
  join(hub);
  const o = join(hub);
  assert.deepEqual(o.sent[0], { t: 'welcome', role: 'observer', reason: 'pilot_present' });
  hub.handle(o, { t: 'arm' });
  assert.equal(o.last('error').msg, 'observers cannot send commands');
  assert.equal(core.calls.filter((c) => c[0] === 'arm').length, 0);
});

test('messages before hello are refused', () => {
  const { hub, core } = setup();
  const c = fakeClient();
  hub.attach(c);
  hub.handle(c, ctl(1));
  assert.equal(c.last('error').msg, 'send hello first');
  assert.equal(core.calls.length, 0);
});

test('valid control messages are forwarded with the session', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(1, { r: -1000, p: 250, y: 3, th: 1000, m: 2 }));
  assert.deepEqual(core.calls.at(-1), ['control', 42, 1, { roll: -1000, pitch: 250, yaw: 3, throttle: 1000, mode: 2 }]);
});

test('malformed or repeated control messages never reach the core', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(5));
  for (const bad of [ctl(5), ctl(4), ctl(6, { r: 1001 }), ctl(6, { th: -1 }), ctl(6, { m: 3 }),
    ctl(6, { p: 0.5 }), ctl(6, { ts: 'x' }), { t: 'ctl', seq: 6 }, ctl(2 ** 32)]) {
    hub.handle(p, bad);
  }
  assert.equal(core.calls.filter((c) => c[0] === 'control').length, 1);
});

test('stale commands are dropped once the clock offset is known', () => {
  const { hub, core, clock } = setup({ maxCommandAgeMs: 200 });
  const p = join(hub);
  const s0 = p.last('tsync').s0;        // 1000
  clock.set(1010);
  hub.handle(p, { t: 'tsync_r', s0, c1: 50005 });   // browser clock ~49000 ahead, rtt 10
  clock.set(2000);
  hub.handle(p, ctl(1, { ts: 50900 }));  // browser 50900 = our 1900: 100 ms old -> ok
  hub.handle(p, ctl(2, { ts: 50700 }));  // our 1700: 300 ms old -> dropped
  const controls = core.calls.filter((c) => c[0] === 'control');
  assert.deepEqual(controls.map((c) => c[2]), [1]);
  hub.onCoreStatus({ state: 'DISARMED' });
  assert.equal(p.last('status').staleDropped, 1);
  assert.equal(p.last('status').rttMs, 10);
});

test('pilot buttons are forwarded with the session', () => {
  const { hub, core } = setup();
  const p = join(hub);
  for (const t of ['arm', 'disarm', 'ack', 'failsafe']) hub.handle(p, { t });
  assert.deepEqual(core.calls.slice(1), [['arm', 42], ['disarm', 42], ['ack', 42], ['failsafe', 42]]);
});

test('pilot disconnect reports pilot lost and frees the pilot seat', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const o = join(hub, 'observer');
  hub.detach(p);
  assert.deepEqual(core.calls.at(-1), ['pilotLost', 42]);
  assert.equal(o.last('status').pilot, false);
  const p2 = join(hub);
  assert.equal(p2.sent[0].session, 43);
});

test('status and telemetry are broadcast, cached and replayed', () => {
  const { hub } = setup();
  const p = join(hub);
  hub.onCoreTelemetry('battery', { voltage: 16.8 });
  hub.onCoreStatus({ state: 'ARMED', reason: 'none' });
  assert.deepEqual(p.last('telem'), { t: 'telem', battery: { voltage: 16.8 } });
  assert.equal(p.last('status').state, 'ARMED');
  assert.equal(p.last('status').core, true);
  const late = join(hub, 'observer');
  assert.deepEqual(late.sent.find((m) => m.t === 'telem'), { t: 'telem', battery: { voltage: 16.8 } });
  assert.equal(late.last('status').state, 'ARMED');
  hub.onCoreDown();
  assert.equal(p.last('status').core, false);
  assert.equal(p.last('status').state, undefined);
});

test('core events reach the browsers', () => {
  const { hub } = setup();
  const p = join(hub);
  hub.onCoreEvent({ what: 'arm', refused: 'throttle_high', session: 42 });
  assert.deepEqual(p.last('event'), { t: 'event', what: 'arm', refused: 'throttle_high' });
});

test('ping is answered with our time', () => {
  const { hub } = setup();
  const p = join(hub, 'observer');
  hub.handle(p, { t: 'ping', id: 7, ts: 123 });
  assert.deepEqual(p.last('pong'), { t: 'pong', id: 7, ts: 123, srv: 1000 });
});

test('a flooding client is rate limited', () => {
  const { hub, core, clock } = setup();
  const p = join(hub);                 // hello used 1 message of the budget
  for (let seq = 1; seq <= 200; seq++) hub.handle(p, ctl(seq));
  assert.equal(core.calls.filter((c) => c[0] === 'control').length, 119);
  clock.set(2001);
  hub.handle(p, ctl(201));
  assert.equal(core.calls.filter((c) => c[0] === 'control').length, 120);
});

test('a message type that is not a string cannot crash the gateway', () => {
  const { hub } = setup();
  const pilot = join(hub);
  assert.doesNotThrow(() => hub.handle(pilot, { t: { toString: 1 } }));
  assert.match(pilot.last('error').msg, /unknown message type/);
});

test('when the core comes back, the pilot gets a fresh session the core knows', () => {
  // The core drops its session when it loses the gateway (and a pilot that joined while the
  // core was down never registered). Without a new SESSION, every arm/ack is refused.
  const { hub, core } = setup();
  const pilot = join(hub);
  assert.equal(pilot.last('welcome').session, 42);
  hub.onCoreDown();
  hub.onCoreUp();
  assert.deepEqual(core.calls.filter((c) => c[0] === 'sessionStart'), [['sessionStart', 42], ['sessionStart', 43]]);
  assert.deepEqual(pilot.last('welcome'), { t: 'welcome', role: 'pilot', session: 43 });
  hub.handle(pilot, ctl(1));
  assert.deepEqual(core.calls.at(-1)[1], 43);
  hub.handle(pilot, { t: 'ack' });
  assert.deepEqual(core.calls.at(-1), ['ack', 43]);
});

test('core coming back with no pilot connected changes nothing', () => {
  const { hub, core } = setup();
  join(hub, 'observer');
  hub.onCoreUp();
  assert.equal(core.calls.length, 0);
});
