import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlHub } from '../src/hub.js';

function fakeCore() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    sessionStart: rec('sessionStart'), control: rec('control'), arm: rec('arm'), disarm: rec('disarm'),
    ack: rec('ack'), pilotLost: rec('pilotLost'), failsafe: rec('failsafe'), standby: rec('standby'),
  };
}

function fakeClient() {
  const sent = [];
  const c = { sent, closed: false, send: (m) => sent.push(m), last: (t) => sent.filter((m) => m.t === t).at(-1) };
  c.close = () => { c.closed = true; };
  return c;
}

function setup({ maxCommandAgeMs = 200 } = {}) {
  let now = 1000;
  let nextSession = 41;
  const core = fakeCore();
  const hub = new ControlHub({ core, maxCommandAgeMs, now: () => now, newSession: () => ++nextSession });
  return { hub, core, clock: { get: () => now, set: (v) => { now = v; } } };
}

const ANA = { user: { name: 'ana', admin: true }, relay: false };
const user = (name) => ({ user: { name, admin: false }, relay: false });
const SPECTATOR = { user: null, relay: false };

function join(hub, role = 'pilot', auth = ANA) {
  const c = fakeClient();
  hub.attach(c, auth);
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

test('a second pilot is queued and cannot send commands', () => {
  const { hub, core } = setup();
  join(hub);
  const o = join(hub);
  assert.deepEqual(o.sent[0], { t: 'welcome', role: 'queued', position: 1 });
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
  hub.handle(p, ctl(1, { r: -1000, p: 250, y: 3, th: 1000, m: 2, sp: 2, tu: 1 }));
  assert.deepEqual(core.calls.at(-1),
    ['control', 42, 1, { roll: -1000, pitch: 250, yaw: 3, throttle: 1000, mode: 2, speed: 2, turtle: 1 }]);
});

test('a page without speed and turtle (older version) flies at Slow with turtle off', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(1));
  assert.deepEqual(core.calls.at(-1)[3], { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0, speed: 0, turtle: 0 });
});

test('malformed or repeated control messages never reach the core', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(5));
  for (const bad of [ctl(5), ctl(4), ctl(6, { r: 1001 }), ctl(6, { th: -1 }), ctl(6, { m: 3 }),
    ctl(6, { p: 0.5 }), ctl(6, { ts: 'x' }), { t: 'ctl', seq: 6 }, ctl(2 ** 32),
    ctl(6, { sp: 3 }), ctl(6, { sp: -1 }), ctl(6, { tu: 2 }), ctl(6, { tu: true }), ctl(6, { sp: 1.5 })]) {
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
  hub.onCoreStatus({ state: 'DISARMED', session: 0 });
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

// --- Pilot queue, standby and the core's handover ---

const standbyCalls = (core) => core.calls.filter((c) => c[0] === 'standby');

test('a spectator who asks for the pilot role is told to sign in', () => {
  const { hub, core } = setup();
  const s = join(hub, 'pilot', SPECTATOR);
  assert.deepEqual(s.sent[0], { t: 'welcome', role: 'observer', reason: 'login_required' });
  hub.handle(s, { t: 'ready', on: true });
  assert.equal(s.last('error').msg, 'observers cannot send commands');
  assert.deepEqual(core.calls, []);
});

test('signed-in pilots queue in join order; the second is queued at position 1', () => {
  const { hub, core } = setup();
  const p = join(hub, 'pilot', ANA);
  const q1 = join(hub, 'pilot', user('luis'));
  const q2 = join(hub, 'pilot', user('eva'));
  assert.equal(p.last('welcome').role, 'pilot');
  assert.deepEqual(q1.last('welcome'), { t: 'welcome', role: 'queued', position: 1 });
  assert.deepEqual(q2.last('welcome'), { t: 'welcome', role: 'queued', position: 2 });
  assert.deepEqual(core.calls, [['sessionStart', 42]]);   // only the head's session reaches the core
  hub.detach(q1);
  assert.deepEqual(q2.last('welcome'), { t: 'welcome', role: 'queued', position: 1 });
});

test('only the standby page is told it is the standby, wherever it stands in the queue', () => {
  const { hub } = setup();
  join(hub);
  const q1 = join(hub, 'pilot', user('luis'));
  const q2 = join(hub, 'pilot', user('eva'));
  hub.handle(q2, { t: 'ready', on: true });   // luis (first in line) is not ready: eva is the standby
  assert.deepEqual(q2.last('welcome'), { t: 'welcome', role: 'queued', position: 2, standby: true });
  assert.deepEqual(q1.last('welcome'), { t: 'welcome', role: 'queued', position: 1 });
  hub.handle(q1, { t: 'ready', on: true });   // now luis is
  assert.deepEqual(q1.last('welcome'), { t: 'welcome', role: 'queued', position: 1, standby: true });
  assert.deepEqual(q2.last('welcome'), { t: 'welcome', role: 'queued', position: 2 });
});

test('a ready queued pilot becomes the standby and the core is told (STANDBY), not ready → STANDBY 0', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q1 = join(hub, 'pilot', user('luis'));
  const q2 = join(hub, 'pilot', user('eva'));
  hub.handle(q2, { t: 'ready', on: true });              // q1 isn't ready: the standby is q2
  assert.deepEqual(standbyCalls(core), [['standby', 44]]);
  hub.handle(q1, { t: 'ready', on: true });              // q1 joined first: it becomes the standby
  assert.deepEqual(standbyCalls(core), [['standby', 44], ['standby', 43]]);
  hub.handle(q2, { t: 'ready', on: false });             // not the standby: nothing changes
  hub.handle(q1, { t: 'ready', on: false });
  assert.deepEqual(standbyCalls(core), [['standby', 44], ['standby', 43], ['standby', 0]]);
  hub.handle(p, { t: 'ready', on: true });               // the active pilot isn't queued
  assert.equal(p.last('error').msg, 'observers cannot send commands');
});

