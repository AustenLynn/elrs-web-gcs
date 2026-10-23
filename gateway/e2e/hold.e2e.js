// End-to-end: hold, then land. Two pilots (ana flying, luis at the head of the queue) in two
// headless Firefox profiles -> gateway -> crsf-core -> fake TX module. When ana's commands stop
// (her page goes away, or she lets go with Esc), the core holds at hold_throttle with ARM high;
// luis can take the control from the banner, or nobody chooses and the core lands by itself.
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
// R7 browser e2e values (test values, never flight values)
const HOLD_MS = 3000;
const LAND_MS = 1000;
const HOLD_THROTTLE = 450;                 // per mille
const HT = LOW + (HIGH - LOW) * 0.45;      // hold_throttle on the air
const TOLERANCE_MS = 300;

/** One run: its processes are killed at its end, so the next run starts on a quiet Pi. */
async function run(name, scenario) {
  const procs = [];
  try {
    await scenario(await setUp(procs, name));
  } finally {
    for (const p of procs) p.kill('SIGKILL');
  }
}

/** Fake TX, core with the hold on, gateway, and two signed-in pilots: ana flying at about 30 %
 *  throttle, luis queued behind her (the queue head, so he can take during a hold). */
async function setUp(procs, name) {
  const tmp = tempDir(`gcs-e2e-${name}-`);
  const fake = start(procs, 'python3', ['-u', 'fake_tx_cli.py'], { cwd: path.join(repo, 'core/tests/integration') });
  const frames = [];                       // every RC frame the fake module received
  const lines = readline.createInterface({ input: fake.stdout });
  const ptyPath = await new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l).path)));
  lines.on('line', (l) => { const m = JSON.parse(l); if (m.ch) frames.push({ at: Date.now(), ch: m.ch }); });

  const sock = path.join(tmp, 'core.sock');
  writeFileSync(path.join(tmp, 'core.conf'), `serial_device = ${ptyPath}\nsocket_path = ${sock}\nrt_priority = 0\nrt_cpu = -1\n`
    + `hold_ms = ${HOLD_MS}\nland_ms = ${LAND_MS}\nhold_throttle = ${HOLD_THROTTLE}\n`);
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
  const press = (page, value, ms) => page.call('input.performActions', {
    context: page.context,
    actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'pause', duration: ms }, { type: 'keyUp', value }] }],
  });

  // Both browsers start before anyone flies: a second Firefox starting up can stall the first
  // page for more than the 300 ms command timeout.
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
  await waitFor(async () => /Estás en espera/.test(await text(luis, 'queue-text')), 5000, 'luis is the queue head');

  return { frames, channels, ana, luis, press };
}

const text = (page, id) => page.evaluate(`document.getElementById('${id}').textContent`);

/** [ms since t0, ARM, throttle] at every change: the evidence in a failure message. */
const changes = (frames, t0) => frames.map((f) => [f.at - t0, f.ch[ARM], f.ch[THROTTLE]])
  .filter((x, i, a) => i === 0 || x[1] !== a[i - 1][1] || x[2] !== a[i - 1][2]);

/** ana's commands stop (`dropAna`); luis takes from the banner during the hold. */
async function takeDuringHold({ frames, channels, ana, luis, press }, dropAna) {
  const before = frames.length;
  const t0 = Date.now();
  await dropAna(ana, press);

  await waitFor(() => luis.evaluate("!document.getElementById('hold-banner').hidden"
    + " && !document.getElementById('btn-hold-take').hidden && !document.getElementById('btn-hold-take').disabled"),
  HOLD_MS, 'luis sees the hold banner with «Tomar el control»');
  assert.match(await text(luis, 'hold-text'), /^ana perdió la conexión · aterriza en \d s$/);
  assert.ok(Math.abs(channels()[THROTTLE] - HT) <= FIVE_PERCENT, `holding at ${channels()[THROTTLE]}, expected about ${HT}`);
  const tTake = Date.now();
  await luis.evaluate("document.getElementById('btn-hold-take').click()");
  await waitFor(() => luis.evaluate("!document.getElementById('takeover').hidden"), 3000, 'luis shows TIENES EL CONTROL');
  assert.equal(await text(luis, 'takeover'), 'TIENES EL CONTROL');
  await waitFor(() => Date.now() - tTake > 1000, 2000, 'a second of frames after the take');

  const during = frames.slice(before);
  assert.ok(during.every((f) => f.ch[ARM] === HIGH), `the aircraft saw ARM low: [ms, ARM, throttle] ${JSON.stringify(changes(during, t0))}`);
  const first500 = during.filter((f) => f.at >= tTake && f.at - tTake <= 500);
  assert.ok(first500.length > 5, `frames in the 500 ms after the take: ${first500.length}`);
  const off = first500.filter((f) => Math.abs(f.ch[THROTTLE] - HT) > FIVE_PERCENT);
  assert.deepEqual(off.map((f) => [f.at - tTake, f.ch[THROTTLE]]), [], `throttle left ${HT} ± 5 % after the take (take at ${tTake - t0} ms): ${JSON.stringify(changes(during, t0))}`);
  assert.ok(await luis.evaluate("!document.body.classList.contains('observer')"), 'luis is the pilot');
  assert.deepEqual(luis.errors, [], 'no JavaScript errors on luis\'s page');
}

