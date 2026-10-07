import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFUSAL_TEXT, closeAction, connectionTarget, controlMessage, helloMessage, shouldReclaimPilotSeat, tsyncReply } from '../js/protocol.js';

test('messages match what the gateway hub expects', () => {
  assert.deepEqual(helloMessage('pilot'), { t: 'hello', role: 'pilot' });
  assert.deepEqual(controlMessage(7, 123.5, { roll: 1, pitch: -2, yaw: 3, throttle: 400, mode: 1 }),
    { t: 'ctl', seq: 7, ts: 123.5, r: 1, p: -2, y: 3, th: 400, m: 1 });
  assert.deepEqual(tsyncReply({ t: 'tsync', s0: 99 }, 5000), { t: 'tsync_r', s0: 99, c1: 5000 });
});

test('every refusal the core can send has a text', () => {
  for (const r of ['wrong_session', 'not_disarmed', 'not_in_failsafe', 'link_stale', 'throttle_high', 'fc_still_armed']) {
    assert.ok(REFUSAL_TEXT[r], r);
  }
});

test('connects to the Pi directly, or through the relay with ?room=', () => {
  const local = connectionTarget({ protocol: 'https:', host: 'pi.local:8443', search: '' }, 'pilot', () => 'unused');
  assert.deepEqual(local, { url: 'wss://pi.local:8443/ws', hello: { t: 'hello', role: 'pilot' }, relay: false, room: null });
  const asked = [];
  const remote = connectionTarget({ protocol: 'https:', host: 'relay.example.org', search: '?room=pi1' }, 'pilot',
    (room) => { asked.push(room); return 'secret'; });
  assert.deepEqual(remote, { url: 'wss://relay.example.org/relay', hello: { t: 'hello', role: 'pilot', room: 'pi1', token: 'secret' }, relay: true, room: 'pi1' });
  assert.deepEqual(asked, ['pi1']);
  assert.equal(connectionTarget({ protocol: 'http:', host: 'h', search: '' }, 'observer', () => '').url, 'ws://h/ws');
});

test('a page that wanted to fly reclaims the pilot seat once it is free', () => {
  // e.g. after a Wi-Fi blip the new connection arrived while the old one still held the seat
  assert.equal(shouldReclaimPilotSeat('pilot', 'observer', { pilot: false }), true);
  assert.equal(shouldReclaimPilotSeat('pilot', 'observer', { pilot: true }), false);
  assert.equal(shouldReclaimPilotSeat('pilot', 'pilot', { pilot: true }), false);
  assert.equal(shouldReclaimPilotSeat('observer', 'observer', { pilot: false }), false);
  assert.equal(shouldReclaimPilotSeat('pilot', 'observer', null), false);
});

test('relay close codes: what the page does next', () => {
  // 4003 wrong token: stop and ask (no endless prompt loop); 4001 Pi offline: back off.
  assert.deepEqual(closeAction(4003, 'pi1'), { retryMs: null, clearToken: true, text: 'Clave de piloto incorrecta: recarga la página para intentarlo de nuevo' });
  assert.equal(closeAction(4001, 'pi1').retryMs, 5000);
  assert.match(closeAction(4001, 'pi1').text, /Pi/);
  assert.match(closeAction(4004, 'pi1').text, /llena/);
  assert.equal(closeAction(1006, null).retryMs, 1000);              // local gateway: reconnect quickly
  assert.equal(closeAction(1006, null).text, null);
});
