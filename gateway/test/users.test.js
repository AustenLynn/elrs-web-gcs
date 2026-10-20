import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UserStore } from '../src/users.js';

function tmpFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'gcs-users-')), 'users.json');
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => err.code === code);
}

test('add, then verify: right password gives the user, wrong or unknown gives null', async () => {
  const store = new UserStore(tmpFile());
  await store.load();
  await store.add('ana', 'correcthorse', true);
  await store.add('luis', 'batterystaple');
  assert.deepEqual(await store.verify('ana', 'correcthorse'), { name: 'ana', admin: true });
  assert.deepEqual(await store.verify('luis', 'batterystaple'), { name: 'luis', admin: false });
  assert.equal(await store.verify('ana', 'wrongpassword'), null);
  assert.equal(await store.verify('nobody', 'correcthorse'), null);
  assert.deepEqual(store.list(), [{ name: 'ana', admin: true }, { name: 'luis', admin: false }]);
  assert.equal(store.size, 2);
});

test('the file is mode 0600 and holds no plain password', async () => {
  const file = tmpFile();
  const store = new UserStore(file);
  await store.load();
  await store.add('ana', 'correcthorse');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, 'utf8').includes('correcthorse'));
});

test('bad name, short password and duplicate report their code', async () => {
  const store = new UserStore(tmpFile());
  await store.load();
  await rejectsWith(store.add('A', 'correcthorse'), 'bad_name');
  await rejectsWith(store.add('Ana', 'correcthorse'), 'bad_name');
  await rejectsWith(store.add('a'.repeat(21), 'correcthorse'), 'bad_name');
  await rejectsWith(store.add('ana', 'short'), 'bad_password');
  await store.add('ana', 'correcthorse');
  await rejectsWith(store.add('ana', 'correcthorse'), 'exists');
  await rejectsWith(store.setPassword('nobody', 'correcthorse'), 'unknown');
  await rejectsWith(store.setPassword('ana', 'short'), 'bad_password');
  await rejectsWith(store.remove('nobody'), 'unknown');
});

test('a reload from the file keeps users, passwords changes and removals', async () => {
  const file = tmpFile();
  const a = new UserStore(file);
  await a.load();
  await a.add('ana', 'correcthorse', true);
  await a.add('luis', 'batterystaple');
  await a.setPassword('ana', 'newpassword1');
  await a.remove('luis');
  const b = new UserStore(file);
  await b.load();
  assert.deepEqual(b.list(), [{ name: 'ana', admin: true }]);
  assert.equal(await b.verify('ana', 'correcthorse'), null);
  assert.deepEqual(await b.verify('ana', 'newpassword1'), { name: 'ana', admin: true });
});

test('a failing write leaves the original file and the in-memory users untouched', async (t) => {
  const file = tmpFile();
  const store = new UserStore(file);
  await store.load();
  await store.add('ana', 'correcthorse');
  const before = readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  chmodSync(dir, 0o500);                                  // read-only: the temp file cannot be created
  t.after(() => chmodSync(dir, 0o700));
  if (process.getuid?.() === 0) return t.skip('root ignores directory modes');
  await assert.rejects(store.add('luis', 'batterystaple'));
  chmodSync(dir, 0o700);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(store.list(), [{ name: 'ana', admin: false }]);
});

test('a missing file is an empty store', async () => {
  const store = new UserStore(tmpFile());
  await store.load();
  assert.equal(store.size, 0);
});
