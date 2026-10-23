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
    take: rec('take'), land: rec('land'),
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
  assert.deepEqual(o.sent[0], { t: 'welcome', role: 'queued', position: 1, standby: true });
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
  hub.handle(s, { t: 'ready', on: true });   // `ready` is gone: an unknown type, like any other
  assert.equal(s.last('error').msg, 'observers cannot send commands');
  assert.deepEqual(core.calls, []);
});

test('signed-in pilots queue in join order; the second is queued at position 1', () => {
  const { hub, core } = setup();
  const p = join(hub, 'pilot', ANA);
  const q1 = join(hub, 'pilot', user('luis'));
  const q2 = join(hub, 'pilot', user('eva'));
  assert.equal(p.last('welcome').role, 'pilot');
  assert.deepEqual(q1.last('welcome'), { t: 'welcome', role: 'queued', position: 1, standby: true });
  assert.deepEqual(q2.last('welcome'), { t: 'welcome', role: 'queued', position: 2 });
  assert.deepEqual(core.calls, [['sessionStart', 42], ['standby', 43]]);   // the head's session, then the standby
  hub.detach(q1);
  assert.deepEqual(q2.last('welcome'), { t: 'welcome', role: 'queued', position: 1, standby: true });
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

test('a relay client may queue without a user; it is named "remoto"', () => {
  const { hub } = setup();
  join(hub);
  const remote = join(hub, 'pilot', { user: null, relay: true });
  assert.deepEqual(remote.last('welcome'), { t: 'welcome', role: 'queued', position: 1, standby: true });
  assert.equal(remote.last('status').standbyName, 'remoto');
});

test('status carries pilotName and standbyName', () => {
  const { hub } = setup();
  const o = join(hub, 'observer', SPECTATOR);
  assert.equal(o.last('status').pilotName, null);
  assert.equal(o.last('status').standbyName, null);
  join(hub);
  join(hub, 'pilot', user('luis'));
  assert.equal(o.last('status').pilotName, 'ana');
  assert.equal(o.last('status').standbyName, 'luis');
  assert.equal(hub.activePilotName(), 'ana');
});

test('dropUser closes a queued user\'s sockets and updates STANDBY', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  const q2 = join(hub, 'observer', user('luis'));
  hub.dropUser('luis');
  assert.ok(q.closed && q2.closed);
  assert.deepEqual(standbyCalls(core), [['standby', 43], ['standby', 0]]);
  assert.equal(p.last('status').standbyName, null);
  hub.dropUser('ana');                                   // the active pilot is never dropped
  assert.equal(p.closed, false);
});

test('taken for a taker whose page just left frees the core\'s seat, then the queue head is seated', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  const r = join(hub, 'pilot', user('eva'));
  hub.detach(q);                                         // gone while the core was already switching to it
  hub.onCoreEvent({ what: 'taken', reason: 'cmd_timeout', session: 43 });
  assert.ok(core.calls.some((c) => c[0] === 'pilotLost' && c[1] === 43));
  assert.deepEqual(p.last('welcome'), { t: 'welcome', role: 'queued', position: 2, lost: true });
  assert.equal(r.last('welcome').role, 'queued');
  hub.onCoreStatus({ state: 'FAILSAFE', session: 0 });
  assert.deepEqual(r.last('welcome'), { t: 'welcome', role: 'pilot', session: 44 });
  assert.ok(core.calls.some((c) => c[0] === 'sessionStart' && c[1] === 44));
  assert.deepEqual(core.calls.at(-1), ['standby', 42]);   // ana, now the queue head, is the standby
});

test('the queue head is the standby without pressing anything', () => {
  const { hub, core } = setup();
  join(hub);
  const q = join(hub, 'pilot', user('luis'));
  assert.deepEqual(core.calls.at(-1), ['standby', 43]);
  assert.equal(q.last('welcome').standby, true);
});

test('STANDBY follows the queue head when it leaves', () => {
  const { hub, core } = setup();
  join(hub);
  const q1 = join(hub, 'pilot', user('luis'));
  const q2 = join(hub, 'pilot', user('eva'));
  assert.deepEqual(standbyCalls(core), [['standby', 43]]);
  hub.detach(q1);
  assert.deepEqual(standbyCalls(core), [['standby', 43], ['standby', 44]]);
  assert.equal(q2.last('welcome').standby, true);
  hub.detach(q2);
  assert.deepEqual(standbyCalls(core), [['standby', 43], ['standby', 44], ['standby', 0]]);
});

