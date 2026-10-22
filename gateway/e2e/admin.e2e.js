// End-to-end: the admin screen in a real browser. A same-origin GET carries no Origin header,
// so this is the test that shows the list loads at all (the unit tests set headers by hand).
// Needs: firefox.   Run: npm run e2e
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { firefox, login, makeUsers, tempDir, waitFor } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const procs = [];
after(() => procs.forEach((p) => p.kill('SIGKILL')));

test('an admin opens /admin, sees the pilots and adds one', { timeout: 90000 }, async () => {
  const tmp = tempDir('gcs-e2e-admin-');
  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 },
    coreSocket: path.join(tmp, 'no-core.sock'), webRoot: path.join(repo, 'web'),
    auth: { usersFile: await makeUsers(tmp, [{ name: 'ana', password: 'ana-password', admin: true }, { name: 'luis', password: 'luis-password' }]) } });
  after(() => gw.close());
  const page = await firefox(procs, tmp);
  after(() => page.close());
  await page.open(`http://127.0.0.1:${gw.port}/`);
  await login(page, 'ana', 'ana-password');

  await page.open(`http://127.0.0.1:${gw.port}/admin`);
  const rows = () => page.evaluate("[...document.querySelectorAll('#users .user-name')].map((e) => e.textContent).join(',')");
  await waitFor(async () => (await rows()) === 'ana (admin),luis', 10000, 'the pilot list');
  assert.equal(await page.evaluate('location.pathname'), '/admin', 'still on the admin screen');

  await page.evaluate(`document.getElementById('new-name').value = 'eva';
    document.getElementById('new-pass').value = 'eva-password';
    document.getElementById('add').requestSubmit()`);
  await waitFor(async () => (await rows()) === 'ana (admin),luis,eva', 10000, 'eva in the list');
  assert.deepEqual(page.errors, [], 'no JavaScript errors on the admin page');
});
