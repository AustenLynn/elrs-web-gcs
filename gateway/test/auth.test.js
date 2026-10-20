import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { authRoutes, cookieToken, LoginLimiter, Sessions } from '../src/auth.js';
import { UserStore } from '../src/users.js';

async function fixture({ secure = false, now = Date.now } = {}) {
  const users = new UserStore(path.join(mkdtempSync(path.join(tmpdir(), 'gcs-auth-')), 'users.json'));
  await users.load();
  await users.add('ana', 'correcthorse', true);
  const sessions = new Sessions({ now });
  const limiter = new LoginLimiter({ now });
  const routes = authRoutes({ users, sessions, limiter, secure, hub: null });
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = { 'Content-Type': 'application/json' }) =>
    fetch(base + p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { users, sessions, limiter, base, port: server.address().port, post, close: () => new Promise((r) => server.close(r)) };
}

test('login sets an HttpOnly SameSite=Strict cookie for 12 h, Secure only when asked', async (t) => {
  const plain = await fixture();
  t.after(plain.close);
  const res = await plain.post('/login', { name: 'ana', password: 'correcthorse' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'ana', admin: true });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^gcs_session=[0-9a-f]{64};/);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(cookie.includes(part), part);
  assert.ok(!cookie.includes('Secure'));

  const tls = await fixture({ secure: true });
  t.after(tls.close);
  const res2 = await tls.post('/login', { name: 'ana', password: 'correcthorse' });
  assert.ok(res2.headers.get('set-cookie').includes('Secure'));
});

test('/me answers the signed-in user, or 401 with noUsers', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const login = await f.post('/login', { name: 'ana', password: 'correcthorse' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await fetch(`${f.base}/me`, { headers: { cookie } });
  assert.deepEqual(await me.json(), { name: 'ana', admin: true });
  const anon = await fetch(`${f.base}/me`);
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { noUsers: false });
  await f.users.remove('ana');
  assert.deepEqual(await (await fetch(`${f.base}/me`)).json(), { noUsers: true });
});

test('logout clears the cookie and ends the session', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const login = await f.post('/login', { name: 'ana', password: 'correcthorse' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const out = await fetch(`${f.base}/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${f.base}/me`, { headers: { cookie } })).status, 401);
});

test('wrong password is 401; bad bodies are 413, 415 and 400; other paths are not handled', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.post('/login', { name: 'ana', password: 'nope-nope' })).status, 401);
  assert.equal((await f.post('/login', { name: 'x'.repeat(5000), password: 'x' })).status, 413);
  assert.equal((await f.post('/login', 'name=ana', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('/login', '{not json')).status, 400);
  assert.equal((await f.post('/login', { name: 1, password: 2 })).status, 400);
  assert.equal((await fetch(`${f.base}/login`)).status, 405);
  assert.equal((await fetch(`${f.base}/other`)).status, 404);
});

test('unknown or expired cookie is a spectator', () => {
  let t = 1000;
  const sessions = new Sessions({ ttlMs: 500, now: () => t });
  const token = sessions.create({ name: 'ana', admin: true });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual(sessions.get(token), { name: 'ana', admin: true });
  assert.equal(sessions.get('f'.repeat(64)), null);
  assert.equal(sessions.get(null), null);
  t += 501;
  assert.equal(sessions.get(token), null);
});

test('endUser invalidates every token of that user, delete just one', () => {
  const sessions = new Sessions();
  const a1 = sessions.create({ name: 'ana', admin: true });
  const a2 = sessions.create({ name: 'ana', admin: true });
  const l1 = sessions.create({ name: 'luis', admin: false });
  sessions.delete(a1);
  assert.equal(sessions.get(a1), null);
  assert.ok(sessions.get(a2));
  sessions.endUser('ana');
  assert.equal(sessions.get(a2), null);
  assert.ok(sessions.get(l1));
});

test('a sixth failed login in 60 s is 429 even with the right password, allowed after the window', async (t) => {
  let now = 10_000;
  const f = await fixture({ now: () => now });
  t.after(f.close);
  for (let i = 0; i < 5; i++) assert.equal((await f.post('/login', { name: 'ana', password: 'wrong-pass' })).status, 401);
  assert.equal((await f.post('/login', { name: 'ana', password: 'correcthorse' })).status, 429);
  now += 60_001;
  assert.equal((await f.post('/login', { name: 'ana', password: 'correcthorse' })).status, 200);
});

test('parallel wrong logins for one name: at most 5 are checked, the rest get 429', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const statuses = await Promise.all(Array.from({ length: 30 }, () =>
    f.post('/login', { name: 'ana', password: 'wrong-pass' }).then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 25);
});

test('behind the tunnel (loopback peer) the address counter keys on CF-Connecting-IP', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const h = (ip) => ({ 'Content-Type': 'application/json', 'CF-Connecting-IP': ip });
  for (let i = 0; i < 5; i++) await f.post('/login', { name: `u${i}-x`, password: 'wrong-pass' }, h('9.9.9.9'));
  assert.equal((await f.post('/login', { name: 'fresh-user', password: 'wrong-pass' }, h('9.9.9.9'))).status, 429);
  assert.equal((await f.post('/login', { name: 'ana', password: 'correcthorse' }, h('8.8.8.8'))).status, 200);
});

test('a client that aborts the login body does not take the gateway down', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await new Promise((resolve) => {
    const s = net.connect(f.port, '127.0.0.1', () => {
      s.write('POST /login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"name":');
      setTimeout(() => { s.destroy(); resolve(); }, 50);
    });
    s.on('error', () => {});
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await fetch(`${f.base}/me`)).status, 401);
});

test('the limiter counts per name and per address', () => {
  const l = new LoginLimiter({ now: () => 0 });
  for (let i = 0; i < 5; i++) l.fail('ana', '1.1.1.1');
  assert.ok(l.blocked('ana', '2.2.2.2'));       // same name, other address
  assert.ok(l.blocked('luis', '1.1.1.1'));      // same address, other name
  assert.ok(!l.blocked('luis', '2.2.2.2'));
  l.ok('ana', '1.1.1.1');
  assert.ok(!l.blocked('ana', '2.2.2.2'));
  assert.ok(!l.blocked('luis', '1.1.1.1'));       // ok() clears the address counter too
});

test('cookieToken reads gcs_session from the Cookie header', () => {
  assert.equal(cookieToken({ headers: { cookie: 'a=1; gcs_session=abc123; b=2' } }), 'abc123');
  assert.equal(cookieToken({ headers: { cookie: 'a=1' } }), null);
  assert.equal(cookieToken({ headers: {} }), null);
});
