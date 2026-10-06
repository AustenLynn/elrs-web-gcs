import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HoldGesture } from '../js/hold.js';

test('fires once after the full hold', () => {
  let fired = 0;
  const h = new HoldGesture(1000, () => fired++);
  assert.equal(h.update(0), 0);
  h.press(100);
  assert.equal(h.update(600), 0.5);
  assert.equal(fired, 0);
  assert.equal(h.update(1100), 1);
  h.update(1500);
  assert.equal(fired, 1);
});

test('releasing early cancels', () => {
  let fired = 0;
  const h = new HoldGesture(1000, () => fired++);
  h.press(0);
  h.update(900);
  h.release();
  assert.equal(h.update(2000), 0);
  assert.equal(fired, 0);
});
