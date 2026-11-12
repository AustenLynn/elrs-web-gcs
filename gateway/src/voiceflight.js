// Flight mode is confirmed event state, not a heartbeat. Only RF and core status
// have a freshness deadline. A gap invalidates before a new receipt can hide it.
const FRESH_MS = 500;
const normal = text => typeof text === 'string' && /^[SMF]-NORMAL$/.test(text);
const fresh = (now, at) => Number.isFinite(now) && Number.isFinite(at) && now-at >= 0 && now-at < FRESH_MS;
const operational = status => status?.state==='DISARMED' || status?.state==='ARMED';
const positiveLink = link => Number.isFinite(link?.upLq) && link.upLq > 0 && link.upLq <= 100;

export class VoiceFlightState {
  constructor({now = () => performance.now()} = {}) { this.now=now;this.reset(); }
  reset() {
    this.status=null;this.statusAt=null;this.link=null;this.linkAt=null;
    this.mode=null;this.target=null;this.confirmed=false;this.interrupted=false;
  }
  #invalidate() { this.confirmed=false;this.interrupted=true; }
  #checkGaps(now) {
    if (!Number.isFinite(now) || (this.statusAt!==null && !fresh(now,this.statusAt)) ||
        (this.linkAt!==null && !fresh(now,this.linkAt))) this.#invalidate();
  }
  onStatus(status) {
    const now=this.now();this.#checkGaps(now);
    const previous=this.status;
    if (previous && (previous.out?.mode!==status?.out?.mode ||
        previous.out?.turtle!==status?.out?.turtle)) this.#invalidate();
    if (!operational(status)) this.#invalidate();
    this.status=status;this.statusAt=now;
    // The first snapshot seeds the requested target until an accepted pilot control.
    if (this.target===null) this.target={mode:status?.out?.mode,turtle:status?.out?.turtle};
  }
  onLink(link) {
    const now=this.now();this.#checkGaps(now);
    this.link=link;this.linkAt=now;
    if (!positiveLink(link)) this.#invalidate();
  }
  onMode(text) {
    const now=this.now();this.#checkGaps(now);this.mode=text;
    if (!normal(text)) {this.#invalidate();return;}
    const targetNormal=this.target===null || (this.target.mode===0 && this.target.turtle===0);
    const outputNormal=this.status===null || (this.status.out?.mode===0 && this.status.out?.turtle===0);
    // On initial connection either receipt order is valid. After an interruption,
    // confirmation must follow recovered live RF/status; recovery alone cannot do it.
    const recovered=!this.interrupted || (fresh(now,this.statusAt) && fresh(now,this.linkAt) && positiveLink(this.link));
    this.confirmed=Number.isFinite(now) && targetNormal && outputNormal && recovered && (this.status===null || operational(this.status));
  }
  onControl({mode,turtle}) {
    this.#checkGaps(this.now());
    if (this.target && (this.target.mode!==mode || this.target.turtle!==turtle)) this.#invalidate();
    this.target={mode,turtle};
  }
  readiness(session) {
    const now=this.now();this.#checkGaps(now);
    let reason='ready';
    if (!this.status || !fresh(now,this.statusAt)) reason='core_stale';
    else if (!Number.isInteger(session) || session<=0 || this.status.session!==session) reason='pilot_mismatch';
    else if (!operational(this.status)) reason='unsafe_state';
    else if (this.status.state==='DISARMED') reason='not_armed';
    else if (this.status.out?.turtle!==0 || this.target?.turtle!==0) reason='turtle_active';
    else if (this.status.out?.mode!==0 || this.target?.mode!==0 || !normal(this.mode)) reason='not_normal';
    else if (!fresh(now,this.linkAt)) reason='link_stale';
    else if (!positiveLink(this.link)) reason='link_lost';
    else if (!this.confirmed) reason='normal_unconfirmed';
    return {ready:reason==='ready',reason};
  }
}
