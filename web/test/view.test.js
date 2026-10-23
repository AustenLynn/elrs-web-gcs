import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkTracker, failsafeAlert, failsafeDetail, formatBattery, formatCmdAge, formatFlightMode, formatLink, formatMs, holdBanner, pilotLine, queueText, recoverySteps, reportsTurtle, segments, stateLabel } from '../js/view.js';

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

test('the Aquila20 report is shown as mode and speed, turtle on its own; other texts as they are', () => {
  // The Aquila20 reports "<speed>-<mode>": speed S/M/F (CH7), mode NORMAL/SPORT/MANUAL or TURTLE.
  assert.equal(formatFlightMode('S-NORMAL'), 'Normal · Slow');
  assert.equal(formatFlightMode('F-SPORT'), 'Sport · Fast');
  assert.equal(formatFlightMode('M-MANUAL'), 'Manual · Mid');
  assert.equal(formatFlightMode('S-TURTLE'), 'TURTLE');
  assert.equal(formatFlightMode('ACRO*'), 'ACRO*');            // e.g. Betaflight
  assert.equal(formatFlightMode(null), '—');
  assert.equal(reportsTurtle('F-TURTLE'), true);
  assert.equal(reportsTurtle('S-NORMAL'), false);
  assert.equal(reportsTurtle(null), false);
});

// Failsafe recovery: the steps the core requires before it clears a failsafe (safety_ack).
const failsafe = { core: true, state: 'FAILSAFE', reason: 'cmd_timeout', fcArm: 'disarmed', cmdAgeMs: 20 };
const stateOf = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.state]));

test('no recovery steps outside FAILSAFE', () => {
  assert.equal(recoverySteps({ status: goodStatus, engaged: true }), null);
  assert.equal(recoverySteps({ status: null, engaged: false }), null);
});

test('recovery is take control, then clear (the page holds the throttle at 0 itself)', () => {
  const steps = recoverySteps({ status: failsafe, engaged: true });
  assert.deepEqual(steps.map((s) => s.id), ['control', 'drone', 'clear']);
});

test('control counts as taken only while engaged and the core sees fresh commands', () => {
  const at = (engaged, cmdAgeMs) => stateOf(recoverySteps({ status: { ...failsafe, cmdAgeMs }, engaged })).control;
  assert.equal(at(false, 20), 'todo');
  assert.equal(at(true, null), 'todo');
  assert.equal(at(true, 2000), 'todo');
  assert.equal(at(true, 20), 'done');
});

test('the drone step follows the flight controller; unknown does not block', () => {
  const at = (fcArm) => stateOf(recoverySteps({ status: { ...failsafe, fcArm }, engaged: true })).drone;
  assert.equal(at('disarmed'), 'done');
  assert.equal(at('armed'), 'todo');
  assert.equal(at('unknown'), 'unknown');
});

test('exactly one step is next: the first one not done', () => {
  const steps = recoverySteps({ status: failsafe, engaged: false });
  assert.deepEqual(steps.filter((s) => s.next).map((s) => s.id), ['control']);
  const ready = recoverySteps({ status: { ...failsafe, fcArm: 'unknown' }, engaged: true });
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

test('the queued page says who flies and what happens if they drop', () => {
  assert.equal(queueText({ role: 'queued', position: 1 }, { pilotName: 'ana' }), 'En la cola: puesto 1');   // not ready yet
  assert.equal(queueText({ role: 'queued', position: 2, standby: true }, { pilotName: 'ana', holdMs: 5000 }),
    'Estás en espera. Si ana pierde la conexión, podrás tomar el control o aterrizar.');
  assert.equal(queueText({ role: 'queued', position: 1, lost: true }, { pilotName: 'luis' }), 'Perdiste el control: ahora vuela luis');
  assert.equal(queueText({ role: 'queued', position: 1, lost: true }, { pilotName: null }), 'Perdiste el control: ahora vuela —');
  assert.equal(queueText({ role: 'queued', position: 3 }, { pilotName: 'ana' }), 'En la cola: puesto 3');
  assert.equal(queueText({ role: 'pilot' }, { pilotName: 'ana' }), '');
});

test('with the hold off, the queue head is not promised a rescue', () => {
  // hold_ms = 0: a lost pilot means FAILSAFE at once and the core refuses a take.
  assert.equal(queueText({ role: 'queued', position: 1, standby: true }, { pilotName: 'ana', holdMs: 0 }),
    'Estás en espera. Si ana pierde la conexión, el dron se detiene.');
  assert.equal(queueText({ role: 'queued', position: 1, standby: true }, { pilotName: 'ana' }),
    'Estás en espera. Si ana pierde la conexión, el dron se detiene.');   // no core status yet
  assert.deepEqual(holdBanner({ state: 'HOLD', stageLeftMs: 900, pilotName: 'ana', holdMs: 0 }, { role: 'queued', standby: true }),
    { text: 'ana perdió la conexión · aterriza en 1 s', take: false, land: false });
});

test('who is flying and who is standby, with a dash for none', () => {
  assert.equal(pilotLine({ pilotName: 'ana', standbyName: 'luis' }), 'Piloto: ana · En espera: luis');
  assert.equal(pilotLine({ pilotName: 'ana', standbyName: null }), 'Piloto: ana · En espera: —');
  assert.equal(pilotLine(null), 'Piloto: — · En espera: —');
});

test('hold banner for the queue head: name, whole seconds left, both buttons', () => {
  const st = { state: 'HOLD', stageLeftMs: 3400, pilotName: 'ana', holdMs: 5000 };
  assert.deepEqual(holdBanner(st, { role: 'queued', standby: true }),
    { text: 'ana perdió la conexión · aterriza en 4 s', take: true, land: true });
});
test('during LANDING the queue head can only take', () => {
  assert.deepEqual(holdBanner({ state: 'LANDING', stageLeftMs: 2000, pilotName: 'ana', holdMs: 5000 }, { role: 'queued', standby: true }),
    { text: 'Aterrizando…', take: true, land: false });
});
test('everyone else sees the countdown without buttons; nothing outside a hold', () => {
  const st = { state: 'HOLD', stageLeftMs: 900, pilotName: 'ana', holdMs: 5000 };
  assert.deepEqual(holdBanner(st, { role: 'observer' }), { text: 'ana perdió la conexión · aterriza en 1 s', take: false, land: false });
  assert.deepEqual(holdBanner(st, { role: 'queued', standby: false }), { text: 'ana perdió la conexión · aterriza en 1 s', take: false, land: false });
  assert.equal(holdBanner({ state: 'ARMED' }, { role: 'queued', standby: true }), null);
  assert.equal(holdBanner(st, { role: 'pilot' }), null);   // the main pilot's page keeps flying
});
test('state pill and queue text for the hold', () => {
  assert.equal(stateLabel({ core: true, state: 'HOLD' }, true), 'ESPERA · SIN PILOTO');
  assert.equal(stateLabel({ core: true, state: 'LANDING' }, true), 'ATERRIZANDO');
});
