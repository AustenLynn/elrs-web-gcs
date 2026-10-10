// End-to-end: flying with the keyboard input mode. The real pilot page in headless Firefox ->
// gateway -> crsf-core -> fake TX module, with real key presses (WebDriver BiDi input actions).
// Needs: core built (make -C core), python3, firefox.   Run: npm run e2e
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { firefox, openWithInputMode, sleep, start, waitFor } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'gcs-e2e-kbd-'));
const procs = [];
const THROTTLE = 2;
const ARM = 4;
const HIGH = 1792;
const LOW = 192;

after(() => { for (const p of procs) p.kill('SIGKILL'); });

test('keyboard mode: hold R arms, W raises and holds the throttle, Space disarms; step mode keys move 5 % per press', { timeout: 90000 }, async () => {
  const fake = start(procs, 'python3', ['-u', 'fake_tx_cli.py'], { cwd: path.join(repo, 'core/tests/integration') });
  let channels = null;
  const lines = readline.createInterface({ input: fake.stdout });
  const ptyPath = await new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l).path)));
  lines.on('line', (l) => { const m = JSON.parse(l); if (m.ch) channels = m.ch; });

  const sock = path.join(tmp, 'core.sock');
  writeFileSync(path.join(tmp, 'core.conf'), `serial_device = ${ptyPath}\nsocket_path = ${sock}\nrt_priority = 0\nrt_cpu = -1\n`);
  start(procs, path.join(repo, 'core/build/crsf-core'), ['-c', path.join(tmp, 'core.conf')]);
  await waitFor(() => channels !== null, 5000, 'RC frames from crsf-core');

  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: sock, webRoot: path.join(repo, 'web') });
  after(() => gw.close());
  await waitFor(() => gw.core.connected, 5000, 'gateway -> core');

  const page = await firefox(procs, tmp);
  after(() => page.close());
  await openWithInputMode(page, `http://127.0.0.1:${gw.port}/`, 'keyboard');
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'DESARMADO'"), 10000, 'DESARMADO on the page');
  assert.equal(await page.evaluate("document.querySelector('[data-input=\"keyboard\"]').classList.contains('on')"), true);

  // A headless window never has focus (see pilot.e2e.js): stand in for the window manager.
  await page.evaluate('document.hasFocus = () => true');
  await page.evaluate("document.getElementById('btn-take').click()");
  const hold = (value, ms) => page.call('input.performActions', {
    context: page.context,
    actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'pause', duration: ms }, { type: 'keyUp', value }] }],
  });

  await hold('r', 1500);
  await waitFor(() => channels[ARM] === HIGH, 3000, 'ARM channel high after holding R');
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'ARMADO'"), 3000, 'ARMADO on the page');

  await hold('w', 600);
  await waitFor(() => channels[THROTTLE] > LOW + 200, 2000, 'throttle up after holding W');
  const throttle = channels[THROTTLE];
  await sleep(500);
  assert.ok(channels[THROTTLE] >= throttle - 2, `throttle must hold after W is released (${throttle} -> ${channels[THROTTLE]})`);

  await hold(' ', 50);
  await waitFor(() => channels[ARM] === LOW, 2000, 'ARM channel low after Space');
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'DESARMADO'"), 3000, 'DESARMADO after Space');

  // Step mode ("Prueba"): the same flight keys move one step (5 %) per press.
  await page.evaluate("document.querySelector('[data-input=\"step\"]').click()");
  const value = (axis) => page.evaluate(`document.querySelector('#panel-step [data-axis="${axis}"] input').value`);
  await waitFor(async () => (await value('throttle')) === '0', 2000, 'step panel shown at neutral');
  await hold('w', 50);
  await hold('w', 50);
  await hold('\uE013', 50);                          // ArrowUp
  await hold('a', 50);
  await waitFor(async () => (await value('throttle')) === '10', 2000, 'throttle 10 % after W twice');
  assert.equal(await value('pitch'), '5', 'pitch 5 % after one ArrowUp');
  assert.equal(await value('yaw'), '-5', 'yaw -5 % after one A');

  assert.deepEqual(page.errors, [], 'no JavaScript errors on the page');
});
