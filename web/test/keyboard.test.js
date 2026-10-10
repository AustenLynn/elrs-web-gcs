import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_ACTIONS, KeyboardModel, MODE_KEYS } from '../js/keyboard.js';

const neutral = { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 };

test('with no key held the command is neutral with throttle at zero', () => {
  const k = new KeyboardModel();
  k.update(20);
  assert.deepEqual(k.command(0), neutral);
});

test('a held axis key ramps to the intensity, not in one jump', () => {
  const k = new KeyboardModel({ intensity: 0.5, rampMs: 150 });
  assert.equal(k.keyDown('KeyD'), true);
  k.update(30);                                   // 30 ms of a 150 ms full-scale ramp
  assert.equal(k.command(0).yaw, 200);
  k.update(100);
  assert.equal(k.command(0).yaw, 500, 'stops at 50 % intensity');
});

test('releasing an axis key springs it back to centre at once', () => {
  const k = new KeyboardModel({ intensity: 1 });
  k.keyDown('ArrowRight');
  k.update(100);
  k.update(100);
  assert.equal(k.command(0).roll, 1000);
  k.keyUp('ArrowRight');
  k.update(20);
  assert.equal(k.command(0).roll, 0);
});

test('Mode 2 directions: up arrow is positive pitch, left arrow negative roll, A negative yaw', () => {
  const k = new KeyboardModel({ intensity: 1, rampMs: 1 });
  for (const code of ['ArrowUp', 'ArrowLeft', 'KeyA']) k.keyDown(code);
  k.update(20);
  const c = k.command(0);
  assert.deepEqual([c.pitch, c.roll, c.yaw], [1000, -1000, -1000]);
});

test('opposite keys on one axis cancel out', () => {
  const k = new KeyboardModel({ intensity: 1, rampMs: 1 });
  k.keyDown('KeyA');
  k.keyDown('KeyD');
  k.update(20);
  assert.equal(k.command(0).yaw, 0);
});

test('Shift halves the deflection (fine control)', () => {
  const k = new KeyboardModel({ intensity: 1, rampMs: 1 });
  k.keyDown('ShiftLeft');
  k.keyDown('ArrowDown');
  k.update(20);
  assert.equal(k.command(0).pitch, -500);
});

test('W raises the throttle at its rate and it stays when released; S lowers it', () => {
  const k = new KeyboardModel({ throttleRatePerS: 500 });
  k.keyDown('KeyW');
  for (let i = 0; i < 10; i++) k.update(20);    // 200 ms
  assert.equal(k.command(0).throttle, 100);
  k.keyUp('KeyW');
  k.update(500);
  assert.equal(k.command(0).throttle, 100, 'throttle holds, like the real stick');
  k.keyDown('KeyS');
  for (let i = 0; i < 20; i++) k.update(20);
  assert.equal(k.command(0).throttle, 0, 'never below zero');
});

test('Shift halves the throttle rate', () => {
  const k = new KeyboardModel({ throttleRatePerS: 500 });
  k.keyDown('ShiftRight');
  k.keyDown('KeyW');
  for (let i = 0; i < 10; i++) k.update(20);
  assert.equal(k.command(0).throttle, 50);
});

test('throttle never goes above full scale', () => {
  const k = new KeyboardModel({ throttleRatePerS: 5000, cap: 1000 });
  k.keyDown('KeyW');
  for (let i = 0; i < 50; i++) k.update(20);
  assert.equal(k.command(0).throttle, 1000);
});

test('the throttle limit starts at 30 % and W never goes past it', () => {
  const k = new KeyboardModel({ throttleRatePerS: 5000 });
  assert.equal(k.cap, 300);
  k.keyDown('KeyW');
  for (let i = 0; i < 50; i++) k.update(20);
  assert.equal(k.command(0).throttle, 300);
});

