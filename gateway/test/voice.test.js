import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { voiceRoutes } from '../src/voice.js';
import { ControlHub } from '../src/hub.js';
import { Sessions } from '../src/auth.js';
import { VoiceController } from '../../web/js/voicecontroller.js';

function setup(execution = 'dry-run', recognize = async () => ({ choice:'forward_short', transcript:'adelante', timing:{transcriptionMs:1,decisionMs:2} })) {
 let time=1000, calls=0; const controlCalls=[]; const core = new Proxy({}, {get:(_,key)=>(...args)=>{if(key==='control')controlCalls.push(args);}});
 const hub=new ControlHub({core,voice:true,now:()=>time,newSession:()=>42});
 const messages=[]; const client={send:m=>messages.push(m)};
 const user={name:'ana'}; hub.attach(client,{user,relay:false});hub.handle(client,{t:'hello',role:'pilot'});
 const ready=messages.find(m=>m.t==='voice_ready');
 const sessions=new Sessions({now:()=>time,ttlMs:1000000});const token=sessions.create(user);
 const route=voiceRoutes({cfg:{voice:{execution,shortMs:250,mediumMs:500,strength:50}},hub,sessions,now:()=>time,provider:{recognize:async args=>{calls++;return recognize(args);}}});
 function request(headers={},body=Buffer.from('audio'),secure=false) {
  const req=new PassThrough();Object.assign(req,{url:'/voice/command',method:'POST',socket:{encrypted:secure},headers:{host:'gcs.test',origin:'http://gcs.test',cookie:`gcs_session=${token}`,'content-type':'audio/webm; codecs=opus','x-voice-session':'42','x-voice-capability':ready?.capability,'x-voice-request':randomUUID(),...(execution==='enabled'?{'x-voice-epoch':String(hub.voiceEpoch)}:{}),...headers}});
  let status,data;const res={writeHead:s=>{status=s;},end:b=>{data=b?JSON.parse(b):null;},destroy:()=>{}};
  const done=route(req,res).then(()=>({status,data})); if(body!==null)req.end(body);return {req,done};
 }
 return {hub,client,route,request,messages,sessions,token,controlCalls,get calls(){return calls;},setTime:t=>{time=t;}};
}
test('promotion sends a private capability and exact identity is required',()=>{
 const s=setup(); const ready=s.messages.find(m=>m.t==='voice_ready');assert.ok(ready?.capability);
 assert.equal(s.hub.authorizeVoice({user:{name:'ana'},session:42,capability:ready.capability}),s.client);
 assert.equal(s.hub.authorizeVoice({user:{name:'ana'},session:42,capability:'wrong'}),null);
 s.hub.detach(s.client);assert.equal(s.hub.authorizeVoice({user:{name:'ana'},session:42,capability:ready.capability}),null);
});
test('bounded successful reply and MIME normalization',async()=>{const s=setup();const r=await s.request().done;assert.equal(r.status,200);assert.equal(r.data.choice,'forward_short');assert.equal(r.data.session,42);assert.equal(s.calls,1);s.route.close();});
for(const [label,headers,status] of [ ['cookie',{cookie:''},401],['origin missing',{origin:undefined},403],['origin scheme',{origin:'https://gcs.test'},403],['foreign origin',{origin:'http://evil.test'},403],['capability',{'x-voice-capability':'bad'},403],['session',{'x-voice-session':'43'},409],['mime',{'content-type':'audio/wav'},415],['length',{'content-length':'524289'},413],['request id',{'x-voice-request':'NaN'},400]])test(`reject ${label}`,async()=>{const s=setup();assert.equal((await s.request(headers).done).status,status);assert.equal(s.calls,0);s.route.close();});
test('stream size is bounded without Content-Length',async()=>{const s=setup();assert.equal((await s.request({},Buffer.alloc(524289)).done).status,413);assert.equal(s.calls,0);s.route.close();});
test('busy and duplicate requests rejected; ctl remains synchronous',async()=>{
 let finish;const s=setup('dry-run',()=>new Promise(r=>{finish=r;}));const id=randomUUID();const a=s.request({'x-voice-request':id});await new Promise(setImmediate);
 assert.equal((await s.request().done).status,409);s.hub.handle(s.client,{t:'ctl',seq:1,ts:1000,r:0,p:0,y:0,th:0,m:0});assert.equal(s.controlCalls.length,1);
 finish({choice:'none',transcript:'',timing:{transcriptionMs:0,decisionMs:0}});assert.equal((await a.done).status,200);s.setTime(3000);assert.equal((await s.request({'x-voice-request':id}).done).status,409);s.route.close();
});
for(const change of ['cookie','owner'])test(`rechecks ${change} after recognition`,async()=>{let finish;const s=setup('dry-run',()=>new Promise(r=>{finish=r;}));const a=s.request();await new Promise(setImmediate);if(change==='cookie')s.sessions.delete(s.token);else s.hub.detach(s.client);finish({choice:'none',transcript:'',timing:{}});assert.equal((await a.done).status,409);s.route.close();});
test('provider exceptions are sanitized',async()=>{const s=setup('dry-run',()=>{throw Error('secret-token-key');});const r=await s.request().done;assert.equal(r.status,502);assert.equal(JSON.stringify(r).includes('secret'),false);s.route.close();});
test('live requires fresh armed Normal state and telemetry',async()=>{const s=setup('enabled');assert.equal((await s.request().done).status,409);s.hub.onCoreStatus({state:'ARMED',session:42,out:{mode:0,turtle:0}});s.hub.onCoreTelemetry('flightMode','S-NORMAL');s.setTime(3000);assert.equal((await s.request().done).status,409);s.hub.onCoreStatus({state:'ARMED',session:42,out:{mode:0,turtle:0}});s.hub.onCoreTelemetry('link',{upLq:95});s.hub.onCoreTelemetry('flightMode','S-NORMAL');assert.equal((await s.request().done).status,200);s.route.close();});
test('disabled feature never calls provider',async()=>{const s=setup();const route=voiceRoutes({cfg:{voice:null},hub:s.hub,sessions:s.sessions,provider:{recognize:()=>assert.fail()}});const req=new PassThrough();Object.assign(req,{url:'/voice/command',method:'POST',headers:{cookie:`gcs_session=${s.token}`,origin:'http://gcs.test',host:'gcs.test'}});let status;await route(req,{writeHead:s=>{status=s;},end:()=>{}});assert.equal(status,404);route.close();s.route.close();});
test('aborted uploads release admission slots',async()=>{const s=setup();const a=s.request({},null);a.req.emit('aborted');await a.done;s.setTime(3000);assert.equal((await s.request().done).status,200);s.route.close();});
test('upload timeout is bounded',async()=>{const s=setup();assert.equal((await s.request({},null).done).status,408);s.route.close();});
test('provider deadline aborts even an uncooperative injected promise',async()=>{const s=setup('dry-run',()=>new Promise(()=>{}));assert.equal((await s.request().done).status,504);s.route.close();});
test('same-user queued tab and observer cannot supply their own capability',async()=>{const s=setup();for(const role of ['pilot','observer']){const sent=[];const other={send:m=>sent.push(m)};s.hub.attach(other,{user:{name:'ana'},relay:false});s.hub.handle(other,{t:'hello',role});assert.equal(sent.some(m=>m.t==='voice_ready'),false);assert.equal((await s.request({'x-voice-capability':'tab-invented-token'}).done).status,403);}s.route.close();});
test('shutdown aborts pending provider work and returns a fixed error',async()=>{let signal;const s=setup('dry-run',args=>{signal=args.signal;return new Promise(()=>{});});const a=s.request();await new Promise(setImmediate);s.route.close();assert.equal((await a.done).status,409);assert.equal(signal.aborted,true);});
test('provider cannot forge route errors or leak credentials',async()=>{const s=setup('dry-run',()=>{throw Object.assign(Error('secret'),{status:400,code:'key-secret'});});const r=await s.request().done;assert.equal(r.status,502);assert.equal(r.data.error,'provider_error');s.route.close();});
test('live rejects unknown, stale, non-Normal telemetry and non-armed status',async()=>{for(const mode of [undefined,'NORMAL','S-SPORT','S-TURTLE']){const s=setup('enabled');s.hub.onCoreStatus({state:'ARMED',session:42,out:{mode:0,turtle:0}});if(mode)s.hub.onCoreTelemetry('flightMode',mode);assert.equal((await s.request().done).status,409);s.route.close();}const s=setup('enabled');s.hub.onCoreStatus({state:'DISARMED',session:42,out:{mode:0,turtle:0}});s.hub.onCoreTelemetry('flightMode','S-NORMAL');assert.equal((await s.request().done).status,409);s.route.close();});
test('consumed IDs are capped at 128 and then capability rotates while idle',async()=>{const s=setup();for(let i=0;i<128;i++){s.setTime(1000+i*1001);assert.equal((await s.request().done).status,200);}s.setTime(200000);const old=s.messages.filter(m=>m.t==='voice_ready').at(-1);assert.equal((await s.request().done).status,409);const fresh=s.messages.filter(m=>m.t==='voice_ready').at(-1);assert.notEqual(fresh.capability,old.capability);assert.equal(s.calls,128);s.route.close();});
test('cookie expiration during recognition invalidates the response',async()=>{let finish;const s=setup('dry-run',()=>new Promise(r=>{finish=r;}));const a=s.request();await new Promise(setImmediate);s.setTime(2000000);finish({choice:'none',transcript:'',timing:{}});assert.equal((await a.done).status,409);s.route.close();});
test('matching HTTPS gateway origin works without trusting proxy scheme headers',async()=>{const s=setup();assert.equal((await s.request({origin:'https://gcs.test'},Buffer.from('audio'),true).done).status,200);s.route.close();const t=setup();assert.equal((await t.request({origin:'https://gcs.test','x-forwarded-proto':'https'}).done).status,403);t.route.close();});
test('late upload transport errors after abort cannot escape the HTTP handler',async()=>{const s=setup();const a=s.request({},null);a.req.emit('aborted');await a.done;assert.doesNotThrow(()=>a.req.emit('error',Error('connection reset')));s.route.close();});
test('another tab cannot use its queued session and an invented capability',async()=>{const s=setup();assert.equal((await s.request({'x-voice-session':'43','x-voice-capability':'other-tab'}).done).status,403);s.route.close();});

