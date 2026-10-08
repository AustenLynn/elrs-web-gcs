// Step input mode ("Prueba"), for bench tests: every axis is set with ± buttons or a typed
// value and holds it, so a test does not depend on the pilot's precision. StepModel is pure.
//  - Values move away from neutral at a limited rate (default 20 % per second), never in a jump;
//    towards neutral they move at once (see ramp.js).
//  - The throttle is limited (default 30 %). The limit can be lowered at any time and raised
//    only while not armed.
import { approach } from './ramp.js';

export const STEP_SIZES = [10, 50, 100];          // 1 %, 5 %, 10 %
export const THROTTLE_CAPS = [300, 500, 1000];    // 30 %, 50 %, 100 %
const RANGE = { roll: [-1000, 1000], pitch: [-1000, 1000], yaw: [-1000, 1000], throttle: [0, 1000] };
const MAX_DT_MS = 100;

export const capChangeAllowed = (current, next, status) => next <= current || status?.state !== 'ARMED';

export class StepModel {
  constructor({ step = 50, cap = 300, ratePerS = 200 } = {}) {
    this.step = step;
    this.cap = cap;
    this.ratePerS = ratePerS;
    this.target = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    this.out = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  }

  /** Sets an axis target (per mille), clamped to its range and the throttle limit.
   *  Returns the value applied, or null when the axis or the value is not valid. */
  set(axis, value) {
    if (!(axis in RANGE) || !Number.isFinite(value)) return null;
    const [lo, hi] = RANGE[axis];
    const max = axis === 'throttle' ? Math.min(hi, this.cap) : hi;
    this.target[axis] = Math.max(lo, Math.min(max, Math.round(value)));
    return this.target[axis];
  }

  nudge(axis, dir) {
    return this.set(axis, this.target[axis] + dir * this.step);
  }

  setStep(step) {
    if (STEP_SIZES.includes(step)) this.step = step;
  }

  setCap(cap) {
    if (!THROTTLE_CAPS.includes(cap)) return;
    this.cap = cap;
    this.target.throttle = Math.min(this.target.throttle, cap);
  }

  neutral() {
    for (const axis of Object.keys(this.target)) this.target[axis] = 0;
  }

  reset() {
    this.neutral();
    for (const axis of Object.keys(this.out)) this.out[axis] = 0;
  }

  update(dtMs) {
    const maxStep = (this.ratePerS * Math.max(0, Math.min(MAX_DT_MS, dtMs))) / 1000;
    for (const axis of Object.keys(this.out)) this.out[axis] = approach(this.out[axis], this.target[axis], maxStep);
  }

  command(mode) {
    return {
      roll: Math.round(this.out.roll) || 0,
      pitch: Math.round(this.out.pitch) || 0,
      yaw: Math.round(this.out.yaw) || 0,
      throttle: Math.round(this.out.throttle) || 0,
      mode,
    };
  }
}
