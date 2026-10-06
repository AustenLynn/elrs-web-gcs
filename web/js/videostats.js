// Video quality from RTCPeerConnection.getStats(), recorded for criterion C4
// (>= 2 viewers, >= 5 minutes, no dropped frames or freezes).
export function videoStats(report) {
  for (const s of report) {
    if (s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video') {
      return {
        framesReceived: s.framesReceived ?? 0,
        framesDecoded: s.framesDecoded ?? 0,
        framesDropped: s.framesDropped ?? null,     // null = this browser does not report it
        freezeCount: s.freezeCount ?? null,
        freezeSeconds: s.totalFreezesDuration ?? 0,
        packetsLost: s.packetsLost ?? 0,
        fps: s.framesPerSecond ?? 0,
        jitterBufferMs: s.jitterBufferEmittedCount ? (1000 * s.jitterBufferDelay) / s.jitterBufferEmittedCount : null,
        width: s.frameWidth ?? 0,
        height: s.frameHeight ?? 0,
      };
    }
  }
  return null;
}

const COLUMNS = ['t', 'framesReceived', 'framesDecoded', 'framesDropped', 'freezeCount', 'freezeSeconds',
  'packetsLost', 'fps', 'jitterBufferMs', 'width', 'height', 'session'];
const MAX_GAP_MS = 2000;          // samples come every second
const MAX_STALL_MS = 2000;        // no new decoded frame for longer than this is a failure

export class StatsLog {
  constructor() {
    this.rows = [];
  }

  /** session: identifies the RTCPeerConnection the stats came from (a reconnect makes a
   *  new one whose counters start again from zero). */
  add(tMs, stats, session = 0) {
    if (stats) this.rows.push({ t: tMs, ...stats, session });
  }

  /** Changes between the first and last sample, everything that makes the run invalid,
   *  and the C4 verdict for this viewer. */
  summary(minSeconds = 300) {
    if (this.rows.length < 2) return null;
    const a = this.rows[0];
    const b = this.rows.at(-1);
    const problems = [];
    let lastNewFrame = a.t;
    for (let i = 1; i < this.rows.length; i++) {
      const p = this.rows[i - 1];
      const r = this.rows[i];
      if (r.session !== p.session || r.framesDecoded < p.framesDecoded) problems.push(`reconnect at ${Math.round(r.t / 1000)} s`);
      if (r.t - p.t > MAX_GAP_MS) problems.push(`gap of ${Math.round((r.t - p.t) / 1000)} s without samples`);
      if (r.framesDecoded > p.framesDecoded) lastNewFrame = r.t;
      else if (r.t - lastNewFrame > MAX_STALL_MS && !problems.some((x) => x.startsWith('no new frames'))) {
        problems.push(`no new frames from ${Math.round(lastNewFrame / 1000)} s`);
      }
    }
    if (this.rows.some((r) => r.freezeCount === null || r.framesDropped === null)) {
      problems.push('freeze or drop counters unknown in this browser');
    }
    const s = {
      seconds: (b.t - a.t) / 1000,
      framesDecoded: b.framesDecoded - a.framesDecoded,
      framesDropped: b.framesDropped - a.framesDropped,
      freezes: b.freezeCount - a.freezeCount,
      packetsLost: b.packetsLost - a.packetsLost,
      problems,
    };
    s.pass = problems.length === 0 && s.seconds >= minSeconds && s.framesDecoded > 0 &&
      s.framesDropped === 0 && s.freezes === 0;
    return s;
  }

  toCsv() {
    const lines = [COLUMNS.join(',')];
    for (const r of this.rows) lines.push(COLUMNS.map((c) => r[c] ?? '').join(','));
    return `${lines.join('\n')}\n`;
  }
}
