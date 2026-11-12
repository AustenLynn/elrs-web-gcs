import { t, onLanguageChange, initLanguageUI } from './i18n.js';
// Spectator page: full-screen video plus the C4 recorder (5-minute stats log as CSV).
import { StatsLog, videoStats } from './videostats.js';
import { keepPlaying } from './whep.js';

const $ = (id) => document.getElementById(id);
const RECORD_SECONDS = 310;  // leave up to 10 s to start the second client's recorder
const MIN_SECONDS = 300;
let videoState = 'connecting';
let latestStats = null;
let result = null;
initLanguageUI(document);
let log = null;
let recording = false;
const player = keepPlaying($('video'), { onState: (state) => { videoState = state; render(); } });

$('v-record').addEventListener('click', () => {
  log = new StatsLog();
  recording = true;
  $('v-record').disabled = true;
  $('v-download').disabled = true;
  result = null;
  render();
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
  latestStats = stats;
  render();
  if (log && recording) {
    log.add(performance.now(), stats, sessionOf(pc), Date.now());
    if (log.rows.at(-1).t - log.rows[0].t >= RECORD_SECONDS * 1000) {
      recording = false;
      result = log.summary(MIN_SECONDS);
      render();
      $('v-record').disabled = false;
      $('v-download').disabled = false;
    }
  }
}, 1000);

function problemText(problem) {
  let match;
  if ((match = /^reconnect at (\d+) s$/.exec(problem))) return t('watch.problem.reconnect', {seconds:match[1]});
  if ((match = /^gap of (\d+) s without samples$/.exec(problem))) return t('watch.problem.gap', {seconds:match[1]});
  if ((match = /^no new frames from (\d+) s$/.exec(problem))) return t('watch.problem.stalled', {seconds:match[1]});
  return t({'freeze or drop counters unknown in this browser':'watch.problem.counters','average decoded fps below 25':'watch.problem.fps','received resolution is not 1280x720 throughout':'watch.problem.resolution'}[problem] ?? problem);
}
function render() {
  $('v-state').textContent = t(`video.${videoState}`);
  if (latestStats) $('v-stats').textContent = t('watch.stats', {width:latestStats.width,height:latestStats.height,fps:Math.round(latestStats.fps),dropped:latestStats.framesDropped ?? '?',freezes:latestStats.freezeCount ?? '?'});
  $('v-result').textContent = recording ? t('watch.recording') : result ? t('watch.summary', {
    verdict:t(result.pass?'watch.pass':'watch.fail'), seconds:Math.round(result.seconds),fps:(result.framesDecoded/result.seconds).toFixed(1),frames:result.framesDecoded,dropped:result.framesDropped,freezes:result.freezes,packets:result.packetsLost,
  }) + (result.problems.length ? ` · ${result.problems.map(problemText).join('; ')}` : '') : '';
}
onLanguageChange(render);
render();
