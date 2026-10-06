// Video quality from RTCPeerConnection.getStats(), recorded for criterion C4
// (>= 2 viewers, >= 5 minutes, no dropped frames or freezes).
export function videoStats(report) {
  for (const s of report) {
    if (s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video') {
      return {
        framesReceived: s.framesReceived ?? 0,
        framesDecoded: s.framesDecoded ?? 0,
        framesDropped: s.framesDropped ?? 0,
        freezeCount: s.freezeCount ?? 0,
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
  'packetsLost', 'fps', 'jitterBufferMs', 'width', 'height'];

export class StatsLog {
  constructor() {
    this.rows = [];
  }

  add(tMs, stats) {
    if (stats) this.rows.push({ t: tMs, ...stats });
  }

  /** Changes between the first and last sample, and the C4 verdict for this viewer. */
  summary(minSeconds = 300) {
    if (this.rows.length < 2) return null;
    const a = this.rows[0];
    const b = this.rows.at(-1);
    const s = {
      seconds: (b.t - a.t) / 1000,
      framesDecoded: b.framesDecoded - a.framesDecoded,
      framesDropped: b.framesDropped - a.framesDropped,
      freezes: b.freezeCount - a.freezeCount,
      packetsLost: b.packetsLost - a.packetsLost,
    };
    s.pass = s.seconds >= minSeconds && s.framesDecoded > 0 && s.framesDropped === 0 && s.freezes === 0;
    return s;
  }

  toCsv() {
    const lines = [COLUMNS.join(',')];
    for (const r of this.rows) lines.push(COLUMNS.map((c) => r[c] ?? '').join(','));
    return `${lines.join('\n')}\n`;
  }
}
