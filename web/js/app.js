import { t, getLanguage, onLanguageChange, initLanguageUI } from './i18n.js';
// Pilot page: wires the pure modules to the DOM and the gateway WebSocket.
// ?observe in the URL opens a read-only view. Flying needs a pilot sign-in (or, with ?room=,
// the relay room's key): a signed-in page joins the gateway's queue. The queue head is the
// standby: if the pilot drops, the drone holds and the head chooses «Tomar el control» (from the
// drone's last command) or «Aterrizar»; the core decides, the page only asks.
import { Deadman, DEADMAN_TEXT } from './deadman.js';
import { HoldGesture, bindHold } from './hold.js';
import { canSwitchInput, channelsCommand, enteringFailsafe, inputsLocked, isTypingTarget, loadInputMode, lockedCommand, padPositions, readouts, saveInputMode, seedInputs } from './inputmode.js';
import { KEY_ACTIONS, KeyboardModel, MODE_KEYS } from './keyboard.js';
import { RATE_HZ, closeAction, connectionTarget, controlMessage, eventReaction, shouldReclaimPilotSeat, tsyncReply } from './protocol.js';
import { StepModel, capChangeAllowed } from './stepper.js';
import { Switches, SPEED_KEYS } from './switches.js';
import { fullscreenTip, takeControlSteps } from './fullscreen.js';
import { StickModel, bindStick, layoutAction, orientationLock, padsMoved, sticksToCommand } from './sticks.js';
import { LinkTracker, failsafeAlert, formatBattery, formatCmdAge, formatFlightMode, formatLink, formatMs, holdBanner, pilotLine, queueText, recoverySteps, reportsTurtle, segments, stateLabel } from './view.js';
import { keepPlaying } from './whep.js';
import { ControlTrace } from './controltrace.js';
import { VoiceCapture } from './voicecapture.js';
import { VoiceTrace } from './voicetrace.js';
import { VoiceController } from './voicecontroller.js';
import { VoiceManeuver } from './voicemaneuver.js';
import { voiceFeedback } from './voiceview.js';
import { FlightAnnouncer } from './announcer.js';

// Add ?measure to opt in. Export after a props-off bench run with controlLatency.download().
const controlTrace = new URLSearchParams(location.search).has('measure') ? new ControlTrace() : null;
if (controlTrace) window.controlLatency = controlTrace;
const voiceTrace = controlTrace ? new VoiceTrace() : null;
if (voiceTrace) window.voiceLatency = voiceTrace;

