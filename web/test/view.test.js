import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkTracker, failsafeDetail, formatBattery, formatFlightMode, formatLink, formatMs, segments, stateLabel } from '../js/view.js';

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