function live(s){s.hub.onCoreStatus({state:'ARMED',session:42,out:{mode:0,turtle:0}});s.hub.onCoreTelemetry('link',{upLq:95});s.hub.onCoreTelemetry('flightMode','S-NORMAL');}
test('HTTP admission and status expose the same fixed readiness reason',async()=>{
  const s=setup('enabled');const response=await s.request().done;assert.deepEqual(response.data,{error:'not_ready',reason:'core_stale'});assert.deepEqual(s.messages.filter(m=>m.t==='status').at(-1).voice,{ready:false,reason:'core_stale',epoch:s.hub.voiceEpoch});assert.equal(s.calls,0);s.route.close();
});
test('HTTP accepts sparse mode while status/RF stay fresh',async()=>{
  const s=setup('enabled');live(s);for(let t=1100;t<=2500;t+=100){s.setTime(t);s.hub.onCoreStatus({state:'ARMED',session:42,out:{mode:0,turtle:0}});s.hub.onCoreTelemetry('link',{upLq:95});}assert.equal((await s.request().done).status,200);s.route.close();
});
test('RF loss during recognition is rejected by the same post-check without execution',async()=>{
  let finish;const s=setup('enabled',()=>new Promise(r=>{finish=r;}));live(s);const a=s.request();await new Promise(setImmediate);s.hub.onCoreTelemetry('link',{upLq:0});s.hub.onCoreStatus({state:'ARMED',session:42,out:{mode:0,turtle:0}});finish({choice:'forward_short',transcript:'adelante'});assert.deepEqual((await a.done).data,{error:'not_ready',reason:'link_lost'});assert.deepEqual(s.messages.filter(m=>m.t==='status').at(-1).voice,{ready:false,reason:'link_lost',epoch:s.hub.voiceEpoch});assert.equal(s.controlCalls.length,0);s.route.close();
});
test('hello cached mode replay never restores invalidated confirmation',()=>{
  const s=setup('enabled');live(s);s.hub.onCoreTelemetry('link',{upLq:0});s.hub.onCoreTelemetry('link',{upLq:95});const other={send(){}};s.hub.attach(other,{user:{name:'other'},relay:false});s.hub.handle(other,{t:'hello',role:'observer'});assert.deepEqual(s.hub.voiceReadiness(42),{ready:false,reason:'normal_unconfirmed'});s.route.close();
});
test('accepted control intent invalidates rapid mode/turtle changes before status sampling',()=>{
  for(const field of ['m','tu']){const s=setup('enabled');live(s);for(const [i,v]of [1,0].entries())s.hub.handle(s.client,{t:'ctl',seq:i+1,ts:1000,r:0,p:0,y:0,th:0,m:field==='m'?v:0,tu:field==='tu'?v:0});assert.deepEqual(s.hub.voiceReadiness(42),{ready:false,reason:'normal_unconfirmed'});s.route.close();}
});

