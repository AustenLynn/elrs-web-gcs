// Shared helpers for the browser end-to-end tests: headless Firefox driven over
// WebDriver BiDi (the W3C standard protocol) through a WebSocket.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join(dir, 'firefox');
  mkdirSync(profile, { recursive: true });
  start(procs, 'firefox', ['--headless', '--profile', profile, '--remote-debugging-port', String(port), 'about:blank']);
  let ws;
  await waitFor(async () => {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return true;
    } catch {
      return false;
    }
  }, 30000, 'firefox remote agent');
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
  return { call, evaluate, open, context, errors, close: () => ws.close() };
}
