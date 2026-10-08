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
