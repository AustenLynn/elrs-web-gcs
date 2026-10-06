import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { DEFAULTS } from '../src/config.js';
import { FrameReader, MSG } from '../src/ipc.js';
import { startGateway } from '../src/server.js';

// A stand-in for crsf-core: records what the gateway sends, can push status.
async function fakeCore(dir) {
  const sockPath = path.join(dir, 'core.sock');
  const fake = { received: [], conn: null };
  const server = net.createServer((s) => {
    fake.conn = s;
    const r = new FrameReader();
    s.on('data', (d) => fake.received.push(...r.push(d)));
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  fake.path = sockPath;
  fake.close = () => new Promise((resolve) => { fake.conn?.destroy(); server.close(resolve); });
  return fake;
}

async function setup(t, { tls = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcs-gw-'));
  writeFileSync(path.join(dir, 'index.html'), '<h1>pilot</h1>');
  const core = await fakeCore(dir);
  let tlsCfg = null;
  if (tls) {
    tlsCfg = { cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') };
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-days', '1', '-subj', '/CN=localhost', '-keyout', tlsCfg.key, '-out', tlsCfg.cert], { stdio: 'ignore' });
  }
  const cfg = { ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, tls: tlsCfg, coreSocket: core.path, webRoot: dir };
  const gw = await startGateway(cfg);
  t.after(async () => { await gw.close(); await core.close(); });
  await waitFor(() => core.conn !== null);
  return { gw, core, base: `${tls ? 'https' : 'http'}://127.0.0.1:${gw.port}`, wsUrl: `${tls ? 'wss' : 'ws'}://127.0.0.1:${gw.port}/ws` };
}

async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Raw request: unlike fetch(), node:http sends the path exactly as given (no normalisation).
function rawStatus(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}

function connect(url, opts = {}) {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', reject);
  });
}

test('serves the web app and refuses to escape the web root', async (t) => {
  const { base, gw } = await setup(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await res.text(), '<h1>pilot</h1>');
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal(await rawStatus(gw.port, '/%2e%2e%2f%2e%2e%2fetc%2fpasswd'), 403);   // encoded slashes
  assert.equal(await rawStatus(gw.port, '/../../etc/passwd'), 404);                  // URL parser drops the dots
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});

test('pilot session end to end: hello, control, status, disconnect', async (t) => {
  const { core, wsUrl } = await setup(t);
  const pilot = await connect(wsUrl);
  pilot.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => pilot.msgs.some((m) => m.t === 'welcome'));
  const { session } = pilot.msgs.find((m) => m.t === 'welcome');
  await waitFor(() => core.received.some((m) => m.type === MSG.SESSION));
  assert.equal(core.received[0].payload.readUInt32LE(0), session);

  pilot.send({ t: 'ctl', seq: 1, ts: 0, r: 10, p: -20, y: 30, th: 400, m: 1 });
  await waitFor(() => core.received.some((m) => m.type === MSG.CONTROL));
  const c = core.received.find((m) => m.type === MSG.CONTROL).payload;
  assert.deepEqual([c.readUInt32LE(0), c.readUInt32LE(4), c.readInt16LE(8), c.readInt16LE(10), c.readInt16LE(12), c.readUInt16LE(14), c[16]],
    [session, 1, 10, -20, 30, 400, 1]);

  const status = Buffer.alloc(83);
  status.writeUInt16LE(81, 0);
  status[2] = MSG.STATUS;
  status[3] = 1; // ARMED
  core.conn.write(status);
  await waitFor(() => pilot.msgs.some((m) => m.t === 'status' && m.state === 'ARMED'));

  const observer = await connect(wsUrl);
  observer.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => observer.msgs.some((m) => m.t === 'welcome'));
  assert.equal(observer.msgs.find((m) => m.t === 'welcome').role, 'observer');

  pilot.ws.close();
  await waitFor(() => core.received.some((m) => m.type === MSG.PILOT_LOST));
  observer.ws.close();
});

test('HTTPS and secure WebSocket with the configured certificate', async (t) => {
  const { base, wsUrl } = await setup(t, { tls: true });
  assert.match(base, /^https:/);
  const client = await connect(wsUrl, { rejectUnauthorized: false });
  client.send({ t: 'hello', role: 'observer' });
  await waitFor(() => client.msgs.some((m) => m.t === 'welcome'));
  client.ws.close();
});

test('binary frames and invalid JSON are ignored without closing the socket', async (t) => {
  const { core, wsUrl } = await setup(t);
  const c = await connect(wsUrl);
  c.ws.send(Buffer.from([1, 2, 3]));
  c.ws.send('{not json');
  c.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => c.msgs.some((m) => m.t === 'welcome'));
  await waitFor(() => core.received.length === 1);
  assert.equal(core.received[0].type, MSG.SESSION);
  c.ws.close();
});

