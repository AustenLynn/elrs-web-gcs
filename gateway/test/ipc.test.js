import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoreClient, FrameReader, MSG, REASONS, decodeBattery, decodeDevice, decodeEvent, decodeFlightMode, decodeLink, decodeStatus, encodeControl, encodeSessionMsg } from '../src/ipc.js';

// Same bytes as CONTROL_GOLDEN in core/tests/test_ipc_proto.c
const CONTROL_GOLDEN = Buffer.from([
  0x12, 0x00, 0x02, 0x04, 0x03, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00,
  0x18, 0xfc, 0xfa, 0x00, 0x00, 0x00, 0xe8, 0x03, 0x02,
]);
// Produced by the C encoder (ipc_encode_status) for the sample in core/tests/test_ipc_proto.c
const STATUS_GOLDEN = Buffer.from([
  0x51, 0x00, 0x81, 0x02, 0x01, 0x02, 0x01, 0x04, 0x03, 0x02, 0x01, 0x63,
  0x00, 0x00, 0x00, 0x2d, 0x01, 0x00, 0x00, 0xe8, 0x03, 0x00, 0x00, 0x02,
  0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xa0,
  0x0f, 0x00, 0x00, 0x2e, 0xfb, 0xff, 0xff, 0x07, 0x00, 0x00, 0x00, 0x55,
  0x00, 0x00, 0x00, 0xac, 0x00, 0xad, 0x00, 0xae, 0x00, 0xaf, 0x00, 0xb0,
  0x00, 0xb1, 0x00, 0xb2, 0x00, 0xb3, 0x00, 0xb4, 0x00, 0xb5, 0x00, 0xb6,
  0x00, 0xb7, 0x00, 0xb8, 0x00, 0xb9, 0x00, 0xba, 0x00, 0xbb, 0x00,
]);

test('control message matches the C encoder byte for byte', () => {
  const buf = encodeControl({ session: 0x01020304, seq: 5, roll: -1000, pitch: 250, yaw: 0, throttle: 1000, mode: 2 });
  assert.deepEqual(buf, CONTROL_GOLDEN);
});

test('session-style messages', () => {
  assert.deepEqual(encodeSessionMsg(MSG.ARM, 77), Buffer.from([0x05, 0x00, 0x03, 77, 0, 0, 0]));
});

test('decodes the STATUS produced by the C encoder', () => {
  const [msg] = new FrameReader().push(STATUS_GOLDEN);
  assert.equal(msg.type, MSG.STATUS);
  const s = decodeStatus(msg.payload);
  assert.equal(s.state, 'FAILSAFE');
  assert.equal(s.reason, 'cmd_timeout');
  assert.equal(s.fcArm, 'armed');
  assert.equal(s.serialOk, true);
  assert.equal(s.session, 0x01020304);
  assert.equal(s.lastSeq, 99);
  assert.equal(s.cmdAgeMs, 301);
  assert.equal(s.framesSent, 1000);
  assert.equal(s.periodUs, 4000);
  assert.equal(s.offsetUs, -123.4);
  assert.equal(s.wakeLateMaxUs, 85);
  assert.deepEqual(s.channels, Array.from({ length: 16 }, (_, i) => 172 + i));
});

test('no-command age decodes as null', () => {
  const p = Buffer.from(STATUS_GOLDEN.subarray(3));
  p.writeUInt32LE(0xffffffff, 12);
  assert.equal(decodeStatus(p).cmdAgeMs, null);
});

test('telemetry decoders', () => {
  assert.deepEqual(decodeLink(Buffer.from([0xbd, 0xba, 100, 9, 1, 7, 100, 0, 0xc9, 98, 0xfc])), {
    upRssi1: -67, upRssi2: -70, upLq: 100, upSnr: 9, antenna: 1, rfMode: 7, txPowerMw: 100, dnRssi: -55, dnLq: 98, dnSnr: -4,
  });
  assert.deepEqual(decodeBattery(Buffer.from([168, 0, 45, 0, 0xd2, 0x04, 0, 0, 87])), {
    voltage: 16.8, current: 4.5, capacityMah: 1234, remainingPct: 87,
  });
  assert.equal(decodeFlightMode(Buffer.from([5, ...Buffer.from('ACRO*')])), 'ACRO*');
  assert.deepEqual(decodeDevice(Buffer.from([0xee, 3, 5, 3, 0x53, 0x52, 0x4c, 0x45, 3, ...Buffer.from('FAK')])), {
    origin: 0xee, version: '3.5.3', serial: 0x454c5253, name: 'FAK',
  });
  assert.deepEqual(decodeEvent(Buffer.from([1, 5, 9, 0, 0, 0])), { what: 'arm', refused: 'throttle_high', session: 9 });
  assert.throws(() => decodeLink(Buffer.alloc(3)), RangeError);
  assert.throws(() => decodeFlightMode(Buffer.from([9, 65])), RangeError);
});

test('frame reader handles split and batched input, rejects bad lengths', () => {
  const r = new FrameReader();
  const both = Buffer.concat([encodeSessionMsg(MSG.SESSION, 1), CONTROL_GOLDEN]);
  const got = [];
  for (const b of both) got.push(...r.push(Buffer.from([b])));
  assert.deepEqual(got.map((m) => m.type), [MSG.SESSION, MSG.CONTROL]);
  assert.equal(new FrameReader().push(both).length, 2);
  assert.throws(() => new FrameReader().push(Buffer.from([0x00, 0x00])), /corrupt/);
  assert.throws(() => new FrameReader().push(Buffer.from([0x00, 0x01])), /corrupt/);
});

test('core client connects, decodes, sends and reconnects', async (t) => {
  const sockPath = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-')), 'core.sock');
  const received = [];
  let serverSide;
  const server = net.createServer((s) => {
    serverSide = s;
    const r = new FrameReader();
    s.on('data', (d) => received.push(...r.push(d)));
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  t.after(() => server.close());

  const client = new CoreClient(sockPath, { reconnectMs: 50 });
  t.after(() => client.stop());
  const up = new Promise((resolve) => client.once('up', resolve));
  client.start();
  await up;

  const status = new Promise((resolve) => client.once('status', resolve));
  serverSide.write(STATUS_GOLDEN.subarray(0, 10));
  serverSide.write(STATUS_GOLDEN.subarray(10));
  assert.equal((await status).state, 'FAILSAFE');

  client.control(0x01020304, 5, { roll: -1000, pitch: 250, yaw: 0, throttle: 1000, mode: 2 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].payload, CONTROL_GOLDEN.subarray(3));

  const down = new Promise((resolve) => client.once('down', resolve));
  const upAgain = new Promise((resolve) => client.once('up', resolve));
  serverSide.destroy();
  await down;
  await upAgain;
  assert.equal(client.connected, true);
});

test('every failsafe reason the core can report has a text on the pilot page', async () => {
  // The reason list mirrors fs_reason_t in core/src/safety.h; the page must explain each one.
  const { REASON_TEXT } = await import('../../web/js/protocol.js');
  for (const r of REASONS.slice(1)) assert.ok(REASON_TEXT[r], `no text for "${r}"`);
  assert.equal(REASONS[6], 'rf_lost');
});
