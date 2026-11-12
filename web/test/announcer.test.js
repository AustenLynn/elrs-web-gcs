import test from 'node:test';
import assert from 'node:assert/strict';
const { FlightAnnouncer } = await import('../js/announcer.js').catch(() => ({}));
const snapshot = {connected:true,coreFresh:true,state:'DISARMED',reason:'none',radio:'up'};
function setup({stored=null,storageFails=false}={}) {
  assert.equal(typeof FlightAnnouncer,'function','FlightAnnouncer implementation is required');
  let clock=0;
  const calls=[],states=[],writes=[];
  const audio={src:'',volume:1,muted:false,currentTime:0,paused:true,reject:null,pending:null,
    play(){this.paused=false;calls.push({url:this.src,volume:this.volume,muted:this.muted});if(this.pending)return this.pending;if(this.reject)return Promise.reject(this.reject);return Promise.resolve();},
    pause(){this.paused=true;},onended:null,onerror:null};
  const c=new FlightAnnouncer({audioFactory:url=>{audio.src=url;return audio;},now:()=>clock,onState:s=>states.push(s),storage:{getItem(){if(storageFails)throw Error('storage');return stored;},setItem(k,v){if(storageFails)throw Error('storage');writes.push([k,v]);}}});
  return {c,audio,calls,states,writes,time:v=>clock=v,update:v=>c.update({...snapshot,...v}),events:()=>calls.filter(x=>x.volume!==0&&!x.muted).map(x=>x.url.split('/').at(-1))};
}
async function enabled(options){const s=setup(options);assert.equal(await s.c.enable(),true);return s;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('starts opted out; gesture probes silently and remembers preference without announcing initial state',async()=>{
  const s=setup();s.update({state:'ARMED'});assert.deepEqual(s.calls,[]);
  assert.equal(await s.c.enable(),true);assert.deepEqual(s.events(),[]);assert.equal(s.audio.paused,true);
  assert.deepEqual(s.writes,[['gcs.announcements','true']]);assert.deepEqual(s.states.at(-1),{enabled:true,blocked:false,error:null});
  const returning=setup({stored:'true'});assert.equal(returning.c.preferred,true);returning.update({state:'ARMED'});assert.deepEqual(returning.calls,[]);
});
test('confirmed armed/disarmed transitions speak once and disconnected reconnect seeds silently',async()=>{
  const s=await enabled();s.update({});s.update({state:'ARMED'});s.update({state:'ARMED'});
  assert.deepEqual(s.events(),['armed.mp3']);s.audio.onended();s.time(4000);s.update({state:'DISARMED'});
  assert.deepEqual(s.events(),['armed.mp3','disarmed.mp3']);s.update({connected:false});assert.equal(s.audio.paused,true);
  s.update({state:'ARMED',radio:'down'});assert.equal(s.events().length,2);s.update({radio:'up',state:'ARMED'});assert.equal(s.events().at(-1),'signal_restored.mp3');
});
test('unknown/stale core seeds a new baseline; unknown radio never asserts restored',async()=>{
  const s=await enabled();s.update({});s.update({coreFresh:false,state:'ARMED',radio:'down'});s.update({state:'ARMED'});
  s.update({state:'unknown'});s.update({state:'DISARMED'});assert.deepEqual(s.events(),[]);
  s.update({radio:'unknown'});s.update({radio:'up'});assert.deepEqual(s.events(),[]);
  s.update({radio:'down'});assert.deepEqual(s.events(),['signal_lost.mp3']);
});
test('simultaneous RF-loss failsafe coalesces into loss; failsafe never claims recovery',async()=>{
  const s=await enabled();s.update({state:'ARMED'});s.update({state:'FAILSAFE',reason:'rf_lost',radio:'down'});
  assert.deepEqual(s.events(),['signal_lost.mp3']);s.audio.onended();s.update({state:'FAILSAFE',reason:'rf_lost',radio:'up'});
  assert.deepEqual(s.events(),['signal_lost.mp3','signal_restored.mp3']);s.audio.onended();s.time(4000);s.update({state:'ARMED'});s.audio.onended();s.update({state:'FAILSAFE',reason:'pilot_lost'});
  assert.equal(s.events().at(-1),'failsafe.mp3');
});
test('urgent loss preempts routine; other speech is discarded without a queue',async()=>{
  const s=await enabled();s.update({});s.update({state:'ARMED'});const routineEnd=s.audio.onended;
  s.update({state:'ARMED',radio:'down'});assert.deepEqual(s.events(),['armed.mp3','signal_lost.mp3']);
  routineEnd();s.update({state:'DISARMED',radio:'down'});assert.equal(s.events().length,2);
  s.audio.onended();s.update({state:'DISARMED',radio:'down'});assert.equal(s.events().length,2);
});
test('three-second per-event cooldown bounds repeated and flapping telemetry',async()=>{
  const s=await enabled();s.update({});s.update({radio:'down'});s.audio.onended();s.time(100);s.update({radio:'up'});s.audio.onended();s.time(200);s.update({radio:'down'});s.time(2999);s.update({radio:'up'});s.update({radio:'down'});
  assert.deepEqual(s.events(),['signal_lost.mp3','signal_restored.mp3']);s.time(3000);s.update({radio:'up'});s.update({radio:'down'});assert.equal(s.events().filter(x=>x==='signal_lost.mp3').length,2);
});
for(const operation of ['mute','language','recording']) test(`${operation} stops playback, updates silent baselines and never replays stale events`,async()=>{
  const s=await enabled();s.update({});s.update({state:'ARMED'});
  if(operation==='mute')s.c.mute();if(operation==='language')s.c.setLanguage('es');if(operation==='recording')s.c.setRecording(true);
  assert.equal(s.audio.paused,true);
  if(operation==='language'){s.update({state:'ARMED'});assert.equal(s.events().length,1);s.time(4000);s.update({state:'DISARMED'});assert.equal(s.calls.at(-1).url,'/audio/announcements/es/disarmed.mp3');return;}
  s.update({state:'DISARMED',radio:'down'});if(operation==='mute')await s.c.enable();else s.c.setRecording(false);
  s.update({state:'DISARMED',radio:'down'});assert.equal(s.events().length,1);s.time(4000);s.update({state:'ARMED',radio:'down'});assert.equal(s.events().at(-1),'armed.mp3');
});
test('reset stops speech and silently seeds the next confirmed state',async()=>{const s=await enabled();s.update({});s.update({state:'ARMED'});s.c.reset();assert.equal(s.audio.paused,true);s.update({radio:'down'});assert.equal(s.events().length,1);});
test('storage failure and corrupt preference remain usable',async()=>{for(const options of [{storageFails:true},{stored:'garbage'}]){const s=await enabled(options);s.c.mute();assert.equal(s.states.at(-1).enabled,false);}});
test('blocked probe is caught; unavailable clips and later play failures disable cleanly',async()=>{
  for(const name of ['NotAllowedError','NotSupportedError']){const s=setup();s.audio.reject=Object.assign(Error('private detail'),{name});assert.equal(await s.c.enable(),false);assert.deepEqual(s.states.at(-1),{enabled:false,blocked:name==='NotAllowedError',error:name==='NotAllowedError'?'audio_blocked':'audio_unavailable'});}
  const s=await enabled();s.update({});s.audio.reject=Error('private');s.update({state:'ARMED'});await tick();assert.equal(s.states.at(-1).error,'audio_unavailable');assert.equal(s.audio.paused,true);
});
for(const operation of ['mute','language','recording','reset'])test(`${operation} invalidates pending unlock and stale playback rejection`,async()=>{
  const s=setup();let resolve;s.audio.pending=new Promise(r=>resolve=r);const unlocking=s.c.enable();
  if(operation==='mute')s.c.mute();if(operation==='language')s.c.setLanguage('es');if(operation==='recording')s.c.setRecording(true);if(operation==='reset')s.c.reset();
  resolve();assert.equal(await unlocking,false);assert.equal(s.audio.paused,true);assert.equal(s.states.at(-1).enabled,false);
});
test('late failure from preempted routine does not disable urgent speech',async()=>{
  const s=await enabled();s.update({});let reject;s.audio.pending=new Promise((_,r)=>reject=r);s.update({state:'ARMED'});s.audio.pending=null;s.update({state:'ARMED',radio:'down'});reject(Error('old'));await tick();assert.equal(s.states.at(-1).enabled,true);assert.equal(s.events().at(-1),'signal_lost.mp3');
});

test('gesture probe stays silent when volume writes are ignored; confirmed event becomes audible only after paused unmute',async()=>{
  const s=setup();let muted=false,unmutedWhilePlaying=false;
  Object.defineProperty(s.audio,'volume',{get:()=>1,set(){}});
  Object.defineProperty(s.audio,'muted',{get:()=>muted,set(value){if(!value&&!s.audio.paused)unmutedWhilePlaying=true;muted=value;}});
  assert.equal(await s.c.enable(),true);
  assert.deepEqual(s.events(),[],'unlock must never speak armed before confirmed telemetry');
  assert.equal(s.calls[0].muted,true);assert.equal(s.audio.paused,true);assert.equal(s.audio.muted,false);assert.equal(unmutedWhilePlaying,false);
  s.update({});assert.deepEqual(s.events(),[]);s.update({state:'ARMED'});
  assert.deepEqual(s.events(),['armed.mp3']);assert.equal(s.calls.at(-1).muted,false);
});
test('a legitimate event always plays unmuted, even if an earlier probe left the element muted',async()=>{
  const s=await enabled();s.update({});s.audio.muted=true;s.update({state:'ARMED'});
  assert.deepEqual(s.calls.at(-1),{url:'/audio/announcements/en/armed.mp3',volume:1,muted:false});
});
