import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHOICES, validatePresets, VoiceManeuver } from '../js/voicemaneuver.js';

const manual = Object.freeze({ roll: 0, pitch: 0, yaw: 0, throttle: 237, mode: 0 });
function fixture(presets) {
  let time = 0;
  const scheduler = new VoiceManeuver({ presets, now: () => time });
  return { scheduler, at: (value) => { time = value; } };
}

test('bounded_forward_preserves_throttle', () => {
  const { scheduler: s, at } = fixture();
  assert.equal(s.start('forward_short'), true);
  for (const time of [0, 100, 249]) {
    at(time);
    const out = s.apply(manual);
    assert.ok(out.pitch > 0 && out.pitch <= 50);
    assert.deepEqual(out, { ...manual, pitch: 50 });
  }
  at(250);
  assert.deepEqual(s.apply(manual), manual);
  assert.equal(s.busy, false);
  assert.equal(s.lastCompletedDirection, 'forward');
});

test('late_tick_expires', () => {
  const { scheduler: s, at } = fixture();
  s.start('right_medium');
  at(1001);
  assert.deepEqual(s.apply(manual), manual);
  assert.equal(s.busy, false);
});

test('repeat_only_after_completion', () => {
  const { scheduler: s, at } = fixture();
  assert.equal(s.start('repeat_short'), false);
  s.start('left_short');
  s.cancel();
  assert.equal(s.start('repeat_short'), false);
  s.start('backward_medium');
  at(500);
  // start itself must observe expiry, even with no intervening output tick.
  assert.equal(s.start('repeat_short'), true);
  assert.deepEqual(s.apply(manual), { ...manual, pitch: -50 });
  at(750);
  assert.equal(s.busy, false);
  assert.equal(s.lastCompletedDirection, 'backward');
  s.cancel({ clearRepeat: false });
  assert.equal(s.start('repeat_short'), true);
  s.reset();
  assert.equal(s.lastCompletedDirection, null);
  assert.equal(s.start('repeat_short'), false);
});

test('no_queue_or_mutation', () => {
  const { scheduler: s, at } = fixture();
  s.start('forward_short');
  assert.equal(s.start('right_short'), false);
  const input = Object.freeze({ roll: 14, pitch: -12, yaw: 6, throttle: 321, mode: 2 });
  assert.deepEqual(s.apply(input), { roll: 0, pitch: 50, yaw: 0, throttle: 321, mode: 2 });
  assert.deepEqual(input, { roll: 14, pitch: -12, yaw: 6, throttle: 321, mode: 2 });
  at(250);
  assert.deepEqual(s.apply(manual), manual);
  assert.equal(s.start('none'), false);
  for (const invalid of ['forward', 'constructor', '__proto__', '', null, 1]) {
    assert.equal(s.start(invalid), false);
  }
});

test('preset_caps', () => {
  for (const [key, values] of Object.entries({
    shortMs: [NaN, -1, 0, 1.5, Infinity, 1001, '250'],
    mediumMs: [NaN, -1, 0, 1.5, Infinity, 1001, '500'],
    strength: [NaN, -1, 0, 1.5, Infinity, 101, '50'],
  })) {
    for (const value of values) {
      const presets = { shortMs: 250, mediumMs: 500, strength: 50, [key]: value };
      assert.throws(() => validatePresets(presets));
      assert.throws(() => new VoiceManeuver({ presets }));
    }
  }
  assert.throws(() => validatePresets({ shortMs: 501, mediumMs: 500, strength: 50 }));
  const presets = { shortMs: 1000, mediumMs: 1000, strength: 100 };
  assert.deepEqual(validatePresets(presets), presets);
  const { scheduler: s, at } = fixture(presets);
  presets.strength = 999;
  s.start('turn_right_medium');
  assert.deepEqual(s.apply(manual), { ...manual, yaw: 100 });
  at(1000);
  assert.deepEqual(s.apply(manual), manual);
});

test('idle_passes_manual', () => {
  const { scheduler: s } = fixture();
  const input = Object.freeze({ roll: 19, pitch: -7, yaw: 41, throttle: 420, mode: 1 });
  assert.deepEqual(s.apply(input), input);
  assert.notEqual(s.apply(input), input);
  s.start('left_short');
  s.cancel();
  assert.deepEqual(s.apply(input), input);
  assert.equal(s.lastCompletedDirection, null);
});

test('catalog_directions_and_medium_duration', () => {
  assert.equal(CHOICES.length, 14);
  for (const [direction, axes] of [
    ['forward', { pitch: 50 }], ['backward', { pitch: -50 }],
    ['left', { roll: -50 }], ['right', { roll: 50 }],
    ['turn_left', { yaw: -50 }], ['turn_right', { yaw: 50 }],
  ]) {
    for (const tier of ['short', 'medium']) {
      const { scheduler: s, at } = fixture();
      const choice = `${direction}_${tier}`;
      assert.ok(CHOICES.includes(choice));
      assert.equal(s.start(choice), true);
      at(tier === 'short' ? 249 : 499);
      assert.deepEqual(s.apply(manual), { ...manual, ...axes });
      at(tier === 'short' ? 250 : 500);
      assert.deepEqual(s.apply(manual), manual);
    }
  }
});
