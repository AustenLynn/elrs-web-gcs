// Pure helpers that turn gateway state into what the page shows.
import { REASON_TEXT, STATE_TEXT } from './protocol.js';

const LINK_STALE_MS = 2000;
const STATUS_STALE_MS = 500;    // the core sends status at 10 Hz
const TIMING_STALE_MS = 1000;   // ELRS sends timing frames about every 200 ms

/** When the last core status arrived, and when the module's timing-frame count last grew.
 *  A counter that stops growing means the module stopped talking, even if USB is fine. */
export class LinkTracker {
  constructor() {
    this.statusAt = 0;
    this.timingAt = 0;
    this.lastFrames = null;
  }

  update(status, now) {
    if (!status?.core) return;
    this.statusAt = now;
    if (this.lastFrames !== null && status.timingFrames > this.lastFrames) this.timingAt = now;
    this.lastFrames = status.timingFrames;
  }
}

/** Health of the four links between the pilot and the drone: 'ok' | 'warn' | 'down'. */
export function segments({ wsOpen, lastMsgAt, status, links, telem, now }) {
  const pc = !wsOpen ? 'down' : now - lastMsgAt < 1000 ? 'ok' : 'warn';
  const coreUp = Boolean(status?.core) && now - links.statusAt < STATUS_STALE_MS;
  const core = coreUp ? 'ok' : 'down';
  let tx = 'down';
  if (coreUp && status.serialOk) {
    if (links.timingAt === 0) tx = 'warn';                       // no timing frame seen yet
    else if (now - links.timingAt < TIMING_STALE_MS) tx = 'ok';
  }
  let drone = 'down';
  if (telem.link && now - telem.linkAt < LINK_STALE_MS && telem.link.upLq > 0) {
    drone = telem.link.upLq >= 70 ? 'ok' : 'warn';
  }
  return { pc, core, tx, drone };
}

export function stateLabel(status, wsOpen, statusFresh = true) {
  if (!wsOpen) return 'SIN CONEXIÓN';
  if (!status?.core) return 'NÚCLEO APAGADO';
  if (!statusFresh) return 'NÚCLEO SIN RESPUESTA';
  return STATE_TEXT[status.state] ?? status.state;
}

export function failsafeDetail(status) {
  if (status?.state !== 'FAILSAFE') return null;
  return REASON_TEXT[status.reason] ?? status.reason;
}

/** What the failsafe alert says. Losing the radio link has its own wording: the drone's own
 *  receiver failsafe is in charge, whatever the profile does with ARM. */
export function failsafeAlert(status) {
  const detail = failsafeDetail(status);
  if (detail === null) return null;
  if (status.reason === 'rf_lost') {
    return { title: 'EL DRON DEJÓ DE RESPONDER', detail: 'El failsafe del receptor ELRS toma el control. Mantén el dron a la vista.' };
  }
  return { title: 'FAILSAFE ACTIVO', detail: detail.charAt(0).toUpperCase() + detail.slice(1) };
}

const CMD_FRESH_MS = 500;   // the core sees our commands (it times out at 300 ms; status lags up to 100 ms)

/** The way back from FAILSAFE, in the order crsf-core checks it before clearing (safety_ack).
 *  The core's throttle check needs no step: the page holds every input at neutral, throttle 0,
 *  for the whole failsafe (inputmode.js). Only a guide: the core decides, and its refusals are
 *  still shown. Each step is 'done', 'todo' or 'unknown' (no data, and the core does not block
 *  on it); the first step not done is marked next. */
export function recoverySteps({ status, engaged }) {
  if (status?.state !== 'FAILSAFE') return null;
  const commandsFresh = engaged && status.cmdAgeMs !== null && status.cmdAgeMs !== undefined && status.cmdAgeMs <= CMD_FRESH_MS;
  const drone = { disarmed: ['done', 'Dron desarmado'],
    armed: ['todo', 'El dron sigue armado: espera a que aterrice y se desarme'] }[status.fcArm]
    ?? ['unknown', 'Dron: sin datos de armado'];
  const steps = [
    { id: 'control', state: commandsFresh ? 'done' : 'todo', text: commandsFresh ? 'Control tomado' : 'Pulsa «Tomar control»' },
    { id: 'drone', state: drone[0], text: drone[1] },
    { id: 'clear', state: 'todo', text: 'Mantén «Limpiar failsafe» 2 s; luego comprueba que Dron está en verde y arma de nuevo' },
  ];
  const next = steps.find((st) => st.state === 'todo');
  for (const st of steps) st.next = st === next;
  return steps;
}

/** How long ago the core received the last command. */
export const formatCmdAge = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? 'ahora' : `hace ${(ms / 1000).toFixed(1)} s`);

export const formatBattery = (b) => (b ? `${b.voltage.toFixed(1)} V · ${b.remainingPct} %` : '—');

export const formatLink = (l) => (l ? `LQ ${l.upLq} % · ${l.upRssi1} dBm · ${l.txPowerMw} mW` : '—');

// The Aquila20 reports "<sensitivity>-<mode>" (e.g. "S-NORMAL"); the pilot chose the mode.
const AQUILA_MODES = { NORMAL: 'N (mantener posición)', SPORT: 'S (estable)', MANUAL: 'M (manual)' };

export function formatFlightMode(text) {
  if (!text) return '—';
  const mode = /^[SMF]-(NORMAL|SPORT|MANUAL)$/.exec(text);
  return mode ? AQUILA_MODES[mode[1]] : text;
}

export const formatMs = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