test('lowering the limit brings the throttle down to it at once; raising it lets W go higher', () => {
  const k = new KeyboardModel({ throttleRatePerS: 5000, cap: 1000 });
  k.keyDown('KeyW');
  for (let i = 0; i < 10; i++) k.update(20);
  assert.equal(k.command(0).throttle, 1000);
  k.setCap(500);
  assert.equal(k.command(0).throttle, 500);
  k.update(20);
  assert.equal(k.command(0).throttle, 500, 'W held: still at the limit');
  k.setCap(1000);
  k.update(20);
  assert.equal(k.command(0).throttle, 600);
});

test('only the listed throttle limits are accepted', () => {
  const k = new KeyboardModel();
  k.setCap(700);
  k.setCap(Number.NaN);
  assert.equal(k.cap, 300);
  k.setCap(500);
  assert.equal(k.cap, 500);
});

test('reset keeps the throttle limit the pilot chose', () => {
  const k = new KeyboardModel({ cap: 500 });
  k.reset();
  assert.equal(k.cap, 500);
});

test('a long pause between updates counts as at most 100 ms (a stalled page never jumps)', () => {
  const k = new KeyboardModel({ throttleRatePerS: 500 });
  k.keyDown('KeyW');
  k.update(2000);
  assert.equal(k.command(0).throttle, 50);
});

test('releaseAll lets go of every key: axes centre, throttle stops but holds', () => {
  const k = new KeyboardModel({ intensity: 1, rampMs: 1, throttleRatePerS: 500 });
  k.keyDown('KeyW');
  k.keyDown('ArrowUp');
  k.update(100);
  k.releaseAll();
  k.update(100);
  const c = k.command(0);
  assert.deepEqual([c.pitch, c.throttle], [0, 50]);
});

test('reset brings everything, throttle included, back to zero', () => {
  const k = new KeyboardModel({ throttleRatePerS: 500 });
  k.keyDown('KeyW');
  k.update(100);
  k.reset();
  k.update(20);
  assert.deepEqual(k.command(2), { ...neutral, mode: 2 });
});

test('only flight keys are claimed by the model', () => {
  const k = new KeyboardModel();
  for (const code of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(k.keyDown(code), true, code);
  }
  for (const code of ['Space', 'KeyF', 'KeyR', 'Escape', 'KeyQ', 'ShiftLeft']) {
    assert.equal(k.keyDown(code), false, code);
  }
});

test('action and flight-mode keys', () => {
  assert.deepEqual(KEY_ACTIONS, { Space: 'disarm', KeyF: 'failsafe', KeyR: 'arm', Escape: 'release' });
  assert.equal(MODE_KEYS.Digit1, 0);
  assert.equal(MODE_KEYS.Digit3, 2);
  assert.equal(MODE_KEYS.Numpad2, 1);
});

test('commands are integers in protocol range', () => {
  const k = new KeyboardModel({ intensity: 0.3, rampMs: 150, throttleRatePerS: 333 });
  k.keyDown('KeyW');
  k.keyDown('ArrowUp');
  k.update(17);
  const c = k.command(1);
  for (const v of [c.roll, c.pitch, c.yaw, c.throttle]) assert.ok(Number.isInteger(v), `${v} is not an integer`);
  assert.equal(c.mode, 1);
});

test('a key held through a reset is ignored until it is pressed again (auto-repeat does not bring it back)', () => {
  const k = new KeyboardModel({ throttleRatePerS: 500, cap: 1000 });
  k.keyDown('KeyW');
  k.update(100);
  k.reset();
  assert.equal(k.keyDown('KeyW', true), true, 'still claimed: the page must not use it for anything else');
  k.update(100);
  assert.equal(k.command(0).throttle, 0);
  k.keyUp('KeyW');
  k.keyDown('KeyW');
  k.update(100);
  assert.equal(k.command(0).throttle, 50, 'a fresh press works');
  k.keyDown('KeyW', true);
  k.update(100);
  assert.equal(k.command(0).throttle, 100, 'repeats of a key that is held are fine');
});
