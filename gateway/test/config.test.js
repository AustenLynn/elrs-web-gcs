import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, validateConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the shipped deploy/gateway.json is valid', async () => {
  const cfg = await loadConfig(path.resolve(here, '../../deploy/gateway.json'));
  assert.equal(cfg.listen.port, 8443);
  assert.equal(cfg.tls.cert, '/etc/gcs/tls/cert.pem');
  assert.equal(cfg.coreSocket, '/run/crsf-core/core.sock');
});

test('missing keys fall back to defaults, listen is merged field by field', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-cfg-')), 'g.json');
  writeFileSync(file, JSON.stringify({ listen: { port: 9000 } }));
  const cfg = await loadConfig(file);
  assert.equal(cfg.listen.port, 9000);
  assert.equal(cfg.listen.host, DEFAULTS.listen.host);
  assert.equal(cfg.maxCommandAgeMs, 200);
  assert.equal(cfg.tls, null);
});

test('bad values are reported together', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, listen: { host: 1, port: 70000 }, maxCommandAgeMs: 5000, tls: {} }),
    /listen.port.*listen.host.*tls.*maxCommandAgeMs/);
});
