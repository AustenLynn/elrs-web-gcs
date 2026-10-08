// The pilot page at phone sizes (landscape): no control button may sit over the cockpit,
// where a thumb working a stick could hit "Desarmar" or "FAILSAFE" by accident.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { firefox } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const procs = [];
after(() => { for (const p of procs) p.kill('SIGKILL'); });

test('control buttons stay out of the cockpit on landscape phone screens', { timeout: 90000 }, async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gcs-layout-'));
  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 },
    coreSocket: path.join(tmp, 'no-core.sock'), webRoot: path.join(repo, 'web') });
  after(() => gw.close());
  const page = await firefox(procs, tmp);
  after(() => page.close());
  for (const [width, height] of [[800, 360], [740, 360], [640, 360]]) {
    await page.call('browsingContext.setViewport', { context: page.context, viewport: { width, height } });
    await page.open(`http://127.0.0.1:${gw.port}/`);
    const m = JSON.parse(await page.evaluate(`JSON.stringify((() => {
      const r = (el) => el.getBoundingClientRect();
      const cockpit = r(document.querySelector('.cockpit'));
      const buttons = [...document.querySelectorAll('.controls button')].map((b) => ({ id: b.id || b.textContent, ...r(b).toJSON() }));
      const pads = ['stick-left', 'stick-right'].map((id) => r(document.getElementById(id)));
      return { cockpitBottom: cockpit.bottom, cockpitTop: cockpit.top, buttons, pads, vh: innerHeight };
    })())`));
    for (const p of m.pads) {
      assert.ok(p.top >= m.cockpitTop - 1 && p.bottom <= m.cockpitBottom + 1, `${width}x${height}: a stick pad does not fit the cockpit`);
      assert.ok(p.height >= 100, `${width}x${height}: stick pad only ${p.height} px tall`);
    }
    for (const b of m.buttons) {
      assert.ok(b.top >= m.cockpitBottom - 1, `${width}x${height}: "${b.id}" top ${b.top} is over the cockpit (ends ${m.cockpitBottom})`);
      assert.ok(b.bottom <= m.vh + 1, `${width}x${height}: "${b.id}" bottom ${b.bottom} is off screen (${m.vh})`);
    }
  }
});

test('"Tomar control" survives the full-screen transition; a later layout change ends control', { timeout: 90000 }, async () => {
  // Chrome on a Mac resizes the page for ~1 s after requestFullscreen(): that must not drop
  // control (found on the M4 bench). A resize later, with fingers on the sticks, still must.
  const tmp = mkdtempSync(path.join(tmpdir(), 'gcs-layout-'));
  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 },
    coreSocket: path.join(tmp, 'no-core.sock'), webRoot: path.join(repo, 'web') });
  after(() => gw.close());
  const page = await firefox(procs, tmp);
  after(() => page.close());
  await page.call('browsingContext.setViewport', { context: page.context, viewport: { width: 1280, height: 640 } });
  await page.open(`http://127.0.0.1:${gw.port}/`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await page.evaluate('document.hasFocus = () => true');
  const deadman = () => page.evaluate("document.getElementById('deadman').textContent");
  await page.evaluate("document.getElementById('btn-take').click()");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.call('browsingContext.setViewport', { context: page.context, viewport: { width: 1440, height: 900 } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await deadman(), '', 'still in control after the full-screen transition');
  await page.call('browsingContext.setViewport', { context: page.context, viewport: { width: 1280, height: 640 } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(await deadman(), /pantalla/, 'a later layout change ends control');
});