test('take and land are refused from anyone but the queue head', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const head = join(hub, 'pilot', user('luis'));
  const second = join(hub, 'pilot', user('eva'));
  const spec = join(hub, 'observer', SPECTATOR);
  for (const t of ['take', 'land']) {
    for (const who of [second, spec, p]) {
      hub.handle(who, { t });
      assert.equal(who.last('error').msg, 'only the next pilot can take control or land');
      who.sent.length = 0;
    }
    assert.equal(core.calls.filter((c) => c[0] === t).length, 0);
    hub.handle(head, { t });
    assert.deepEqual(core.calls.at(-1), [t, 43]);
  }
});

test('taken seats the new pilot with the drone\'s current outputs as takeover', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  hub.onCoreStatus({ state: 'HOLD', session: 42, out: { roll: 0, pitch: 0, yaw: 0, throttle: 450, mode: 0, speed: 1, turtle: 0 } });
  hub.onCoreEvent({ what: 'taken', reason: 'cmd_timeout', session: 43 });
  assert.deepEqual(q.last('welcome'), { t: 'welcome', role: 'pilot', session: 43,
    takeover: { r: 0, p: 0, y: 0, th: 450, m: 0, sp: 1, tu: 0 } });
  // alone in the queue, the old pilot is the head: it is the new standby
  assert.deepEqual(p.last('welcome'), { t: 'welcome', role: 'queued', position: 1, lost: true, standby: true });
  assert.deepEqual(core.calls.at(-1), ['standby', 42]);
  assert.equal(core.calls.filter((c) => c[0] === 'sessionStart').length, 1);
  hub.handle(q, ctl(1, { th: 450 }));
  assert.deepEqual(core.calls.at(-1).slice(0, 2), ['control', 43]);
});

test('taken after the old pilot\'s page closed seats the taker', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  hub.detach(p);
  assert.deepEqual(core.calls.filter((c) => c[0] === 'pilotLost'), [['pilotLost', 42]]);
  hub.onCoreEvent({ what: 'taken', reason: 'pilot_lost', session: 43 });
  assert.equal(q.last('welcome').role, 'pilot');
  assert.equal(hub.awaitingCore, false);
  const before = core.calls.length;
  hub.onCoreStatus({ state: 'ARMED', session: 43 });     // must not reseat anyone
  assert.equal(core.calls.length, before);
  assert.equal(q.last('status').pilotName, 'luis');
});

test('hold events reach every browser', () => {
  const { hub } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  const o = join(hub, 'observer', SPECTATOR);
  for (const what of ['hold', 'resumed', 'landing']) {
    hub.onCoreEvent({ what, reason: 'pilot_lost', session: 42 });
    for (const c of [p, q, o]) assert.deepEqual(c.last('event'), { t: 'event', what, reason: 'pilot_lost', session: 42 });
  }
});

test('take and land refusals go only to the queue head', () => {
  const { hub } = setup();
  const p = join(hub);
  const q = join(hub, 'pilot', user('luis'));
  hub.onCoreEvent({ what: 'take', refused: 'not_in_hold', session: 43 });
  assert.deepEqual(q.last('event'), { t: 'event', what: 'take', refused: 'not_in_hold' });
  assert.equal(p.last('event'), undefined);
  hub.onCoreEvent({ what: 'land', refused: 'not_in_hold', session: 43 });
  assert.deepEqual(q.last('event'), { t: 'event', what: 'land', refused: 'not_in_hold' });
});

test('core coming back during a hold clears the hold banner state', () => {
  const { hub } = setup();
  const p = join(hub);
  hub.onCoreStatus({ state: 'HOLD', session: 42, stageLeftMs: 3000, out: { roll: 0, pitch: 0, yaw: 0, throttle: 450, mode: 0, speed: 1, turtle: 0 } });
  hub.onCoreDown();
  assert.equal(p.last('status').core, false);
  assert.equal(p.last('status').stageLeftMs, undefined);
  hub.onCoreUp();
  assert.deepEqual(p.last('welcome'), { t: 'welcome', role: 'pilot', session: 43 });
});
