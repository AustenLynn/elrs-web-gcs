import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openConnLog } from '../src/connlog.js';

test('a file log appends one JSON line per write, time first', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-log-')), 'events.jsonl');
  const log = openConnLog(file);
  log.write({ ev: 'join', name: 'ana', via: 'tunnel' });
  log.write({ ev: 'gap', name: 'ana', ms: 400 });
  await log.close();
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(Object.keys(lines[0])[0], 't');
  assert.ok(!Number.isNaN(Date.parse(lines[0].t)));
  assert.deepEqual({ ...lines[1], t: 0 }, { t: 0, ev: 'gap', name: 'ana', ms: 400 });
});

test('a null path writes to stdout with a gateway: prefix', async (t) => {
  const out = [];
  t.mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  const log = openConnLog(null);
  log.write({ ev: 'join' });
  await log.close();
  assert.equal(out.length, 1);
  assert.match(out[0], /^gateway: \{"t":"[^"]+","ev":"join"\}$/);
});

test('writing into a missing directory does not throw', async (t) => {
  const errs = [];
  t.mock.method(console, 'error', (...a) => errs.push(a));
  const log = openConnLog('/nonexistent-dir-gcs/events.jsonl');
  assert.doesNotThrow(() => { log.write({ ev: 'join' }); log.write({ ev: 'leave' }); });
  await new Promise((r) => setTimeout(r, 100));   // the open error is asynchronous
  await log.close();
  assert.equal(errs.length, 1);
});

test('lines are dropped, not queued, when the disk falls behind', async (t) => {
  const errs = [];
  t.mock.method(console, 'error', (...a) => errs.push(a));
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-log-')), 'events.jsonl');
  const log = openConnLog(file);
  for (let i = 0; i < 5000; i++) log.write({ ev: 'stale', pad: 'x'.repeat(100) });   // same tick: nothing drains
  await log.close();
  const n = readFileSync(file, 'utf8').trim().split('\n').length;
  assert.ok(n < 5000 && n > 100);
  assert.equal(errs.length, 1);
});
