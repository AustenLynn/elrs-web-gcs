import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { firefox, tempDir, waitFor, sleep, start, login, makeUsers, openWithInputMode, fakeVoiceMedia } from './helpers.js';

async function voiceFixture(t, inputMode='keyboard') {
  const procs=[];
  const root=path.resolve(import.meta.dirname,'../../web');
  const server=createServer(async(req,res)=>{
    try {const file=path.join(root,req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]);
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.close();for(const p of procs)p.kill('SIGKILL');});
  const page=await firefox(procs,tempDir('gcs-voice-'));
  t.after(()=>page.close());
  await page.call('script.addPreloadScript',{functionDeclaration:`() => {
    document.hasFocus=()=>true;
    window.fixture={sent:[],requests:0,delay:0,choice:'forward_short',execution:'dry-run',state:'DISARMED',flightMode:'S-NORMAL',modeTelemetry:true,clock:0,transcript:'adelante <b>hola</b>',error:null};
    const realNow=performance.now.bind(performance);performance.now=()=>fixture.freeze ?? (realNow()+fixture.clock);
    class Recorder {static isTypeSupported(){return true;} constructor(){this.state='inactive';fixture.recorder=this;} start(){this.state='recording';} stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fake-audio'],{type:'audio/webm;codecs=opus'})});this.onstop?.();}}
    window.MediaRecorder=Recorder;
    window.RTCPeerConnection=class {constructor(){throw new Error('video unavailable in voice fixture');}};
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
    window.fetch=async(url,opts={})=>{
      const answer=data=>({ok:true,json:async()=>data});
      if(url==='/me')return answer({name:'ana',admin:false});
      if(url==='/voice/config')return answer({execution:fixture.execution,shortMs:250,mediumMs:500,strength:50});
      if(url==='/voice/command'){fixture.requests++;await new Promise(r=>setTimeout(r,fixture.delay));if(fixture.error)return {ok:false,json:async()=>({error:fixture.error})};return answer({requestId:opts.headers['X-Voice-Request'],session:opts.headers['X-Voice-Session'],choice:fixture.choice,transcript:fixture.transcript});}
      return {ok:false,json:async()=>({})};
    };
    class Socket {static OPEN=1; constructor(){this.readyState=1;fixture.socket=this;setTimeout(()=>this.onopen?.(),0);} send(raw){const m=JSON.parse(raw);fixture.sent.push(m);if(m.t==='hello'){this.emit({t:'welcome',role:'pilot',session:1});this.emit({t:'voice_ready',session:1,capability:'fake-capability'});this.timer=setInterval(()=>{this.emit({t:'status',state:fixture.state});if(fixture.modeTelemetry)this.emit({t:'telem',flightMode:fixture.flightMode});},50);}} emit(m){this.onmessage?.({data:JSON.stringify(m)});} close(){clearInterval(this.timer);this.readyState=3;this.onclose?.({code:1000});}}
    window.WebSocket=Socket;
    try {localStorage.setItem('gcs-input-mode','${inputMode}');sessionStorage.setItem('gcs-token-demo','fake');} catch {}
  }`});
  const url=`http://127.0.0.1:${server.address().port}/`;
  return {page,url};
}

