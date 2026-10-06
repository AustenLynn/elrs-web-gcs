import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StickModel, padsMoved, sticksToCommand } from '../js/sticks.js';

test('moves are scaled to the pad radius and clamped (square gimbal)', () => {
  const s = new StickModel();
  s.grab(1, 50, -25, 100);
  assert.deepEqual([s.x, s.y], [0.5, -0.25]);
  s.move(1, 500, -500, 100);
  assert.deepEqual([s.x, s.y], [1, -1]);
});

test('right stick springs back on both axes; throttle axis holds', () => {
  const right = new StickModel();
  right.grab(1, 80, 80, 100);
  right.release(1);
  assert.deepEqual([right.x, right.y], [0, 0]);
  const left = new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } });
  left.grab(1, 60, 100, 100);
  left.move(1, 60, 50, 100);                    // dragged half the radius up
  left.release(1);
  assert.deepEqual([left.x, left.y], [0, 0.5]);
});

test('re-gripping the throttle does not move it: the held axis follows the drag, not the touch point', () => {
  const left = new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } });
  left.grab(1, 0, 100, 100);
  left.move(1, 0, 0, 100);                      // drag up to mid throttle
  left.release(1);
  assert.equal(left.y, 0);
  left.grab(2, 0, -90, 100);                    // finger lands near the top of the pad
  assert.equal(left.y, 0, 'touching must not jump the throttle');
  left.move(2, 0, -70, 100);                    // drag 20 px down
  assert.equal(left.y, 0.2);
});

test('a second finger on the same pad is ignored', () => {
  const right = new StickModel();
  assert.equal(right.grab(1, 50, 0, 100), true);
  assert.equal(right.grab(2, -90, 90, 100), false);
  right.move(2, -90, 90, 100);
  assert.deepEqual([right.x, right.y], [0.5, 0]);
  right.release(2);                             // lifting the other finger changes nothing
  assert.deepEqual([right.x, right.y], [0.5, 0]);
  assert.equal(right.active, true);
  right.release(1);
  assert.deepEqual([right.x, right.y], [0, 0]);
});

test('pads that moved under the fingers are detected', () => {
  const box = (x, y) => ({ left: x, top: y, width: 144, height: 144 });
  assert.equal(padsMoved([box(10, 50), box(600, 50)], [box(10, 52), box(600, 50)]), false);
  assert.equal(padsMoved([box(10, 50), box(600, 50)], [box(10, 78), box(600, 50)]), true);
  assert.equal(padsMoved([box(10, 50)], [{ ...box(10, 50), width: 120 }]), true);
});

test('mode 2 mapping: throttle at the bottom is 0, stick up is positive pitch', () => {
  const left = new StickModel({ springY: false, initial: { x: 0, y: 1 } });
  const right = new StickModel();
  assert.deepEqual(sticksToCommand(left, right, 0), { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 });
  left.grab(1, -100, 100, 100);
  left.move(1, -100, -100, 100); // drag from the bottom to full up-left: throttle max, yaw left
  right.grab(1, 100, -100, 100); // full up-right: pitch forward, roll right
  assert.deepEqual(sticksToCommand(left, right, 2), { roll: 1000, pitch: 1000, yaw: -1000, throttle: 1000, mode: 2 });
  left.move(1, 0, 0, 100);
  assert.equal(sticksToCommand(left, right, 0).throttle, 500);
});

test('centred values are plain 0 (never -0)', () => {
  const s = new StickModel();
  s.grab(1, -0.0001, 0.0001, 100);
  const c = sticksToCommand(s, s, 0);
  assert.ok(Object.is(c.roll, 0) && Object.is(c.pitch, 0) && Object.is(c.yaw, 0));
});
