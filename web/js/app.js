// Pilot page: wires the pure modules to the DOM and the gateway WebSocket.
// ?observe in the URL opens a read-only view.
import { Deadman, DEADMAN_TEXT } from './deadman.js';
import { HoldGesture, bindHold } from './hold.js';
import { canSwitchInput, loadInputMode, padPositions, readouts, saveInputMode } from './inputmode.js';
import { KEY_ACTIONS, KeyboardModel, MODE_KEYS } from './keyboard.js';
import { REFUSAL_TEXT, RATE_HZ, closeAction, connectionTarget, controlMessage, shouldReclaimPilotSeat, tsyncReply } from './protocol.js';
import { StepModel, capChangeAllowed } from './stepper.js';
import { StickModel, bindStick, layoutAction, orientationLock, padsMoved, sticksToCommand } from './sticks.js';
import { LinkTracker, failsafeAlert, formatBattery, formatCmdAge, formatFlightMode, formatLink, formatMs, recoverySteps, segments, stateLabel } from './view.js';
import { keepPlaying } from './whep.js';

const $ = (id) => document.getElementById(id);
const wantRole = new URLSearchParams(location.search).has('observe') ? 'observer' : 'pilot';
const tokenKey = (room) => `gcs-token-${room}`;
const getToken = (room) => {
  let token = sessionStorage.getItem(tokenKey(room));
  if (!token) {
    token = prompt(`Clave de piloto para «${room}»`) ?? '';
    if (token) sessionStorage.setItem(tokenKey(room), token);
  }
  return token;
};

const left = new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } }); // throttle starts at 0
const right = new StickModel();
const keyboard = new KeyboardModel();
const stepper = new StepModel();
const deadman = new Deadman();
const links = new LinkTracker();
// Throttle-limit buttons of the step and keyboard modes: [selector, dataset key, model].
const CAP_CONTROLS = [['[data-cap]', 'cap', stepper], ['[data-key-cap]', 'keyCap', keyboard]];
const telem = { link: null, linkAt: 0, battery: null, flightMode: null, device: null };
let ws = null;
let role = null;
let status = null;
let seq = 0;
let mode = 0;
let lastMsgAt = 0;
let wakeLock = null;
let inputMode = 'touch';
let lastTick = performance.now();
let lastCmd = sticksToCommand(left, right, mode);

const storage = () => { try { return window.localStorage; } catch { return null; } };

const wsOpen = () => ws?.readyState === WebSocket.OPEN;
const send = (msg) => { if (wsOpen()) ws.send(JSON.stringify(msg)); };

function toast(text, persist = false) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  if (!persist) toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function connect() {
  const target = connectionTarget(location, wantRole, getToken);
  ws = new WebSocket(target.url);
  ws.onopen = () => {
    seq = 0;                       // a new connection is a new session: never resend old commands
    send(target.hello);
  };
  ws.onmessage = (ev) => {
    lastMsgAt = performance.now();
    handle(JSON.parse(ev.data));
  };
  ws.onclose = (ev) => {
    const next = closeAction(ev.code, target.room);
    if (next.clearToken) sessionStorage.removeItem(tokenKey(target.room));   // asked again after a reload
    if (next.text) toast(next.text, next.retryMs === null);
    role = null;
    status = null;
    deadman.disengage('disconnected');
    if (next.retryMs !== null) setTimeout(connect, next.retryMs);
  };
}

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      role = msg.role;
      // A pilot welcome (new connection, or the core came back) starts a new session in the
      // hub with sequence 0: restart ours too.
      if (role === 'pilot') seq = 0;
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

/** The command from whichever input mode is active; dtMs advances the keyboard and step ramps. */
function currentCommand(dtMs) {
  if (inputMode === 'keyboard') {
    keyboard.update(dtMs);
    return keyboard.command(mode);
  }
  if (inputMode === 'step') {
    stepper.update(dtMs);
    return stepper.command(mode);
  }
  return sticksToCommand(left, right, mode);
}

// 50 Hz control loop. Nothing is queued while disconnected or disengaged.
setInterval(() => {
  const now = performance.now();
  lastCmd = currentCommand(now - lastTick);
  lastTick = now;
  const canSend = deadman.canSend({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    wsOpen: wsOpen() && role === 'pilot',
  });
  if (canSend) send(controlMessage(++seq, now, lastCmd));
}, 1000 / RATE_HZ);

/** Changes how the pilot flies. Refused while armed; every input starts again from neutral
 *  with throttle at zero, and the pilot must take control again. */
function setInputMode(next, { save = true } = {}) {
  if (next !== inputMode && !canSwitchInput(status)) {
    toast('Desarma antes de cambiar el modo de control');
    return;
  }
  inputMode = next;
  left.reset();
  right.reset();
  keyboard.reset();
  stepper.reset();
  deadman.disengage('input');
  document.body.dataset.input = next;
  if (save) saveInputMode(storage(), next);
}

