// Shared helpers for the browser end-to-end tests: headless Firefox driven over
// WebDriver BiDi (the W3C standard protocol) through a WebSocket.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { UserStore } from '../src/users.js';
import path from 'node:path';
import WebSocket from 'ws';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Starts a process and remembers it so the test can kill it afterwards. */
export function start(procs, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], ...opts });
  procs.push(p);
  return p;
}

/** Launches headless Firefox with a fresh profile in `dir` and returns a page handle. */
export async function firefox(procs, dir) {
  const profile = path.join(dir, 'firefox');
  mkdirSync(profile, { recursive: true });
  // Port 0: Firefox picks a free port and announces it. A port chosen here could collide with
  // another test's Firefox running in parallel ("Maximum number of active sessions").
  const ff = start(procs, 'firefox', ['--headless', '--profile', profile, '--remote-debugging-port', '0', 'about:blank'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const base = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for firefox remote agent')), 30000);
    ff.stderr.on('data', (d) => {
      text += d;
      const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(text);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    ff.once('exit', () => reject(new Error('firefox exited before its remote agent started')));
  });
  ff.stderr.resume();                       // keep draining, so Firefox never blocks on stderr
  const ws = new WebSocket(`${base}/session`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'log.entryAdded' && m.params.level === 'error') {
      errors.push(m.params.text);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, (m) => (m.type === 'error' ? reject(new Error(`${method}: ${m.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await call('session.new', { capabilities: {} });
  await call('session.subscribe', { events: ['log.entryAdded'] });
  const { contexts } = await call('browsingContext.getTree');
  const context = contexts[0].context;
  const evaluate = async (expression) => {
    const r = await call('script.evaluate', { expression, target: { context }, awaitPromise: true, userActivation: true });
    if (r.type !== 'success') throw new Error(`script failed: ${JSON.stringify(r.exceptionDetails?.text)}`);
    return r.result.value;
  };
  const open = (url) => call('browsingContext.navigate', { context, url, wait: 'complete' });
  return { call, evaluate, open, context, errors, process: ff, close: () => ws.close() };
}

/** Opens the pilot page with an input mode chosen (remembered by the page per origin), so the
 *  default for this browser (keyboard on a desktop browser) does not decide what is tested. */
export async function openWithInputMode(page, url, mode) {
  await page.open(url);
  await page.evaluate(`localStorage.setItem('gcs-input-mode', '${mode}')`);
  await page.open(url);
}

/** Writes a users file in `dir` through the gateway's own UserStore and returns its path.
 *  `users`: [{ name, password, admin }]. */
export async function makeUsers(dir, users) {
  const file = path.join(dir, 'users.json');
  const store = new UserStore(file);
  await store.load();
  for (const u of users) await store.add(u.name, u.password, !!u.admin);
  return file;
}

/** Signs in through the page's own form, then waits for the reconnected page to be either
 *  the pilot or queued behind one (it starts as a spectator, which is neither). */
export async function login(page, name, password) {
  await page.evaluate("document.getElementById('btn-login').click()");
  await page.evaluate(`document.getElementById('login-name').value = ${JSON.stringify(name)};
    document.getElementById('login-password').value = ${JSON.stringify(password)};
    document.getElementById('login').requestSubmit()`);
  await waitFor(() => page.evaluate(`document.getElementById('auth-name').textContent === ${JSON.stringify(name)}
    && (!document.body.classList.contains('observer') || document.body.classList.contains('queued'))`),
  10000, `${name} signed in as pilot or queued`);
}
