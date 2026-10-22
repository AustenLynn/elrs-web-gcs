// End-to-end: the automatic handover. Two pilots (ana flying, luis standing by) in two headless
// Firefox profiles -> gateway -> crsf-core -> fake TX module. When ana's page goes away, or she
// lets go with Esc, luis gets the control and the aircraft neither disarms nor loses throttle.
// Needs: core built (make -C core), python3, firefox.   Run: npm run e2e
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { firefox, login, makeUsers, openWithInputMode, sleep, start, tempDir, waitFor } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const THROTTLE = 2;
const ARM = 4;
const HIGH = 1792;
const LOW = 192;
const FIVE_PERCENT = (HIGH - LOW) * 0.05;

/** One run: ana arms at about 30 % throttle, luis is ready; `dropAna` takes the control from her. */
async function handover(name, dropAna) {
  const procs = [];                        // this run's processes: killed at its end, so the next run starts on a quiet Pi
  try {
    await fly(procs, name, dropAna);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
  }
}

async function fly(procs, name, dropAna) {
  const tmp = tempDir(`gcs-e2e-${name}-`);
  const fake = start(procs, 'python3', ['-u', 'fake_tx_cli.py'], { cwd: path.join(repo, 'core/tests/integration') });
  const frames = [];                       // every RC frame the fake module received
  const lines = readline.createInterface({ input: fake.stdout });
  const ptyPath = await new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l).path)));
  lines.on('line', (l) => { const m = JSON.parse(l); if (m.ch) frames.push({ at: Date.now(), ch: m.ch }); });

  const sock = path.join(tmp, 'core.sock');
  writeFileSync(path.join(tmp, 'core.conf'), `serial_device = ${ptyPath}\nsocket_path = ${sock}\nrt_priority = 0\nrt_cpu = -1\n`);
  start(procs, path.join(repo, 'core/build/crsf-core'), ['-c', path.join(tmp, 'core.conf')]);
  await waitFor(() => frames.length > 0, 5000, 'RC frames from crsf-core');

  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: sock, webRoot: path.join(repo, 'web'),
    auth: { usersFile: await makeUsers(tmp, [{ name: 'ana', password: 'ana-password' }, { name: 'luis', password: 'luis-password' }]) } });
  after(() => gw.close());
  await waitFor(() => gw.core.connected, 5000, 'gateway -> core');
  const channels = () => frames.at(-1).ch;

  // a browser per pilot: each has its own profile, so its own session cookie
  const open = async (who, password) => {
    const page = await firefox(procs, path.join(tmp, who));
    after(() => page.close());
    await openWithInputMode(page, `http://127.0.0.1:${gw.port}/`, 'keyboard');
    await login(page, who, password);
    await page.evaluate('document.hasFocus = () => true');   // a headless window never has focus
    return page;
  };
  const text = (page, id) => page.evaluate(`document.getElementById('${id}').textContent`);
  const press = (page, value, ms) => page.call('input.performActions', {
    context: page.context,
    actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'pause', duration: ms }, { type: 'keyUp', value }] }],
  });

  // Both browsers start before anyone flies: a second Firefox starting up can stall the first
  // page for more than the 300 ms command timeout, which would fail safe (no standby yet).
  const ana = await open('ana', 'ana-password');
  await waitFor(() => ana.evaluate("!document.body.classList.contains('observer')"), 5000, 'ana is the pilot');
  const luis = await open('luis', 'luis-password');
  assert.ok(await luis.evaluate("document.body.classList.contains('queued')"), 'luis is queued behind ana');

  // ana flies: armed, throttle raised to about 30 %
  await ana.evaluate("document.getElementById('btn-take').click()");
  await press(ana, 'r', 1500);
  await waitFor(() => channels()[ARM] === HIGH, 3000, 'ARM high');
  await press(ana, 'w', 600);
  await waitFor(() => channels()[THROTTLE] > LOW + 0.2 * (HIGH - LOW), 3000, 'throttle raised');
  await sleep(300);

  // luis presses «Listo para tomar el control»

  await luis.evaluate("document.getElementById('btn-ready').click()");
  await waitFor(async () => /En espera: luis/.test(await text(ana, 'pilots')), 5000, 'luis registered as the standby');

  // the handover
  const before = frames.length;
  const lastThrottle = channels()[THROTTLE];
  const t0 = Date.now();
  if (dropAna) {
    ana.process.kill('SIGKILL');          // the tab is gone: its WebSocket closes
  } else {
    await press(ana, '\uE00C', 50);        // Escape
  }
  await waitFor(() => luis.evaluate("!document.getElementById('takeover').hidden"), 3000, 'luis shows TIENES EL CONTROL');
  assert.equal(await text(luis, 'takeover'), 'TIENES EL CONTROL');
  await waitFor(() => Date.now() - t0 > 1000, 2000, 'a second of frames after the handover');

  const during = frames.slice(before);
  const changes = during.map((f) => [f.at - t0, f.ch[ARM], f.ch[THROTTLE]]).filter((x, i, a) => i === 0 || x[1] !== a[i - 1][1] || x[2] !== a[i - 1][2]);
  assert.ok(during.every((f) => f.ch[ARM] === HIGH), `the aircraft saw ARM low: [ms, ARM, throttle] ${JSON.stringify(changes)}`);
  const first500 = during.filter((f) => f.at - t0 <= 500);
  assert.ok(first500.length > 5, `frames in the first 500 ms: ${first500.length}`);
  const lowest = Math.min(...first500.map((f) => f.ch[THROTTLE]));
  assert.ok(lowest >= lastThrottle - FIVE_PERCENT, `throttle dropped to ${lowest} (ana's last: ${lastThrottle})`);
  assert.ok(await luis.evaluate("!document.body.classList.contains('observer')"), 'luis is the pilot');
  assert.deepEqual(luis.errors, [], 'no JavaScript errors on luis\'s page');
}

test('closing the pilot page hands the control to the ready standby without dropping ARM or throttle', { timeout: 120000 }, () => handover('close', true));
test('the pilot letting go with Esc hands the control to the ready standby without dropping ARM or throttle', { timeout: 120000 }, () => handover('esc', false));
