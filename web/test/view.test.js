import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkTracker, failsafeAlert, failsafeDetail, formatBattery, formatCmdAge, formatFlightMode, formatLink, formatMs, recoverySteps, segments, stateLabel } from '../js/view.js';

const goodStatus = { core: true, serialOk: true, timingFrames: 10, state: 'ARMED', reason: 'none' };
const link = { upLq: 100, upRssi1: -60, txPowerMw: 100 };

// links: when the last core status arrived and when the module's timing-frame count last grew
const fresh = (now) => ({ statusAt: now, timingAt: now });

test('all links healthy', () => {
  const s = segments({ wsOpen: true, lastMsgAt: 900, status: goodStatus, links: fresh(1000), telem: { link, linkAt: 500 }, now: 1000 });
  assert.deepEqual(s, { pc: 'ok', core: 'ok', tx: 'ok', drone: 'ok' });
});

test('each link degrades independently', () => {
  const now = 10000;
  const links = fresh(now);
  assert.equal(segments({ wsOpen: true, lastMsgAt: 8000, status: goodStatus, links, telem: {}, now }).pc, 'warn');
  assert.equal(segments({ wsOpen: false, lastMsgAt: now, status: null, links, telem: {}, now }).pc, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { core: false }, links, telem: {}, now }).core, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, links: { statusAt: now, timingAt: 0 }, telem: {}, now }).tx, 'warn');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { ...goodStatus, serialOk: false }, links, telem: {}, now }).tx, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, links, telem: { link: { ...link, upLq: 40 }, linkAt: now }, now }).drone, 'warn');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, links, telem: { link, linkAt: now - 2500 }, now }).drone, 'down');
});

test('a core that stopped sending status is shown as down, never a frozen ARMADO', () => {
  const now = 10000;
  const links = { statusAt: now - 600, timingAt: now - 600 };
  const s = segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, links, telem: {}, now });
  assert.equal(s.core, 'down');
  assert.equal(s.tx, 'down');
  assert.equal(stateLabel(goodStatus, true, false), 'NÚCLEO SIN RESPUESTA');
});

test('a module whose timing frames stopped is shown as down even if USB is still there', () => {
  // e.g. the module browned out while its USB serial chip stayed enumerated
  const now = 10000;
  const s = segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, links: { statusAt: now, timingAt: now - 1500 }, telem: {}, now });
  assert.equal(s.tx, 'down');
});

test('the link tracker notices when status stops and when timing frames stop growing', () => {
  const t = new LinkTracker();
  t.update({ ...goodStatus, timingFrames: 10 }, 100);
  assert.deepEqual([t.statusAt, t.timingAt], [100, 0]);           // no growth seen yet
  t.update({ ...goodStatus, timingFrames: 12 }, 200);
  assert.deepEqual([t.statusAt, t.timingAt], [200, 200]);
  t.update({ ...goodStatus, timingFrames: 12 }, 300);              // frozen count
  assert.deepEqual([t.statusAt, t.timingAt], [300, 200]);
  t.update({ core: false }, 400);                                  // gateway says the core is gone
  assert.equal(t.statusAt, 300);
});

test('labels and formatting', () => {
  assert.equal(stateLabel(goodStatus, true), 'ARMADO');
  assert.equal(stateLabel(goodStatus, false), 'SIN CONEXIÓN');
  assert.equal(stateLabel({ core: false }, true), 'NÚCLEO APAGADO');
  assert.equal(failsafeDetail(goodStatus), null);
  assert.equal(failsafeDetail({ state: 'FAILSAFE', reason: 'cmd_timeout' }), 'dejaron de llegar comandos del piloto');
  assert.equal(formatBattery({ voltage: 16.84, remainingPct: 87 }), '16.8 V · 87 %');
  assert.equal(formatBattery(null), '—');
  assert.equal(formatLink(link), 'LQ 100 % · -60 dBm · 100 mW');
  assert.equal(formatMs(12.6), '13 ms');
  assert.equal(formatMs(null), '—');
});

