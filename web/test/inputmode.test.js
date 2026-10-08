import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT_MODES, canSwitchInput, defaultInputMode, loadInputMode, padPositions, readouts, saveInputMode } from '../js/inputmode.js';

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
