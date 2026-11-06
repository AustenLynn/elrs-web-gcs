import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlTrace } from '../js/controltrace.js';

test('sent manifest preserves command identity across session changes', () => {
  const log = new ControlTrace(3);
  log.add(7, { seq: 1, ts: 12.5 });
  log.add(8, { seq: 1, ts: 32.5 });
  assert.deepEqual(log.export().commands, [
    { session: 7, seq: 1, ts: 12.5 }, { session: 8, seq: 1, ts: 32.5 },
  ]);
  assert.equal(log.export().overflow, false);
});

test('capacity exhaustion is explicit and does not silently replace earlier commands', () => {
  const log = new ControlTrace(1);
  log.add(7, { seq: 1, ts: 12 });
  log.add(7, { seq: 2, ts: 32 });
  assert.equal(log.export().overflow, true);
  assert.equal(log.export().commands.length, 1);
  assert.equal(log.export().sent, 2);
});
