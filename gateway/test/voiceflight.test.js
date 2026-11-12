import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceFlightState } from '../src/voiceflight.js';

const status = (extra={}) => ({session:42,state:'ARMED',out:{mode:0,turtle:0},...extra});
function setup() {
  let time=1000;
  const flight=new VoiceFlightState({now:()=>time});
  return {flight,time:t=>{time=t;},ready:()=>flight.readiness(42),seed(){flight.onStatus(status());flight.onControl({mode:0,turtle:0});flight.onLink({upLq:95});flight.onMode('S-NORMAL');}};
}
test('one actual Normal confirmation persists through quiet mode and continuous RF/status beyond one second',()=>{
  const s=setup();s.seed();
  for(let t=1100;t<=3000;t+=100){s.time(t);s.flight.onStatus(status());s.flight.onLink({upLq:95});assert.deepEqual(s.ready(),{ready:true,reason:'ready'});}
});
for(const order of ['mode-first','link-first'])test(`initial confirmation accepts ${order} receipt order`,()=>{
  const s=setup();s.flight.onStatus(status());
  if(order==='mode-first'){s.flight.onMode('S-NORMAL');s.flight.onLink({upLq:95});}
  else{s.flight.onLink({upLq:95});s.flight.onMode('S-NORMAL');}
  assert.equal(s.ready().ready,true);
});
for(const kind of ['core','link'])test(`${kind} exact 500ms expiry invalidates even when next receipt hides the gap`,()=>{
  const s=setup();s.seed();s.time(1500);
  if(kind==='core')s.flight.onLink({upLq:95});else s.flight.onStatus(status());
  assert.deepEqual(s.ready(),{ready:false,reason:kind==='core'?'core_stale':'link_stale'});
  s.flight.onStatus(status());s.flight.onLink({upLq:95});
  assert.deepEqual(s.ready(),{ready:false,reason:'normal_unconfirmed'});
  s.flight.onMode('S-NORMAL');assert.equal(s.ready().ready,true);
});
test('arrival after an unobserved stale gap cannot preserve a confirmation',()=>{
  const s=setup();s.seed();s.time(1500);s.flight.onStatus(status());s.flight.onLink({upLq:95});assert.equal(s.ready().reason,'normal_unconfirmed');
});
for(const lq of [0,-1,101,NaN,Infinity,undefined,'95'])test(`RF quality ${String(lq)} fails closed until new Normal after recovery`,()=>{
  const s=setup();s.seed();s.flight.onLink({upLq:lq});assert.deepEqual(s.ready(),{ready:false,reason:'link_lost'});
  s.flight.onMode('S-NORMAL');s.flight.onLink({upLq:95});assert.equal(s.ready().reason,'normal_unconfirmed');
  s.flight.onMode('S-NORMAL');assert.equal(s.ready().ready,true);
});
for(const mode of ['UNKNOWN','NORMAL','S-SPORT','S-TURTLE',''])test(`observed ${mode} rejects until actual Normal`,()=>{
  const s=setup();s.seed();s.flight.onMode(mode);assert.equal(s.ready().reason,'not_normal');s.flight.onMode('S-NORMAL');assert.equal(s.ready().ready,true);
});
for(const field of ['mode','turtle'])test(`rapid requested ${field} transitions invalidate without waiting for output status`,()=>{
  const s=setup();s.seed();s.flight.onControl({mode:field==='mode'?1:0,turtle:field==='turtle'?1:0});
  assert.equal(s.ready().reason,field==='mode'?'not_normal':'turtle_active');
  s.flight.onMode('S-NORMAL');s.flight.onControl({mode:0,turtle:0});assert.equal(s.ready().reason,'normal_unconfirmed');
  s.flight.onStatus(status());s.flight.onLink({upLq:95});assert.equal(s.ready().reason,'normal_unconfirmed');
  s.flight.onMode('S-NORMAL');assert.equal(s.ready().ready,true);
});
for(const state of ['HOLD','LANDING','FAILSAFE'])test(`entry to ${state} invalidates and cannot auto-arm`,()=>{
  const s=setup();s.seed();s.flight.onStatus(status({state}));assert.equal(s.ready().reason,'unsafe_state');s.flight.onStatus(status());assert.equal(s.ready().reason,'normal_unconfirmed');
});
test('initial disarmed Normal may confirm before manual arming',()=>{
  const s=setup();s.flight.onStatus(status({state:'DISARMED'}));s.flight.onLink({upLq:95});s.flight.onMode('S-NORMAL');assert.equal(s.ready().reason,'not_armed');s.flight.onStatus(status());assert.equal(s.ready().ready,true);
});
test('confirmed core snapshot before pilot login survives harmless session creation',()=>{
  const s=setup();s.flight.onStatus(status({state:'DISARMED',session:0}));s.flight.onLink({upLq:95});s.flight.onMode('S-NORMAL');
  assert.equal(s.ready().reason,'pilot_mismatch');
  s.time(1100);s.flight.onStatus(status({state:'DISARMED'}));s.flight.onControl({mode:0,turtle:0});
  assert.equal(s.ready().reason,'not_armed','a new pilot still must arm manually');
  s.time(1200);s.flight.onStatus(status());assert.deepEqual(s.ready(),{ready:true,reason:'ready'});
  assert.equal(s.flight.readiness(0).reason,'pilot_mismatch','session admission remains mandatory');
});
test('manual disarm and rearm preserve confirmed Normal while RF and targets stay live',()=>{
  const s=setup();s.seed();s.time(1100);s.flight.onStatus(status({state:'DISARMED'}));
  assert.equal(s.ready().reason,'not_armed');s.flight.onControl({mode:0,turtle:0});s.flight.onLink({upLq:95});
  s.time(1200);s.flight.onStatus(status());assert.deepEqual(s.ready(),{ready:true,reason:'ready'});
});
test('pilot ownership and on-air target/turtle remain mandatory',()=>{
  const s=setup();s.seed();assert.equal(s.flight.readiness(43).reason,'pilot_mismatch');
  s.flight.onStatus(status({out:{mode:1,turtle:0}}));assert.equal(s.ready().reason,'not_normal');
  s.flight.onStatus(status());assert.equal(s.ready().reason,'normal_unconfirmed');
  s.flight.onStatus(status({out:{mode:0,turtle:1}}));assert.equal(s.ready().reason,'turtle_active');
});
test('core reset clears all mode confirmation and RF history',()=>{
  const s=setup();s.seed();s.flight.reset();assert.equal(s.ready().reason,'core_stale');s.flight.onStatus(status());s.flight.onLink({upLq:95});assert.equal(s.ready().ready,false);s.flight.onMode('S-NORMAL');assert.equal(s.ready().ready,true);
});
for(const time of [999,NaN,Infinity])test(`invalid/backwards time ${time} rejects and invalidates`,()=>{
  const s=setup();s.seed();s.time(time);assert.equal(s.ready().ready,false);s.time(1100);s.flight.onStatus(status());s.flight.onLink({upLq:95});assert.equal(s.ready().reason,'normal_unconfirmed');
});

test('unknown non-operational core state needs recovery and a new Normal report',()=>{
  const s=setup();s.flight.onStatus(status({state:'UNKNOWN'}));s.flight.onLink({upLq:95});s.flight.onMode('S-NORMAL');assert.equal(s.ready().reason,'unsafe_state');s.flight.onStatus(status());assert.equal(s.ready().reason,'normal_unconfirmed');
});

test('invalidation epoch survives reconfirmation and resets but not benign transitions',()=>{
  const s=setup();s.seed();const epoch=s.flight.epoch;assert.ok(Number.isSafeInteger(epoch));
  s.flight.onStatus(status({state:'DISARMED',session:0}));s.flight.onStatus(status());s.flight.onLink({upLq:95});s.flight.onMode('S-NORMAL');
  assert.equal(s.flight.epoch,epoch);
  s.flight.onLink({upLq:0});s.flight.onLink({upLq:95});s.flight.onMode('S-NORMAL');
  assert.equal(s.ready().ready,true);assert.ok(s.flight.epoch>epoch);
  const recovered=s.flight.epoch;s.flight.reset();assert.ok(s.flight.epoch>recovered);
});