for(const interruption of ['core_stale','link_stale','target','turtle','rf_recovered'])test(`HTTP post-check rejects ${interruption} while recognition is pending`,async()=>{
  let finish;const s=setup('enabled',()=>new Promise(r=>{finish=r;}));live(s);const pending=s.request();await new Promise(setImmediate);
  let reason;
  if(interruption==='core_stale'){s.setTime(1500);s.hub.onCoreTelemetry('link',{upLq:95});reason='core_stale';}
  else if(interruption==='link_stale'){s.setTime(1500);s.hub.onCoreStatus({state:'ARMED',session:42,out:{mode:0,turtle:0}});reason='link_stale';}
  else if(interruption==='rf_recovered'){s.hub.onCoreTelemetry('link',{upLq:0});s.hub.onCoreTelemetry('link',{upLq:95});reason='normal_unconfirmed';}
  else {s.hub.handle(s.client,{t:'ctl',seq:1,ts:1000,r:0,p:0,y:0,th:0,m:interruption==='target'?1:0,tu:interruption==='turtle'?1:0});reason=interruption==='target'?'not_normal':'turtle_active';}
  finish({choice:'forward_short',transcript:'adelante'});assert.deepEqual((await pending.done).data,{error:'not_ready',reason});s.route.close();
});

for(const state of ['FAILSAFE','HOLD','LANDING','UNKNOWN'])test(`HTTP ${state} feedback requires recovery instead of arming`,async()=>{
  const s=setup('enabled');s.hub.onCoreStatus({state,session:42,out:{mode:0,turtle:0}});assert.deepEqual((await s.request().done).data,{error:'not_ready',reason:'unsafe_state'});assert.equal(s.calls,0);s.route.close();
});

