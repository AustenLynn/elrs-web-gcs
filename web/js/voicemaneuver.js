// Per-mille input deflections only: these presets do not describe travel distance.
const DIRECTIONS = Object.freeze({
  forward: ['pitch', 1], backward: ['pitch', -1],
  left: ['roll', -1], right: ['roll', 1],
  turn_left: ['yaw', -1], turn_right: ['yaw', 1],
});
export const CHOICES = Object.freeze([
  ...Object.keys(DIRECTIONS).flatMap((direction) => [`${direction}_short`, `${direction}_medium`]),
  'repeat_short', 'none',
]);
const DEFAULTS = Object.freeze({ shortMs: 250, mediumMs: 500, strength: 50 });

/** Validate independently of gateway limits and return an owned preset snapshot. */
export function validatePresets(presets = DEFAULTS) {
  if (!presets || typeof presets !== 'object') throw new TypeError('Invalid voice presets');
  const { shortMs, mediumMs, strength } = presets;
  for (const [value, cap] of [[shortMs, 1000], [mediumMs, 1000], [strength, 100]]) {
    if (!Number.isInteger(value) || value <= 0 || value > cap) {
      throw new RangeError('Voice presets must be positive integers within hard limits');
    }
  }
  if (shortMs > mediumMs) throw new RangeError('Short duration exceeds medium duration');
  return { shortMs, mediumMs, strength };
}

export class VoiceManeuver {
  #presets;
  #now;
  #active = null;
  #lastCompletedDirection = null;

  constructor({ presets, now = () => performance.now() } = {}) {
    this.#presets = validatePresets(presets);
    this.#now = now;
  }

  #expire() {
    if (this.#active && this.#now() >= this.#active.deadline) {
      this.#lastCompletedDirection = this.#active.direction;
      this.#active = null;
    }
  }

  get busy() {
    this.#expire();
    return this.#active !== null;
  }

  get lastCompletedDirection() {
    this.#expire();
    return this.#lastCompletedDirection;
  }

  start(choice) {
    this.#expire();
    if (this.#active || !CHOICES.includes(choice) || choice === 'none') return false;
    const tier = choice.endsWith('_medium') ? 'medium' : 'short';
    const direction = choice === 'repeat_short'
      ? this.#lastCompletedDirection
      : choice.slice(0, -(tier.length + 1));
    if (!direction) return false;
    this.#active = { direction, deadline: this.#now() + this.#presets[`${tier}Ms`] };
    return true;
  }

  apply(manualCommand) {
    this.#expire();
    if (!this.#active) return { ...manualCommand };
    const [axis, sign] = DIRECTIONS[this.#active.direction];
    return {
      ...manualCommand, roll: 0, pitch: 0, yaw: 0,
      [axis]: sign * this.#presets.strength,
    };
  }

  cancel({ clearRepeat = true } = {}) {
    this.#active = null;
    if (clearRepeat) this.#lastCompletedDirection = null;
  }

  reset() {
    this.cancel();
  }

  configure(presets) {
    const validated = validatePresets(presets);
    this.reset();
    this.#presets = validated;
  }
}