test('closing the pilot page: luis takes during the hold, ARM never drops, the throttle starts at the hold value', { timeout: 120000 }, () => run('hold-close', (s) => takeDuringHold(s, async (ana) => {
  ana.process.kill('SIGKILL');            // the tab is gone: its WebSocket closes
})));

test('ana lets go with Esc: same as above', { timeout: 120000 }, () => run('hold-esc', async (s) => {
  await takeDuringHold(s, (ana, press) => press(ana, '', 50));   // Escape
  // ana's page stayed connected: she is told who flies now
  const lost = 'Perdiste el control: ahora vuela luis';
  await waitFor(async () => (await text(s.ana, 'toast')) === lost || (await text(s.ana, 'queue-text')) === lost, 3000, `ana sees «${lost}»`);
  assert.ok(await s.ana.evaluate("document.body.classList.contains('queued')"), 'ana is back in the queue');
  assert.deepEqual(s.ana.errors, [], 'no JavaScript errors on ana\'s page');
}));

test('nobody chooses: hold, landing, then ARM low on time', { timeout: 120000 }, () => run('hold-land', async ({ frames, ana, luis }) => {
  const before = frames.length;
  const t0 = Date.now();
  ana.process.kill('SIGKILL');
  await waitFor(() => frames.at(-1).ch[ARM] !== HIGH, HOLD_MS + LAND_MS + 3000, 'ARM low after the landing');
  await sleep(200);

  const during = frames.slice(before);
  const evidence = `[ms, ARM, throttle] ${JSON.stringify(changes(during, t0))}`;
  const holdAt = during.findIndex((f) => Math.abs(f.ch[THROTTLE] - HT) <= FIVE_PERCENT);
  assert.ok(holdAt >= 0, `no hold at ${HT}: ${evidence}`);
  const landAt = during.findIndex((f, i) => i > holdAt && f.ch[THROTTLE] !== during[holdAt].ch[THROTTLE]);
  assert.ok(landAt > holdAt, `no landing after the hold: ${evidence}`);
  const lowAt = during.findIndex((f) => f.ch[ARM] !== HIGH);
  assert.ok(lowAt > landAt, `ARM dropped before the landing: ${evidence}`);

  const hold = during.slice(holdAt, landAt);
  assert.ok(hold.every((f) => f.ch[ARM] === HIGH && Math.abs(f.ch[THROTTLE] - HT) <= FIVE_PERCENT), `hold: ${evidence}`);
  const landing = during.slice(landAt, lowAt);
  assert.ok(landing.every((f) => f.ch[ARM] === HIGH && f.ch[THROTTLE] === LOW), `landing at LOW with ARM high: ${evidence}`);
  const holdMs = during[landAt].at - during[holdAt].at;
  const landMs = during[lowAt].at - during[landAt].at;
  assert.ok(Math.abs(holdMs - HOLD_MS) <= TOLERANCE_MS, `hold lasted ${holdMs} ms: ${evidence}`);
  assert.ok(Math.abs(landMs - LAND_MS) <= TOLERANCE_MS, `landing lasted ${landMs} ms: ${evidence}`);
  assert.deepEqual(luis.errors, [], 'no JavaScript errors on luis\'s page');
}));
