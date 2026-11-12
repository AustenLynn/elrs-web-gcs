import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCapture } from '../js/voicecapture.js';
import { VoiceManeuver } from '../js/voicemaneuver.js';
import { VoiceController } from '../js/voicecontroller.js';
const context={role:'pilot',engaged:true,visible:true,focused:true,connected:true,armed:true,mode:'Normal',voiceReady:true,statusAt:0,heldManual:false};
function setup(execution='enabled',trace=null){let t=0,starts=0,presses=0,canceled=0,request,resolve;const states=[];const maneuver={busy:false,configure(){},start(){starts++;this.busy=true;return true;},apply:m=>({...m,pitch:50}),cancel(){this.busy=false;},reset(){this.busy=false;}};const capture={press:async()=>{presses++;},release:async()=>({audio:new Blob(['a']),mime:'audio/webm;codecs=opus'}),cancel:()=>canceled++};const c=new VoiceController({capture,maneuver,trace,now:()=>t,onState:s=>states.push(s),fetchImpl:async(url,options)=>{request=options;return new Promise(r=>resolve=r);}});c.configure({execution,shortMs:250,mediumMs:500,strength:50});c.setSession({session:'s',capability:'c'});return {c,states,time:v=>t=v,get starts(){return starts;},get presses(){return presses;},get request(){return request;},reply(data={},ok=true){resolve({ok,json:async()=>({session:'s',requestId:request.headers['X-Voice-Request'],choice:'forward_short',transcript:'adelante',...data})});}};}
const manual={roll:0,pitch:0,yaw:0,throttle:0,mode:0};
async function submitted(s){await s.c.press();const p=s.c.release();await new Promise(r=>setImmediate(r));return {p};}
test('result starts only inside apply with current context',async()=>{const s=setup();const {p}=await submitted(s);s.reply();await p;assert.equal(s.starts,0);s.c.apply(manual,context);assert.equal(s.starts,1);});
test('held manual input blocks result and dry-run never starts',async()=>{for(const execution of ['enabled','dry-run']){const s=setup(execution);const {p}=await submitted(s);s.reply();await p;s.c.apply(manual,{...context,heldManual:execution==='enabled'});assert.equal(s.starts,0);}});
test('busy presses ignored; cancel aborts and late result cannot start',async()=>{const s=setup();const {p}=await submitted(s);await s.c.press();assert.equal(s.presses,1);s.c.cancel('hidden');assert.equal(s.request.signal.aborted,true);s.reply();await p;s.c.apply(manual,context);assert.equal(s.starts,0);});
test('result at lifetime boundary and mismatched result rejected',async()=>{for(const mismatch of [false,true]){const s=setup();const {p}=await submitted(s);if(!mismatch)s.time(6000);s.reply(mismatch?{session:'other'}:{});await p;s.c.apply(manual,{...context,statusAt:6000});assert.equal(s.starts,0);assert.equal(s.c.busy,false);}});

test('HTTP fixed errors become idle state',async()=>{const s=setup();const {p}=await submitted(s);s.reply({error:'provider_timeout'},false);await p;assert.equal(s.c.busy,false);assert.equal(s.states.at(-1).error,'provider_timeout');});
test('capability rotation aborts old response',async()=>{const s=setup();const {p}=await submitted(s);s.c.setSession({session:'s',capability:'new'});assert.equal(s.request.signal.aborted,true);s.reply();await p;s.c.apply(manual,context);assert.equal(s.starts,0);});
test('repeated release and repeated apply never start twice',async()=>{const s=setup();const {p}=await submitted(s);await s.c.release();s.reply();await p;s.c.apply(manual,context);s.c.apply(manual,context);assert.equal(s.starts,1);});
test('hidden state cancels pending recognition',async()=>{const s=setup();const {p}=await submitted(s);s.c.apply(manual,{...context,visible:false});assert.equal(s.request.signal.aborted,true);s.reply();await p;s.c.apply(manual,context);assert.equal(s.starts,0);});
test('invalid choice never reaches maneuver',async()=>{const s=setup();const {p}=await submitted(s);s.reply({choice:'arm'});await p;s.c.apply(manual,context);assert.equal(s.starts,0);assert.equal(s.states.at(-1).error,'invalid_result');});

test('default browser fetch retains global receiver', async t => {
  t.mock.method(globalThis, 'fetch', async function(url, options) {
    assert.equal(this, globalThis, 'native Window.fetch requires its global receiver');
    return {ok:true,json:async()=>({session:1,requestId:options.headers['X-Voice-Request'],choice:'forward_short',transcript:'adelante'})};
  });
  const states=[];
  const c=new VoiceController({
    capture:{press:async()=>{},release:async()=>({audio:new Blob(['a']),mime:'audio/webm;codecs=opus'}),cancel(){}},
    maneuver:{busy:false,configure(){},cancel(){}},onState:s=>states.push(s),
  });
  c.configure({execution:'dry-run',shortMs:250,mediumMs:500,strength:50});
  c.setSession({session:1,capability:'capability'});
  await c.press();await c.release();
  assert.equal(states.at(-1).phase,'ready');
  assert.equal(states.at(-1).error,null);
  c.cancel('cleanup');
});


test('optional trace records release, recognition stages, start/end/cancel without speech or identity',async()=>{
 const events=[];const s=setup('enabled',{record:(event,data)=>events.push({event,...data})});
 const {p}=await submitted(s);s.reply({timing:{transcriptionMs:12,decisionMs:8}});await p;
 s.c.apply(manual,context);s.c.maneuver.busy=false;s.c.apply(manual,context);
 await s.c.press();s.c.cancel('manual_secret');
 assert.deepEqual(events.map(e=>e.event),['release','recognition_start','transcription','decision','recognition_end','maneuver_start','maneuver_end','cancel']);
 assert.equal(JSON.stringify(events).includes('secret'),false);
 assert.equal(JSON.stringify(events).includes('adelante'),false);
});