test('not-ready standby is withdrawn with STANDBY 0', () => {
  const { hub, core } = setup();
  join(hub);
  const q = join(hub, 'pilot', user('luis'));
  hub.handle(q, { t: 'ready', on: true });
  hub.handle(q, { t: 'ready', on: true });               // no change: no repeat
  hub.handle(q, { t: 'ready', on: false });
  assert.deepEqual(standbyCalls(core), [['standby', 43], ['standby', 0]]);
  assert.equal(q.last('status').standbyName, null);
});

test('pilot socket closes with a standby: pilotLost, then the core\'s handover event promotes the standby with takeover of the last command', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  hub.handle(q, { t: 'ready', on: true });
  hub.handle(p, ctl(1, { r: 10, p: -20, y: 30, th: 550, m: 1, sp: 2, tu: 0 }));
  hub.detach(p);
  assert.deepEqual(core.calls.at(-1), ['pilotLost', 42]);
  hub.onCoreStatus({ state: 'ARMED', session: 42 });     // sent before the core saw PILOT_LOST
  assert.equal(q.last('welcome').role, 'queued');        // the hub never promotes on its own
  hub.onCoreEvent({ what: 'handover', reason: 'pilot_lost', session: 43 });
  assert.deepEqual(q.last('event'), { t: 'event', what: 'handover', reason: 'pilot_lost' });
  assert.deepEqual(q.last('welcome'),
    { t: 'welcome', role: 'pilot', session: 43, takeover: { r: 10, p: -20, y: 30, th: 550, m: 1, sp: 2, tu: 0 } });
  assert.equal(q.sent.at(-1).t, 'status');
  assert.ok(q.sent.some((m) => m.t === 'tsync'));
  assert.equal(core.calls.filter((c) => c[0] === 'sessionStart').length, 1);   // never SESSION for a promoted standby
  hub.handle(q, ctl(1, { th: 550 }));
  assert.equal(core.calls.at(-1)[0], 'control');
  assert.equal(core.calls.at(-1)[1], 43);
  hub.onCoreStatus({ state: 'ARMED', session: 43 });
  assert.equal(q.last('status').pilotName, 'luis');
});

test('pilot socket closes with no standby: pilotLost, and the next queued pilot gets the seat once status shows session 0', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  hub.detach(p);
  assert.deepEqual(core.calls.at(-1), ['pilotLost', 42]);
  hub.onCoreStatus({ state: 'FAILSAFE', session: 42 });  // the core hasn't read PILOT_LOST yet
  assert.equal(q.last('welcome').role, 'queued');
  hub.onCoreStatus({ state: 'FAILSAFE', session: 0 });
  assert.deepEqual(q.last('welcome'), { t: 'welcome', role: 'pilot', session: 43 });
  assert.deepEqual(core.calls.at(-1), ['sessionStart', 43]);
});