test('two-tap voice button submits once and isolates keyboard ownership', {timeout:45000}, async t => {
  const {page,url}=await voiceFixture(t,'touch');
  await page.call('browsingContext.setViewport',{context:page.context,viewport:{width:740,height:360}});
  await page.open(url);
  await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-prepare').disabled"),3000,'preflight ready');
  await page.evaluate("document.getElementById('btn-voice-prepare').click();document.getElementById('btn-take').click()");
  await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-ptt').disabled"),3000,'voice ready');
  const phase=()=>page.evaluate("document.getElementById('voice-state').dataset.phase");
  const requests=()=>page.evaluate('fixture.requests');
  const press=()=>page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',bubbles:true}))");
  const release=()=>page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyV',bubbles:true}))");
  const touch=actions=>page.call('input.performActions',{context:page.context,actions:[{type:'pointer',id:'voice-tap',parameters:{pointerType:'touch'},actions}]});
  const down=async()=>{
    const b=JSON.parse(await page.evaluate("JSON.stringify(document.getElementById('btn-voice-ptt').getBoundingClientRect().toJSON())"));
    await touch([{type:'pointerMove',x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)},{type:'pointerDown',button:0}]);
  };
  const up=()=>touch([{type:'pointerUp',button:0}]);
  const tap=async()=>{await down();await up();await sleep(40);};
  const reset=async()=>{
    await page.evaluate("document.getElementById('btn-voice-cancel').click();document.getElementById('btn-take').click()");
    await sleep(60);
    assert.equal(await phase(),'idle');
    assert.equal(await page.evaluate("document.getElementById('btn-voice-ptt').textContent"),'Hablar');
    assert.equal(await page.evaluate("document.getElementById('btn-voice-ptt').getAttribute('aria-pressed')"),'false');
  };
  const canceledTap=async()=>{
    await down();
    await page.evaluate("document.getElementById('btn-voice-ptt').dispatchEvent(new PointerEvent('pointercancel',{pointerId:7,bubbles:true}))");
    await touch([{type:'pointerMove',x:1,y:1},{type:'pointerUp',button:0}]);
    await sleep(40);
  };
  await down();
  assert.equal(await phase(),'idle','uncompleted touch does not start recording');
  await up();await sleep(80);
  assert.equal(await phase(),'recording','first completed touch remains recording');
  assert.equal(await requests(),0,'first release and synthetic click never upload');
  assert.equal(await page.evaluate("document.getElementById('btn-voice-ptt').textContent"),'Enviar');
  assert.equal(await page.evaluate("document.getElementById('btn-voice-ptt').getAttribute('aria-pressed')"),'true');
  await page.evaluate('fixture.delay=400');
  await tap();
  await waitFor(async()=>await requests()===1,1000,'second touch uploads');
  assert.equal(await phase(),'processing');
  await tap();await tap();
  assert.equal(await requests(),1,'busy taps cannot upload again');
  await waitFor(async()=>await phase()==='idle',2000,'dry-run completion');
  await reset();
  await canceledTap();
  assert.equal(await phase(),'idle','canceled first touch never starts');
  await tap();await canceledTap();
  assert.equal(await phase(),'recording','canceled second touch never submits');
  assert.equal(await requests(),1);
  await reset();
  // A release or repeat from V cannot submit a button-owned utterance.
  await tap();await press();await release();
  assert.equal(await phase(),'recording');
  assert.equal(await requests(),1);
  await reset();
  await press();await sleep(60);await tap();
  assert.equal(await phase(),'recording','button cannot submit keyboard-owned recording');
  assert.equal(await page.evaluate("document.getElementById('btn-voice-ptt').disabled"),true);
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',repeat:true,bubbles:true}));fixture.delay=0");
  await release();
  await waitFor(async()=>await requests()===2,1000,'V release still uploads once');
  await waitFor(async()=>await phase()==='idle',2000,'V completion');
  // Every interruption resets ownership so the next first tap starts afresh.
  for(const interruption of [
    "document.getElementById('btn-voice-cancel').click()",
    "fixture.recorder.onerror()",
    "window.dispatchEvent(new Event('blur'))",
    "fixture.socket.emit({t:'welcome',role:'pilot',session:2});fixture.socket.emit({t:'voice_ready',session:2,capability:'next'})",
    "document.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowUp',bubbles:true}))",
  ]) {
    await reset();await tap();assert.equal(await phase(),'recording');
    await page.evaluate(interruption);await sleep(80);
    assert.equal(await phase(),'idle',interruption);
    assert.equal(await requests(),2,'interruption discards without upload');
    if(interruption.includes('ArrowUp')) {
      await tap();assert.equal(await phase(),'idle','held manual input blocks recording');
      await page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'ArrowUp',bubbles:true}))");
    }
    await reset();await tap();assert.equal(await phase(),'recording','fresh first tap after interruption');
  }
  await reset();await tap();
  await waitFor(async()=>await phase()==='idle',6000,'five-second discard');
  assert.equal(await page.evaluate("document.getElementById('voice-state').textContent"),'Sin acción: recording_timeout');
  assert.equal(await requests(),2,'timeout never auto-submits');
  await tap();assert.equal(await phase(),'recording','timeout cleared button ownership');
  await reset();
  // Normal click activation also supports mouse and keyboard accessibility callers.
  await page.evaluate("document.getElementById('btn-voice-ptt').click()");
  assert.equal(await phase(),'recording');
  await page.evaluate("document.getElementById('btn-voice-ptt').click()");
  await waitFor(async()=>await requests()===3,1000,'completed click pair uploads');
  await waitFor(async()=>await phase()==='idle',2000,'click completion');
  assert.deepEqual(page.errors,[]);
});

