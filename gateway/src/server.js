// HTTP(S) server: static web app + WebSocket endpoint /ws, wired to crsf-core.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { authRoutes, cookieToken, LoginLimiter, Sessions } from './auth.js';
import { openConnLog } from './connlog.js';
import { ControlHub } from './hub.js';
import { CoreClient } from './ipc.js';
import { RelayClient } from './relayClient.js';
import { staticHandler } from './static.js';
import { UserStore } from './users.js';
import { whepProxy } from './whep.js';

/** Request path, or null when the request line is not a parsable URL (never throw here:
 *  an exception in the upgrade handler would take the whole gateway down). */
function pathOf(url) {
  try {
    return new URL(url, 'http://local').pathname;
  } catch {
    return null;
  }
}

/** Browsers always send Origin: only pages served by this gateway may open /ws, so another
 *  web site open in a LAN browser cannot take the pilot seat. Tools send no Origin. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** One heartbeat pass (every second): drop sockets that did not answer the last ping
 *  (half-open TCP after Wi-Fi loss). With the hold on, the seated pilot's socket is kept until
 *  it has been silent for hold_ms + 1 s: dropping it would report "pilot lost" to the core and
 *  end the hold's resume window early. */
export function heartbeatSweep(sockets, { now, pilot, holdMs }) {
  for (const ws of sockets) {
    if (!ws.isAlive) {
      const graceMs = holdMs > 0 && ws.client === pilot ? holdMs + 1000 : 0;
      if (now - ws.lastPongAt > graceMs) {
        ws.terminate();
        continue;
      }
    }
    ws.isAlive = false;
    ws.ping();
  }
}

export async function startGateway(cfg, { core = new CoreClient(cfg.coreSocket) } = {}) {
  const connlog = openConnLog(cfg.eventLog ?? null);
  const hub = new ControlHub({ core, maxCommandAgeMs: cfg.maxCommandAgeMs, log: connlog.write });
  core.on('status', (s) => hub.onCoreStatus(s));
  core.on('down', () => hub.onCoreDown());
  core.on('up', () => hub.onCoreUp());
  core.on('telemetry', (kind, value) => hub.onCoreTelemetry(kind, value));
  core.on('event', (ev) => hub.onCoreEvent(ev));
  core.start();

  const users = new UserStore(cfg.auth.usersFile);
  await users.load();
  const sessions = new Sessions();
  const auth = authRoutes({ users, sessions, limiter: new LoginLimiter(), secure: !!cfg.tls, hub });

  const files = staticHandler(cfg.webRoot);
  const video = cfg.video ? whepProxy(cfg.video.whep) : null;
  const handler = async (req, res) => {
    try {
      if (await auth(req, res)) return;
      if (video && (await video(req, res))) return;
      files(req, res);
    } catch (err) {
      // An unhandled rejection would kill the process (and fail safe the aircraft).
      console.error('gateway: error handling a request:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      } else {
        res.destroy();
      }
    }
  };
  const server = cfg.tls
    ? https.createServer({ cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) }, handler)
    : http.createServer(handler);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (pathOf(req.url) !== '/ws') {
      socket.destroy();
      return;
    }
    if (!sameOrigin(req)) {
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const user = sessions.get(cookieToken(req));   // no or stale cookie: a spectator
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, user, req.headers['cf-connecting-ip'] ? 'tunnel' : 'local'));
  });

  wss.on('connection', (ws, user, via) => {
    const client = {
      send: (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
      close: () => ws.close(),
    };
    ws.isAlive = true;
    ws.lastPongAt = Date.now();
    ws.client = client;
    hub.attach(client, { user, relay: false, via });
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      try {
        hub.handle(client, msg);
      } catch (err) {
        // Backstop: a bug triggered by one message must not kill the process (that would
        // fail safe the aircraft and drop every browser).
        console.error('gateway: error handling a message:', err);
      }
    });
    ws.on('close', () => hub.detach(client));
    // Oversized frames (maxPayload) and protocol errors arrive here; ws then closes the
    // socket itself. Without a listener the error would crash the whole process.
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => heartbeatSweep(wss.clients,
    { now: Date.now(), pilot: hub.pilot, holdMs: hub.lastStatus?.holdMs ?? 0 }), 1000);
  const tsync = setInterval(() => hub.tick(), 2000);
  const relay = cfg.relay ? new RelayClient({ ...cfg.relay, hub }) : null;
  relay?.start();

  await new Promise((resolve) => server.listen(cfg.listen.port, cfg.listen.host, resolve));

  return {
    hub,
    users,
    sessions,
    core,
    relay,
    server,
    port: server.address().port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(tsync);
      relay?.stop();
      for (const ws of wss.clients) ws.terminate();
      core.stop();
      await new Promise((resolve) => server.close(resolve));
      await connlog.close();
    },
  };
}
