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

test('summary passes a clean 5-minute run and fails freezes or drops', () => {
  const log = new StatsLog();
  log.add(0, videoStats([inbound({ framesDecoded: 10 })]));
  log.add(300000, videoStats([inbound({ framesDecoded: 9010 })]));
  assert.deepEqual(log.summary(), { seconds: 300, framesDecoded: 9000, framesDropped: 0, freezes: 0, packetsLost: 0, pass: true });

  const bad = new StatsLog();
  bad.add(0, videoStats([inbound({})]));
  bad.add(300000, videoStats([inbound({ framesDecoded: 9000, freezeCount: 1 })]));
  assert.equal(bad.summary().pass, false);

  const short = new StatsLog();
  short.add(0, videoStats([inbound({})]));
  short.add(60000, videoStats([inbound({ framesDecoded: 2000 })]));
  assert.equal(short.summary().pass, false);
  assert.equal(new StatsLog().summary(), null);
});

test('CSV has a header and one line per sample', () => {
  const log = new StatsLog();
  log.add(1000, videoStats([inbound({})]));
  log.add(2000, null);                       // no stats yet: skipped
  const lines = log.toCsv().trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^t,framesReceived,framesDecoded,framesDropped,freezeCount/);
  assert.match(lines[1], /^1000,100,98,0,0,0,0,30,30,1280,720$/);
});
