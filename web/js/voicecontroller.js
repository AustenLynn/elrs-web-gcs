import { CHOICES, validatePresets } from './voicemaneuver.js';
const LIMITS = Object.freeze({recordingMs:5000,uploadBytes:524288,uploadMs:6000,processingMs:5000,resultMs:6000,statusMs:500});
const REASONS = new Set(['ready','core_stale','pilot_mismatch','not_armed','unsafe_state','not_normal','turtle_active','link_stale','link_lost','normal_unconfirmed']);
const neutral = manual => ['roll','pitch','yaw'].every(axis => manual[axis] === 0);

export class VoiceController {
  constructor({capture,maneuver,fetchImpl=(...args)=>globalThis.fetch(...args),now=()=>performance.now(),onState=()=>{},trace=null}) {
    Object.assign(this,{capture,maneuver,fetchImpl,now,onState,trace});
    this.generation=0;
    this.phase='idle';
    this.config=null;
    this.session=null;
    this.pending=null;
    const captureState = capture.onState;
    capture.onState = state => {
      captureState?.call(capture, state);
      if (state.error && ['recording','processing'].includes(this.phase)) {
        this.cancel('capture');
        this.emit('idle', state.error);
      }
    };
  }
  emit(phase,error=null,extra={}) { this.phase=phase;this.error=error;this.reason=extra.reason??null; this.onState({phase,error,transcript:this.transcript||'',choice:this.choice||'none',...extra}); }
  onReadiness(readiness) {
    if (this.phase!=='idle' || this.error!=='not_ready') return;
    if (readiness?.ready===true) {this.emit('idle');return;}
    const reason=REASONS.has(readiness?.reason) && readiness.reason!=='ready' ? readiness.reason : null;
    if (reason!==this.reason) this.emit('idle','not_ready',{reason});
  }
  configure(config) {
    if (config !== null) {
      validatePresets(config);
      if (!['enabled','dry-run'].includes(config.execution)) throw new TypeError('invalid_config');
      if (config.limits && Object.keys(LIMITS).some(k=>config.limits[k]!==LIMITS[k])) throw new TypeError('invalid_config');
    }
    this.cancel('configured');
    this.config=config ? {...validatePresets(config),execution:config.execution,limits:LIMITS} : null;
    if (this.config) this.maneuver.configure(this.config);
  }
  setSession(value) {
    if (value?.session===this.session?.session && value?.capability===this.session?.capability) return;
    this.cancel('session_changed');
    this.session=value?.session && value?.capability ? {...value} : null;
  }
  get busy() { return this.phase !== 'idle' || this.maneuver.busy; }
  async press() {
    if (!this.config || !this.session || this.busy) return;
    const generation=++this.generation;
    this.transcript=''; this.choice='none';
    this.emit('recording');
    try { await this.capture.press(); }
    catch (error) { if (generation===this.generation) this.emit('idle',error.message==='unsupported_codec'?'unsupported_codec':'capture_failed'); }
  }
  async release() {
    if (this.phase!=='recording') return;
    const generation=this.generation, session={...this.session}, releasedAt=this.now();
    this.trace?.record('release');
    this.emit('processing');
    let timer;
    try {
      const recording=await this.capture.release();
      if (generation!==this.generation) return;
      if (!recording || recording.audio.size>LIMITS.uploadBytes) { this.emit('idle','recording_discarded'); return; }
      const requestId=crypto.randomUUID();
      const abort=new AbortController(); this.abort=abort;
      timer=setTimeout(()=>{if(generation===this.generation){this.cancel('timeout');this.emit('idle','timeout');}},LIMITS.resultMs);
      this.trace?.record('recognition_start');
      const response=await this.fetchImpl('/voice/command',{method:'POST',headers:{'Content-Type':recording.mime,'X-Voice-Request':requestId,'X-Voice-Session':session.session,'X-Voice-Capability':session.capability},body:recording.audio,signal:abort.signal});
      const data=await response.json();
      if (generation!==this.generation || session.session!==this.session?.session || session.capability!==this.session?.capability) return;
      if (!response.ok) {this.emit('idle',typeof data.error==='string' && /^[a-z_]{1,64}$/.test(data.error)?data.error:'request_failed',{reason:REASONS.has(data.reason)?data.reason:null});return;}
      if (this.now()-releasedAt>=LIMITS.resultMs) {this.emit('idle','stale_result');return;}
      if (data.requestId!==requestId || data.session!==session.session || !CHOICES.includes(data.choice) || typeof data.transcript!=='string' || data.transcript.length>1000) {this.emit('idle','invalid_result');return;}
      this.trace?.record('transcription',{durationMs:data.timing?.transcriptionMs});
      this.trace?.record('decision',{durationMs:data.timing?.decisionMs});
      this.trace?.record('recognition_end');
      this.choice=data.choice;this.transcript=data.transcript;
      this.pending={choice:data.choice,releasedAt,generation};
      this.emit('ready');
    } catch { if(generation===this.generation) this.emit('idle','request_failed'); }
    finally {clearTimeout(timer);if(generation===this.generation)this.abort=null;}
  }
  cancel(reason,{clearRepeat=true,preserveReadiness=false}={}) {
    const readiness=preserveReadiness && this.phase==='idle' && this.error==='not_ready' ? {reason:this.reason} : null;
    if(this.phase!=='idle')this.trace?.record('cancel');
    ++this.generation;
    this.abort?.abort();this.abort=null;
    this.capture.cancel();this.pending=null;
    this.maneuver.cancel({clearRepeat});
    this.emit('idle',readiness?'not_ready':null,readiness??{});
  }
  reset() {this.cancel('reset');this.session=null;this.transcript='';this.choice='none';this.maneuver.reset();this.emit('idle');}
  apply(manual,context={}) {
    const baseSafe=context.role==='pilot' && context.engaged===true && context.visible===true && context.focused===true && context.connected===true && context.heldManual===false && neutral(manual);
    const age=this.now()-context.statusAt;
    const liveSafe=baseSafe && context.voiceReady===true && context.armed===true && context.mode==='Normal' && age>=0 && age<LIMITS.statusMs;
    if ((this.phase!=='idle'||this.maneuver.busy) && !baseSafe) {this.cancel('context');return {...manual};}
    const pending=this.pending;
    if(pending){
      this.pending=null;
      if(pending.generation!==this.generation || this.now()-pending.releasedAt>=LIMITS.resultMs){this.emit('idle','stale_result');return {...manual};}
      if(this.config?.execution==='dry-run'){this.emit('idle',null,{dryRun:true});return {...manual};}
      if(!liveSafe){this.cancel('context');return {...manual};}
      if(pending.choice==='none' || !this.maneuver.start(pending.choice)){this.emit('idle');return {...manual};}
      this.trace?.record('maneuver_start');
      this.emit('executing');
    }
    if(this.maneuver.busy && !liveSafe){this.cancel('context');return {...manual};}
    if(this.phase==='executing'&&!this.maneuver.busy){this.trace?.record('maneuver_end');this.emit('idle');}
    return this.maneuver.busy ? this.maneuver.apply(manual) : {...manual};
  }
}
