import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCapture } from '../js/voicecapture.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup({pending=false,supported=true,bytes=5,delayedStop=false,stopThrows=false}={}) {let stopped=0,started=0,t=0;const recorders=[];const d=deferred();const stream={getTracks:()=>[{stop:()=>stopped++}]};class Recorder {static isTypeSupported(){return supported;} constructor(){this.state='inactive';recorders.push(this);} start(){started++;this.state='recording';} stop(){if(stopThrows)throw new Error('recorder stopped');this.state='inactive';this.ondataavailable?.({data:new Blob(['a'.repeat(bytes)])});if(!delayedStop)queueMicrotask(()=>this.onstop?.());}}const capture=new VoiceCapture({mediaDevices:{getUserMedia:()=>pending?d.promise:Promise.resolve(stream)},MediaRecorderClass:Recorder,now:()=>t});return {capture,d,stream,recorders,get stopped(){return stopped;},get started(){return started;},time:v=>t=v};}
test('permission resolving after release never records and stops tracks',async()=>{const s=setup({pending:true});const p=s.capture.press();assert.equal(await s.capture.release(),null);s.d.resolve(s.stream);await p;assert.equal(s.started,0);assert.equal(s.stopped,1);});
test('prepare releases tracks and repeated press records once',async()=>{const s=setup();await s.capture.prepare();assert.equal(s.stopped,1);await s.capture.press();await s.capture.press();assert.equal(s.started,1);const result=await s.capture.release();assert.equal(result.mime,'audio/webm;codecs=opus');assert.equal(s.stopped,2);});
test('cancel and overlong recordings discard chunks',async()=>{const s=setup();await s.capture.press();s.capture.cancel();assert.equal(await s.capture.release(),null);await s.capture.press();s.time(5001);assert.equal(await s.capture.release(),null);assert.equal(s.stopped,2);});
test('unsupported codecs explicitly fail',async()=>{await assert.rejects(setup({supported:false}).capture.prepare(),/unsupported_codec/);});

test('oversized chunks are discarded and tracks stopped',async()=>{const s=setup({bytes:524289});await s.capture.press();assert.equal(await s.capture.release(),null);assert.equal(s.stopped,1);});
test('late recorder stop cannot replace a new capture',async()=>{const s=setup({delayedStop:true});await s.capture.press();const old=s.capture.release();s.capture.cancel();assert.equal(await old,null);await s.capture.press();s.recorders[0].onstop();const fresh=s.capture.release();s.recorders[1].onstop();assert.ok(await fresh);assert.equal(s.stopped,2);});

test('recorder stop failure releases tracks and discards recording',async()=>{const s=setup({stopThrows:true});await s.capture.press();assert.equal(await s.capture.release(),null);assert.equal(s.stopped,1);});

test('queued error from canceled recorder cannot cancel a newer recording', async () => {
  const s = setup();
  await s.capture.press();
  const oldRecorder = s.recorders[0];
  s.capture.cancel();
  await s.capture.press();
  oldRecorder.onerror();
  assert.equal(s.stopped, 1, 'stale error must leave new microphone tracks running');
  assert.equal(s.recorders[1].state, 'recording');
  assert.ok(await s.capture.release());
  assert.equal(s.stopped, 2);
});

test('queued timeout from canceled press cannot cancel a newer recording', async (t) => {
  const callbacks = [];
  t.mock.method(globalThis, 'setTimeout', callback => {
    callbacks.push(callback);
    return 0;
  });
  const s = setup();
  await s.capture.press();
  s.capture.cancel();
  await s.capture.press();
  callbacks[0]();
  assert.equal(s.stopped, 1, 'stale timeout must leave new microphone tracks running');
  assert.equal(s.recorders[1].state, 'recording');
  assert.ok(await s.capture.release());
  assert.equal(s.stopped, 2);
});
