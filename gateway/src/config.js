// Gateway settings: a JSON file merged over these defaults.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  listen: { host: '0.0.0.0', port: 8443 },
  tls: null, // { cert: '/etc/gcs/tls/cert.pem', key: '/etc/gcs/tls/key.pem' }; null = plain HTTP (tests only)
  coreSocket: '/run/crsf-core/core.sock',
  webRoot: path.resolve(here, '../../web'),
  maxCommandAgeMs: 200,
});

export function validateConfig(cfg) {
  const problems = [];
  if (!Number.isInteger(cfg.listen?.port) || cfg.listen.port < 0 || cfg.listen.port > 65535) problems.push('listen.port must be 0..65535');
  if (typeof cfg.listen?.host !== 'string') problems.push('listen.host must be a string');
  if (cfg.tls !== null && (typeof cfg.tls?.cert !== 'string' || typeof cfg.tls?.key !== 'string')) problems.push('tls must be null or { cert, key }');
  if (typeof cfg.coreSocket !== 'string') problems.push('coreSocket must be a path');
  if (typeof cfg.webRoot !== 'string') problems.push('webRoot must be a path');
  if (typeof cfg.maxCommandAgeMs !== 'number' || cfg.maxCommandAgeMs < 20 || cfg.maxCommandAgeMs > 1000) problems.push('maxCommandAgeMs must be 20..1000');
  if (problems.length) throw new Error(`invalid gateway config: ${problems.join('; ')}`);
  return cfg;
}

export async function loadConfig(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const cfg = { ...DEFAULTS, ...raw, listen: { ...DEFAULTS.listen, ...raw.listen } };
  return validateConfig(cfg);
}