const $ = (id) => document.getElementById(id);
const wantRole = new URLSearchParams(location.search).has('observe') ? 'observer' : 'pilot';
const signInShown = wantRole === 'pilot' && !new URLSearchParams(location.search).has('room');
const tokenKey = (room) => `gcs-token-${room}`;
const getToken = (room) => {
  let token = sessionStorage.getItem(tokenKey(room));
  if (!token) {
    token = prompt(t('pilot.key.for.room', { room })) ?? '';
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

// Voice never sends commands from a recognition callback: apply runs only in the control tick.
const voiceLocal = wantRole === 'pilot' && !new URLSearchParams(location.search).has('room');
let voiceConfig = null;
let voicePrepared = false;
let voiceLoad = 0;
let statusAt = -Infinity;
const heldFlightKeys = new Set();
const heldFlightPointers = new Set();
let voicePreviousPhase = 'idle';
let voiceOwner = null;
const capture = new VoiceCapture();

// Spoken flight alerts: an observer of confirmed status/link state only. It never sends, and no
// failure of it may reach the control loop or rendering. Off on every load until a tap unlocks audio.
const announcer = new FlightAnnouncer({ onState: () => renderAnnouncer() });
announcer.setLanguage(getLanguage());
// Longer than the link-stale time (view.js): the gateway replays its last link telemetry to a new
// connection, which looks fresh for 2 s. Until then the radio is unknown, so it seeds silently.
const ANNOUNCE_SETTLE_MS = 2500;
let announceSettledAt = Infinity;
let clipsReady = null;   // {es, en} from the clip manifest; null = unknown (the enable probe decides)
let voiceDisplay = () => {};
function renderVoiceFeedback(state, previousPhase) {
  const feedback = voiceFeedback(state, {owner: voiceOwner, previousPhase, config: voiceConfig});
  $('voice-state').dataset.phase = feedback.phase;
  $('voice-state').title = feedback.title;
  $('voice-state').textContent = feedback.text;
  $('voice-transcript').textContent = feedback.transcript;
  $('voice-action').textContent = feedback.action;
}
function voiceNotice(key) {
  voiceDisplay = () => { $('voice-state').textContent = t(key); $('voice-state').title = ''; };
  voiceDisplay();
}
const voice = new VoiceController({ trace: voiceTrace, capture, maneuver: new VoiceManeuver(), onState: state => {
  announcer.setRecording(state.phase === 'recording');   // the microphone must not hear alerts
  if (state.phase === 'idle') voiceOwner = null;
  const previousPhase = voicePreviousPhase;
  voiceDisplay = () => renderVoiceFeedback(state, previousPhase);
  voiceDisplay();
  voicePreviousPhase = state.phase;
}});
function cancelVoice(reason,options) {
  const wasBusy = voice.busy;
  voice.cancel(reason,options);
  if (wasBusy) voiceNotice('voice.cancelled');
}
async function loadVoice() {
  const generation = ++voiceLoad;
  voiceConfig = null;
  voice.configure(null);
  if (!voiceLocal || role !== 'pilot') return;
  try {
    const response = await fetch('/voice/config');
    const config = response.ok ? await response.json() : null;
    if (generation !== voiceLoad || role !== 'pilot') return;
    voice.configure(config);
    voiceConfig = config;
  } catch { if (generation === voiceLoad) voice.configure(null); }
}
function voicePress(source) {
  if (voice.busy || !voiceLocal || !voicePrepared || !voiceConfig || role !== 'pilot' || !deadman.engaged || !wsOpen() || !document.hasFocus() || document.visibilityState !== 'visible') return;
  voiceOwner = source;
  voice.press();
  if (voice.phase === 'idle') voiceOwner = null;
}

const storage = () => { try { return window.localStorage; } catch { return null; } };

function gatewayError(message) {
  const key = {'send hello first': 'gateway.hello', 'only the next pilot can take control or land': 'gateway.next', 'observers cannot send commands': 'gateway.observer'}[message];
  return key ? t(key) : t('gateway.error', {message});
}

const wsOpen = () => ws?.readyState === WebSocket.OPEN;
const send = (msg) => {
  if (!wsOpen()) return;
  ws.send(JSON.stringify(msg));
  if (msg.t === 'ctl' && controlTrace) controlTrace.add(welcome?.session, msg);
};

function toast(text, persist = false, ms = 4000) {
  const el = $('toast');
  toast.display = typeof text === 'function' ? text : () => text;
  el.textContent = toast.display();
  el.hidden = false;
  clearTimeout(toast.timer);
  if (!persist) toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function connect() {
  const target = connectionTarget(location, wantRole, getToken);
  ws = new WebSocket(target.url);
  ws.onopen = () => {
    announceSettledAt = performance.now() + ANNOUNCE_SETTLE_MS;
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
    if (next.text) toast(() => closeAction(ev.code, target.room).text, next.retryMs === null);
    voice.setSession(null);
    ++voiceLoad;
    voiceConfig = null;
    role = null;
    welcome = null;
    queued = null;
    status = null;
    announceSettledAt = Infinity;
    announcer.reset();
    disengage('disconnected');
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
      statusAt = performance.now();
      if (prevState !== status.state) cancelVoice('state',{preserveReadiness:true});
      if (enteringFailsafe(prevState, status.state)) startAgainAfterFailsafe();
      voice.onReadiness(status.voice);
      links.update(status, performance.now());
      if (shouldReclaimPilotSeat(wantRole, welcome, status)) ws.close();   // reconnects with hello pilot
      if (lostPending) {               // this status names the pilot who took over
        lostPending = false;
        const lostStatus = status;
        toast(() => queueText({ role: 'queued', lost: true }, lostStatus));
        queued = { ...queued, lost: false };   // told once: from now on the usual queue text
      }
      announce(performance.now());
      break;
    }
    case 'voice_ready':
      if (voiceLocal && role === 'pilot' && msg.session === welcome?.session) voice.setSession(msg);
      break;
    case 'telem':
      if (typeof msg.flightMode === 'string') {
        if (telem.flightMode !== msg.flightMode) cancelVoice('flight_mode');
      }
      if (msg.link) telem.linkAt = performance.now();
      Object.assign(telem, msg);
      delete telem.t;
      break;
    case 'event':
      onEvent(msg);
      break;
    case 'tsync':
      send(tsyncReply(msg, performance.now()));
      break;
    case 'error':
      toast(() => gatewayError(msg.msg));
      break;
    default:
      break;
  }
}

/** Events: the hold, the take and the landing show in the banner and the state pill; only the
 *  recovery and the refusals need words. */
function onEvent(msg) {
  const r = eventReaction(msg, welcome?.session);
  if (!r) return;
  if (r.disengage) disengage('not_engaged');
  const session = welcome?.session;
  toast(() => eventReaction(msg, session).text);
}

function onWelcome(msg) {
  voice.setSession(null);
  welcome = msg;
  role = msg.role;
  loadVoice();
  // A pilot welcome (new connection, the core came back, or a takeover) starts a new session
  // in the hub with sequence 0: restart ours too.
  if (role === 'pilot') seq = 0;
  document.body.classList.toggle('observer', role !== 'pilot');
  document.body.classList.toggle('queued', role === 'queued');
  loginRequired = role === 'observer' && msg.reason === 'login_required';
  if (role === 'queued') {
    queued = msg;
    if (msg.lost) {                  // someone took over: back of the queue
      lostPending = true;            // toast once the status names the new pilot
      disengage('lost');
      releaseKeys();
      armHold.release();
      $('btn-arm').style.setProperty('--progress', 0);
    }
  } else {
    queued = null;
  }
  if (role === 'pilot' && msg.takeover) takeOver(msg.takeover);
  if (role === 'observer' && msg.reason === 'pilot_present') toast(() => t('a.pilot.is.already.connected.observer.mode'));
}

/** Promoted on a take: every input starts from the drone's last command (the throttle
 *  never jumps), with its flight mode and switches. The dead-man was engaged by
 *  «Tomar el control», so the next tick of the control loop sends. */
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

/** Every way of losing control goes through here. */
function disengage(reason,options) {
  cancelVoice(reason,options);
  deadman.disengage(reason);
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
function resetInputs(options) {
  cancelVoice('reset',options);
  left.reset();
  right.reset();
  keyboard.reset();
  stepper.reset();
}

/** The core entered FAILSAFE: everything starts again from zero, and the pilot takes control
 *  again before clearing it (inputmode.js). */
function startAgainAfterFailsafe() {
  resetInputs({preserveReadiness:true});
  switches.turtleOff();
  armKey.release();
  armHold.release();
  $('btn-arm').style.setProperty('--progress', 0);
  disengage('failsafe',{preserveReadiness:true});
}

// 50 Hz control loop. Nothing is queued while disconnected or disengaged. In FAILSAFE every
// input is held at neutral, throttle 0, whatever the pilot does.
setInterval(() => {
  const now = performance.now();
  checkPadLayout();
  const locked = inputsLocked(status);
  if (locked) resetInputs({preserveReadiness:true});
  lastCmd = locked ? lockedCommand(mode) : currentCommand(now - lastTick);
  lastTick = now;
  // Not tied to the role: a taker stays engaged and sends from its promotion on.
  const engaged = deadman.canSend({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    wsOpen: wsOpen(),
  });
  const overlay = voice.apply(lastCmd, {
    role, engaged, visible: document.visibilityState === 'visible', focused: document.hasFocus(), connected: wsOpen(),
    armed: !locked && status?.state === 'ARMED',
    mode: mode === 0 && !switches.turtle ? 'Normal' : null,
    voiceReady: status?.voice?.ready === true,
    voiceEpoch: status?.voice?.epoch,
    statusAt, heldManual: heldFlightKeys.size > 0 || heldFlightPointers.size > 0,
  });
  lastCmd = locked ? lockedCommand(mode) : overlay;
  if (engaged && role === 'pilot') send(controlMessage(++seq, performance.now(), lastCmd, switches.wire(locked)));
}, 1000 / RATE_HZ);

/** Changes how the pilot flies. Refused while armed; every input starts again from neutral
 *  with throttle at zero, and the pilot must take control again. */
function setInputMode(next, { save = true } = {}) {
  if (next !== inputMode && !canSwitchInput(status)) {
    toast(() => t('disarm.before.changing.input.mode'));
    return;
  }
  inputMode = next;
  resetInputs();
  switches.turtleOff();
  disengage('input');
  document.body.dataset.input = next;
  if (save) saveInputMode(storage(), next);
}

function setFlightMode(n) {
  cancelVoice('mode');
  mode = n;
  for (const o of document.querySelectorAll('[data-mode]')) o.classList.toggle('on', Number(o.dataset.mode) === n);
}

// Where the stick pads are while flying: if the layout moves them (browser bars come back,
// rotation, leaving full screen) the stick values under the fingers would jump.
const padBoxes = () => [$('stick-left'), $('stick-right')].map((p) => p.getBoundingClientRect());
let padsAtEngage = null;
let engagedAt = 0;
let fullscreenTipShown = false;   // once per visit

/** afterEngage runs as soon as the dead-man is engaged (the standby's `take`). */
async function takeControl(afterEngage = () => {}) {
  if (role !== 'pilot' && role !== 'queued') return;
  await takeControlSteps({
    goFullscreen: async () => {
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
        toast(() => fullscreenTip({canFullscreen: false, standalone: false}), false, 10000);                // two steps to read
      }
    },
    engage: () => {
      deadman.engage();
      engagedAt = performance.now();
      padsAtEngage = padBoxes();
    },
    afterEngage,
    keepAwake: async () => {
      try {
        wakeLock = await navigator.wakeLock?.request('screen');
      } catch { /* needs HTTPS; the screen may sleep, which disengages the dead-man */ }
    },
  });
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

function renderDisplay(updateInputs = true) {
  const now = performance.now();
  if (updateInputs) renderInput(now);
  $('voice-panel').hidden = voiceLocal && !voiceConfig;
  for (const id of ['btn-voice-prepare','btn-voice-ptt','btn-voice-cancel','voice-state','voice-transcript','voice-action']) $(id).hidden = !voiceLocal;
  $('voice-badge').hidden = !voiceConfig;
  $('voice-badge').textContent = voiceConfig?.execution === 'enabled' ? t('timed.movement') : t('simulation');
  $('btn-voice-prepare').disabled = !voiceLocal || role !== 'pilot' || !voiceConfig || status?.state !== 'DISARMED' || voice.busy;
  const recording = voice.phase === 'recording';
  const buttonRecording = recording && voiceOwner === 'button';
  $('btn-voice-ptt').disabled = !voiceLocal || role !== 'pilot' || !voiceConfig || !voicePrepared || (voice.busy && !buttonRecording);
  $('btn-voice-ptt').textContent = buttonRecording ? t('send') : recording ? t('recording.v') : voice.busy ? t('processing') : t('speak');
  $('btn-voice-ptt').setAttribute('aria-pressed', String(recording));
  const voiceHelp = buttonRecording ? t('send.recording') : recording ? t('recording.release.v.to.send') : voice.busy ? t('processing.voice.command') : t('tap.to.speak.tap.send.to.finish.with.keyboard.hold.v.and.release.to.send');
  $('btn-voice-ptt').setAttribute('aria-label', voiceHelp);
  $('btn-voice-ptt').title = voiceHelp;
  $('btn-voice-cancel').disabled = !voiceLocal;
  $('voice-unavailable').hidden = voiceLocal && !!voiceConfig;
  $('voice-unavailable').textContent = voiceLocal ? t('voice.unavailable.on.this.connection') : t('voice.unavailable.through.relay.or.observer');
  const seg = segments({ wsOpen: wsOpen(), lastMsgAt, status, links, telem, now });
  for (const [name, health] of Object.entries(seg)) $(`seg-${name}`).dataset.health = health;
  announce(now, seg);
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
  const waiting = role === 'queued';   // nothing to hold yet: the dead-man starts with «Tomar el control»
  $('deadman').textContent = deadman.engaged || waiting ? '' : DEADMAN_TEXT[deadman.reason] ?? '';
  $('btn-take').disabled = role !== 'pilot' || deadman.engaged;
  $('standby').hidden = role !== 'queued';
  if (queued) $('queue-text').textContent = queueText(queued, status);
  const hold = holdBanner(status, { role, standby: queued?.standby === true });
  $('hold-banner').hidden = hold === null;
  if (hold !== null) {
    $('hold-text').textContent = hold.text;
    $('btn-hold-take').hidden = !hold.take;
    $('btn-hold-land').hidden = !hold.land;
  }
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
}

function render() { renderDisplay(); requestAnimationFrame(render); }

/** The radio as the link segment confirms it. 'down' needs evidence: the TX module is talking
 *  and link telemetry was seen but stopped or reports no uplink, or the core failed safe for
 *  rf_lost. Anything else (no TX, never any telemetry, just reconnected) is 'unknown'. */
function announcedRadio(seg, now) {
  if (now < announceSettledAt) return 'unknown';
  if (seg.drone === 'ok' || seg.drone === 'warn') return 'up';
  if (status?.state === 'FAILSAFE' && status.reason === 'rf_lost') return 'down';
  if (seg.tx === 'ok' && telem.link) return 'down';
  return 'unknown';
}

/** Feeds the announcer at the status and render cadence (repeats are no-ops). HOLD and LANDING
 *  keep ARM high in crsf-core (safety.h), so for the spoken state they are still armed. */
function announce(now, seg = segments({ wsOpen: wsOpen(), lastMsgAt, status, links, telem, now })) {
  try {
    const state = status?.state === 'HOLD' || status?.state === 'LANDING' ? 'ARMED' : status?.state;
    announcer.update({ connected: wsOpen(), coreFresh: seg.core === 'ok', state, reason: status?.reason, radio: announcedRadio(seg, now) });
  } catch { /* alerts are optional: never into status handling or rendering */ }
}

function renderAnnouncer() {
  const state = announcer.enabled ? 'on' : announcer.error === 'audio_blocked' ? 'blocked' : announcer.error ? 'unavailable' : 'off';
  const help = t({ on: 'announce.on', blocked: 'announce.blocked', unavailable: 'announce.unavailable',
    off: announcer.preferred ? 'announce.resume' : 'announce.off' }[state]);
  const button = $('btn-announce');
  button.dataset.state = state;
  button.setAttribute('aria-pressed', String(announcer.enabled));
  button.title = help;
  button.firstElementChild.textContent = t(state === 'blocked' || state === 'unavailable' ? 'announce.noaudio' : 'announce.label');
  $('announce-status').textContent = help;
}

/** Which languages have a complete clip pack. Old deployments without a manifest stay unknown. */
async function loadClipManifest() {
  try {
    const response = await fetch('/audio/announcements/manifest.json');
    if (!response.ok) return;
    const manifest = await response.json();
    const ready = (language) => manifest.available === true || ['armed', 'disarmed', 'signal_lost', 'signal_restored', 'failsafe']
      .every((event) => manifest.clips?.some((c) => c.language === language && c.event === event && c.available === true));
    clipsReady = { es: ready('es'), en: ready('en') };
  } catch { /* unknown: the enable probe still finds missing clips */ }
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
    ? t('no.pilot.accounts.yet.create.them.on.the.pi.with.users.cli.js.see.docs.handoff.md')
    : loginRequired && me === null ? t('sign.in.to.fly') : '';
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

const LOGIN_ERRORS = { 401: 'incorrect.name.or.password', 429: 'too.many.attempts.wait.one.minute' };
let loginError = '';
function renderLoginError() { $('login-msg').textContent = loginError ? t(loginError) : ''; }

/** Signed in: the WebSocket reconnects, since the gateway reads the cookie at the upgrade. */
async function login(ev) {
  ev.preventDefault();
  const name = $('login-name').value.trim().toLowerCase();
  let res;
  try {
    res = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: $('login-password').value }) });
  } catch {
    loginError = 'no.connection.to.pi'; renderLoginError();
    return;
  }
  if (!res.ok) {
    loginError = LOGIN_ERRORS[res.status] ?? 'server.error'; renderLoginError();
    return;
  }
  $('login-password').value = '';
  loginError = ''; renderLoginError();
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

// enable() must start inside the tap: browsers only unlock audio from a user gesture.
$('btn-announce').addEventListener('click', (ev) => {
  ev.currentTarget.blur();   // never keeps focus: Space/Enter stay with the flight keys
  if (announcer.enabled) announcer.mute();
  else if (clipsReady && !clipsReady[getLanguage()]) announcer.fail();   // reports audio_unavailable, plays nothing
  else announcer.enable();
});

$('btn-voice-prepare').addEventListener('click', async () => {
  if (!voiceConfig || role !== 'pilot' || status?.state !== 'DISARMED') return;
  try { await capture.prepare(); voicePrepared = true; voiceNotice('microphone.ready.tap.speak.or.hold.v'); }
  catch { voicePrepared = false; voiceNotice('microphone.unavailable.or.format.unsupported'); }
});
$('btn-voice-cancel').addEventListener('click', () => { cancelVoice('local'); voiceNotice('cancelled'); });
const ptt = $('btn-voice-ptt');
ptt.addEventListener('click', () => {
  if (voice.phase === 'recording' && voiceOwner === 'button') voice.release();
  else if (!voice.busy) voicePress('button');
});
// Capture deliberate intent before any flight listener changes its model or starts a ramp.
const flightSelector = '#stick-left, #stick-right, #btn-arm, #btn-ack, #btn-take, #btn-hold-take, #btn-disarm, #btn-failsafe, #btn-hold-land, #btn-neutral, #btn-turtle, [data-mode], [data-speed], button[data-input], [data-step], [data-intensity], [data-cap], [data-key-cap], #panel-step .axis';
for (const type of ['pointerdown','click','input','change']) document.addEventListener(type, ev => {
  if (!(ev.target instanceof Element) || !ev.target.closest(flightSelector)) return;
  cancelVoice('manual');
  if (type === 'pointerdown') heldFlightPointers.add(ev.pointerId);
}, true);
for (const type of ['pointerup','pointercancel','lostpointercapture']) document.addEventListener(type, ev => heldFlightPointers.delete(ev.pointerId), true);
const flightCodes = new Set(['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyT', ...Object.keys(SPEED_KEYS), ...Object.keys(KEY_ACTIONS), ...Object.keys(MODE_KEYS)]);
document.addEventListener('keydown', ev => {
  if (typing(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.code === 'KeyC') { ev.preventDefault(); cancelVoice('local'); voiceNotice('cancelled'); return; }
  if (ev.code === 'KeyV') { if (ev.shiftKey) return; ev.preventDefault(); if (!ev.repeat) voicePress('key'); return; }
  if (role === 'pilot' && flightCodes.has(ev.code)) { heldFlightKeys.add(ev.code); cancelVoice('manual'); }
}, true);
document.addEventListener('keyup', ev => {
  heldFlightKeys.delete(ev.code);
  if (ev.code === 'KeyV' && voiceOwner === 'key') voice.release();
}, true);
bindStick($('stick-left'), left);
bindStick($('stick-right'), right);
const armHold = bindHold($('btn-arm'), 1000, () => send({ t: 'arm' }));
bindHold($('btn-ack'), 2000, () => send({ t: 'ack' }));
$('btn-take').addEventListener('click', () => takeControl());
// The take goes out once the dead-man is engaged, without waiting for the wake lock: the new
// pilot's first command follows it.
$('btn-hold-take').addEventListener('click', () => takeControl(() => send({ t: 'take' })));
$('btn-hold-land').addEventListener('click', () => send({ t: 'land' }));
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
      else toast(() => t('disarm.to.raise.the.throttle.limit'));
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
    if (applied !== null && axis === 'throttle' && typed > applied) toast(() => t('throttle.limit.cap', { cap: stepper.cap / 10 }));
    input.value = String(stepper.target[axis] / 10);
  });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
}

