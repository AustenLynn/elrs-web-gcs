// Pure helpers that turn gateway state into what the page shows.
import { REASON_TEXT, STATE_TEXT } from './protocol.js';

const LINK_STALE_MS = 2000;

/** Health of the four links between the pilot and the drone: 'ok' | 'warn' | 'down'. */
export function segments({ wsOpen, lastMsgAt, status, telem, now }) {
  const pc = !wsOpen ? 'down' : now - lastMsgAt < 1000 ? 'ok' : 'warn';
  const core = status?.core ? 'ok' : 'down';
  const tx = !status?.core || !status.serialOk ? 'down' : status.timingFrames > 0 ? 'ok' : 'warn';
  let drone = 'down';
  if (telem.link && now - telem.linkAt < LINK_STALE_MS && telem.link.upLq > 0) {
    drone = telem.link.upLq >= 70 ? 'ok' : 'warn';
  }
  return { pc, core, tx, drone };
}

export function stateLabel(status, wsOpen) {
  if (!wsOpen) return 'SIN CONEXIÓN';
  if (!status?.core) return 'NÚCLEO APAGADO';
  return STATE_TEXT[status.state] ?? status.state;
}

export function failsafeDetail(status) {
  if (status?.state !== 'FAILSAFE') return null;
  return REASON_TEXT[status.reason] ?? status.reason;
}

export const formatBattery = (b) => (b ? `${b.voltage.toFixed(1)} V · ${b.remainingPct} %` : '—');

export const formatLink = (l) => (l ? `LQ ${l.upLq} % · ${l.upRssi1} dBm · ${l.txPowerMw} mW` : '—');

export const formatMs = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
