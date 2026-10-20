// Input modes: how the pilot produces stick values. Every mode yields the same command
// ({roll, pitch, yaw, throttle, mode}), so the gateway and crsf-core never know which one
// is in use, and the dead-man, arming and failsafe rules apply unchanged.
//   touch     two virtual sticks (Mode 2), one finger each   - phones and tablets
//   keyboard  keys for both sticks (keyboard.js)              - computers
//   step      ± buttons and typed values (stepper.js)         - bench tests
export const INPUT_MODES = ['touch', 'keyboard', 'step'];
const STORAGE_KEY = 'gcs-input-mode';

export const defaultInputMode = (coarsePointer) => (coarsePointer ? 'touch' : 'keyboard');

/** Switching while armed would change how the sticks respond under the pilot's hands. */
export const canSwitchInput = (status) => status?.state !== 'ARMED';

/** The mode this device used last time (storage may be missing or blocked). */
export function loadInputMode(storage, coarsePointer) {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (INPUT_MODES.includes(saved)) return saved;
  } catch { /* private window, blocked site data */ }
  return defaultInputMode(coarsePointer);
}

export function saveInputMode(storage, mode) {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch { /* the choice is just not remembered */ }
}

/** A failsafe starts every input again from zero: the page resets the sticks, keys and step
 *  values when the core enters FAILSAFE, and holds them at neutral, throttle 0, until it is
 *  cleared. The core already ignores the sticks in FAILSAFE; this makes sure that what the
 *  page sends afterwards starts from zero too, and that the throttle can never be in the way
 *  of clearing it. */
export const enteringFailsafe = (prevState, nextState) => nextState === 'FAILSAFE' && prevState !== 'FAILSAFE';

export const inputsLocked = (status) => status?.state === 'FAILSAFE';

export const lockedCommand = (mode) => ({ roll: 0, pitch: 0, yaw: 0, throttle: 0, mode });

/** Knob positions (−1..1, screen coordinates) that show a command on the two stick pads. */
export function padPositions(cmd) {
  return {
    left: { x: cmd.yaw / 1000, y: 1 - cmd.throttle / 500 },
    right: { x: cmd.roll / 1000, y: -cmd.pitch / 1000 || 0 },
  };
}

/** Takeover: every input mode starts from the drone's last command (the gateway's
 *  {r, p, y, th}), so the new pilot's first command never jumps the throttle. */
export function seedInputs({ left, right, keyboard, stepper }, last) {
  const cmd = { roll: last.r, pitch: last.p, yaw: last.y, throttle: last.th };
  const pos = padPositions(cmd);
  left.seed(pos.left);
  right.seed(pos.right);
  keyboard.seed(cmd.throttle);
  stepper.seed(cmd);
}

// The channels the core sends (CRSF values, in STATUS) back to a command, for the live sticks
// of a page that is not flying. Assumes the default map (deploy/crsf-core.conf): CH1-4 roll,
// pitch, throttle, yaw, sticks 1000-2000 us.
const chUs = (ch) => 1500 + (ch - 992) * 0.625;
const clampStick = (v, lo) => Math.max(lo, Math.min(1000, Math.round(v))) || 0;

export function channelsCommand(channels, mode) {
  if (!Array.isArray(channels) || channels.length < 4) return null;
  const stick = (ch) => clampStick((chUs(ch) - 1500) * 2, -1000);
  return { roll: stick(channels[0]), pitch: stick(channels[1]), yaw: stick(channels[3]),
    throttle: clampStick(chUs(channels[2]) - 1000, 0), mode };
}

const pct = (v) => Math.round(v / 10);
const signed = (v) => (pct(v) > 0 ? `+${pct(v)}` : pct(v) < 0 ? `−${-pct(v)}` : '0');

/** The values on the air, in percent, under each pad. */
export function readouts(cmd) {
  return {
    left: `Acel. ${pct(cmd.throttle)} % · Guiñ. ${signed(cmd.yaw)} %`,
    right: `Cab. ${signed(cmd.pitch)} % · Alab. ${signed(cmd.roll)} %`,
  };
}
