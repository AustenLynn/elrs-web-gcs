import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startRelay } from '../../relay/src/server.js';
import { measureRtt } from '../../tools/relay-rtt.mjs';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';

const BRIDGE = 'b'.repeat(64);
const PILOT = 'p'.repeat(64);

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('relay-rtt measures round trips through the relay as an observer', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcs-rtt-'));
  const coreSock = path.join(dir, 'core.sock');
  const core = net.createServer(() => {});
  await new Promise((resolve) => core.listen(coreSock, resolve));
  t.after(() => core.close());
  const relay = await startRelay({ listen: { host: '127.0.0.1', port: 0 }, rooms: { pi1: { bridgeToken: BRIDGE, pilotToken: PILOT } } });
  t.after(() => relay.close());
  const gw = await startGateway({
    ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: coreSock, webRoot: dir,
    relay: { url: `ws://127.0.0.1:${relay.port}/relay`, room: 'pi1', token: BRIDGE },
  });
  t.after(() => gw.close());
  await waitFor(() => relay.relay.live.get('pi1')?.bridge);
  const r = await measureRtt({ url: `ws://127.0.0.1:${relay.port}/relay`, room: 'pi1', token: PILOT, seconds: 1, rateHz: 10 });
  assert.ok(r.sent >= 8 && r.received === r.sent, JSON.stringify(r));
  assert.ok(r.p50 > 0 && r.p50 < 100, JSON.stringify(r));
  await assert.rejects(measureRtt({ url: `ws://127.0.0.1:${relay.port}/relay`, room: 'pi1', token: 'x'.repeat(64), seconds: 1 }), /refused: 4003/);
});