test('the Aquila20 flight mode is shown in Spanish; other texts as they are', () => {
  // The Aquila20 reports "<sensitivity>-<mode>"; the mode is what the pilot chose (N/S/M).
  assert.equal(formatFlightMode('S-NORMAL'), 'N (mantener posición)');
  assert.equal(formatFlightMode('F-SPORT'), 'S (estable)');
  assert.equal(formatFlightMode('M-MANUAL'), 'M (manual)');
  assert.equal(formatFlightMode('ACRO*'), 'ACRO*');            // e.g. Betaflight
  assert.equal(formatFlightMode(null), '—');
});

// Failsafe recovery: the steps the core requires before it clears a failsafe (safety_ack).
const failsafe = { core: true, state: 'FAILSAFE', reason: 'cmd_timeout', fcArm: 'disarmed', cmdAgeMs: 20 };
const zero = { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 };
const stateOf = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.state]));

test('no recovery steps outside FAILSAFE', () => {
  assert.equal(recoverySteps({ status: goodStatus, engaged: true, cmd: zero }), null);
  assert.equal(recoverySteps({ status: null, engaged: false, cmd: zero }), null);
});

test('recovery steps come in the order the core checks them', () => {
  const steps = recoverySteps({ status: failsafe, engaged: true, cmd: zero });
  assert.deepEqual(steps.map((s) => s.id), ['throttle', 'control', 'drone', 'clear']);
});

test('throttle counts as down only at exactly 0 (the core threshold is configurable)', () => {
  assert.equal(stateOf(recoverySteps({ status: failsafe, engaged: true, cmd: { ...zero, throttle: 1 } })).throttle, 'todo');
  assert.equal(stateOf(recoverySteps({ status: failsafe, engaged: true, cmd: zero })).throttle, 'done');
});

test('control counts as taken only while engaged and the core sees fresh commands', () => {
  const at = (engaged, cmdAgeMs) => stateOf(recoverySteps({ status: { ...failsafe, cmdAgeMs }, engaged, cmd: zero })).control;
  assert.equal(at(false, 20), 'todo');
  assert.equal(at(true, null), 'todo');
  assert.equal(at(true, 2000), 'todo');
  assert.equal(at(true, 20), 'done');
});

test('the drone step follows the flight controller; unknown does not block', () => {
  const at = (fcArm) => stateOf(recoverySteps({ status: { ...failsafe, fcArm }, engaged: true, cmd: zero })).drone;
  assert.equal(at('disarmed'), 'done');
  assert.equal(at('armed'), 'todo');
  assert.equal(at('unknown'), 'unknown');
});

test('exactly one step is next: the first one not done', () => {
  const steps = recoverySteps({ status: failsafe, engaged: false, cmd: { ...zero, throttle: 400 } });
  assert.deepEqual(steps.filter((s) => s.next).map((s) => s.id), ['throttle']);
  const ready = recoverySteps({ status: { ...failsafe, fcArm: 'unknown' }, engaged: true, cmd: zero });
  assert.deepEqual(ready.filter((s) => s.next).map((s) => s.id), ['clear']);
  for (const step of ready) assert.ok(step.text.length > 0);
});

test('failsafe alert: generic title with the reason; its own text when the radio link was lost', () => {
  assert.equal(failsafeAlert(goodStatus), null);
  assert.deepEqual(failsafeAlert(failsafe), { title: 'FAILSAFE ACTIVO', detail: 'Dejaron de llegar comandos del piloto' });
  const rf = failsafeAlert({ ...failsafe, reason: 'rf_lost' });
  assert.equal(rf.title, 'EL DRON DEJÓ DE RESPONDER');
  assert.match(rf.detail, /a la vista/);
});

test('age of the last command the core received', () => {
  assert.equal(formatCmdAge(null), '—');
  assert.equal(formatCmdAge(40), 'ahora');
  assert.equal(formatCmdAge(1400), 'hace 1.4 s');
});
