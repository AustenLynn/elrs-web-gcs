// The gateway's outbound connection to the internet relay. Every remote browser behind
// the relay becomes an ordinary ControlHub client, so all local rules apply unchanged:
// one pilot, fresh session per connection, stale-command filter, pilot lost -> failsafe.
import WebSocket from 'ws';

export class RelayClient {
  #ws = null;
  #timer = null;
  #stopped = false;
  #clients = new Map();

  constructor({ url, room, token, insecure = false, hub, reconnectMs = 2000, pingMs = 1000 }) {
    Object.assign(this, { url, room, token, insecure, hub, reconnectMs, pingMs });
    this.connected = false;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#ws?.terminate();
  }

  #connect() {
    const ws = new WebSocket(this.url, { rejectUnauthorized: !this.insecure, maxPayload: 16 * 1024 });
    this.#ws = ws;
    const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    // A pulled uplink sends no FIN: without our own heartbeat the socket would look open for
    // minutes while the remote pilot still held the seat. No pong for 2 pings -> drop it.
    let alive = true;
    let heartbeat = null;
    ws.on('pong', () => { alive = true; });
    ws.on('open', () => {
      this.connected = true;
      send({ t: 'hello', role: 'bridge', room: this.room, token: this.token });
      heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, this.pingMs);
    });
    ws.on('message', (data) => {
      try {
        this.#relayed(JSON.parse(data), send);
      } catch (err) {
        // Same backstop as /ws: one bad message must not take the gateway down.
        console.error('gateway: error handling a relayed message:', err);
      }
    });
    ws.on('error', () => {}); // 'close' follows
    ws.on('close', () => {
      clearInterval(heartbeat);
      this.connected = false;
      for (const client of this.#clients.values()) this.hub.detach(client);   // remote pilot lost
      this.#clients.clear();
      if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), this.reconnectMs);
    });
  }

  #relayed(m, send) {
    if (m?.t !== 'relay' || typeof m.id !== 'string') return;
    if (m.ev === 'open' && !this.#clients.has(m.id)) {
      const client = {
        send: (msg) => send({ t: 'relay', ev: 'send', id: m.id, msg }),
        close: () => send({ t: 'relay', ev: 'kick', id: m.id }),
      };
      this.#clients.set(m.id, client);
      this.hub.attach(client);
    } else if (m.ev === 'msg' && this.#clients.has(m.id)) {
      this.hub.handle(this.#clients.get(m.id), m.msg);
    } else if (m.ev === 'close' && this.#clients.has(m.id)) {
      this.hub.detach(this.#clients.get(m.id));
      this.#clients.delete(m.id);
    }
  }
}
