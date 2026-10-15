import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fullscreenTip } from '../js/fullscreen.js';

test('a tip only where the page cannot go full screen and is not already the home-screen app', () => {
  assert.equal(fullscreenTip({ canFullscreen: true, standalone: false }), null);    // Android, desktop
  assert.equal(fullscreenTip({ canFullscreen: false, standalone: true }), null);    // iPhone, from the icon
  const tip = fullscreenTip({ canFullscreen: false, standalone: false });           // iPhone Safari
  assert.match(tip, /Compartir/);
  assert.match(tip, /pantalla de inicio/);
});

test('the pilot page can be added to the home screen as an app without browser bars', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/icon-180.png">/);
});
