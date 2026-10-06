import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failsafeDetail, formatBattery, formatLink, formatMs, segments, stateLabel } from '../js/view.js';

const goodStatus = { core: true, serialOk: true, timingFrames: 10, state: 'ARMED', reason: 'none' };
const link = { upLq: 100, upRssi1: -60, txPowerMw: 100 };

test('all links healthy', () => {
  const s = segments({ wsOpen: true, lastMsgAt: 900, status: goodStatus, telem: { link, linkAt: 500 }, now: 1000 });
  assert.deepEqual(s, { pc: 'ok', core: 'ok', tx: 'ok', drone: 'ok' });
});

test('each link degrades independently', () => {
  const now = 10000;
  assert.equal(segments({ wsOpen: true, lastMsgAt: 8000, status: goodStatus, telem: {}, now }).pc, 'warn');
  assert.equal(segments({ wsOpen: false, lastMsgAt: now, status: null, telem: {}, now }).pc, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { core: false }, telem: {}, now }).core, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { ...goodStatus, timingFrames: 0 }, telem: {}, now }).tx, 'warn');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { ...goodStatus, serialOk: false }, telem: {}, now }).tx, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, telem: { link: { ...link, upLq: 40 }, linkAt: now }, now }).drone, 'warn');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, telem: { link, linkAt: now - 2500 }, now }).drone, 'down');
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
