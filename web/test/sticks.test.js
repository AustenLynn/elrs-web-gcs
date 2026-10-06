import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StickModel, sticksToCommand } from '../js/sticks.js';

test('moves are scaled to the pad radius and clamped (square gimbal)', () => {
  const s = new StickModel();
  s.move(50, -25, 100);
  assert.deepEqual([s.x, s.y], [0.5, -0.25]);
  s.move(500, -500, 100);
  assert.deepEqual([s.x, s.y], [1, -1]);
});

test('right stick springs back on both axes; throttle axis holds', () => {
  const right = new StickModel();
  right.move(80, 80, 100);
  right.release();
  assert.deepEqual([right.x, right.y], [0, 0]);
  const left = new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } });
  left.move(60, -40, 100);
  left.release();
  assert.deepEqual([left.x, left.y], [0, -0.4]);
});

test('mode 2 mapping: throttle at the bottom is 0, stick up is positive pitch', () => {
  const left = new StickModel({ springY: false, initial: { x: 0, y: 1 } });
  const right = new StickModel();
  assert.deepEqual(sticksToCommand(left, right, 0), { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 });
  left.move(-100, -100, 100);   // full up-left: throttle max, yaw left
  right.move(100, -100, 100);   // full up-right: pitch forward, roll right
  assert.deepEqual(sticksToCommand(left, right, 2), { roll: 1000, pitch: 1000, yaw: -1000, throttle: 1000, mode: 2 });
  left.move(0, 0, 100);
  assert.equal(sticksToCommand(left, right, 0).throttle, 500);
});

test('centred values are plain 0 (never -0)', () => {
  const s = new StickModel();
  s.move(-0.0001, 0.0001, 100);
  const c = sticksToCommand(s, s, 0);
  assert.ok(Object.is(c.roll, 0) && Object.is(c.pitch, 0) && Object.is(c.yaw, 0));
});
