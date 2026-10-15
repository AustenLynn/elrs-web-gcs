import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPEED_KEYS, Switches, TURTLE_KEY } from '../js/switches.js';

test('starts at Slow with turtle off; only valid speeds are taken', () => {
  const s = new Switches();
  assert.deepEqual(s.wire(false), { sp: 0, tu: 0 });
  s.setSpeed(2);
  assert.equal(s.speed, 2);
  for (const bad of [3, -1, 1.5, '1', undefined]) s.setSpeed(bad);
  assert.equal(s.speed, 2);
});

test('keys: T toggles turtle on a fresh press only; 4/5/6 choose the speed', () => {
  const s = new Switches();
  assert.equal(TURTLE_KEY, 'KeyT');
  assert.equal(s.keyDown('KeyT', false), true);
  assert.equal(s.turtle, true);
  for (let i = 0; i < 30; i++) assert.equal(s.keyDown('KeyT', true), true);   // held: no flicker
  assert.equal(s.turtle, true);
  s.keyDown('KeyT', false);
  assert.equal(s.turtle, false);
  for (const [code, speed] of [['Digit6', 2], ['Digit4', 0], ['Numpad5', 1], ['Digit5', 1]]) {
    assert.equal(s.keyDown(code, false), true);
    assert.equal(s.speed, speed);
  }
  assert.equal(SPEED_KEYS.Numpad6, 2);
  assert.equal(s.keyDown('KeyR', false), false);     // arm stays with the page
  assert.equal(s.keyDown('Digit1', false), false);   // flight modes too
});

test('on the wire: turtle is off while inputs are locked (FAILSAFE); speed is kept', () => {
  const s = new Switches();
  s.setSpeed(1);
  s.keyDown('KeyT', false);
  assert.deepEqual(s.wire(false), { sp: 1, tu: 1 });
  assert.deepEqual(s.wire(true), { sp: 1, tu: 0 });
  s.turtleOff();
  assert.deepEqual(s.wire(false), { sp: 1, tu: 0 });
});