function setFlightMode(n) {
  mode = n;
  for (const o of document.querySelectorAll('[data-mode]')) o.classList.toggle('on', Number(o.dataset.mode) === n);
}

// Where the stick pads are while flying: if the layout moves them (browser bars come back,
// rotation, leaving full screen) the stick values under the fingers would jump.
const padBoxes = () => [$('stick-left'), $('stick-right')].map((p) => p.getBoundingClientRect());
let padsAtEngage = null;
let engagedAt = 0;

async function takeControl() {
  if (role !== 'pilot') return;
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.(orientationLock(screen.orientation.type));
  } catch { /* not supported (desktop browsers): fine */ }
  deadman.engage();
  engagedAt = performance.now();
  padsAtEngage = padBoxes();
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* needs HTTPS; the screen may sleep, which disengages the dead-man */ }
}

const markOn = (selector, isOn) => {
  for (const b of document.querySelectorAll(selector)) b.classList.toggle('on', isOn(b));
};
let armKeyShown = false;

function renderInput(now) {
  const pilot = wantRole === 'pilot' && role !== 'observer';
  $('panel-step').hidden = !(pilot && inputMode === 'step');
  $('panel-keys').hidden = !(pilot && inputMode === 'keyboard');
  for (const b of document.querySelectorAll('[data-input]')) {
    b.classList.toggle('on', b.dataset.input === inputMode);
    b.disabled = b.dataset.input !== inputMode && !canSwitchInput(status);
  }
  markOn('[data-step]', (b) => Number(b.dataset.step) === stepper.step);
  markOn('[data-intensity]', (b) => Number(b.dataset.intensity) === keyboard.intensity);
  for (const [selector, attr, model] of CAP_CONTROLS) {
    for (const b of document.querySelectorAll(selector)) {
      const cap = Number(b.dataset[attr]);
      b.classList.toggle('on', cap === model.cap);
      b.disabled = !capChangeAllowed(model.cap, cap, status);
    }
  }
  for (const row of document.querySelectorAll('#panel-step .axis')) {
    const input = row.querySelector('input');
    const shown = String(stepper.target[row.dataset.axis] / 10);
    if (document.activeElement !== input && input.value !== shown) input.value = shown;
  }
  // The pads show what is on the air in every mode (touch: the sticks themselves).
  const cmd = inputMode === 'touch' ? sticksToCommand(left, right, mode) : lastCmd;
  const pos = padPositions(cmd);
  const text = readouts(cmd);
  for (const side of ['left', 'right']) {
    const knob = $(`stick-${side}`).querySelector('.knob');
    knob.style.setProperty('--x', pos[side].x);
    knob.style.setProperty('--y', pos[side].y);
    $(`ro-${side}`).textContent = text[side];
  }
  const p = armKey.update(now);
  if (p > 0 || armKeyShown) $('btn-arm').style.setProperty('--progress', p);
  armKeyShown = p > 0;
}

let recoveryKey = '';

/** The recovery checklist, rebuilt only when a step changes. */
function renderRecovery(steps) {
  const key = steps.map((st) => `${st.state}${st.next ? '>' : ''}${st.text}`).join('|');
  if (key === recoveryKey) return;
  recoveryKey = key;
  $('recovery').replaceChildren(...steps.map((st) => {
    const li = document.createElement('li');
    li.dataset.state = st.state;
    li.classList.toggle('next', st.next);
    li.textContent = st.text;
    return li;
  }));
}

function render() {
  const now = performance.now();
  renderInput(now);
  const seg = segments({ wsOpen: wsOpen(), lastMsgAt, status, links, telem, now });
  for (const [name, health] of Object.entries(seg)) $(`seg-${name}`).dataset.health = health;
  $('state').textContent = stateLabel(status, wsOpen(), seg.core === 'ok' || !status?.core);
  $('state').dataset.state = status?.state ?? 'none';
  $('t-battery').textContent = formatBattery(telem.battery);
  $('t-link').textContent = formatLink(telem.link);
  $('t-mode').textContent = formatFlightMode(telem.flightMode);
  // Values from the drone are its last known ones once its link is down: shown dimmed.
  for (const id of ['t-battery', 't-link', 't-mode']) $(id).dataset.stale = String(seg.drone === 'down');
  document.body.dataset.state = status?.state ?? 'none';
  $('t-rtt').textContent = formatMs(status?.rttMs);
  $('t-age').textContent = formatMs(status?.cmdAgeMs);
  $('deadman').textContent = deadman.engaged ? '' : DEADMAN_TEXT[deadman.reason] ?? '';
  $('btn-take').disabled = role !== 'pilot' || deadman.engaged;
  const alert = failsafeAlert(status);
  $('banner').hidden = alert === null;
  if (alert !== null) {
    $('banner-title').textContent = alert.title;
    $('banner-detail').textContent = alert.detail;
    $('banner-age').textContent = formatCmdAge(status.cmdAgeMs);
    renderRecovery(recoverySteps({ status, engaged: deadman.engaged, cmd: lastCmd }));
  }
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
  b.addEventListener('click', () => setFlightMode(Number(b.dataset.mode)));
}

