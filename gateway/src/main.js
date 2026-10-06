// gcs-gateway entry point:  node src/main.js [/etc/gcs/gateway.json]
import { loadConfig } from './config.js';
import { startGateway } from './server.js';

const file = process.argv[2] ?? '/etc/gcs/gateway.json';
const cfg = await loadConfig(file);
const gw = await startGateway(cfg);
console.log(`gateway: ${cfg.tls ? 'https' : 'http'}://${cfg.listen.host}:${gw.port}  core: ${cfg.coreSocket}  web: ${cfg.webRoot}`);
gw.core.on('up', () => console.log('gateway: connected to crsf-core'));
gw.core.on('down', () => console.log('gateway: lost crsf-core, reconnecting'));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await gw.close();
    process.exit(0);
  });
}
