const COOLDOWN_MS = 3000;
const STATES = new Set(['ARMED', 'DISARMED', 'FAILSAFE']);
const urgent = event => event === 'signal_lost' || event === 'failsafe';
const clip = (language, event) => `/audio/announcements/${language}/${event}.mp3`;

// Browser-only observer: no requests, commands, timers or queued announcements.
export class FlightAnnouncer {
  constructor({audioFactory = url => new Audio(url), now = () => performance.now(), onState = () => {}, storage} = {}) {
    Object.assign(this, {audioFactory, now, onState});
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; } catch {}
    try { this.preferred = this.storage?.getItem('gcs.announcements') === 'true'; } catch { this.preferred = false; }
    this.language = 'en';
    this.enabled = false;
    this.blocked = false;
    this.error = null;
    this.recording = false;
    this.generation = 0;
    this.lastPlayed = new Map();
    this.state = this.radio = null;
    this.emit();
  }
  emit() {
    // A rendering callback must never throw into telemetry/control processing.
    try { this.onState({enabled:this.enabled, blocked:this.blocked, error:this.error}); } catch {}
  }
  remember(value) {
    this.preferred = value;
    try { this.storage?.setItem('gcs.announcements', String(value)); } catch {}
  }
  stop() {
    ++this.generation;
    this.playing = null;
    if (!this.audio) return;
    this.audio.onended = this.audio.onerror = null;
    try { this.audio.pause(); this.audio.currentTime = 0; } catch {}
  }
  setLanguage(language) {
    if (!['es','en'].includes(language) || language === this.language) return;
    this.stop();
    this.language = language;
    this.emit();
  }
  async enable() {
    if (this.recording) return false;
    this.stop();
    this.enabled = false;
    this.blocked = false;
    this.error = null;
    const generation = this.generation;
    try {
      // A real, muted clip both unlocks this element and detects missing assets.
      this.audio ??= this.audioFactory(clip(this.language, 'armed'));
      this.audio.src = clip(this.language, 'armed');
      this.audio.muted = true;
      await this.audio.play();
      if (generation !== this.generation) return false;
      this.stop();
      this.audio.muted = false;
      this.enabled = true;
      this.remember(true);
      this.emit();
      return true;
    } catch (error) {
      if (generation === this.generation) this.fail(error);
      return false;
    }
  }
  fail(error) {
    this.stop();
    this.enabled = false;
    this.blocked = error?.name === 'NotAllowedError';
    this.error = this.blocked ? 'audio_blocked' : 'audio_unavailable';
    this.emit();
  }
  mute() {
    this.stop();
    this.enabled = false;
    this.blocked = false;
    this.error = null;
    this.remember(false);
    this.emit();
  }
  setRecording(recording) {
    if (this.recording === Boolean(recording)) return;
    this.recording = Boolean(recording);
    this.stop();
    this.emit();
  }
  reset() {
    this.stop();
    this.state = this.radio = null;
  }
  update({connected, coreFresh, state, reason, radio} = {}) {
    if (!connected || !coreFresh) { this.reset(); return; }
    const nextState = STATES.has(state) ? state : null;
    const nextRadio = radio === 'up' || radio === 'down' ? radio : null;
    const stateChanged = this.state !== null && nextState !== null && this.state !== nextState;
    const radioChanged = this.radio !== null && nextRadio !== null && this.radio !== nextRadio;
    const lost = radioChanged && nextRadio === 'down';
    const failsafe = stateChanged && nextState === 'FAILSAFE';
    let event;
    if (lost && failsafe && reason === 'rf_lost') event = 'signal_lost';
    else if (failsafe) event = 'failsafe';
    else if (lost) event = 'signal_lost';
    else if (stateChanged) event = nextState === 'ARMED' ? 'armed' : 'disarmed';
    else if (radioChanged) event = 'signal_restored';
    // Always consume telemetry while muted/recording: obsolete events cannot return.
    this.state = nextState;
    this.radio = nextRadio;
    if (!this.enabled || this.recording || !event) return;
    const at = this.now(), previous = this.lastPlayed.get(event);
    if (previous !== undefined && at - previous < COOLDOWN_MS) return;
    if (this.playing && (!urgent(event) || urgent(this.playing))) return;
    this.play(event, at);
  }
  play(event, at) {
    this.stop();
    const generation = this.generation;
    this.playing = event;
    this.lastPlayed.set(event, at); // At most five event keys, regardless of flight length.
    try {
      this.audio.src = clip(this.language, event);
      this.audio.volume = 1;
      this.audio.onended = () => { if (generation === this.generation) this.stop(); };
      this.audio.onerror = () => { if (generation === this.generation) this.fail(); };
      Promise.resolve(this.audio.play()).catch(error => {
        if (generation === this.generation) this.fail(error);
      });
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
}
