import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTrace } from '../js/voicetrace.js';

test('voice trace bounds memory and only retains finite approved timing fields', () => {
  const trace = new VoiceTrace({now:()=>123});
  for(let i=0;i<600;i++)trace.record('release',{durationMs:i,transcript:'secret',capability:'secret',audio:'secret'});
  const rows=trace.snapshot();
  assert.equal(rows.length,512);
  assert.deepEqual(rows.at(-1),{event:'release',atMs:123,durationMs:599});
  trace.record('unknown',{durationMs:1});
  trace.record('decision',{durationMs:NaN});
  assert.deepEqual(trace.snapshot().at(-1),{event:'decision',atMs:123});
  rows[0].event='mutated';
  assert.equal(trace.snapshot()[0].event,'release');
  trace.clear();assert.deepEqual(trace.snapshot(),[]);
});
