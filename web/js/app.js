// Pilot page: wires the pure modules to the DOM and the gateway WebSocket.
// ?observe in the URL opens a read-only view. Flying needs a pilot sign-in (or, with ?room=,
// the relay room's key): a signed-in page joins the gateway's queue, becomes the standby once
// the pilot presses «Listo», and takes over from the drone's last command on a handover.
import { Deadman, DEADMAN_TEXT } from './deadman.js';
import { HoldGesture, bindHold } from './hold.js';
import { canSwitchInput, channelsCommand, enteringFailsafe, inputsLocked, loadInputMode, lockedCommand, padPositions, readouts, saveInputMode, seedInputs } from './inputmode.js';
import { KEY_ACTIONS, KeyboardModel, MODE_KEYS } from './keyboard.js';
import { REFUSAL_TEXT, RATE_HZ, closeAction, connectionTarget, controlMessage, shouldReclaimPilotSeat, tsyncReply } from './protocol.js';
import { StepModel, capChangeAllowed } from './stepper.js';
import { Switches } from './switches.js';
import { fullscreenTip } from './fullscreen.js';
import { StickModel, bindStick, layoutAction, orientationLock, padsMoved, sticksToCommand } from './sticks.js';
import { LinkTracker, failsafeAlert, formatBattery, formatCmdAge, formatFlightMode, formatLink, formatMs, pilotLine, queueText, recoverySteps, reportsTurtle, segments, stateLabel } from './view.js';
import { keepPlaying } from './whep.js';

const $ = (id) => document.getElementById(id);
const wantRole = new URLSearchParams(location.search).has('observe') ? 'observer' : 'pilot';
const signInShown = wantRole === 'pilot' && !new URLSearchParams(location.search).has('room');
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
let role = null;      // 'pilot' | 'queued' | 'observer', from the last welcome
let welcome = null;
let queued = null;    // the last queued welcome: {position, lost}
let readySent = false;
let lostPending = false;
let me = null;        // the signed-in pilot ({name, admin}), from GET /me
let noUsers = false;
let loginRequired = false;
let status = null;
let seq = 0;
let mode = 0;
const switches = new Switches();   // speed (CH7) and turtle (CH8)
let lastMsgAt = 0;
let wakeLock = null;
let inputMode = 'touch';
let lastTick = performance.now();
let lastCmd = sticksToCommand(left, right, mode);

const storage = () => { try { return window.localStorage; } catch { return null; } };

const wsOpen = () => ws?.readyState === WebSocket.OPEN;
const send = (msg) => { if (wsOpen()) ws.send(JSON.stringify(msg)); };

function toast(text, persist = false, ms = 4000) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  if (!persist) toast.timer = setTimeout(() => { el.hidden = true; }, ms);
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
    welcome = null;
    queued = null;
    readySent = false;
    status = null;
    deadman.disengage('disconnected');
    if (next.retryMs !== null) setTimeout(connect, next.retryMs);
  };
}

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      onWelcome(msg);
      break;
    case 'status': {
      const prevState = status?.state;
      status = msg;
      if (enteringFailsafe(prevState, status.state)) startAgainAfterFailsafe();
      links.update(status, performance.now());
      if (shouldReclaimPilotSeat(wantRole, welcome, status)) ws.close();   // reconnects with hello pilot
      if (lostPending) {               // this status names the pilot who took over
        lostPending = false;
        toast(queueText({ role: 'queued', lost: true }, status));
      }
      break;
    }
    case 'telem':
      if (msg.link) telem.linkAt = performance.now();
      Object.assign(telem, msg);
      delete telem.t;
      break;
    case 'event':
      if (msg.what === 'handover') break;   // the welcomes and the status line tell it
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

function onWelcome(msg) {
  welcome = msg;
  role = msg.role;
  // A pilot welcome (new connection, the core came back, or a takeover) starts a new session
  // in the hub with sequence 0: restart ours too.
  if (role === 'pilot') seq = 0;
  if (role !== 'queued') readySent = false;    // the gateway forgets "ready" off the queue
  document.body.classList.toggle('observer', role !== 'pilot');
  document.body.classList.toggle('queued', role === 'queued');
  loginRequired = role === 'observer' && msg.reason === 'login_required';
  if (role === 'queued') {
    queued = msg;
    if (msg.lost) {                  // the standby took over: back of the queue, not ready
      readySent = false;
      lostPending = true;            // toast once the status names the new pilot
      deadman.disengage('lost');
      releaseKeys();
      armHold.release();
      $('btn-arm').style.setProperty('--progress', 0);
    }
  } else {
    queued = null;
  }
  if (role === 'pilot' && msg.takeover) takeOver(msg.takeover);
  if (role === 'observer' && msg.reason === 'pilot_present') toast('Ya hay un piloto conectado: modo observador');
}

