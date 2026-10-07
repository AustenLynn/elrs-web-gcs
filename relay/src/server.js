// Relay HTTP + WebSocket server. TLS is terminated in front of it (Caddy) on the VPS.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { staticHandler } from '../../gateway/src/static.js';
import { Relay } from './relay.js';

export async function startRelay(cfg) {
  const relay = new Relay({ rooms: cfg.rooms });
  const server = http.createServer(cfg.webRoot ? staticHandler(cfg.webRoot) : (req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });   // browsers are held to 4 KiB in Relay
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://local').pathname !== '/relay') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    const conn = {
      send: (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
      close: (code, reason) => ws.close(code, reason),
    };
    const handlers = relay.connect(conn);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        handlers.message(JSON.parse(data), data.length);
      } catch {
        // not JSON: ignore
      }
    });
    ws.on('close', handlers.close);
    // Oversized frames (maxPayload) and protocol errors arrive here; ws then closes the
    // socket itself. Without a listener the error would crash the whole process.
    ws.on('error', () => {});
  });
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
  await new Promise((resolve) => server.listen(cfg.listen.port, cfg.listen.host, resolve));
  return {
    relay,
    port: server.address().port,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