// Input modes and the step panel.
for (const b of document.querySelectorAll('[data-input]')) b.addEventListener('click', () => setInputMode(b.dataset.input));
for (const b of document.querySelectorAll('[data-step]')) b.addEventListener('click', () => stepper.setStep(Number(b.dataset.step)));
for (const b of document.querySelectorAll('[data-intensity]')) {
  b.addEventListener('click', () => { keyboard.intensity = Number(b.dataset.intensity); });
}
// Throttle limits (step and keyboard modes): lower at any time, raise only while not armed.
for (const [selector, attr, model] of CAP_CONTROLS) {
  for (const b of document.querySelectorAll(selector)) {
    b.addEventListener('click', () => {
      const next = Number(b.dataset[attr]);
      if (capChangeAllowed(model.cap, next, status)) model.setCap(next);
      else toast('Desarma para subir el límite del acelerador');
    });
  }
}
$('btn-neutral').addEventListener('click', () => stepper.neutral());
for (const row of document.querySelectorAll('#panel-step .axis')) {
  const axis = row.dataset.axis;
  const input = row.querySelector('input');
  for (const b of row.querySelectorAll('[data-nudge]')) b.addEventListener('click', () => stepper.nudge(axis, Number(b.dataset.nudge)));
  input.addEventListener('change', () => {
    if (input.value.trim() === '') return;          // left empty: keep the current value
    const typed = Number(input.value) * 10;
    const applied = stepper.set(axis, typed);
    if (applied !== null && axis === 'throttle' && typed > applied) toast(`Límite del acelerador: ${stepper.cap / 10} %`);
    input.value = String(stepper.target[axis] / 10);
  });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
}

// Keyboard: flight keys in the keyboard mode; action keys (disarm, failsafe, arm, release,
// flight mode) in every mode. Never while typing a value.
const armKey = new HoldGesture(1000, () => send({ t: 'arm' }));
const typing = (ev) => ev.target instanceof Element && ev.target.matches('input, textarea, select');
document.addEventListener('keydown', (ev) => {
  if (role !== 'pilot' || typing(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (inputMode === 'keyboard' && keyboard.keyDown(ev.code)) {
    ev.preventDefault();                             // arrows must not scroll the page
    return;
  }
  const action = KEY_ACTIONS[ev.code];
  const flightMode = MODE_KEYS[ev.code];
  if (action === undefined && flightMode === undefined) return;
  ev.preventDefault();                               // Space must not also press a focused button
  if (ev.repeat) return;
  if (flightMode !== undefined) setFlightMode(flightMode);
  else if (action === 'disarm') send({ t: 'disarm' });
  else if (action === 'failsafe') send({ t: 'failsafe' });
  else if (action === 'release') deadman.disengage('released');
  else if (action === 'arm') armKey.press(performance.now());
});
document.addEventListener('keyup', (ev) => {
  keyboard.keyUp(ev.code);
  if (ev.code === 'KeyR') armKey.release();
  if (ev.code === 'Space' && !typing(ev)) ev.preventDefault();
});
const releaseKeys = () => {
  keyboard.releaseAll();
  armKey.release();
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    deadman.disengage('hidden');
    releaseKeys();
  }
});
window.addEventListener('blur', () => {
  deadman.disengage('blur');
  releaseKeys();
});
// Esc in full screen is taken by the browser (it leaves full screen and the page never sees
// the key): outside the touch mode, leaving full screen therefore also releases control.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && inputMode !== 'touch') deadman.disengage('released');
});
for (const type of ['resize', 'orientationchange', 'fullscreenchange']) {
  window.addEventListener(type, () => {
    // Only the touch sticks sit under the pilot's fingers; other modes do not care where the pads are.
    if (!padsAtEngage || inputMode !== 'touch') return;
    const boxes = padBoxes();
    const action = layoutAction({ engaged: deadman.engaged, msSinceEngage: performance.now() - engagedAt,
      moved: padsMoved(padsAtEngage, boxes) });
    if (action === 'resnapshot') padsAtEngage = boxes;
    else if (action === 'disengage') deadman.disengage('layout');
  });
}

setInputMode(loadInputMode(storage(), matchMedia('(pointer: coarse)').matches), { save: false });
connect();
// Video stays on the local network (charter: no video over the internet).
if (!connectionTarget(location, wantRole, () => '').relay) keepPlaying($('video'));
requestAnimationFrame(render);
