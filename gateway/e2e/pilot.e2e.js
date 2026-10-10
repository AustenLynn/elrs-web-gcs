// End-to-end: the real pilot page in headless Firefox -> gateway -> crsf-core -> fake TX
// module. Needs: core built (make -C core), python3, firefox.   Run: npm run e2e
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { firefox, start, waitFor } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'gcs-e2e-'));
const procs = [];
const ARM = 4;
const SENSITIVITY = 6;   // fc_profile aquila20 (the default): CH7 is the drone's sensitivity, kept at S
const HIGH = 1792;
const LOW = 192;

after(() => { for (const p of procs) p.kill('SIGKILL'); });

test('pilot page arms the aircraft, fails safe when the page loses control, and recovers', { timeout: 90000 }, async () => {
  // 1. fake TX module on a pseudo-terminal
  const fake = start(procs, 'python3', ['-u', 'fake_tx_cli.py'], { cwd: path.join(repo, 'core/tests/integration') });
  let channels = null;
  const lines = readline.createInterface({ input: fake.stdout });
  const ptyPath = await new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l).path)));
  lines.on('line', (l) => { const m = JSON.parse(l); if (m.ch) channels = m.ch; });

  // 2. crsf-core on that pty (no real-time settings needed for the test)
  const sock = path.join(tmp, 'core.sock');
  writeFileSync(path.join(tmp, 'core.conf'), `serial_device = ${ptyPath}\nsocket_path = ${sock}\nrt_priority = 0\nrt_cpu = -1\n`);
  start(procs, path.join(repo, 'core/build/crsf-core'), ['-c', path.join(tmp, 'core.conf')]);
  await waitFor(() => channels !== null, 5000, 'RC frames from crsf-core');

  // 3. gateway serving the real web app
  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: sock, webRoot: path.join(repo, 'web') });
  after(() => gw.close());
  await waitFor(() => gw.core.connected, 5000, 'gateway -> core');

  // 4. headless Firefox
  const page = await firefox(procs, tmp);
  after(() => page.close());
  await page.open(`http://127.0.0.1:${gw.port}/`);

  // the page connects and shows state and telemetry from the (fake) aircraft
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'DESARMADO'"), 10000, 'DESARMADO on the page');
  // the failsafe banner is not on screen while disarmed (the attribute alone is not enough)
  assert.equal(await page.evaluate("getComputedStyle(document.getElementById('banner')).display"), 'none', 'banner hidden while DESARMADO');
  await waitFor(() => page.evaluate("document.getElementById('t-battery').textContent.startsWith('16.5 V')"), 5000, 'battery telemetry');
  // TX turns green once the module's timing-frame count is seen growing (a few statuses)
  await waitFor(() => page.evaluate("document.getElementById('seg-tx').dataset.health === 'ok'"), 2000, 'TX link green');

  // A headless window never has focus, and the dead-man (correctly) refuses to fly without
  // it, so the test stands in for the window manager: focused now, unfocused later.
  await page.evaluate('document.hasFocus = () => true');

  // take control, then press and hold ARM for 1.5 s with a real pointer
  await page.evaluate("document.getElementById('btn-take').click()");
  const box = JSON.parse(await page.evaluate("JSON.stringify(document.getElementById('btn-arm').getBoundingClientRect())"));
  await page.call('input.performActions', {
    context: page.context,
    actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 1500 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
  await waitFor(() => channels[ARM] === HIGH, 3000, 'ARM channel high');
  assert.equal(channels[SENSITIVITY], LOW, 'sensitivity must stay at S');
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'ARMADO'"), 3000, 'ARMADO on the page');

  // dead-man: the page loses focus -> it stops sending -> crsf-core fails safe, which on the
  // Aquila20 means ARM low (the drone disarms) while the link keeps running
  const t0 = Date.now();
  await page.evaluate("document.hasFocus = () => false; window.dispatchEvent(new Event('blur'))");
  await waitFor(() => channels[ARM] === LOW, 3000, 'ARM channel low (failsafe disarm)');
  assert.equal(channels[SENSITIVITY], LOW, 'sensitivity still S during failsafe');
  assert.ok(Date.now() - t0 < 1000, `failsafe took ${Date.now() - t0} ms`);
  await waitFor(() => page.evaluate("!document.getElementById('banner').hidden"), 3000, 'failsafe banner');
  assert.notEqual(await page.evaluate("getComputedStyle(document.getElementById('banner')).display"), 'none', 'banner rendered in FAILSAFE');

  // The way back, in the order the core checks it: control is the first step missing (the
  // page put every input back to zero, and the fake drone reports itself disarmed).
  const nextStep = () => page.evaluate("document.querySelector('#recovery li.next')?.textContent ?? ''");
  await waitFor(async () => /Tomar control/.test(await nextStep()), 2000, 'recovery: take control next');
  await page.evaluate("document.hasFocus = () => true");
  await page.evaluate("document.getElementById('btn-take').click()");
  await waitFor(async () => /Limpiar failsafe/.test(await nextStep()), 3000, 'recovery: clear the failsafe next');
  // Inputs stay at neutral, throttle 0, for the whole failsafe: holding W sends nothing more.
  await page.call('input.performActions', {
    context: page.context,
    actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: 'w' }, { type: 'pause', duration: 500 }, { type: 'keyUp', value: 'w' }] }],
  });
  assert.match(await page.evaluate("document.getElementById('ro-left').textContent"), /^Acel\. 0 %/, 'throttle held at 0 during the failsafe');
  const ack = JSON.parse(await page.evaluate("JSON.stringify(document.getElementById('btn-ack').getBoundingClientRect())"));
  await page.call('input.performActions', {
    context: page.context,
    actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(ack.x + ack.width / 2), y: Math.round(ack.y + ack.height / 2) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 2500 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'DESARMADO'"), 3000, 'DESARMADO after clearing');
  await waitFor(() => page.evaluate("getComputedStyle(document.getElementById('banner')).display === 'none'"), 1000, 'banner gone after clearing');

  assert.deepEqual(page.errors, [], 'no JavaScript errors on the page');
});
