import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { whepProxy } from '../src/whep.js';

// Stand-in for MediaMTX's WHEP endpoint.
async function fakeMediamtx(t) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      if (req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/fpv/whep/abc-123', ETag: '*', 'Accept-Patch': 'application/trickle-ice-sdpfrag' });
        res.end('v=0 answer');
      } else {
        res.writeHead(204).end();
      }
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => srv.close());
  return { seen, url: `http://127.0.0.1:${srv.address().port}/fpv/whep` };
}

async function gateway(t, upstream) {
  const proxy = whepProxy(upstream);
  const srv = http.createServer(async (req, res) => {
    if (!(await proxy(req, res))) res.writeHead(404).end('not video');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}

test('offer is forwarded and the session location is rewritten', async (t) => {
  const up = await fakeMediamtx(t);
  const gw = await gateway(t, up.url);
  const res = await fetch(`${gw}/video/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0 offer' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('location'), '/video/whep/abc-123');
  assert.equal(res.headers.get('content-type'), 'application/sdp');
  assert.equal(await res.text(), 'v=0 answer');
  assert.deepEqual(up.seen[0], { method: 'POST', url: '/fpv/whep', type: 'application/sdp', body: 'v=0 offer' });
});

test('session updates and teardown go to the session URL', async (t) => {
  const up = await fakeMediamtx(t);
  const gw = await gateway(t, up.url);
  assert.equal((await fetch(`${gw}/video/whep/abc-123`, { method: 'PATCH', headers: { 'Content-Type': 'application/trickle-ice-sdpfrag' }, body: 'a=x' })).status, 204);
  assert.equal((await fetch(`${gw}/video/whep/abc-123`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(up.seen.map((s) => [s.method, s.url]), [['PATCH', '/fpv/whep/abc-123'], ['DELETE', '/fpv/whep/abc-123']]);
});

test('wrong methods, bad ids, huge bodies and other paths', async (t) => {
  const up = await fakeMediamtx(t);
  const gw = await gateway(t, up.url);
  assert.equal((await fetch(`${gw}/video/whep`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${gw}/video/whep/abc`, { method: 'POST', body: 'x' })).status, 405);
  assert.equal((await fetch(`${gw}/video/whep/a%2Fb`, { method: 'DELETE' })).status, 400);
  const big = 'x'.repeat(70 * 1024);
  const tooBig = await fetch(`${gw}/video/whep`, { method: 'POST', body: big }).catch(() => ({ status: 413 }));
  assert.equal(tooBig.status, 413);
  assert.equal((await fetch(`${gw}/index.html`)).status, 404);   // not ours: falls through
  assert.equal(up.seen.length, 0);
});

test('MediaMTX down gives 502', async (t) => {
  const gw = await gateway(t, 'http://127.0.0.1:1/fpv/whep');
  assert.equal((await fetch(`${gw}/video/whep`, { method: 'POST', body: 'v=0' })).status, 502);
});
