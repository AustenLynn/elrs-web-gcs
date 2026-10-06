// The gateway's outbound connection to the internet relay. Every remote browser behind
// the relay becomes an ordinary ControlHub client, so all local rules apply unchanged:
// one pilot, fresh session per connection, stale-command filter, pilot lost -> failsafe.
import WebSocket from 'ws';

export class RelayClient {
  #ws = null;
  #timer = null;
  #stopped = false;
  #clients = new Map();

  constructor({ url, room, token, insecure = false, hub, reconnectMs = 2000 }) {
    Object.assign(this, { url, room, token, insecure, hub, reconnectMs });
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
    const ws = new WebSocket(this.url, { rejectUnauthorized: !this.insecure, maxPayload: 4096 });
    this.#ws = ws;
    const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    ws.on('open', () => {
      this.connected = true;
      send({ t: 'hello', role: 'bridge', room: this.room, token: this.token });
    });
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
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
    });
    ws.on('error', () => {}); // 'close' follows
    ws.on('close', () => {
      this.connected = false;
      for (const client of this.#clients.values()) this.hub.detach(client);   // remote pilot lost
      this.#clients.clear();
      if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), this.reconnectMs);
    });
  }
}
