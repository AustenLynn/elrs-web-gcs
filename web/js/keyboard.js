// Keyboard input mode (computers). KeyboardModel is pure (tested in Node); app.js feeds it
// key events by physical key (`event.code`), so the layout of the keyboard does not matter.
//   W / S      throttle up / down while held; it stays where it is left, like the real stick
//   A / D      yaw          (springs back)
//   ↑ / ↓      pitch        (springs back)
//   ← / →      roll         (springs back)
//   Shift      fine control: half the deflection and half the throttle rate
import { approach } from './ramp.js';

const AXIS_KEYS = {
  KeyA: ['yaw', -1], KeyD: ['yaw', 1],
  ArrowUp: ['pitch', 1], ArrowDown: ['pitch', -1],     // stick up = nose down/forward = higher value
  ArrowLeft: ['roll', -1], ArrowRight: ['roll', 1],
};
const THROTTLE_KEYS = { KeyW: 1, KeyS: -1 };
const FINE_KEYS = ['ShiftLeft', 'ShiftRight'];
const MAX_DT_MS = 100;   // a stalled page (busy main thread, background tab) never jumps the sticks

/** Keys that act once when pressed (handled by the page, not by the model). */
export const KEY_ACTIONS = { Space: 'disarm', KeyF: 'failsafe', KeyR: 'arm', Escape: 'release' };

/** Flight-mode switch N / S / M. */
export const MODE_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 };

export const INTENSITIES = [0.3, 0.5, 1];

export class KeyboardModel {
  constructor({ intensity = 0.5, rampMs = 150, throttleRatePerS = 500 } = {}) {
    this.intensity = intensity;        // how far a held key moves its axis (0..1)
    this.rampMs = rampMs;              // time for a full-scale move away from centre
    this.throttleRatePerS = throttleRatePerS;
    this.held = new Set();
    this.out = { roll: 0, pitch: 0, yaw: 0 };
    this.throttle = 0;
  }

  /** Returns true when the key is a flight key (the page should not use it for anything else). */
  keyDown(code) {
    this.held.add(code);
    return code in AXIS_KEYS || code in THROTTLE_KEYS;
  }

  keyUp(code) {
    this.held.delete(code);
  }

  /** Every key counts as released (window lost focus, control released). */
  releaseAll() {
    this.held.clear();
  }

  reset() {
    this.releaseAll();
    this.out = { roll: 0, pitch: 0, yaw: 0 };
    this.throttle = 0;
  }

  update(dtMs) {
    const dt = Math.max(0, Math.min(MAX_DT_MS, dtMs));
    const fine = FINE_KEYS.some((k) => this.held.has(k)) ? 0.5 : 1;
    const dir = { roll: 0, pitch: 0, yaw: 0 };
    for (const code of this.held) {
      const axis = AXIS_KEYS[code];
      if (axis) dir[axis[0]] += axis[1];
    }
    for (const axis of Object.keys(this.out)) {
      const target = Math.sign(dir[axis]) * this.intensity * fine * 1000;
      this.out[axis] = approach(this.out[axis], target, (1000 * dt) / this.rampMs);
    }
    let up = 0;
    for (const code of this.held) up += THROTTLE_KEYS[code] ?? 0;
    this.throttle = Math.max(0, Math.min(1000, this.throttle + (up * this.throttleRatePerS * fine * dt) / 1000));
  }

  command(mode) {
    return {
      roll: Math.round(this.out.roll) || 0,
      pitch: Math.round(this.out.pitch) || 0,
      yaw: Math.round(this.out.yaw) || 0,
      throttle: Math.round(this.throttle) || 0,
      mode,
    };
  }
}
