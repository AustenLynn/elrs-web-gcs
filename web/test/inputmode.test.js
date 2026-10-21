import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT_MODES, canSwitchInput, channelsCommand, defaultInputMode, enteringFailsafe, inputsLocked, loadInputMode, lockedCommand, padPositions, readouts, saveInputMode, seedInputs } from '../js/inputmode.js';
import { KeyboardModel } from '../js/keyboard.js';
import { StepModel } from '../js/stepper.js';
import { StickModel, sticksToCommand } from '../js/sticks.js';

const memory = (init = {}) => {
  const data = { ...init };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); }, data };
};
const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

test('three input modes', () => {
  assert.deepEqual(INPUT_MODES, ['touch', 'keyboard', 'step']);
});

test('touch screens start with the sticks, computers with the keyboard', () => {
  assert.equal(defaultInputMode(true), 'touch');
  assert.equal(defaultInputMode(false), 'keyboard');
});

test('the saved choice wins; anything else falls back to the default', () => {
  assert.equal(loadInputMode(memory({ 'gcs-input-mode': 'step' }), true), 'step');
  assert.equal(loadInputMode(memory({ 'gcs-input-mode': 'joystick' }), true), 'touch');
  assert.equal(loadInputMode(memory(), false), 'keyboard');
  assert.equal(loadInputMode(null, false), 'keyboard');
  assert.equal(loadInputMode(broken, true), 'touch', 'blocked storage must not break the page');
});

test('saving remembers the choice and never throws', () => {
  const m = memory();
  saveInputMode(m, 'keyboard');
  assert.equal(m.data['gcs-input-mode'], 'keyboard');
  assert.doesNotThrow(() => saveInputMode(broken, 'step'));
  assert.doesNotThrow(() => saveInputMode(null, 'step'));
});

test('the mode cannot change while armed', () => {
  assert.equal(canSwitchInput({ state: 'ARMED' }), false);
  for (const s of [{ state: 'DISARMED' }, { state: 'FAILSAFE' }, null, undefined]) assert.equal(canSwitchInput(s), true);
});

test('pad positions mirror the Mode 2 stick layout', () => {
  assert.deepEqual(padPositions({ roll: 0, pitch: 0, yaw: 0, throttle: 0 }), { left: { x: 0, y: 1 }, right: { x: 0, y: 0 } });
  assert.deepEqual(padPositions({ roll: 1000, pitch: 1000, yaw: -500, throttle: 1000 }), { left: { x: -0.5, y: -1 }, right: { x: 1, y: -1 } });
  assert.deepEqual(padPositions({ roll: 0, pitch: -500, yaw: 0, throttle: 500 }).left.y, 0);
});

test('readouts show every axis in percent', () => {
  assert.deepEqual(readouts({ roll: -250, pitch: 100, yaw: 0, throttle: 355 }),
    { left: 'Acel. 36 % · Guiñ. 0 %', right: 'Cab. +10 % · Alab. −25 %' });
});

test('inputs start again from zero when the core enters FAILSAFE, once', () => {
  assert.equal(enteringFailsafe('ARMED', 'FAILSAFE'), true);
  assert.equal(enteringFailsafe('DISARMED', 'FAILSAFE'), true);
  assert.equal(enteringFailsafe(undefined, 'FAILSAFE'), true, 'page connected during a failsafe');
  assert.equal(enteringFailsafe('FAILSAFE', 'FAILSAFE'), false);
  assert.equal(enteringFailsafe('FAILSAFE', 'DISARMED'), false);
  assert.equal(enteringFailsafe('ARMED', 'ARMED'), false);
});

test('inputs stay locked at neutral, throttle 0, for the whole failsafe', () => {
  assert.equal(inputsLocked({ state: 'FAILSAFE' }), true);
  assert.equal(inputsLocked({ state: 'DISARMED' }), false);
  assert.equal(inputsLocked({ state: 'ARMED' }), false);
  assert.equal(inputsLocked(null), false, 'no status: the core holds the drone anyway');
  assert.deepEqual(lockedCommand(2), { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 2 }, 'the flight mode passes through');
});

test('takeover seeds every input mode from the last command, raising the throttle limit when needed', () => {
  const models = {
    left: new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } }),
    right: new StickModel(),
    keyboard: new KeyboardModel(),
    stepper: new StepModel(),
  };
  seedInputs(models, { r: 200, p: -100, y: 50, th: 450, m: 1, sp: 2, tu: 0 });
  assert.deepEqual(sticksToCommand(models.left, models.right, 1), { roll: 200, pitch: -100, yaw: 50, throttle: 450, mode: 1 });
  models.keyboard.update(20);                       // no key held: the throttle stays
  assert.equal(models.keyboard.command(1).throttle, 450);
  assert.equal(models.keyboard.cap, 500);
  models.stepper.update(20);
  assert.deepEqual(models.stepper.command(1), { roll: 200, pitch: -100, yaw: 50, throttle: 450, mode: 1 });
  assert.equal(models.stepper.cap, 500);
});

test('the drone\'s channels read back as the command that produced them (CH1-4 = AETR, 1000-2000 us)', () => {
  // CRSF values for roll +50 %, pitch -25 %, throttle 40 %, yaw 0 (crsf_us_to_ch of 1750, 1375, 1400, 1500)
  const ch = [1392, 792, 832, 992, ...Array(12).fill(172)];
  assert.deepEqual(channelsCommand(ch, 0), { roll: 500, pitch: -250, yaw: 0, throttle: 400, mode: 0 });
  assert.deepEqual(channelsCommand([172, 1811, 172, 1811], 2), { roll: -1000, pitch: 1000, yaw: 1000, throttle: 0, mode: 2 });
  assert.equal(channelsCommand(undefined, 0), null);
  assert.equal(channelsCommand([992], 0), null);
});