/** Promoted on a handover: every input starts from the drone's last command (the throttle
 *  never jumps), with its flight mode and switches. The dead-man is still engaged from
 *  «Listo», so the next tick of the control loop sends. */
function takeOver(last) {
  seedInputs({ left, right, keyboard, stepper }, last);
  setFlightMode(last.m);
  switches.setSpeed(last.sp);
  if (switches.turtle !== (last.tu === 1)) switches.toggleTurtle();
  $('takeover').hidden = false;
  clearTimeout(takeOver.timer);
  takeOver.timer = setTimeout(() => { $('takeover').hidden = true; }, 3000);
  navigator.vibrate?.(300);
}

/** Queued: the gateway registers this page as the standby only while it is ready (dead-man
 *  engaged), and is told at once when it stops being ready. */
function setReady(on) {
  if (role !== 'queued' || on === readySent) return;
  readySent = on;
  send({ t: 'ready', on });
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

/** Every input back to neutral with the throttle at zero, no finger or key held. */
function resetInputs() {
  left.reset();
  right.reset();
  keyboard.reset();
  stepper.reset();
}

/** The core entered FAILSAFE: everything starts again from zero, and the pilot takes control
 *  again before clearing it (inputmode.js). */
function startAgainAfterFailsafe() {
  resetInputs();
  switches.turtleOff();
  armKey.release();
  armHold.release();
  $('btn-arm').style.setProperty('--progress', 0);
  deadman.disengage('failsafe');
}

// 50 Hz control loop. Nothing is queued while disconnected or disengaged. In FAILSAFE every
// input is held at neutral, throttle 0, whatever the pilot does.
setInterval(() => {
  const now = performance.now();
  const locked = inputsLocked(status);
  if (locked) resetInputs();
  lastCmd = locked ? lockedCommand(mode) : currentCommand(now - lastTick);
  lastTick = now;
  // Not tied to the role: a ready standby stays engaged and sends from its promotion on.
  const engaged = deadman.canSend({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    wsOpen: wsOpen(),
  });
  if (role === 'queued') setReady(engaged);
  if (engaged && role === 'pilot') send(controlMessage(++seq, now, lastCmd, switches.wire(locked)));
}, 1000 / RATE_HZ);

/** Changes how the pilot flies. Refused while armed; every input starts again from neutral
 *  with throttle at zero, and the pilot must take control again. */
function setInputMode(next, { save = true } = {}) {
  if (next !== inputMode && !canSwitchInput(status)) {
    toast('Desarma antes de cambiar el modo de control');
    return;
  }
  inputMode = next;
  resetInputs();
  switches.turtleOff();
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
let fullscreenTipShown = false;   // once per visit

async function takeControl() {
  if (role !== 'pilot' && role !== 'queued') return;
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.(orientationLock(screen.orientation.type));
  } catch { /* not supported (desktop browsers): fine */ }
  const tip = fullscreenTip({
    canFullscreen: typeof document.documentElement.requestFullscreen === 'function',
    standalone: navigator.standalone === true || matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches,
  });
  if (tip && !fullscreenTipShown) {
    fullscreenTipShown = true;
    toast(tip, false, 10000);                // two steps to read
  }
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
  markOn('[data-speed]', (b) => Number(b.dataset.speed) === switches.speed);
  $('btn-turtle').classList.toggle('on', switches.turtle);
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
  // The pads show what is on the air in every mode (touch: the sticks themselves); a page
  // that is not flying shows the drone's channels.
  const onAir = role === 'pilot' ? null : channelsCommand(status?.channels, mode);
  const cmd = onAir ?? (inputMode === 'touch' && !inputsLocked(status) ? sticksToCommand(left, right, mode) : lastCmd);
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
  $('t-mode').dataset.turtle = String(reportsTurtle(telem.flightMode));
  // Values from the drone are its last known ones once its link is down: shown dimmed.
  for (const id of ['t-battery', 't-link', 't-mode']) $(id).dataset.stale = String(seg.drone === 'down');
  document.body.dataset.state = status?.state ?? 'none';
  $('t-rtt').textContent = formatMs(status?.rttMs);
  $('t-age').textContent = formatMs(status?.cmdAgeMs);
  const waiting = role === 'queued' && deadman.reason === 'not_engaged';   // «Listo» is right there
  $('deadman').textContent = deadman.engaged || waiting ? '' : DEADMAN_TEXT[deadman.reason] ?? '';
  $('btn-take').disabled = role !== 'pilot' || deadman.engaged;
  $('standby').hidden = role !== 'queued';
  if (queued) $('queue-text').textContent = queueText(queued, status);
  $('btn-ready').disabled = role !== 'queued' || deadman.engaged;
  $('pilots').textContent = status ? pilotLine(status) : '';
  renderAuth();
  const alert = failsafeAlert(status);
  $('banner').hidden = alert === null;
  if (alert !== null) {
    $('banner-title').textContent = alert.title;
    $('banner-detail').textContent = alert.detail;
    $('banner-age').textContent = formatCmdAge(status.cmdAgeMs);
    renderRecovery(recoverySteps({ status, engaged: deadman.engaged }));
  }
  requestAnimationFrame(render);
}

function renderAuth() {
  if (!signInShown) return;
  $('auth').hidden = false;
  $('btn-login').hidden = me !== null || noUsers;
  $('auth-name').hidden = me === null;
  $('auth-name').textContent = me?.name ?? '';
  $('btn-logout').hidden = me === null;
  $('btn-logout').disabled = role === 'pilot' && status?.state === 'ARMED';   // disarm first
  $('auth-msg').textContent = noUsers && me === null
    ? 'Todavía no hay cuentas de piloto: créalas en la Pi con users-cli.js (ver docs/HANDOFF.md)'
    : loginRequired && me === null ? 'Inicia sesión para pilotar' : '';
}

/** Who is signed in (the cookie is HttpOnly: only the gateway can tell). */
async function loadMe() {
  try {
    const res = await fetch('/me');
    const data = await res.json().catch(() => ({}));
    me = res.ok ? data : null;
    noUsers = !res.ok && data.noUsers === true;
  } catch { /* gateway unreachable: the connection segment shows it */ }
}

const LOGIN_ERRORS = { 401: 'Nombre o contraseña incorrectos', 429: 'Demasiados intentos: espera un minuto' };

/** Signed in: the WebSocket reconnects, since the gateway reads the cookie at the upgrade. */
async function login(ev) {
  ev.preventDefault();
  const name = $('login-name').value.trim().toLowerCase();
  let res;
  try {
    res = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: $('login-password').value }) });
  } catch {
    $('login-msg').textContent = 'Sin conexión con la Pi';
    return;
  }
  if (!res.ok) {
    $('login-msg').textContent = LOGIN_ERRORS[res.status] ?? 'Error del servidor';
    return;
  }
  $('login-password').value = '';
  $('login-msg').textContent = '';
  $('login').hidden = true;
  await loadMe();
  ws?.close();                       // reconnects with hello pilot and the cookie
}

