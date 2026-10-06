// Pilot page: wires the pure modules to the DOM and the gateway WebSocket.
// ?observe in the URL opens a read-only view.
import { Deadman, DEADMAN_TEXT } from './deadman.js';
import { bindHold } from './hold.js';
import { REFUSAL_TEXT, RATE_HZ, controlMessage, helloMessage, shouldReclaimPilotSeat, tsyncReply } from './protocol.js';
import { StickModel, bindStick, padsMoved, sticksToCommand } from './sticks.js';
import { LinkTracker, failsafeDetail, formatBattery, formatLink, formatMs, segments, stateLabel } from './view.js';

const $ = (id) => document.getElementById(id);
const wantRole = new URLSearchParams(location.search).has('observe') ? 'observer' : 'pilot';

const left = new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } }); // throttle starts at 0
const right = new StickModel();
const deadman = new Deadman();
const links = new LinkTracker();
const telem = { link: null, linkAt: 0, battery: null, flightMode: null, device: null };
let ws = null;
let role = null;
let status = null;
let seq = 0;
let mode = 0;
let lastMsgAt = 0;
let wakeLock = null;

const wsOpen = () => ws?.readyState === WebSocket.OPEN;
const send = (msg) => { if (wsOpen()) ws.send(JSON.stringify(msg)); };

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    seq = 0;                       // a new connection is a new session: never resend old commands
    send(helloMessage(wantRole));
  };
  ws.onmessage = (ev) => {
    lastMsgAt = performance.now();
    handle(JSON.parse(ev.data));
  };
  ws.onclose = () => {
    role = null;
    status = null;
    deadman.disengage('disconnected');
    setTimeout(connect, 1000);
  };
}

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      role = msg.role;
      document.body.classList.toggle('observer', role !== 'pilot');
      if (wantRole === 'pilot' && role !== 'pilot') toast('Ya hay un piloto conectado: modo observador');
      break;
    case 'status':
      status = msg;
      links.update(status, performance.now());
      if (shouldReclaimPilotSeat(wantRole, role, status)) ws.close();   // reconnects with hello pilot
      break;
    case 'telem':
      if (msg.link) telem.linkAt = performance.now();
      Object.assign(telem, msg);
      delete telem.t;
      break;
    case 'event':
      toast(REFUSAL_TEXT[msg.refused] ?? `${msg.what}: ${msg.refused}`);
      break;
    case 'tsync':
      send(tsyncReply(msg, performance.now()));
      break;
    case 'error':
      toast(msg.msg);
      break;
    default:
      break;
  }
}

// 50 Hz control loop. Nothing is queued while disconnected or disengaged.
setInterval(() => {
  const canSend = deadman.canSend({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    wsOpen: wsOpen() && role === 'pilot',
  });
  if (canSend) send(controlMessage(++seq, performance.now(), sticksToCommand(left, right, mode)));
}, 1000 / RATE_HZ);

// Where the stick pads are while flying: if the layout moves them (browser bars come back,
// rotation, leaving full screen) the stick values under the fingers would jump.
const padBoxes = () => [$('stick-left'), $('stick-right')].map((p) => p.getBoundingClientRect());
let padsAtEngage = null;

async function takeControl() {
  if (role !== 'pilot') return;
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.('landscape');
  } catch { /* not supported (desktop browsers): fine */ }
  deadman.engage();                // after the layout settled in full screen
  padsAtEngage = padBoxes();
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* needs HTTPS; the screen may sleep, which disengages the dead-man */ }
}

function render() {
  const now = performance.now();
  const seg = segments({ wsOpen: wsOpen(), lastMsgAt, status, links, telem, now });
  for (const [name, health] of Object.entries(seg)) $(`seg-${name}`).dataset.health = health;
  $('state').textContent = stateLabel(status, wsOpen(), seg.core === 'ok' || !status?.core);
  $('state').dataset.state = status?.state ?? 'none';
  $('t-battery').textContent = formatBattery(telem.battery);
  $('t-link').textContent = formatLink(telem.link);
  $('t-mode').textContent = telem.flightMode ?? '—';
  $('t-rtt').textContent = formatMs(status?.rttMs);
  $('t-age').textContent = formatMs(status?.cmdAgeMs);
  $('deadman').textContent = deadman.engaged ? '' : DEADMAN_TEXT[deadman.reason] ?? '';
  $('btn-take').disabled = role !== 'pilot' || deadman.engaged;
  const detail = failsafeDetail(status);
  $('banner').hidden = detail === null;
  if (detail !== null) $('banner-detail').textContent = detail;
  requestAnimationFrame(render);
}

bindStick($('stick-left'), left);
bindStick($('stick-right'), right);
bindHold($('btn-arm'), 1000, () => send({ t: 'arm' }));
bindHold($('btn-ack'), 2000, () => send({ t: 'ack' }));
$('btn-take').addEventListener('click', takeControl);
$('btn-disarm').addEventListener('click', () => send({ t: 'disarm' }));
$('btn-failsafe').addEventListener('click', () => send({ t: 'failsafe' }));
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => {
    mode = Number(b.dataset.mode);
    for (const o of document.querySelectorAll('[data-mode]')) o.classList.toggle('on', o === b);
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') deadman.disengage('hidden');
});
window.addEventListener('blur', () => deadman.disengage('blur'));
for (const type of ['resize', 'orientationchange', 'fullscreenchange']) {
  window.addEventListener(type, () => {
    if (deadman.engaged && padsAtEngage && padsMoved(padsAtEngage, padBoxes())) deadman.disengage('layout');
  });
}

connect();
requestAnimationFrame(render);
