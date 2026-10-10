import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STEP_KEYS, STEP_SIZES, THROTTLE_CAPS, StepModel, capChangeAllowed } from '../js/stepper.js';

test('starts neutral, 5 % steps, throttle limited to 30 %', () => {
  const s = new StepModel();
  assert.deepEqual(s.command(0), { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 });
  assert.equal(s.step, 50);
  assert.equal(s.cap, 300);
  assert.deepEqual(STEP_SIZES, [10, 50, 100]);
  assert.deepEqual(THROTTLE_CAPS, [300, 500, 1000]);
});

test('a nudge moves the target one step; the output ramps there at 20 % per second', () => {
  const s = new StepModel();
  s.nudge('throttle', 1);
  s.nudge('throttle', 1);
  assert.equal(s.target.throttle, 100);
  s.update(100);                                // 100 ms at 200 per second = 20
  assert.equal(s.command(0).throttle, 20);
  for (let i = 0; i < 10; i++) s.update(100);
  assert.equal(s.command(0).throttle, 100);
});

test('stick axes step both ways and hold their value', () => {
  const s = new StepModel({ ratePerS: 100000 });
  s.nudge('roll', -1);
  s.nudge('pitch', 1);
  s.nudge('yaw', 1);
  s.update(20);
  const c = s.command(0);
  assert.deepEqual([c.roll, c.pitch, c.yaw], [-50, 50, 50]);
  s.update(1000);
  assert.deepEqual(s.command(0).roll, -50, 'nothing springs back in this mode');
});

test('typed values are clamped to the axis range and to the throttle limit', () => {
  const s = new StepModel();
  assert.equal(s.set('roll', 1500), 1000);
  assert.equal(s.set('yaw', -2000), -1000);
  assert.equal(s.set('throttle', 800), 300);
  assert.equal(s.set('throttle', -5), 0);
  assert.equal(s.set('pitch', 123.6), 124);
});

test('unknown axes and non-numbers are ignored', () => {
  const s = new StepModel();
  assert.equal(s.set('arm', 1000), null);
  assert.equal(s.set('roll', Number.NaN), null);
  assert.equal(s.target.roll, 0);
});

test('the step size can be changed', () => {
  const s = new StepModel();
  s.setStep(100);
  s.nudge('roll', 1);
  assert.equal(s.target.roll, 100);
  s.setStep(7);                                 // not one of the offered sizes
  assert.equal(s.step, 100);
});

test('lowering the throttle limit pulls the throttle down with it, at once', () => {
  const s = new StepModel({ cap: 1000, ratePerS: 100000 });
  s.set('throttle', 800);
  s.update(20);
  s.setCap(300);
  s.update(20);
  assert.equal(s.command(0).throttle, 300);
});

test('NEUTRO centres every axis and cuts the throttle immediately', () => {
  const s = new StepModel({ ratePerS: 100000 });
  s.set('throttle', 250);
  s.set('pitch', 400);
  s.update(20);
  s.neutral();
  s.update(1);
  assert.deepEqual(s.command(0), { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 });
});

test('the throttle limit can be lowered at any time but raised only while not armed', () => {
  assert.equal(capChangeAllowed(500, 300, { state: 'ARMED' }), true);
  assert.equal(capChangeAllowed(300, 500, { state: 'ARMED' }), false);
  assert.equal(capChangeAllowed(300, 500, { state: 'DISARMED' }), true);
  assert.equal(capChangeAllowed(300, 1000, { state: 'FAILSAFE' }), true);
  assert.equal(capChangeAllowed(300, 1000, null), true);
});

test('step keys: each press moves its axis one step (5 % by default), like the ± buttons', () => {
  const s = new StepModel();
  assert.equal(s.keyDown('KeyW', false), true);
  assert.equal(s.keyDown('KeyW', false), true);
  s.keyDown('KeyD', false);
  s.keyDown('ArrowUp', false);
  s.keyDown('ArrowLeft', false);
  assert.deepEqual(s.target, { roll: -50, pitch: 50, yaw: 50, throttle: 100 });
  s.keyDown('KeyS', false);
  s.keyDown('KeyA', false);
  s.keyDown('KeyA', false);
  s.keyDown('ArrowDown', false);
  s.keyDown('ArrowRight', false);
  assert.deepEqual(s.target, { roll: 0, pitch: 0, yaw: -50, throttle: 50 });
});

test('step keys: holding a key does not repeat the step; other keys are not taken', () => {
  const s = new StepModel();
  s.keyDown('KeyW', false);
  for (let i = 0; i < 20; i++) assert.equal(s.keyDown('KeyW', true), true);   // still taken: no page scroll
  assert.equal(s.target.throttle, 50);
  assert.equal(s.keyDown('Space', false), false);    // disarm stays with the page
  assert.equal(s.keyDown('KeyR', false), false);
  assert.equal(s.keyDown('Digit1', false), false);
  assert.equal(Object.keys(STEP_KEYS).length, 8);
});

test('step keys follow the chosen step and the throttle limit', () => {
  const s = new StepModel();
  s.setStep(10);
  s.keyDown('KeyW', false);
  assert.equal(s.target.throttle, 10);
  s.setStep(100);
  for (let i = 0; i < 5; i++) s.keyDown('KeyW', false);
  assert.equal(s.target.throttle, 300);              // stops at the 30 % limit
});

test('step keys with Shift: a fine 1 % step, whatever step is chosen', () => {
  const s = new StepModel();
  s.keyDown('KeyW', false, true);
  s.keyDown('ArrowRight', false, true);
  assert.deepEqual(s.target, { roll: 10, pitch: 0, yaw: 0, throttle: 10 });
  s.setStep(100);
  s.keyDown('KeyW', false, true);
  assert.equal(s.target.throttle, 20);
  s.keyDown('KeyW', false);                          // without Shift: the chosen step again
  assert.equal(s.target.throttle, 120);
  assert.equal(s.step, 100);                         // Shift never changes the chosen step
});