async function logout() {
  try {
    await fetch('/logout', { method: 'POST' });
  } catch { /* the cookie ends with the gateway anyway */ }
  me = null;
  await loadMe();
  ws?.close();                       // reconnects as a spectator
}

if (signInShown) {
  $('btn-login').addEventListener('click', () => {
    $('login').hidden = false;
    $('login-name').focus();
  });
  $('login-cancel').addEventListener('click', () => { $('login').hidden = true; });
  $('login').addEventListener('submit', login);
  $('btn-logout').addEventListener('click', logout);
  loadMe();
}

bindStick($('stick-left'), left);
bindStick($('stick-right'), right);
const armHold = bindHold($('btn-arm'), 1000, () => send({ t: 'arm' }));
bindHold($('btn-ack'), 2000, () => send({ t: 'ack' }));
$('btn-take').addEventListener('click', takeControl);
$('btn-ready').addEventListener('click', async () => {
  await takeControl();
  if (deadman.engaged) setReady(true);
});
$('btn-disarm').addEventListener('click', () => send({ t: 'disarm' }));
$('btn-failsafe').addEventListener('click', () => send({ t: 'failsafe' }));
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => setFlightMode(Number(b.dataset.mode)));
}
for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => switches.setSpeed(Number(b.dataset.speed)));
}
$('btn-turtle').addEventListener('click', () => switches.toggleTurtle());

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

// Keyboard: flight keys in the keyboard mode (held) and the step mode (one step per press); action keys (disarm, failsafe, arm, release,
// flight mode) in every mode. Never while typing a value.
const armKey = new HoldGesture(1000, () => send({ t: 'arm' }));
const typing = (ev) => ev.target instanceof Element && ev.target.matches('input, textarea, select');
document.addEventListener('keydown', (ev) => {
  if (role === 'queued' && ev.code === 'Escape' && !typing(ev)) {   // a ready standby lets go
    deadman.disengage('released');
    return;
  }
  if (role !== 'pilot' || typing(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if ((inputMode === 'keyboard' && keyboard.keyDown(ev.code, ev.repeat))
    || (inputMode === 'step' && stepper.keyDown(ev.code, ev.repeat, ev.shiftKey))) {
    ev.preventDefault();                             // arrows must not scroll the page
    return;
  }
  if (switches.keyDown(ev.code, ev.repeat)) {        // T turtle, 4/5/6 speed: every input mode
    ev.preventDefault();
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
