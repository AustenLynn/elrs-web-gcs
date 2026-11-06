// Spectator page: full-screen video plus the C4 recorder (5-minute stats log as CSV).
import { StatsLog, videoStats } from './videostats.js';
import { keepPlaying } from './whep.js';

const $ = (id) => document.getElementById(id);
const RECORD_SECONDS = 310;  // leave up to 10 s to start the second client's recorder
const MIN_SECONDS = 300;
const player = keepPlaying($('video'), { onState: (s) => { $('v-state').textContent = s; } });
let log = null;
let recording = false;

$('v-record').addEventListener('click', () => {
  log = new StatsLog();
  recording = true;
  $('v-record').disabled = true;
  $('v-download').disabled = true;
  $('v-result').textContent = 'grabando…';
});

$('v-download').addEventListener('click', () => {
  const blob = new Blob([log.toCsv()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `c4-video-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Each RTCPeerConnection gets a number, so the recorder can tell a reconnect apart.
const sessions = new WeakMap();
let nextSession = 1;
const sessionOf = (pc) => {
  if (!sessions.has(pc)) sessions.set(pc, nextSession++);
  return sessions.get(pc);
};

setInterval(async () => {
  const pc = player.pc;
  if (!pc) return;
  const stats = videoStats((await pc.getStats()).values());
  if (!stats) return;
  $('v-stats').textContent = `${stats.width}×${stats.height} ${Math.round(stats.fps)} fps · ` +
    `perdidos ${stats.framesDropped ?? '?'} · congelados ${stats.freezeCount ?? '?'}`;
  if (log && recording) {
    log.add(performance.now(), stats, sessionOf(pc), Date.now());
    if (log.rows.at(-1).t - log.rows[0].t >= RECORD_SECONDS * 1000) {
      recording = false;
      const s = log.summary(MIN_SECONDS);
      $('v-result').textContent = `${s.pass ? 'PASA' : 'NO PASA'}: ${Math.round(s.seconds)} s, ` +
        `${(s.framesDecoded / s.seconds).toFixed(1)} fps promedio, ${s.framesDecoded} cuadros, ${s.framesDropped} perdidos, ${s.freezes} congelamientos, ${s.packetsLost} paquetes perdidos` +
        (s.problems.length ? ` · ${s.problems.join('; ')}` : '');
      $('v-record').disabled = false;
      $('v-download').disabled = false;
    }
  }
}, 1000);
