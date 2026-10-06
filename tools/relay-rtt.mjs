#!/usr/bin/env node
// Deliverable 5: round-trip time from a remote position to the Pi through the relay.
//   node tools/relay-rtt.mjs wss://relay.example.org/relay <room> <pilotToken> [seconds]
// Joins as an observer (never takes the pilot seat) and pings the Pi's gateway 5x/s.
// Uses Node's built-in WebSocket (Node >= 22), so it needs no npm packages.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pct(sorted, q) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : NaN;
}

export async function measureRtt({ url, room, token, seconds = 30, rateHz = 5 }) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
  });
  const sent = new Map();
  const rtts = [];
  let welcomed = false;
  let closeInfo = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') welcomed = true;
    if (m.t === 'pong' && sent.has(m.id)) {
      rtts.push(performance.now() - sent.get(m.id));
      sent.delete(m.id);
    }
  });
  ws.addEventListener('close', (ev) => { closeInfo = `${ev.code} ${ev.reason}`; });
  ws.send(JSON.stringify({ t: 'hello', role: 'observer', room, token }));
  for (let i = 0; i < 50 && !welcomed && !closeInfo; i++) await sleep(100);
  if (!welcomed) throw new Error(`relay refused: ${closeInfo ?? 'no welcome from the Pi'}`);

  let id = 0;
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end && !closeInfo) {
    sent.set(++id, performance.now());
    ws.send(JSON.stringify({ t: 'ping', id, ts: 0 }));
    await sleep(1000 / rateHz);
  }
  await sleep(1000);                  // let late answers arrive
  ws.close();
  const s = [...rtts].sort((a, b) => a - b);
  return { sent: id, received: s.length, lossPct: id ? (100 * (id - s.length)) / id : 0,
    p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.at(-1) ?? NaN };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, room, token, seconds = '30'] = process.argv.slice(2);
  if (!url || !room || !token) {
    console.error('usage: node tools/relay-rtt.mjs <wss://host/relay> <room> <pilotToken> [seconds]');
    process.exit(2);
  }
  try {
    const r = await measureRtt({ url, room, token, seconds: Number(seconds) });
    console.log(`pings ${r.sent}, answers ${r.received} (${r.lossPct.toFixed(1)}% lost)`);
    console.log(`round trip: p50 ${r.p50.toFixed(0)} ms, p95 ${r.p95.toFixed(0)} ms, max ${r.max.toFixed(0)} ms`);
  } catch (err) {
    console.error(`relay-rtt: ${err.message}`);
    process.exit(1);
  }
}