test('after a handover the old pilot is queued, not ready, and its commands are refused', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  const r = join(hub, 'pilot', user('eva'));
  hub.handle(q, { t: 'ready', on: true });
  hub.handle(p, ctl(1, { th: 400 }));
  hub.onCoreEvent({ what: 'handover', reason: 'cmd_timeout', session: 43 });   // p's socket is still open
  assert.deepEqual(p.last('welcome'), { t: 'welcome', role: 'queued', position: 2, lost: true });
  assert.deepEqual(r.last('welcome'), { t: 'welcome', role: 'queued', position: 1 });
  assert.equal(q.last('welcome').role, 'pilot');
  assert.equal(p.last('event').what, 'handover');
  const before = core.calls.length;
  hub.handle(p, ctl(2, { th: 400 }));
  hub.handle(p, { t: 'disarm' });
  assert.equal(p.last('error').msg, 'observers cannot send commands');
  assert.equal(core.calls.length, before);
  hub.handle(r, { t: 'ready', on: true });               // the new standby is registered at once
  assert.deepEqual(core.calls.at(-1), ['standby', 44]);
  assert.equal(core.calls.filter((c) => c[0] === 'sessionStart').length, 1);
});

test('a relay client may queue without a user; it is named "remoto"', () => {
  const { hub } = setup();
  join(hub);
  const remote = join(hub, 'pilot', { user: null, relay: true });
  assert.deepEqual(remote.last('welcome'), { t: 'welcome', role: 'queued', position: 1 });
  hub.handle(remote, { t: 'ready', on: true });
  assert.equal(remote.last('status').standbyName, 'remoto');
});

test('status carries pilotName and standbyName', () => {
  const { hub } = setup();
  const o = join(hub, 'observer', SPECTATOR);
  assert.equal(o.last('status').pilotName, null);
  assert.equal(o.last('status').standbyName, null);
  join(hub);
  const q = join(hub, 'pilot', user('luis'));
  assert.equal(o.last('status').pilotName, 'ana');
  assert.equal(o.last('status').standbyName, null);      // queued but not ready
  hub.handle(q, { t: 'ready', on: true });
  assert.equal(o.last('status').standbyName, 'luis');
  assert.equal(hub.activePilotName(), 'ana');
});

test('dropUser closes a queued user\'s sockets and updates STANDBY', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  const q2 = join(hub, 'observer', user('luis'));
  hub.handle(q, { t: 'ready', on: true });
  hub.dropUser('luis');
  assert.ok(q.closed && q2.closed);
  assert.deepEqual(standbyCalls(core), [['standby', 43], ['standby', 0]]);
  assert.equal(p.last('status').standbyName, null);
  hub.dropUser('ana');                                   // the active pilot is never dropped
  assert.equal(p.closed, false);
});

test('after the core comes back, the standby is registered again after the new SESSION', () => {
  const { hub, core } = setup();
  join(hub);
  const q = join(hub, 'pilot', user('luis'));
  hub.handle(q, { t: 'ready', on: true });
  hub.onCoreDown();
  hub.onCoreUp();
  assert.deepEqual(core.calls.slice(-2), [['sessionStart', 44], ['standby', 43]]);
});

test('a handover to a standby whose page just left frees the core\'s seat, then the queue head is seated', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  const r = join(hub, 'pilot', user('eva'));
  hub.handle(q, { t: 'ready', on: true });
  hub.detach(q);                                         // gone while the core was already switching to it
  hub.onCoreEvent({ what: 'handover', reason: 'cmd_timeout', session: 43 });
  assert.deepEqual(core.calls.at(-1), ['pilotLost', 43]);
  assert.deepEqual(p.last('welcome'), { t: 'welcome', role: 'queued', position: 2, lost: true });
  assert.equal(r.last('welcome').role, 'queued');
  hub.onCoreStatus({ state: 'FAILSAFE', session: 0 });
  assert.deepEqual(r.last('welcome'), { t: 'welcome', role: 'pilot', session: 44 });
  assert.deepEqual(core.calls.at(-1), ['sessionStart', 44]);
});
