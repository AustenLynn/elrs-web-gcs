import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLanguage } from '../js/i18n.js';
const view = await import('../js/voiceview.js').catch(()=>({}));
test('visible readiness and errors follow locale while transcript stays literal', () => {
  assert.equal(typeof view.voiceFeedback,'function');
  const state={phase:'idle',error:'not_ready',reason:'not_normal',transcript:'<b>avanza</b>',choice:'none'};
  setLanguage('es');
  assert.equal(view.voiceFeedback(state).text,'Sin acción: Selecciona Normal');
  setLanguage('en');
  const result=view.voiceFeedback(state);
  assert.equal(result.text,'No action: Select Normal');
  assert.equal(result.title,'Select Normal mode and wait for confirmation.');
  assert.equal(result.transcript,'<b>avanza</b>');
  assert.equal(view.voiceFeedback({...state,error:'capture_failed'}).text,'No action: Microphone recording failed');
  assert.equal(view.voiceFeedback({...state,error:'unexpected_code'}).text,'No action: Voice request failed; try again');
});
test('recording guidance and interpreted choices translate without altering choices', () => {
  assert.equal(typeof view.voiceFeedback,'function');
  setLanguage('en');
  const state={phase:'recording',choice:'forward_short',transcript:'avanza'};
  assert.equal(view.voiceFeedback(state,{owner:'button',config:{shortMs:250}}).text,'Listening… tap Send');
  assert.equal(view.voiceFeedback(state,{config:{shortMs:250}}).action,'Forward · short · 250 ms');
  assert.equal(state.choice,'forward_short');
});