test('an oversized frame closes that socket and the gateway keeps running', async (t) => {
  const { wsUrl } = await setup(t);
  const bad = await connect(wsUrl);
  const closed = new Promise((resolve) => bad.ws.once('close', resolve));
  bad.ws.send('x'.repeat(5000));
  assert.equal(await closed, 1009);
  const good = await connect(wsUrl);
  good.send({ t: 'hello', role: 'observer' });
  await waitFor(() => good.msgs.some((m) => m.t === 'welcome'));
  good.ws.close();
});

test('only /ws accepts WebSocket upgrades', async (t) => {
  const { gw } = await setup(t);
  await assert.rejects(connect(`ws://127.0.0.1:${gw.port}/other`));
});

test('a malformed upgrade request is refused and the gateway keeps running', async (t) => {
  // "GET http://[" is not a parsable URL: it must not crash the process (anyone on the LAN
  // could otherwise kill the gateway and fail safe a flying aircraft).
  const { gw, wsUrl } = await setup(t);
  await new Promise((resolve) => {
    const s = net.connect(gw.port, '127.0.0.1', () => {
      s.write('GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('close', resolve);
    s.on('error', resolve);
    s.resume();
  });
  const good = await connect(wsUrl);
  good.send({ t: 'hello', role: 'observer' });
  await waitFor(() => good.msgs.some((m) => m.t === 'welcome'));
  good.ws.close();
});

test('WebSocket connections from another web origin are refused', async (t) => {
  // Any web page a LAN browser opens could otherwise take a free pilot seat.
  const { gw, wsUrl } = await setup(t);
  await assert.rejects(connect(wsUrl, { origin: 'https://evil.example' }), /403/);
  const same = await connect(wsUrl, { origin: `http://127.0.0.1:${gw.port}` });
  same.ws.close();
  const tool = await connect(wsUrl);                 // non-browser clients send no Origin
  tool.ws.close();
});

test('after the core reconnects, the connected pilot is given a new session', async (t) => {
  const { core, wsUrl } = await setup(t);
  const pilot = await connect(wsUrl);
  pilot.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => core.received.some((m) => m.type === MSG.SESSION));
  const first = core.received.find((m) => m.type === MSG.SESSION).payload.readUInt32LE(0);
  core.received.length = 0;
  core.conn.destroy();                               // crsf-core restarted or another client took the socket
  await waitFor(() => core.received.some((m) => m.type === MSG.SESSION), 3000);
  const second = core.received.find((m) => m.type === MSG.SESSION).payload.readUInt32LE(0);
  assert.notEqual(second, first);
  await waitFor(() => pilot.msgs.filter((m) => m.t === 'welcome').length === 2);
  assert.equal(pilot.msgs.filter((m) => m.t === 'welcome').at(-1).session, second);
  pilot.ws.close();
});

test('an exception while handling one message does not take the gateway down', async (t) => {
  // Backstop: whatever a bug in the hub throws, the other browsers and the core link survive.
  const { gw, wsUrl } = await setup(t);
  const bad = await connect(wsUrl);
  bad.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => bad.msgs.some((m) => m.t === 'welcome'));
  bad.send({ t: { toString: 1 } });
  await waitFor(() => bad.msgs.some((m) => m.t === 'error'));
  const handle = gw.hub.handle;
  gw.hub.handle = () => { throw new Error('bug'); };
  bad.send({ t: 'ping', id: 1, ts: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  gw.hub.handle = handle;
  const good = await connect(wsUrl);
  good.send({ t: 'hello', role: 'observer' });
  await waitFor(() => good.msgs.some((m) => m.t === 'welcome'));
  good.ws.close();
  bad.ws.close();
});

test('with video configured, the gateway serves WHEP at /video/whep and static files elsewhere', async (t) => {
  const up = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/fpv/whep/s1' });
      res.end('v=0 answer');
    });
  });
  await new Promise((resolve) => up.listen(0, '127.0.0.1', resolve));
  t.after(() => up.close());
  const dir = mkdtempSync(path.join(tmpdir(), 'gcs-gw-'));
  writeFileSync(path.join(dir, 'index.html'), '<h1>pilot</h1>');
  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: path.join(dir, 'none.sock'),
    webRoot: dir, video: { whep: `http://127.0.0.1:${up.address().port}/fpv/whep` } });
  t.after(() => gw.close());
  const base = `http://127.0.0.1:${gw.port}`;
  const res = await fetch(`${base}/video/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0 offer' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('location'), '/video/whep/s1');
  assert.equal(await (await fetch(`${base}/`)).text(), '<h1>pilot</h1>');
});