// Keyboard: flight keys in the keyboard mode (held) and the step mode (one step per press); action keys (disarm, failsafe, arm, release,
// flight mode) in every mode. Never while typing a value.
const armKey = new HoldGesture(1000, () => send({ t: 'arm' }));
const typing = (ev) => ev.target instanceof Element && isTypingTarget(ev.target);
document.addEventListener('keydown', (ev) => {
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
  else if (action === 'release') disengage('released');
  else if (action === 'arm') armKey.press(performance.now());
});
document.addEventListener('keyup', (ev) => {
  keyboard.keyUp(ev.code);
  if (ev.code === 'KeyR') armKey.release();
  if (ev.code === 'Space' && !typing(ev)) ev.preventDefault();
});
const releaseKeys = () => {
  heldFlightKeys.clear();
  heldFlightPointers.clear();
  keyboard.releaseAll();
  armKey.release();
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    disengage('hidden');
    releaseKeys();
  }
});
window.addEventListener('blur', () => {
  disengage('blur');
  releaseKeys();
});
// Esc in full screen is taken by the browser (it leaves full screen and the page never sees
// the key): outside the touch mode, leaving full screen therefore also releases control.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && inputMode !== 'touch') disengage('released');
});
// Check on each control tick too: content/font changes can move pads without a window event.
function checkPadLayout() {
  if (!padsAtEngage || inputMode !== 'touch' || !deadman.engaged) return;
  const boxes = padBoxes();
  const action = layoutAction({ engaged: deadman.engaged, msSinceEngage: performance.now() - engagedAt,
    moved: padsMoved(padsAtEngage, boxes) });
  if (action === 'resnapshot') padsAtEngage = boxes;
  else if (action === 'disengage') disengage('layout');
}
for (const type of ['resize', 'orientationchange', 'fullscreenchange']) window.addEventListener(type, checkPadLayout);

initLanguageUI(document);
onLanguageChange((language) => {
  try {
    announcer.setLanguage(language);   // stops old-language speech; the current state is not replayed
    if (announcer.enabled && clipsReady && !clipsReady[language]) announcer.fail();
  } catch { /* alerts are optional */ }
  renderAnnouncer();
  voiceDisplay();
  renderLoginError();
  if (!$('toast').hidden && toast.display) $('toast').textContent = toast.display();
  renderDisplay(false);
  // Existing pad-layout safety remains active if translated text causes real reflow.
});

renderAnnouncer();
loadClipManifest();
setInputMode(loadInputMode(storage(), matchMedia('(pointer: coarse)').matches), { save: false });
connect();
// Video stays on the local network (charter: no video over the internet).
if (!connectionTarget(location, wantRole, () => '').relay) keepPlaying($('video'));
requestAnimationFrame(render);
