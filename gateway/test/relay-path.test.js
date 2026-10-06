// Remote pilot -> relay -> gateway (relay client) -> crsf-core (fake), all real sockets.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { startRelay } from '../../relay/src/server.js';
import { DEFAULTS } from '../src/config.js';
import { FrameReader, MSG } from '../src/ipc.js';
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

test('a remote pilot through the relay gets a session and controls the core', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcs-relay-'));
  writeFileSync(path.join(dir, 'index.html'), 'x');
  const received = [];
  const coreSock = path.join(dir, 'core.sock');
  const core = net.createServer((s) => {
    const r = new FrameReader();
    s.on('data', (d) => received.push(...r.push(d)));
  });
  await new Promise((resolve) => core.listen(coreSock, resolve));
  t.after(() => core.close());

  const relay = await startRelay({ listen: { host: '127.0.0.1', port: 0 }, rooms: { pi1: { bridgeToken: BRIDGE, pilotToken: PILOT } } });
  t.after(() => relay.close());
  const gw = await startGateway({
    ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: coreSock, webRoot: dir,
    relay: { url: `ws://127.0.0.1:${relay.port}/relay`, room: 'pi1', token: BRIDGE },
  });
  t.after(() => gw.close());
  await waitFor(() => gw.relay.connected && relay.relay.live.get('pi1')?.bridge);

  const pilot = new WebSocket(`ws://127.0.0.1:${relay.port}/relay`);
  const msgs = [];
  pilot.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((resolve) => pilot.once('open', resolve));
  pilot.send(JSON.stringify({ t: 'hello', role: 'pilot', room: 'pi1', token: PILOT }));
  await waitFor(() => msgs.some((m) => m.t === 'welcome'));
  assert.equal(msgs.find((m) => m.t === 'welcome').role, 'pilot');
  await waitFor(() => received.some((m) => m.type === MSG.SESSION));

  pilot.send(JSON.stringify({ t: 'ctl', seq: 1, ts: 0, r: 0, p: 0, y: 0, th: 0, m: 0 }));
  await waitFor(() => received.some((m) => m.type === MSG.CONTROL));

  pilot.close();
  await waitFor(() => received.some((m) => m.type === MSG.PILOT_LOST));
});

test('if the relay dies, the remote pilot is lost and the core is told at once', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcs-relay-'));
  const received = [];
  const coreSock = path.join(dir, 'core.sock');
  const core = net.createServer((s) => {
    const r = new FrameReader();
    s.on('data', (d) => received.push(...r.push(d)));
  });
  await new Promise((resolve) => core.listen(coreSock, resolve));
  t.after(() => core.close());
  const relay = await startRelay({ listen: { host: '127.0.0.1', port: 0 }, rooms: { pi1: { bridgeToken: BRIDGE, pilotToken: PILOT } } });
  const gw = await startGateway({
    ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: coreSock, webRoot: dir,
    relay: { url: `ws://127.0.0.1:${relay.port}/relay`, room: 'pi1', token: BRIDGE },
  });
  t.after(() => gw.close());
  await waitFor(() => relay.relay.live.get('pi1')?.bridge);
  const pilot = new WebSocket(`ws://127.0.0.1:${relay.port}/relay`);
  pilot.on('error', () => {});
  const msgs = [];
  pilot.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((resolve) => pilot.once('open', resolve));
  pilot.send(JSON.stringify({ t: 'hello', role: 'pilot', room: 'pi1', token: PILOT }));
  await waitFor(() => msgs.some((m) => m.t === 'welcome'));
  await relay.close();                                    // relay process dies
  await waitFor(() => received.some((m) => m.type === MSG.PILOT_LOST));
  await waitFor(() => !gw.relay.connected);
});
