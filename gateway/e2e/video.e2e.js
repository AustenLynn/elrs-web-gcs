// End-to-end video: MediaMTX with the hardware-encoded test pattern -> gateway WHEP proxy
// -> watch.html in headless Firefox. Skipped when MediaMTX is not installed
// (set MEDIAMTX=/path/to/mediamtx, default /opt/mediamtx/mediamtx).
// Firefox fetches its H.264 plugin on first use, hence the generous timeout.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { firefox, start, waitFor } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mediamtx = process.env.MEDIAMTX ?? '/opt/mediamtx/mediamtx';
const procs = [];
after(() => { for (const p of procs) p.kill('SIGKILL'); });

test('watch.html plays the test pattern through the gateway', { timeout: 120000, skip: !existsSync(mediamtx) && `no MediaMTX at ${mediamtx}` }, async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gcs-video-'));
  // the shipped config, moved to spare ports so a running gcs-video service is not disturbed
  const cfg = readFileSync(path.join(repo, 'deploy/video/mediamtx.yml'), 'utf8')
    // the test waits for the stream through the API, which the shipped config keeps off
    .replace('api: false', 'api: true')
    .replace('        path: fpv\n\npaths:', '        path: fpv\n      - action: api\n\npaths:')
    .replace('apiAddress: 127.0.0.1:9997', 'apiAddress: 127.0.0.1:19997')
    .replace('rtspAddress: 127.0.0.1:8554', 'rtspAddress: 127.0.0.1:18554')
    .replace('webrtcAddress: 127.0.0.1:8889', 'webrtcAddress: 127.0.0.1:18889')
    .replace('webrtcLocalUDPAddress: :8189', 'webrtcLocalUDPAddress: :18189')
    .replace('/opt/gcs/video/capture.sh', path.join(repo, 'deploy/video/capture.sh'));
  writeFileSync(path.join(tmp, 'mediamtx.yml'), cfg);
  start(procs, mediamtx, [path.join(tmp, 'mediamtx.yml')], { cwd: tmp, env: { ...process.env, VIDEO_SOURCE: 'test' } });
  await waitFor(async () => {
    try {
      return (await (await fetch('http://127.0.0.1:19997/v3/paths/get/fpv')).json()).ready === true;
    } catch {
      return false;
    }
  }, 20000, 'MediaMTX stream ready');

  const gw = await startGateway({
    ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: path.join(tmp, 'no-core.sock'),
    webRoot: path.join(repo, 'web'), video: { whep: 'http://127.0.0.1:18889/fpv/whep' },
  });
  after(() => gw.close());
  const page = await firefox(procs, tmp);
  after(() => page.close());
  await page.open(`http://127.0.0.1:${gw.port}/watch.html`);
  await waitFor(() => page.evaluate("/^1280×720 [1-9]/.test(document.getElementById('v-stats').textContent)"), 90000, '1280x720 frames on watch.html');
  assert.match(await page.evaluate("document.getElementById('v-stats').textContent"), /perdidos 0 · congelados 0/);
});