test('voice PTT runs on control ticks, dry-run and manual safety lifecycle', {timeout:60000}, async t => {
  const {page,url}=await voiceFixture(t);
  await page.open(url+'?measure');
  assert.equal(await page.evaluate("!!document.getElementById('btn-voice-ptt')"),true,'voice controls exist');
  await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-prepare').disabled"),3000,'preflight ready');
  await page.evaluate("document.getElementById('btn-take').click();document.getElementById('btn-voice-prepare').click()");
  await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-ptt').disabled"),3000,'voice ready');
  const press=()=>page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',bubbles:true}))");
  const release=()=>page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyV',bubbles:true}))");
  await press();await sleep(80);await release();
  await waitFor(()=>page.evaluate('fixture.requests===1'),2000,'single upload');
  await sleep(400);
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').every(m=>m.p===0&&m.r===0&&m.y===0&&m.th===0&&m.m===0)"),true,'dry-run never modifies controls');
  assert.equal(await page.evaluate("document.getElementById('voice-transcript').textContent"),'adelante <b>hola</b>');
  assert.equal(await page.evaluate("document.getElementById('voice-transcript').children.length"),0,'transcript is plain text');
  // Reload with enabled config via preload fixture mutation before config fetch.
  await page.evaluate("fixture.execution='enabled';fixture.state='ARMED'");
  // Configuration is loaded at welcome, so rotate the pilot session.
  await page.evaluate("fixture.socket.emit({t:'welcome',role:'pilot',session:2});fixture.socket.emit({t:'voice_ready',session:2,capability:'next'})");
  await sleep(150);
  await press();await sleep(50);await release();
  await waitFor(()=>page.evaluate("fixture.sent.some(m=>m.t==='ctl'&&m.p===50)"),2000,'immediate timed output');
  await sleep(350);
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').at(-1).p"),0,'duration completes');
  const trace=JSON.parse(await page.evaluate('JSON.stringify(window.voiceLatency.snapshot())'));
  for(const event of ['release','recognition_start','transcription','decision','recognition_end','maneuver_start','maneuver_end'])assert.ok(trace.some(row=>row.event===event),`trace ${event}`);
  assert.ok(trace.every(row=>Object.keys(row).every(key=>['event','atMs','durationMs'].includes(key))),'trace contains timing only');
  await page.evaluate("fixture.delay=500;fixture.sent=[]");
  await press();await sleep(50);await release();await sleep(150);
  assert.ok(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').length")>=4,'normal ctl continues during provider delay');
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowUp',bubbles:true}))");
  await sleep(600);
  assert.equal(await page.evaluate("document.getElementById('voice-state').dataset.phase"),'idle','manual intent cancels pending recognition');
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'ArrowUp',bubbles:true}));fixture.delay=0");
  await sleep(200);
  const utterance=async()=>{await press();await sleep(40);await release();};
  const startLive=async()=>{
    await page.evaluate("fixture.sent=[];fixture.choice='forward_short'");
    await utterance();
    await waitFor(()=>page.evaluate("fixture.sent.some(m=>m.t==='ctl'&&m.p===50)"),2000,'live maneuver starts');
  };
  // Throttle is manual and survives both completion and local cancellation.
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',bubbles:true}))");
  await sleep(180);
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',bubbles:true}))");
  const throttle=await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').at(-1).th");
  assert.ok(throttle>0);
  await startLive();
  await page.evaluate('fixture.clock+=1500');
  await sleep(70);
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').at(-1).p"),0,'clock jump expires duration on next tick');
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').at(-1).th"),throttle);
  await startLive();
  await page.evaluate("document.getElementById('btn-voice-cancel').click()");await sleep(70);
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').at(-1).p"),0);
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').at(-1).th"),throttle);
  await startLive();
  await page.evaluate("document.getElementById('btn-disarm').dispatchEvent(new PointerEvent('pointerdown',{pointerId:17,bubbles:true}))");
  await sleep(70);
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').at(-1).p"),0,'physical pointer intent cancels before manual action');
  await page.evaluate("document.dispatchEvent(new PointerEvent('pointerup',{pointerId:17,bubbles:true}))");
  // Every interruption clears the local repeat context as well as pending output.
  const interruptions=[
    "window.dispatchEvent(new Event('blur'))",
    "fixture.state='DISARMED';fixture.socket.emit({t:'status',state:'DISARMED'});fixture.state='ARMED';fixture.socket.emit({t:'status',state:'ARMED'})",
    "fixture.state='FAILSAFE';fixture.socket.emit({t:'status',state:'FAILSAFE'});fixture.state='ARMED';fixture.socket.emit({t:'status',state:'ARMED'})",
    "fixture.socket.emit({t:'welcome',role:'queued',session:3,lost:true});fixture.socket.emit({t:'welcome',role:'pilot',session:4});fixture.socket.emit({t:'voice_ready',session:4,capability:'rotated'})",
    "document.querySelector('[data-mode=\"1\"]').click();document.querySelector('[data-mode=\"0\"]').click()",
    "document.querySelector('[data-speed=\"1\"]').click()",
    "document.getElementById('btn-turtle').click();document.getElementById('btn-turtle').click()",
    "fixture.socket.emit({t:'telem',flightMode:'S-SPORT'});fixture.socket.emit({t:'telem',flightMode:'S-NORMAL'})",
  ];
  for(const interruption of interruptions){
    try {await startLive();} catch(error) {error.message+=' before '+interruption;throw error;} await sleep(320);
    await page.evaluate("fixture.sent=[];fixture.delay=180;fixture.choice='forward_short'");
    await utterance();
    await page.evaluate(interruption);await sleep(250);
    assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').every(m=>m.p===0)"),true,`pending result canceled by ${interruption}`);
    await page.evaluate('fixture.delay=0');
    await page.evaluate("document.getElementById('btn-take').click()");await sleep(100);
    await page.evaluate("fixture.choice='repeat_short';fixture.sent=[]");
    await utterance();await sleep(320);
    assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').every(m=>m.p===0)"),true,`repeat cleared by ${interruption}`);
  }
  // Canceled button pointers cannot discard a keyboard-owned utterance.
  for(const event of ['pointercancel','lostpointercapture']) {
    const before=await page.evaluate('fixture.requests');
    await press();await sleep(40);
    await page.evaluate(`document.getElementById('btn-voice-ptt').dispatchEvent(new PointerEvent('${event}',{pointerId:7}))`);
    await release();await sleep(70);
    assert.equal(await page.evaluate('fixture.requests'),before+1,`${event} leaves V release authoritative`);
  }
  // Freeze the monotonic clock for neutral keyboard ramps; held physical intent must still block.
  await page.evaluate('fixture.freeze=performance.now()');
  await sleep(70); // one tick establishes dt=0 before the key is pressed
  await page.evaluate("fixture.sent=[];fixture.choice='forward_short';document.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowUp',bubbles:true}))");
  await utterance();await sleep(350);
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').every(m=>m.p===0)"),true,'held intent blocks a still-zero keyboard ramp');
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'ArrowUp',bubbles:true}));fixture.freeze=null");
  // Status stays fresh while actual Normal telemetry ages out independently.
  await page.evaluate("fixture.modeTelemetry=false;fixture.sent=[];fixture.choice='forward_short'");
  await sleep(650);
  await utterance();await sleep(350);
  assert.ok(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').length")>=10,'fresh status and manual ticks continue while mode telemetry is stale');
  assert.equal(await page.evaluate("fixture.sent.filter(m=>m.t==='ctl').every(m=>m.p===0&&m.r===0&&m.y===0)"),true,'stale actual-mode telemetry blocks a valid voice result');
  assert.equal(await page.evaluate("document.getElementById('voice-state').dataset.phase"),'idle');
  await page.evaluate("fixture.modeTelemetry=true");
  // Relay origin never loads or exposes voice permission, capture or upload.
  await page.open(url+'?room=demo');
  assert.equal(await page.evaluate("typeof window.voiceLatency"),'undefined','trace absent without opt-in');
  await sleep(100);
  assert.equal(await page.evaluate("document.getElementById('btn-voice-ptt').disabled"),true);
  assert.match(await page.evaluate("document.getElementById('voice-unavailable').textContent"),/relay/);
  assert.deepEqual(page.errors,[]);
});


