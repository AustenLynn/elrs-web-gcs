const COOLDOWN_MS = 3000;
const STALLED_MS = 8000;   // a clip that never fires ended/error stops counting as playing
const STATES = new Set(['ARMED', 'DISARMED', 'FAILSAFE']);
const urgent = event => event === 'signal_lost' || event === 'failsafe';
const clip = (language, event) => `/audio/announcements/${language}/${event}.mp3`;

// Browser-only observer: no requests, commands, timers or queued announcements.
// this.state/this.radio are what the pilot last heard (or the silent baseline); this.current is
// the confirmed telemetry. Whenever they differ and speech is allowed, the current value is
// spoken once: a change during a clip, or inside its cooldown, waits for it instead of being
// dropped, so the last thing heard for each dimension always converges on the confirmed state.
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
    this.state = this.radio = this.current = null;
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
    // Missing clips belong to the old language; a browser block does not depend on it.
    if (this.error === 'audio_unavailable') this.error = null;
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
    this.state = this.radio = this.current = null;
  }
  update({connected, coreFresh, state, reason, radio} = {}) {
    if (!connected || !coreFresh) { this.reset(); return; }
    const nextState = STATES.has(state) ? state : null;
    const nextRadio = radio === 'up' || radio === 'down' ? radio : null;
    this.current = {state: nextState, radio: nextRadio, reason};
    // Unknown values reseed: the next confirmed value is a silent baseline, never an event.
    if (nextState === null || this.state === null) this.state = nextState;
    if (nextRadio === null || this.radio === null) this.radio = nextRadio;
    this.speak();
  }
  speak() {
    if (!this.current) return;
    const {state, radio, reason} = this.current;
    // Always consume telemetry while muted/recording: obsolete events cannot return.
    if (!this.enabled || this.recording) { this.state = state; this.radio = radio; return; }
    const at = this.now();
    if (this.playing && at - this.startedAt > STALLED_MS) this.stop();
    const stateChanged = this.state !== null && state !== null && this.state !== state;
    const radioChanged = this.radio !== null && radio !== null && this.radio !== radio;
    const lost = radioChanged && radio === 'down';
    const failsafe = stateChanged && state === 'FAILSAFE';
    // Candidates by priority, each with the dimensions it tells the pilot about.
    const candidates = [];
    if (lost && failsafe && reason === 'rf_lost') candidates.push(['signal_lost', true, true]);
    if (failsafe) candidates.push(['failsafe', true, false]);
    if (lost) candidates.push(['signal_lost', false, true]);
    if (stateChanged && !failsafe) candidates.push([state === 'ARMED' ? 'armed' : 'disarmed', true, false]);
    if (radioChanged && !lost) candidates.push(['signal_restored', false, true]);
    for (const [event, saysState, saysRadio] of candidates) {
      // A change that cannot be spoken yet stays pending: the next update or clip end retries it.
      if (this.playing && (!urgent(event) || urgent(this.playing))) continue;
      const previous = this.lastPlayed.get(event);
      if (previous !== undefined && at - previous < COOLDOWN_MS) continue;
      if (saysState) this.state = state;
      if (saysRadio) this.radio = radio;
      this.play(event, at);
      return;
    }
  }
  play(event, at) {
    this.stop();
    const generation = this.generation;
    this.playing = event;
    this.startedAt = at;
    this.lastPlayed.set(event, at); // At most five event keys, regardless of flight length.
    try {
      this.audio.src = clip(this.language, event);
      this.audio.volume = 1;
      this.audio.muted = false;
      this.audio.onended = () => { if (generation === this.generation) { this.stop(); this.speak(); } };
      this.audio.onerror = () => { if (generation === this.generation) this.fail(); };
      Promise.resolve(this.audio.play()).catch(error => {
        if (generation === this.generation) this.fail(error);
      });
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
}