// The real capture/controller boundary must recover without a release gesture.
for (const failure of ['error', 'timeout']) {
  test(`current recorder ${failure} returns controller to idle and stale callbacks spare a fresh press`, async t => {
    const timers = [], recorders = [], states = [];
    let stopped = 0, uploads = 0;
    t.mock.method(globalThis, 'setTimeout', callback => { timers.push(callback); return timers.length; });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    class Recorder {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; recorders.push(this); }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    }
    const capture = new VoiceCapture({mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}]})}, MediaRecorderClass:Recorder});
    const controller = new VoiceController({capture, maneuver:new VoiceManeuver(), onState:state=>states.push(state), fetchImpl:async()=>{uploads++;throw new Error('unexpected upload');}});
    controller.configure({execution:'enabled',shortMs:250,mediumMs:500,strength:50});
    controller.setSession({session:'s',capability:'c'});
    await controller.press();
    const fail = failure === 'error' ? () => recorders[0].onerror({message:'unsafe recorder detail'}) : timers[0];
    fail();
    assert.equal(controller.busy, false);
    assert.equal(states.at(-1).phase, 'idle');
    assert.equal(states.at(-1).error, failure === 'error' ? 'capture_failed' : 'recording_timeout');
    assert.equal(stopped, 1);
    await controller.release();
    assert.equal(uploads, 0);
    await controller.press();
    assert.equal(controller.phase, 'recording', 'another press works immediately');
    fail();
    assert.equal(controller.phase, 'recording', 'queued old failure cannot cancel the new press');
    assert.equal(stopped, 1);
    controller.cancel('cleanup');
    assert.equal(stopped, 2);
  });
}

test('valid responses at and beyond the lifetime boundary report stale_result', async () => {
  for (const age of [6000, 6001]) {
    const s = setup();
    const {p} = await submitted(s);
    s.time(age);
    s.reply();
    await p;
    assert.equal(s.states.at(-1).error, 'stale_result');
    assert.equal(s.c.busy, false);
    s.c.apply(manual, {...context,statusAt:age});
    assert.equal(s.starts, 0);
  }
});

for (const voiceReady of [undefined,false,1,'true',null]) test(`missing/invalid gateway readiness ${voiceReady} blocks live output`,async()=>{
  const s=setup();const {p}=await submitted(s);s.reply();await p;s.c.apply(manual,{...context,voiceReady});assert.equal(s.starts,0);
});
test('gateway readiness loss cancels an active maneuver with fresh local status',async()=>{
  const s=setup();const {p}=await submitted(s);s.reply();await p;s.c.apply(manual,context);assert.equal(s.starts,1);assert.equal(s.c.apply(manual,{...context,voiceReady:false}).pitch,0);assert.equal(s.c.busy,false);
});
for(const reason of ['link_lost','normal_unconfirmed','not_armed','unsafe_state','untrusted_provider_detail'])test(`HTTP readiness reason ${reason} is bounded for UI`,async()=>{
  const s=setup();const {p}=await submitted(s);s.reply({error:'not_ready',reason},false);await p;assert.equal(s.states.at(-1).reason,reason==='untrusted_provider_detail'?null:reason);
});

test('idle readiness feedback follows authoritative reason and clears without another utterance',async()=>{
  const s=setup();const {p}=await submitted(s);s.reply({error:'not_ready',reason:'link_stale'},false);await p;
  s.c.onReadiness({ready:false,reason:'normal_unconfirmed'});
  assert.equal(s.states.at(-1).error,'not_ready');assert.equal(s.states.at(-1).reason,'normal_unconfirmed');
  const count=s.states.length;s.c.onReadiness({ready:false,reason:'normal_unconfirmed'});
  assert.equal(s.states.length,count,'unchanged status does not repaint');
  s.c.cancel('state',{preserveReadiness:true});
  s.c.onReadiness({ready:false,reason:'unsafe_state'});
  assert.equal(s.states.at(-1).reason,'unsafe_state','core state transitions keep readiness feedback current');
  assert.equal(s.states.at(-1).error,'not_ready');
  s.c.onReadiness({ready:true,reason:'ready'});
  assert.equal(s.states.at(-1).phase,'idle');assert.equal(s.states.at(-1).error,null);
  s.c.onReadiness({ready:false,reason:'link_lost'});
  assert.equal(s.states.at(-1).error,null,'cleared feedback stays cleared');
});

test('readiness status preserves provider errors and active voice phases',async()=>{
  const s=setup();const {p}=await submitted(s);s.reply({error:'provider_timeout'},false);await p;
  const count=s.states.length;s.c.onReadiness({ready:true,reason:'ready'});
  assert.equal(s.states.length,count);assert.equal(s.states.at(-1).error,'provider_timeout');
  await s.c.press();s.c.onReadiness({ready:false,reason:'link_lost'});
  assert.equal(s.states.at(-1).phase,'recording');
  const pending=s.c.release();await new Promise(r=>setImmediate(r));
  s.c.onReadiness({ready:true,reason:'ready'});assert.equal(s.states.at(-1).phase,'processing');
  s.reply();await pending;s.c.onReadiness({ready:false,reason:'link_lost'});
  assert.equal(s.states.at(-1).phase,'ready');s.c.apply(manual,context);
  s.c.onReadiness({ready:true,reason:'ready'});assert.equal(s.states.at(-1).phase,'executing');
  s.c.cancel('cleanup');
});
