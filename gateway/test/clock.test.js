import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClockSync } from '../src/clock.js';

test('offset and command age with a browser clock 4000 ms ahead', () => {
  const c = new ClockSync();
  assert.equal(c.ready, false);
  c.add(1000, 5050, 1100);          // 50 ms each way
  assert.equal(c.ready, true);
  assert.equal(c.rtt, 100);
  assert.equal(c.offset, 4000);
  // sent at browser time 5060 (= our 1060), arrives at our 1110: 50 ms old
  assert.equal(c.age(5060, 1110), 50);
});

test('uses the sample with the smallest round trip', () => {
  const c = new ClockSync();
  c.add(0, 4100, 200);              // slow sample: offset estimate 4000, rtt 200
  c.add(1000, 5010, 1020);          // fast sample: offset 4000, rtt 20
  c.add(2000, 6300, 2400);          // asymmetric slow sample would say 4100
  assert.equal(c.rtt, 20);
  assert.equal(c.offset, 4000);
});

test('window keeps only recent samples and ignores negative round trips', () => {
  const c = new ClockSync(2);
  c.add(0, 10, 2);                  // rtt 2, will fall out of the window
  c.add(100, 110, 150);
  c.add(200, 210, 260);
  assert.equal(c.rtt, 50);
  c.add(500, 0, 400);               // s2 < s0: ignored
  assert.equal(c.samples.length, 2);
});
