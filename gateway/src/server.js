// HTTP(S) server: static web app + WebSocket endpoint /ws, wired to crsf-core.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { ControlHub } from './hub.js';
import { CoreClient } from './ipc.js';
import { RelayClient } from './relayClient.js';
import { staticHandler } from './static.js';
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

export async function startGateway(cfg, { core = new CoreClient(cfg.coreSocket) } = {}) {
  const hub = new ControlHub({ core, maxCommandAgeMs: cfg.maxCommandAgeMs });
  core.on('status', (s) => hub.onCoreStatus(s));
  core.on('down', () => hub.onCoreDown());
  core.on('up', () => hub.onCoreUp());
  core.on('telemetry', (kind, value) => hub.onCoreTelemetry(kind, value));
  core.on('event', (ev) => hub.onCoreEvent(ev));
  core.start();

  const files = staticHandler(cfg.webRoot);
  const video = cfg.video ? whepProxy(cfg.video.whep) : null;
  const handler = async (req, res) => {
    if (video && (await video(req, res))) return;
    files(req, res);
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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    const client = {
      send: (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
      close: () => ws.close(),
    };
    ws.isAlive = true;
    hub.attach(client);
    ws.on('pong', () => { ws.isAlive = true; });
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

  // Drop browsers that stopped answering pings (half-open TCP after Wi-Fi loss).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 1000);
  const tsync = setInterval(() => hub.tick(), 2000);
  const relay = cfg.relay ? new RelayClient({ ...cfg.relay, hub }) : null;
  relay?.start();

  await new Promise((resolve) => server.listen(cfg.listen.port, cfg.listen.host, resolve));

  return {
    hub,
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
    },
  };
}
