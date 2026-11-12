// The bilingual interface and the flight announcer in a real browser, against a fake gateway
// socket and fake audio. No core, no aircraft, no ElevenLabs: the fixture serves the real web/
// files, and "available" clips exist only as the fake Audio object injected below.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { firefox, sleep, tempDir, waitFor } from './helpers.js';

const root = path.resolve(import.meta.dirname, '../../web');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2' };

/** manifest: 'real' (the checked-in, unavailable one) or 'available' (a test-only copy that
 *  claims all ten clips; the clips themselves still do not exist on disk). */
async function fixture(t, { locale, manifest = 'available', inputMode = 'keyboard' } = {}) {
  const procs = [];
  const real = JSON.parse(await readFile(path.join(root, 'audio/announcements/manifest.json'), 'utf8'));
  const available = { ...real, available: true, clips: real.clips.map((c) => ({ ...c, available: true })) };
  const server = createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/me') { res.setHeader('Content-Type', 'application/json'); res.end('{"name":"ana","admin":false}'); return; }
    if (url === '/voice/config') { res.setHeader('Content-Type', 'application/json'); res.end('{"execution":"dry-run","shortMs":250,"mediumMs":500,"strength":50}'); return; }
    if (url === '/audio/announcements/manifest.json' && manifest === 'available') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(available)); return;
    }
    try {
      const file = path.join(root, url === '/' ? '/index.html' : url);
      if (!file.startsWith(root + path.sep)) throw new Error('outside');
      const data = await readFile(file);
      res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); for (const p of procs) p.kill('SIGKILL'); });
  const page = await firefox(procs, tempDir('gcs-announcer-'), { locale });
  t.after(() => page.close());
  await page.call('script.addPreloadScript', { functionDeclaration: `() => {
    document.hasFocus = () => true;
    Element.prototype.requestFullscreen = async function () {};   // no real full screen: the viewport must not change under the test
    window.RTCPeerConnection = class { constructor() { throw new Error('no video in this fixture'); } };
    const audioMode = sessionStorage.getItem('fixture-audio') ?? 'fake';
    window.fixture = { sent: [], plays: [], pauses: 0, audios: 0, sockets: 0, frames: 0, loadMark: Math.random(),
      state: 'DISARMED', reason: 'none', lq: null, playError: audioMode === 'blocked' ? 'NotAllowedError' : null };
    class FakeAudio {
      constructor(src = '') { this.src = src; this.muted = false; this.volume = 1; this.currentTime = 0; fixture.audios++; }
      play() {
        fixture.plays.push({ src: new URL(this.src, location.href).pathname, muted: this.muted });
        if (fixture.playError) return Promise.reject(new DOMException('fixture', fixture.playError));
        const handler = this.onended;
        setTimeout(() => { if (this.onended === handler) handler?.(); }, 150);   // a short clip ends by itself
        return Promise.resolve();
      }
      pause() { fixture.pauses++; }
    }
    if (audioMode !== 'real') window.Audio = FakeAudio;
    class Recorder { static isTypeSupported() { return true; } constructor() { this.state = 'inactive'; }
      start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm;codecs=opus' }) }); this.onstop?.(); } }
    window.MediaRecorder = Recorder;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    class Socket {
      static OPEN = 1;
      constructor() { this.readyState = 0; this.id = ++fixture.sockets; fixture.socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(raw) {
        const m = JSON.parse(raw);
        fixture.sent.push(m);
        if (m.t !== 'hello') return;
        // Like the hub: the answer to hello (after a round trip of fixture.helloDelay ms)
        // carries the welcome and a replay of the last cached link telemetry.
        setTimeout(() => this.hello(), fixture.helloDelay ?? 0);
      }
      hello() {
        if (this.readyState !== 1) return;
        this.emit({ t: 'welcome', role: 'pilot', session: this.id });
        this.emit({ t: 'voice_ready', session: this.id, capability: 'fixture-capability' });
        if (fixture.replayLink) this.emit({ t: 'telem', link: fixture.replayLink });
        this.timer = setInterval(() => {
          fixture.frames += 5;   // the TX module keeps talking: timing frames grow
          this.emit({ t: 'status', core: true, state: fixture.state, reason: fixture.reason, serialOk: true, timingFrames: fixture.frames,
            cmdAgeMs: 20, voice: { ready: true, reason: 'ready', epoch: 1 } });
          if (fixture.lq !== null) this.emit({ t: 'telem', link: { upLq: fixture.lq } });
        }, 50);
      }
      emit(m) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) }); }
      close() { clearInterval(this.timer); this.readyState = 3; this.onclose?.({ code: 1000 }); }
    }
    window.WebSocket = Socket;
    try { localStorage.setItem('gcs-input-mode', '${inputMode}'); } catch {}
  }` });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const js = (expr) => page.evaluate(expr);
  const json = async (expr) => JSON.parse(await page.evaluate(`JSON.stringify(${expr})`));
  const ready = () => waitFor(() => js("document.getElementById('state').dataset.state === 'DISARMED' && document.getElementById('seg-core').dataset.health === 'ok'"), 5000, 'fresh fixture status');
  const button = () => json(`(() => { const b = document.getElementById('btn-announce');
    return { state: b.dataset.state, pressed: b.getAttribute('aria-pressed'), text: b.textContent.trim(), title: b.title,
      status: document.getElementById('announce-status').textContent }; })()`);
  const plays = () => json('fixture.plays');
  const setLanguage = (lang) => js(`(() => { const s = document.getElementById('language'); s.value = '${lang}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const click = () => js("document.getElementById('btn-announce').click()");
  const flightMessages = () => json("fixture.sent.filter((m) => m.t !== 'ctl' && m.t !== 'tsync_r').map((m) => m.t)");
  return { page, url, js, json, ready, button, plays, setLanguage, click, flightMessages };
}

test('first visit follows the device language; the choice persists and changes nothing else; missing clips are reported honestly', { timeout: 90000 }, async (t) => {
  const f = await fixture(t, { locale: 'en-US', manifest: 'real' });
  await f.page.open(f.url);
  await f.ready();
  assert.equal(await f.js('document.documentElement.lang'), 'en', 'English device: English page');
  assert.equal(await f.js("localStorage.getItem('gcs.language') === null"), true, 'nothing stored before a choice');
  assert.equal(await f.js("document.getElementById('btn-take').textContent.trim()"), 'Take control');
  let b = await f.button();
  assert.deepEqual([b.state, b.pressed, b.text], ['off', 'false', 'Alerts'], 'announcements start off');
  assert.match(b.status, /off/i);

  const mark = await f.js('fixture.loadMark');
  const before = await f.flightMessages();
  await f.setLanguage('es');
  assert.equal(await f.js('document.documentElement.lang'), 'es');
  assert.equal(await f.js("localStorage.getItem('gcs.language')"), 'es');
  assert.equal(await f.js("document.getElementById('btn-take').textContent.trim()"), 'Tomar control');
  assert.equal(await f.js("document.getElementById('state').textContent"), 'DESARMADO', 'dynamic state text follows the language');
  b = await f.button();
  assert.deepEqual([b.state, b.text], ['off', 'Avisos']);
  assert.notEqual(await f.js('document.activeElement?.id'), 'language', 'the selector gives the keys back to the flight controls');
  assert.equal(await f.js('fixture.loadMark'), mark, 'no reload');
  assert.equal(await f.js('fixture.sockets'), 1, 'no reconnection');
  assert.deepEqual(await f.flightMessages(), before, 'no pilot, session or control message from a setting');
  assert.equal(await f.js("document.getElementById('btn-take').disabled"), false, 'still the pilot, still not engaged');

  // The checked-in manifest has no clips: enabling says so, in the chosen language, and never plays.
  await f.click();
  await waitFor(async () => (await f.button()).state === 'unavailable', 3000, 'unavailable state');
  b = await f.button();
  assert.deepEqual([b.pressed, b.text], ['false', 'Sin audio']);
  assert.match(b.status, /no disponibles/);
  assert.equal(b.title, b.status);
  assert.deepEqual(await f.plays(), [], 'no clip requested when the manifest says there is none');
  await f.setLanguage('en');
  b = await f.button();
  assert.deepEqual([b.state, b.text], ['unavailable', 'No audio']);
  assert.match(b.status, /unavailable/);

  await f.page.open(f.url);
  await f.ready();
  assert.equal(await f.js('document.documentElement.lang'), 'en', 'the choice survives a reload');
  assert.equal((await f.button()).state, 'off');
});

test('announcements: user gesture, silent seeding and reconnect, real transitions only, language switch, mute', { timeout: 120000 }, async (t) => {
  const f = await fixture(t, {});   // the shared helper's Spanish device
  await f.page.open(f.url);
  await f.ready();
  assert.equal(await f.js('document.documentElement.lang'), 'es', 'Spanish device: Spanish page on first visit');
  assert.equal(await f.js("localStorage.getItem('gcs.language') === null"), true);
  await f.js("fixture.lq = 90");
  await f.js("fixture.state = 'ARMED'");
  await sleep(300);
  await f.js("fixture.state = 'DISARMED'");
  await sleep(300);
  assert.deepEqual(await f.plays(), [], 'off until the pilot asks: transitions before enabling are not played');
  assert.equal(await f.js('fixture.audios'), 0, 'no audio element before a gesture');

  await f.click();
  await waitFor(async () => (await f.button()).state === 'on', 3000, 'enabled');
  let b = await f.button();
  assert.deepEqual([b.pressed, b.text], ['true', 'Avisos']);
  assert.equal(await f.js("localStorage.getItem('gcs.announcements')"), 'true');
  assert.deepEqual(await f.plays(), [{ src: '/audio/announcements/es/armed.mp3', muted: true }], 'only the muted unlock probe');
  await sleep(3000);   // past the reconnect settle window: the current link seeds silently
  assert.equal((await f.plays()).length, 1, 'current state is never announced');

  await f.js("fixture.state = 'ARMED'");
  await waitFor(async () => (await f.plays()).length >= 2, 2000, 'armed announcement');
  await sleep(500);
  assert.deepEqual((await f.plays())[1], { src: '/audio/announcements/es/armed.mp3', muted: false });
  assert.equal((await f.plays()).length, 2, 'repeated telemetry is not announced again');

  const pauses = await f.js('fixture.pauses');
  await f.setLanguage('en');
  assert.ok(await f.js('fixture.pauses') > pauses, 'old-language audio stops');
  await sleep(400);
  assert.equal((await f.plays()).length, 2, 'a language change does not replay the current state');
  await f.js("fixture.state = 'DISARMED'");
  await waitFor(async () => (await f.plays()).length >= 3, 2000, 'disarmed announcement');
  assert.equal((await f.plays())[2].src, '/audio/announcements/en/disarmed.mp3');

  await f.js('fixture.lq = null');   // link telemetry stops while the TX module keeps talking
  await waitFor(async () => (await f.plays()).length >= 4, 4000, 'signal lost');
  assert.equal((await f.plays())[3].src, '/audio/announcements/en/signal_lost.mp3');
  await sleep(400);   // the loss clip has ended (a restore during it would be spoken when it ends)
  await f.js('fixture.lq = 80');
  await waitFor(async () => (await f.plays()).length >= 5, 2000, 'signal restored');
  assert.equal((await f.plays())[4].src, '/audio/announcements/en/signal_restored.mp3');
  await f.js("fixture.state = 'FAILSAFE'; fixture.reason = 'cmd_timeout'");
  await waitFor(async () => (await f.plays()).length >= 6, 2000, 'failsafe');
  assert.equal((await f.plays())[5].src, '/audio/announcements/en/failsafe.mp3');

  // Reconnect: whatever changed while disconnected is the new baseline, not an event. The
  // drone went quiet meanwhile, but the hub replays its cached (live-looking) link telemetry
  // one slow round trip after the socket opens; that replay going stale is not a loss.
  await f.js("fixture.helloDelay = 1200; fixture.replayLink = { upLq: 80 }");
  await f.js('fixture.socket.close()');
  await f.js("fixture.state = 'ARMED'; fixture.reason = 'none'; fixture.lq = null");
  await waitFor(() => f.js('fixture.sockets === 2'), 4000, 'reconnected');
  await waitFor(() => f.js("document.getElementById('state').dataset.state === 'ARMED'"), 4000, 'hello answered');
  await waitFor(() => f.js("document.getElementById('seg-drone').dataset.health === 'ok'"), 3000, 'replayed link looks live');
  await waitFor(() => f.js("document.getElementById('seg-drone').dataset.health === 'down'"), 4000, 'replayed link goes stale');
  await sleep(1500);
  assert.deepEqual((await f.plays()).slice(6), [], 'silent after reconnect, including replayed stale link telemetry');
  await f.js("fixture.helloDelay = 0; fixture.replayLink = null");
  assert.deepEqual(await f.flightMessages(), ['hello', 'hello'], 'only the reconnection hello: no pilot or control message');

  await f.click();
  b = await f.button();
  assert.deepEqual([b.state, b.pressed], ['off', 'false'], 'muted');
  assert.equal(await f.js("localStorage.getItem('gcs.announcements')"), 'false');
  await f.js("fixture.state = 'DISARMED'");
  await sleep(500);
  assert.equal((await f.plays()).length, 6, 'nothing while muted');

  await f.click();
  await waitFor(async () => (await f.button()).state === 'on', 3000, 'enabled again');
  await f.page.open(f.url);
  await f.ready();
  b = await f.button();
  assert.equal(b.state, 'off', 'a reload needs a new gesture even after enabling');
  assert.match(b.status, /last time/, 'the remembered preference is shown, not claimed as active');
});

test('blocked or missing audio is reported and never blocks the controls', { timeout: 90000 }, async (t) => {
  const f = await fixture(t, { locale: 'es-ES' });
  await f.page.open(f.url);
  await f.js("sessionStorage.setItem('fixture-audio', 'real')");   // the real Audio: the "available" clips 404
  await f.page.open(f.url);
  await f.ready();
  await f.click();
  await waitFor(async () => (await f.button()).state === 'unavailable', 5000, 'probe fails on missing clip');
  assert.equal((await f.button()).pressed, 'false');
  await f.setLanguage('en');   // the manifest lists English clips: the Spanish error must not linger
  assert.equal((await f.button()).state, 'off', 'missing-clips error cleared by a language with clips');
  await f.setLanguage('es');
  assert.deepEqual(f.page.errors, [], 'a rejected probe (404) leaves no unhandled error');

  await f.js("sessionStorage.setItem('fixture-audio', 'blocked')");
  await f.page.open(f.url);
  await f.ready();
  await f.click();
  await waitFor(async () => (await f.button()).state === 'blocked', 3000, 'blocked state');
  const b = await f.button();
  assert.deepEqual([b.pressed, b.text], ['false', 'Sin audio']);
  assert.match(b.status, /bloque/);
  await f.js("document.getElementById('btn-take').click()");
  await waitFor(() => f.js("fixture.sent.some((m) => m.t === 'ctl')"), 3000, 'control commands still flow');
  assert.equal(await f.js("document.getElementById('deadman').textContent"), '');
  assert.deepEqual(f.page.errors, [], 'a NotAllowedError probe leaves no unhandled error');
});

test('held sticks: language and announcer changes keep pad geometry and control; capture silences; Space still disarms', { timeout: 150000 }, async (t) => {
  const f = await fixture(t, { inputMode: 'touch' });
  const pads = () => f.json("['stick-left', 'stick-right'].map((id) => document.getElementById(id).getBoundingClientRect().toJSON())");
  for (const [width, height] of [[390, 844], [360, 780], [844, 390], [740, 360], [640, 360]]) {
    const at = `${width}x${height}`;
    await f.page.call('browsingContext.setViewport', { context: f.page.context, viewport: { width, height } });
    await f.page.open(f.url);
    await f.ready();
    const ctl = await f.js('fixture.sent.length');
    await f.js("document.getElementById('btn-take').click()");
    await waitFor(() => f.js("document.getElementById('deadman').textContent === ''"), 3000, `${at} engaged`);
    await sleep(1700);   // past the engage settle time: from now on any pad move ends control
    const before = await pads();
    const [left] = before;
    await f.page.call('input.performActions', { context: f.page.context, actions: [{ type: 'pointer', id: 'thumb', parameters: { pointerType: 'touch' },
      actions: [{ type: 'pointerMove', x: Math.round(left.x + left.width / 2), y: Math.round(left.y + left.height * 0.8) }, { type: 'pointerDown', button: 0 }] }] });
    for (const step of [() => f.setLanguage('en'), () => f.click(), () => f.setLanguage('es'), () => f.click()]) {
      await step();
      await sleep(200);   // ten control ticks, each checking the pad layout
      assert.deepEqual(await pads(), before, `${at}: a stick pad moved`);
      assert.equal(await f.js("document.getElementById('deadman').textContent"), '', `${at}: control dropped`);
    }
    await f.page.call('input.releaseActions', { context: f.page.context });
    assert.ok(await f.js(`fixture.sent.slice(${ctl}).filter((m) => m.t === 'ctl').length`) > 20, `${at}: commands kept flowing`);
    assert.equal((await f.button()).state, 'off', `${at}: enabled then muted`);
  }

  // Microphone capture: announcements are discarded while recording and never replayed.
  await f.page.call('browsingContext.setViewport', { context: f.page.context, viewport: { width: 1280, height: 720 } });
  await f.page.open(f.url);
  await f.ready();
  await f.js('fixture.lq = 90');
  await waitFor(() => f.js("!document.getElementById('btn-voice-prepare').disabled"), 3000, 'voice preflight');
  await f.click();
  await waitFor(async () => (await f.button()).state === 'on', 3000, 'enabled');
  await f.js("document.getElementById('btn-voice-prepare').click()");
  await f.js("document.getElementById('btn-take').click()");
  await waitFor(() => f.js("!document.getElementById('btn-voice-ptt').disabled"), 3000, 'voice ready');
  await sleep(2800);   // settled baseline: link up
  const playsBefore = (await f.plays()).length;
  await f.js("document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }))");
  await waitFor(() => f.js("document.getElementById('voice-state').dataset.phase === 'recording'"), 2000, 'recording');
  await f.js('fixture.lq = null');   // a real loss while recording (a state change would end the recording itself)
  await sleep(2700);
  assert.equal(await f.js("document.getElementById('voice-state').dataset.phase"), 'recording', 'still recording');
  assert.equal(await f.js("document.getElementById('seg-drone').dataset.health"), 'down', 'the loss happened');
  assert.equal((await f.plays()).length, playsBefore, 'no announcement while the microphone records');
  await f.js("document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', bubbles: true }))");
  await sleep(600);
  assert.equal((await f.plays()).length, playsBefore, 'the suppressed announcement is not replayed');

  // A focused announcer button is not a keyboard trap: Space disarms and leaves it unchanged.
  await f.js("document.getElementById('btn-voice-cancel').click(); document.getElementById('btn-take').click(); document.getElementById('btn-announce').focus()");
  const sent = await f.js('fixture.sent.length');
  await f.page.call('input.performActions', { context: f.page.context, actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: ' ' }, { type: 'keyUp', value: ' ' }] }] });
  await sleep(200);
  assert.ok(await f.js(`fixture.sent.slice(${sent}).some((m) => m.t === 'disarm')`), 'Space sent disarm');
  assert.equal((await f.button()).state, 'on', 'Space did not toggle the announcer');
});
