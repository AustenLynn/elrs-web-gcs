import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approach } from '../js/ramp.js';

test('moving away from neutral is limited to maxStep per call', () => {
  assert.equal(approach(0, 500, 100), 100);
  assert.equal(approach(100, 500, 100), 200);
  assert.equal(approach(0, -500, 100), -100);
});

test('the target is reached exactly, without overshoot', () => {
  assert.equal(approach(450, 500, 100), 500);
  assert.equal(approach(500, 500, 100), 500);
});

test('moving towards neutral is immediate', () => {
  assert.equal(approach(800, 0, 10), 0);
  assert.equal(approach(800, 300, 10), 300);
  assert.equal(approach(-800, -100, 10), -100);
});

test('crossing neutral drops to zero at once, then ramps out the other side', () => {
  assert.equal(approach(500, -500, 100), -100);
  assert.equal(approach(-300, 300, 50), 50);
});