test('voice-enabled touch pads stay usable and stable across feedback and held-stick PTT', {timeout:90000}, async t => {
  const {page,url}=await voiceFixture(t,'touch');
  const metrics=async()=>JSON.parse(await page.evaluate(`JSON.stringify((()=>{
    const box=el=>el.getBoundingClientRect().toJSON();
    return {width:innerWidth,height:innerHeight,cockpit:box(document.querySelector('.cockpit')),
      pads:['stick-left','stick-right'].map(id=>box(document.getElementById(id))),
      buttons:[...document.querySelectorAll('.controls button, #voice-panel button')].filter(el=>!el.hidden).map(el=>({id:el.id,...box(el)})),
      panel:box(document.getElementById('voice-panel'))};
  })())`));
  const phase=()=>page.evaluate("document.getElementById('voice-state').dataset.phase");
  const press=()=>page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',bubbles:true}))");
  const release=()=>page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyV',bubbles:true}))");
  for(const width of [640,740,800,1024]) {
    await page.call('browsingContext.setViewport',{context:page.context,viewport:{width,height:360}});
    await page.open(url+'?measure');
    await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-prepare').disabled"),3000,'preflight ready');
    await page.evaluate("document.getElementById('btn-voice-prepare').click();document.getElementById('btn-take').click();fixture.execution='enabled';fixture.state='ARMED';fixture.socket.emit({t:'welcome',role:'pilot',session:2});fixture.socket.emit({t:'voice_ready',session:2,capability:'next'})");
    await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-ptt').disabled && document.getElementById('voice-badge').textContent==='Movimiento temporizado'"),3000,'enabled and prepared');
    await sleep(100);
    await page.evaluate('fixture.clock+=2000'); // past the established full-screen settling period
    await sleep(60);
    const baseline=await metrics();
    const stable=async label=>{
      const m=await metrics();
      for(let i=0;i<2;i++) {
        const p=m.pads[i],b=baseline.pads[i];
        assert.ok(p.height>=100 && p.width>=100,`${width}x360 ${label}: pad ${p.width}x${p.height}, voice footer ${m.panel.height}`);
        assert.ok(p.top>=m.cockpit.top-1 && p.bottom<=m.cockpit.bottom+1,`${width} ${label}: pad fits cockpit`);
        for(const key of ['left','top','width','height'])assert.ok(Math.abs(p[key]-b[key])<1,`${width} ${label}: pad ${i} ${key} moved (${b[key]} -> ${p[key]})`);
      }
      for(const b of m.buttons) {
        assert.ok(b.top>=m.cockpit.bottom-1 && b.bottom<=360 && b.left>=0 && b.right<=width,`${width} ${label}: ${b.id} outside visible footer`);
      }
      assert.equal(await page.evaluate("document.getElementById('deadman').textContent"),'',`${width} ${label}: stable feedback keeps engagement`);
    };
    await stable('prepared');
    for(const transcript of ['adelante','palabra '.repeat(125)]) {
      await page.evaluate(`fixture.transcript=${JSON.stringify(transcript)};fixture.delay=160;fixture.choice='forward_medium';fixture.sent=[]`);
      await page.evaluate("document.getElementById('btn-voice-ptt').click()");await sleep(40);await stable('button recording');
      await page.evaluate("document.getElementById('btn-voice-ptt').click()");
      await waitFor(async()=>await phase()==='processing',1000,'processing');await stable('processing');
      await waitFor(async()=>await phase()==='executing',2000,'executing');
      assert.equal(await page.evaluate("document.getElementById('voice-transcript').textContent"),transcript);
      await stable('execution transcript '+transcript.length);
      await waitFor(async()=>await phase()==='idle',2000,'completion');await stable('completion');
    }
    await page.evaluate("fixture.error='provider_timeout'");await press();await sleep(40);await release();
    await waitFor(()=>page.evaluate("document.getElementById('voice-state').textContent==='Sin acción: provider_timeout'"),2000,'provider error');
    await stable('provider error');
    await page.evaluate('fixture.error=null');await press();await sleep(40);
    await page.evaluate('fixture.recorder.onerror()');
    await waitFor(()=>page.evaluate("document.getElementById('voice-state').textContent==='Sin acción: capture_failed'"),1000,'capture error reaches UI');
    await stable('capture error');await release();
    await press();await sleep(40);await page.evaluate("document.getElementById('btn-voice-cancel').click()");
    await stable('cancellation');await release();
    // Keep one real touch on the throttle/yaw pad and attempt PTT with another finger.
    const left=baseline.pads[0], x=Math.round(left.x+left.width*.6),y=Math.round(left.y+left.height*.4);
    const ptt=JSON.parse(await page.evaluate("JSON.stringify(document.getElementById('btn-voice-ptt').getBoundingClientRect().toJSON())"));
    const touch=(id,actions)=>({type:'pointer',id,parameters:{pointerType:'touch'},actions});
    await page.call('input.performActions',{context:page.context,actions:[touch('stick',[
      {type:'pointerMove',x:Math.round(left.x+left.width/2),y:Math.round(left.y+left.height/2)},
      {type:'pointerDown',button:0},{type:'pointerMove',x,y},{type:'pause',duration:100}])]});
    const output=async()=>JSON.parse(await page.evaluate("JSON.stringify((({p,r,y,th,m,sp,tu})=>({p,r,y,th,m,sp,tu}))(fixture.sent.filter(m=>m.t==='ctl').at(-1)))"));
    const before=await output();assert.ok(before.y>0&&before.th>0,'held pad has deliberate manual output');
    await page.evaluate('fixture.sent=[]');
    await page.call('input.performActions',{context:page.context,actions:[touch('ptt',[
      {type:'pointerMove',x:Math.round(ptt.x+ptt.width/2),y:Math.round(ptt.y+ptt.height/2)},
      {type:'pointerDown',button:0},{type:'pause',duration:120},{type:'pointerUp',button:0}]),
      touch('stick',[{type:'pause',duration:100},{type:'pointerMove',x,y},{type:'pause',duration:120}])]});
    await sleep(150);await stable('held stick + PTT');
    const sent=JSON.parse(await page.evaluate("JSON.stringify(fixture.sent.filter(m=>m.t==='ctl').map(({p,r,y,th,m,sp,tu})=>({p,r,y,th,m,sp,tu})))"));
    assert.ok(sent.length>=5,'manual control ticks continue');
    for(const command of sent)assert.deepEqual(command,before,`${width}: PTT and feedback preserve held manual output`);
    await page.call('input.releaseActions',{context:page.context});
    // A deliberate content resize without any window event must use the same disengagement rule.
    await page.evaluate("document.getElementById('voice-panel').style.height='110px'");
    await waitFor(()=>page.evaluate("document.getElementById('deadman').textContent.includes('pantalla')"),2000,'content-driven geometry change disengages');
    t.diagnostic(`${width}x360: pads ${baseline.pads[0].width.toFixed(1)}px; voice footer ${baseline.panel.height.toFixed(1)}px`);
  }
  assert.deepEqual(page.errors,[]);
});

