// HTTP(S) server: static web app + WebSocket endpoint /ws, wired to crsf-core.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { ControlHub } from './hub.js';
import { CoreClient } from './ipc.js';
import { staticHandler } from './static.js';

export async function startGateway(cfg, { core = new CoreClient(cfg.coreSocket) } = {}) {
  const hub = new ControlHub({ core, maxCommandAgeMs: cfg.maxCommandAgeMs });
  core.on('status', (s) => hub.onCoreStatus(s));
  core.on('down', () => hub.onCoreDown());
  core.on('telemetry', (kind, value) => hub.onCoreTelemetry(kind, value));
  core.on('event', (ev) => hub.onCoreEvent(ev));
  core.start();

  const files = staticHandler(cfg.webRoot);
  const server = cfg.tls
    ? https.createServer({ cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) }, files)
    : http.createServer(files);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://local').pathname !== '/ws') {
      socket.destroy();
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
      hub.handle(client, msg);
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

  await new Promise((resolve) => server.listen(cfg.listen.port, cfg.listen.host, resolve));

  return {
    hub,
    core,
    server,
    port: server.address().port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(tsync);
      for (const ws of wss.clients) ws.terminate();
      core.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
