import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { startRelay } from '../src/server.js';

const ROOMS = { pi1: { bridgeToken: 'b'.repeat(64), pilotToken: 'p'.repeat(64) } };

test('over real WebSockets: only /relay upgrades, frames over 4 KiB are refused', async (t) => {
  const srv = await startRelay({ listen: { host: '127.0.0.1', port: 0 }, rooms: ROOMS });
  t.after(() => srv.close());
  const url = `ws://127.0.0.1:${srv.port}`;
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/other`);
    ws.once('open', resolve);
    ws.once('error', reject);
  }));
  const ws = new WebSocket(`${url}/relay`);
  await new Promise((resolve) => ws.once('open', resolve));
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.send(JSON.stringify({ t: 'hello', pad: 'x'.repeat(5000) }));
  assert.equal(await closed, 1009);
});
