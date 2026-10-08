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

/** Knob positions (−1..1, screen coordinates) that show a command on the two stick pads. */
export function padPositions(cmd) {
  return {
    left: { x: cmd.yaw / 1000, y: 1 - cmd.throttle / 500 },
    right: { x: cmd.roll / 1000, y: -cmd.pitch / 1000 || 0 },
  };
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
