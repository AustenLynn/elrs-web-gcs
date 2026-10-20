import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { UserStore } from '../src/users.js';

const cli = fileURLToPath(new URL('../src/users-cli.js', import.meta.url));
const run = (args, input = '') => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });

test('the CLI adds an admin, lists, changes a password and removes', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-cli-')), 'users.json');
  assert.equal(run([file, 'add', 'ana', '--admin'], 'correcthorse\ncorrecthorse\n').status, 0);
  assert.equal(run([file, 'add', 'luis'], 'batterystaple\nbatterystaple\n').status, 0);
  assert.equal(run([file, 'list']).stdout, 'ana (admin)\nluis\n');
  assert.equal(run([file, 'passwd', 'luis'], 'newpassword1\nnewpassword1\n').status, 0);
  let store = new UserStore(file);
  await store.load();
  assert.deepEqual(await store.verify('ana', 'correcthorse'), { name: 'ana', admin: true });
  assert.deepEqual(await store.verify('luis', 'newpassword1'), { name: 'luis', admin: false });
  assert.equal(run([file, 'remove', 'luis']).status, 0);
  store = new UserStore(file);
  await store.load();
  assert.deepEqual(store.list(), [{ name: 'ana', admin: true }]);
});

test('the CLI refuses mismatched passwords, duplicates and bad usage', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-cli-')), 'users.json');
  const mismatch = run([file, 'add', 'ana'], 'correcthorse\nother-thing\n');
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /do not match/);
  assert.equal(run([file, 'add', 'ana'], 'correcthorse\ncorrecthorse\n').status, 0);
  assert.match(run([file, 'add', 'ana'], 'correcthorse\ncorrecthorse\n').stderr, /already exists/);
  assert.equal(run([file]).status, 1);
});
