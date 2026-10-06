// gcs-relay entry point:  node src/main.js /etc/gcs/relay.json
// relay.json: { "listen": {"host": "127.0.0.1", "port": 8080}, "webRoot": "/opt/gcs/web",
//               "rooms": { "pi1": { "bridgeToken": "<openssl rand -hex 32>", "pilotToken": "<...>" } } }
import { readFile } from 'node:fs/promises';
import { startRelay } from './server.js';

const cfg = JSON.parse(await readFile(process.argv[2] ?? '/etc/gcs/relay.json', 'utf8'));
for (const [name, room] of Object.entries(cfg.rooms ?? {})) {
  for (const key of ['bridgeToken', 'pilotToken']) {
    if (!/^[0-9a-f]{32,}$/i.test(room[key] ?? '')) throw new Error(`room ${name}: ${key} must be hex, at least 32 characters (openssl rand -hex 32)`);
  }
}
const relay = await startRelay(cfg);
console.log(`relay: listening on ${cfg.listen.host}:${relay.port}, rooms: ${Object.keys(cfg.rooms).join(', ')}`);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await relay.close();
    process.exit(0);
  });
}