test('real gateway cookie, pilot voice_ready capability and audio HTTP upload with injected provider', {timeout:60000}, async t => {
  const repo=path.resolve(import.meta.dirname,'../..');
  const dir=tempDir('gcs-voice-real-');const procs=[];
  t.after(()=>{for(const p of procs)p.kill('SIGKILL');});
  const fake=start(procs,'python3',['-u','fake_tx_cli.py'],{cwd:path.join(repo,'core/tests/integration')});
  let channels=null;
  const lines=readline.createInterface({input:fake.stdout});
  const serial=await new Promise(resolve=>lines.once('line',line=>resolve(JSON.parse(line).path)));
  lines.on('line',line=>{const m=JSON.parse(line);if(m.ch)channels=m.ch;});
  const sock=path.join(dir,'core.sock');
  const config=path.join(dir,'core.conf');
  writeFileSync(config,`serial_device = ${serial}\nsocket_path = ${sock}\nrt_priority = 0\nrt_cpu = -1\n`);
  start(procs,path.join(repo,'core/build/crsf-core'),['-c',config]);
  await waitFor(()=>channels!==null,5000,'fake serial RC frames');
  let calls=0;
  const gw=await startGateway({...DEFAULTS,listen:{host:'127.0.0.1',port:0},coreSocket:sock,webRoot:path.join(repo,'web'),
    auth:{usersFile:await makeUsers(dir,[{name:'ana',password:'voice-password'}])},
    voice:{execution:'dry-run',shortMs:250,mediumMs:500,strength:50}},
    {voiceProvider:{recognize:async({audio,mime})=>{calls++;assert.equal(audio.toString(),'browser-fixture-audio');assert.equal(mime,'audio/webm;codecs=opus');return {choice:'forward_short',transcript:'adelante',timing:{transcriptionMs:1,decisionMs:1}};}}});
  t.after(()=>gw.close());
  await waitFor(()=>gw.core.connected,5000,'gateway core connection');
  const page=await firefox(procs,dir);t.after(()=>page.close());
  await fakeVoiceMedia(page);
  await openWithInputMode(page,`http://127.0.0.1:${gw.port}/`,'keyboard');
  await login(page,'ana','voice-password');
  await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-prepare').disabled"),5000,'authenticated voice config');
  await page.evaluate("document.hasFocus=()=>true;document.getElementById('btn-voice-prepare').click();document.getElementById('btn-take').click()");
  await waitFor(()=>page.evaluate("!document.getElementById('btn-voice-ptt').disabled"),3000,'prepared microphone');
  await waitFor(()=>page.evaluate("document.getElementById('btn-take').disabled"),3000,'deadman engaged');
  await page.evaluate('document.activeElement.blur()');
  await page.call('input.performActions',{context:page.context,actions:[{type:'key',id:'ptt',actions:[{type:'keyDown',value:'v'},{type:'pause',duration:80},{type:'keyUp',value:'v'}]}]});
  try { await waitFor(()=>calls===1,3000,'one authenticated HTTP upload'); }
  catch(error) { error.message += ' '+await page.evaluate("JSON.stringify({state:document.getElementById('voice-state').textContent,phase:document.getElementById('voice-state').dataset.phase,deadman:document.getElementById('deadman').textContent,active:document.activeElement.tagName,errors:document.getElementById('toast').textContent})");throw error; }
  await waitFor(()=>page.evaluate("document.getElementById('voice-transcript').textContent==='adelante'"),3000,'real response shown');
  assert.equal(await page.evaluate("document.getElementById('voice-state').textContent"),'Simulación: sin movimiento');
  assert.equal(channels[4],192,'voice never arms');
  assert.equal(channels[2],192,'dry-run preserves zero throttle');
  assert.equal(channels[1],992,'dry-run leaves pitch neutral');
  assert.deepEqual(page.errors,[]);
});