test('R1 real route and controller reject held provider after RF bounce and reconfirmation',async()=>{
  let finish;const s=setup('enabled',()=>new Promise(resolve=>{finish=resolve;}));live(s);
  let starts=0;const states=[];
  const c=new VoiceController({capture:{press:async()=>{},release:async()=>({audio:new Blob(['audio']),mime:'audio/webm'}),cancel(){}},
    maneuver:{busy:false,configure(){},cancel(){this.busy=false;},start(){starts++;this.busy=true;return true;},apply:m=>({...m,pitch:50})},onState:state=>states.push(state),now:()=>1000,
    fetchImpl:async(_url,options)=>{const headers=Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[k.toLowerCase(),String(v)]));const reply=await s.request(headers).done;return {ok:reply.status===200,json:async()=>reply.data};}});
  c.configure({execution:'enabled',shortMs:250,mediumMs:500,strength:50});c.setSession(s.messages.find(m=>m.t==='voice_ready'));
  const ready=()=>({...s.hub.voiceReadiness(42),epoch:s.hub.voiceEpoch});c.onReadiness(ready());
  await c.press();const result=c.release();await new Promise(setImmediate);
  s.hub.onCoreTelemetry('link',{upLq:0});c.onReadiness(ready());
  s.hub.onCoreTelemetry('link',{upLq:95});s.hub.onCoreTelemetry('flightMode','S-NORMAL');c.onReadiness(ready());
  finish({choice:'forward_short',transcript:'adelante'});await result;
  c.apply({roll:0,pitch:0,yaw:0,throttle:0},{role:'pilot',engaged:true,visible:true,focused:true,connected:true,heldManual:false,armed:true,mode:'Normal',statusAt:1000,voiceReady:true,voiceEpoch:s.hub.voiceEpoch});
  assert.equal(starts,0,'interrupted old utterance must never start even after readiness recovers');
  assert.equal(c.phase,'idle');s.route.close();
});

test('live HTTP epoch rejects hidden RF bounce before completion and stale pre-submit capture',async()=>{
  let finish;const s=setup('enabled',()=>new Promise(resolve=>{finish=resolve;}));live(s);const epoch=s.hub.voiceEpoch;
  const old=s.request({'x-voice-epoch':String(epoch)});await new Promise(setImmediate);
  s.hub.onCoreTelemetry('link',{upLq:0});s.hub.onCoreTelemetry('link',{upLq:95});s.hub.onCoreTelemetry('flightMode','S-NORMAL');
  assert.equal(s.hub.voiceLiveReady(42),true);finish({choice:'forward_short',transcript:'adelante'});
  assert.deepEqual((await old.done).data,{error:'interrupted'});
  assert.deepEqual((await s.request({'x-voice-epoch':String(epoch)}).done).data,{error:'interrupted'});
  assert.equal(s.calls,1,'stale capture rejected before provider');
  s.setTime(2100);live(s);const fresh=s.request();await new Promise(setImmediate);finish({choice:'forward_short',transcript:'adelante'});
  assert.equal((await fresh.done).status,200,'new utterance after recovery is admitted');assert.equal(s.calls,2);s.route.close();
});

for(const epoch of [undefined,'-1','NaN','1.5','9007199254740992'])test(`ready live HTTP rejects missing/invalid capture epoch ${epoch}`,async()=>{
  const s=setup('enabled');live(s);assert.deepEqual((await s.request({'x-voice-epoch':epoch}).done).data,{error:'interrupted'});assert.equal(s.calls,0);s.route.close();
});
test('upload crossing a hidden RF bounce is rejected before provider work',async()=>{
  const s=setup('enabled');live(s);const pending=s.request({},null);
  s.hub.onCoreTelemetry('link',{upLq:0});s.hub.onCoreTelemetry('link',{upLq:95});s.hub.onCoreTelemetry('flightMode','S-NORMAL');
  pending.req.end(Buffer.from('audio'));assert.deepEqual((await pending.done).data,{error:'interrupted'});assert.equal(s.calls,0);s.route.close();
});
