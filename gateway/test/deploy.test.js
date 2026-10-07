// Checks on the shipped deployment files that tests elsewhere cannot see.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const deploy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy');
const read = (p) => readFileSync(path.join(deploy, p), 'utf8');

test('the MediaMTX control API is off: no local process can add paths that run commands', () => {
  const yml = read('video/mediamtx.yml');
  assert.match(yml, /^api: false$/m);
  assert.doesNotMatch(yml, /- action: api/);
});

test('video runs as its own user, never as the gcs user that owns crsf-core and its socket', () => {
  const unit = read('gcs-video.service');
  assert.match(unit, /^User=gcs-video$/m);
  assert.match(unit, /^Group=gcs-video$/m);
  assert.match(read('install.sh'), /useradd .*gcs-video/);
});
