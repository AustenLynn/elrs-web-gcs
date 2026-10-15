// The Aquila20's two extra switches, as on its own radio (spec 2026-10-14-speed-turtle):
//   speed  (SC, CH7)  0 Slow, 1 Mid, 2 Fast  - can change at any time
//   turtle (SD, CH8)  flips the drone back over; it only acts when the drone is upside down
// Both travel in every control message (sp, tu) like the flight mode. Switches is pure.
export const SPEED_KEYS = { Digit4: 0, Digit5: 1, Digit6: 2, Numpad4: 0, Numpad5: 1, Numpad6: 2 };
export const TURTLE_KEY = 'KeyT';

export class Switches {
  constructor() {
    this.speed = 0;       // Slow: what the drone got before these buttons existed
    this.turtle = false;
  }

  setSpeed(n) {
    if ([0, 1, 2].includes(n)) this.speed = n;
  }

  toggleTurtle() {
    this.turtle = !this.turtle;
  }

  /** After a failsafe or an input-mode change: turtle must not stay on unnoticed. */
  turtleOff() {
    this.turtle = false;
  }

  /** True when the key is one of ours. A held key's auto-repeat does not toggle again. */
  keyDown(code, repeat) {
    if (code === TURTLE_KEY) {
      if (!repeat) this.toggleTurtle();
      return true;
    }
    if (code in SPEED_KEYS) {
      this.setSpeed(SPEED_KEYS[code]);
      return true;
    }
    return false;
  }

  /** The fields for the control message; turtle is off while inputs are locked (FAILSAFE). */
  wire(locked) {
    return { sp: this.speed, tu: this.turtle && !locked ? 1 : 0 };
  }
}
