import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StatsLog, videoStats } from '../js/videostats.js';

const inbound = (extra) => ({ type: 'inbound-rtp', kind: 'video', framesReceived: 100, framesDecoded: 98, framesDropped: 0,
  freezeCount: 0, totalFreezesDuration: 0, packetsLost: 0, framesPerSecond: 30, jitterBufferDelay: 3, jitterBufferEmittedCount: 100,
  frameWidth: 1280, frameHeight: 720, ...extra });

test('picks the inbound video stream out of a stats report', () => {
  const s = videoStats([{ type: 'transport' }, { type: 'inbound-rtp', kind: 'audio' }, inbound({})]);
  assert.equal(s.framesDecoded, 98);
  assert.equal(s.jitterBufferMs, 30);
  assert.equal(s.width, 1280);
  assert.equal(videoStats([{ type: 'transport' }]), null);
});

// One sample per second, like watch.js: `frame(i)` gives the counters at second i.
function record(seconds, frame = (i) => ({ framesDecoded: 30 * i }), session = () => 1) {
  const log = new StatsLog();
  for (let i = 0; i <= seconds; i++) log.add(i * 1000, videoStats([inbound({ framesDecoded: 0, ...frame(i) })]), session(i));
  return log;
}

test('summary passes a clean 5-minute run and fails freezes, drops or short runs', () => {
  assert.deepEqual(record(300).summary(), { seconds: 300, framesDecoded: 9000, framesDropped: 0, freezes: 0, packetsLost: 0, problems: [], pass: true });
  assert.equal(record(300, (i) => ({ framesDecoded: 30 * i, freezeCount: i > 100 ? 1 : 0 })).summary().pass, false);
  assert.equal(record(300, (i) => ({ framesDecoded: 30 * i, framesDropped: i > 200 ? 3 : 0 })).summary().pass, false);
  assert.equal(record(60).summary().pass, false);
  assert.equal(new StatsLog().summary(), null);
});

test('a reconnect during the run fails it (counters of a new connection start from zero)', () => {
  const log = record(300, (i) => ({ framesDecoded: i < 70 ? 30 * i : 30 * (i - 70), freezeCount: i < 70 && i > 50 ? 2 : 0 }),
    (i) => (i < 70 ? 1 : 2));
  const s = log.summary();
  assert.equal(s.pass, false);
  assert.match(s.problems.join(' '), /reconnect/);
});

test('video that stalls with the connection still up fails the run', () => {
  // Chrome counts a freeze only when frames resume: a stall at the end shows no freeze.
  const s = record(300, (i) => ({ framesDecoded: 30 * Math.min(i, 200) })).summary();
  assert.equal(s.pass, false);
  assert.match(s.problems.join(' '), /no new frames/);
});

test('missing samples (no video, background tab) fail the run', () => {
  const log = record(300);
  log.rows.splice(100, 5);                         // 6 s without a sample
  const s = log.summary();
  assert.equal(s.pass, false);
  assert.match(s.problems.join(' '), /gap/);
});

test('a browser without freeze or drop counters cannot pass', () => {
  const log = new StatsLog();
  for (let i = 0; i <= 300; i++) {
    log.add(i * 1000, videoStats([inbound({ framesDecoded: 30 * i, freezeCount: undefined, framesDropped: undefined })]), 1);
  }
  const s = log.summary();
  assert.equal(s.pass, false);
  assert.match(s.problems.join(' '), /unknown/);
});

test('CSV has a header and one line per sample', () => {
  const log = new StatsLog();
  log.add(1000, videoStats([inbound({})]));
  log.add(2000, null);                       // no stats yet: skipped
  const lines = log.toCsv().trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^t,framesReceived,framesDecoded,framesDropped,freezeCount/);
  assert.match(lines[1], /^1000,100,98,0,0,0,0,30,30,1280,720,0$/);
});
