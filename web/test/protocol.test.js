import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFUSAL_TEXT, controlMessage, helloMessage, tsyncReply } from '../js/protocol.js';

test('messages match what the gateway hub expects', () => {
  assert.deepEqual(helloMessage('pilot'), { t: 'hello', role: 'pilot' });
  assert.deepEqual(controlMessage(7, 123.5, { roll: 1, pitch: -2, yaw: 3, throttle: 400, mode: 1 }),
    { t: 'ctl', seq: 7, ts: 123.5, r: 1, p: -2, y: 3, th: 400, m: 1 });
  assert.deepEqual(tsyncReply({ t: 'tsync', s0: 99 }, 5000), { t: 'tsync_r', s0: 99, c1: 5000 });
});

test('every refusal the core can send has a text', () => {
  for (const r of ['wrong_session', 'not_disarmed', 'not_in_failsafe', 'link_stale', 'throttle_high', 'fc_still_armed']) {
    assert.ok(REFUSAL_TEXT[r], r);
  }
});
