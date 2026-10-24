// -----------------------------------------------------------------------------
// The pure parts: the line protocol, the configuration, the device, the store.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseHost, pinOf } from '../src/config.js';
import { buildDevice, parseExternalId, presetIndexOf, presetOptions } from '../src/devices.js';
import {
  authOf,
  blocksMoves,
  boolOf,
  bytesOf,
  errorsOf,
  intOf,
  macOf,
  parseLine,
  positionValue,
  readLine,
  stopTargetOf,
  stringOf,
  writeLine,
} from '../src/motionmount/protocol.js';
import { normalizeMemory, pinMarkOf } from '../src/store.js';

test('lines: a read, a write, nothing else can enter them', () => {
  assert.equal(readLine('mount/extension/current'), 'mount/extension/current\n');
  assert.equal(writeLine('mount/preset/index', 3), 'mount/preset/index = 3\n');
  assert.equal(
    writeLine('mount/preset/position', '[0032ffce]'),
    'mount/preset/position = [0032ffce]\n',
  );
  assert.throws(() => readLine('mount/x\nmount/y'));
  assert.throws(() => readLine('mount extension'));
  assert.throws(() => writeLine('configuration/authentication/pin', '12\n34'));
  assert.throws(() => writeLine('configuration/authentication/pin', '12 34'));
  assert.throws(() => writeLine('mount/preset/index', ''));
});

test('answers: codes, values, junk', () => {
  assert.deepEqual(parseLine('#202'), { kind: 'code', code: 202 });
  assert.deepEqual(parseLine('#404\r'), { kind: 'code', code: 404 });
  assert.deepEqual(parseLine('#20'), { kind: 'junk' });
  assert.deepEqual(parseLine('mount/turn/current = -12'), {
    kind: 'value',
    key: 'mount/turn/current',
    value: '-12',
  });
  assert.deepEqual(parseLine('configuration/name = "A = B"'), {
    kind: 'value',
    key: 'configuration/name',
    value: '"A = B"',
  });
  assert.deepEqual(parseLine('= 3'), { kind: 'junk' });
  assert.deepEqual(parseLine('bad key = 3'), { kind: 'junk' });
  assert.deepEqual(parseLine(''), { kind: 'junk' });
});

test('values: strict, never 0 for an empty text', () => {
  assert.equal(intOf('42'), 42);
  assert.equal(intOf('-3'), -3);
  assert.equal(intOf(''), undefined);
  assert.equal(intOf('4.2'), undefined);
  assert.equal(intOf('0x10'), undefined);
  assert.equal(boolOf('1'), true);
  assert.equal(boolOf('0'), false);
  assert.equal(boolOf('true'), undefined);
  assert.deepEqual([...bytesOf('[80]')], [0x80]);
  assert.equal(bytesOf('[8]'), undefined);
  assert.equal(stringOf('"Salon\u0007 TV"'), 'Salon TV');
  assert.equal(macOf('[f8a55f0d1234]'), 'f8a55f0d1234');
  assert.equal(macOf('[000000000000]'), undefined);
  assert.equal(macOf('[f8a55f]'), undefined);
});

test('authentication status: authenticated, tries left, the wait of the mount', () => {
  assert.deepEqual(authOf('[80]'), { authenticated: true, canTry: true, waitSeconds: 0 });
  assert.deepEqual(authOf('[02]'), { authenticated: false, canTry: true, waitSeconds: 0 });
  assert.deepEqual(authOf('[05]'), { authenticated: false, canTry: false, waitSeconds: 6 });
  assert.equal(authOf('x'), undefined);
});

test('errors: the new form (bits 16..30) and the old one (bit 31)', () => {
  const none = { motor: false, cec: false, obstruction: false, tvWidth: false, internal: false };
  assert.deepEqual(errorsOf('0'), none);
  assert.deepEqual(errorsOf(String((1 << 11) * 65536)), { ...none, obstruction: true });
  assert.deepEqual(errorsOf(String(((1 << 10) | (1 << 4)) * 65536)), {
    ...none,
    motor: true,
    cec: true,
  });
  assert.deepEqual(errorsOf(String(0x80000000 + (1 << 10))), { ...none, motor: true });
  assert.deepEqual(errorsOf(String(0x80000000 + (1 << 4))), { ...none, cec: true });
  assert.deepEqual(errorsOf(String(0x80000000)), { ...none, internal: true });
  assert.equal(errorsOf('-1'), undefined);
  assert.equal(errorsOf('4294967296'), undefined);
  assert.equal(blocksMoves(errorsOf(String((1 << 11) * 65536))), true);
  assert.equal(blocksMoves(errorsOf(String(0x80000000 + (1 << 4)))), false, 'HDMI-CEC only');
});

test('position: big endian unsigned extension and signed turn, never clamped in silence', () => {
  assert.equal(positionValue(50, -50), '[0032ffce]');
  assert.equal(positionValue(100, 100), '[00640064]');
  assert.throws(() => positionValue(-2, 104));
  assert.throws(() => positionValue(101, 0));
  assert.deepEqual(stopTargetOf(101, -101), { extension: 100, turn: -100 });
  assert.deepEqual(stopTargetOf(-3, 105), { extension: 0, turn: 100 });
  assert.equal(stopTargetOf(999, 0), undefined);
  assert.equal(stopTargetOf(20, -4000), undefined);
  assert.equal(stopTargetOf(106, 0), undefined);
  assert.equal(stopTargetOf(undefined, 0), undefined);
});

test('address and PIN: strict, never shown back', () => {
  assert.deepEqual(parseHost('192.168.1.50'), { address: { host: '192.168.1.50', port: 23 } });
  assert.deepEqual(parseHost('tv-mount:2323'), { address: { host: 'tv-mount', port: 2323 } });
  assert.deepEqual(parseHost('user:pw@192.168.1.50'), { credentials: true });
  assert.equal(parseHost('mm.local').local, true);
  assert.deepEqual(pinOf('0042'), { pin: '42', invalid: false });
  assert.deepEqual(pinOf(''), { pin: '', invalid: false });
  assert.deepEqual(pinOf('12345'), { pin: '', invalid: true });
  assert.deepEqual(pinOf('0'), { pin: '', invalid: true });
  assert.deepEqual(pinOf('12\n3'), { pin: '', invalid: true });
  const config = normalizeConfig({ host: '192.168.1.50', pin: 'abcd', max_extension: '250' });
  assert.equal(config.pinInvalid, true);
  assert.equal(config.pin, '');
  assert.equal(config.maxExtension, 100);
  assert.equal(config.allowMoves, false, 'moves off by default');
  assert.equal(normalizeConfig({ allow_moves: 'yes' }).allowMoves, false);
  assert.ok(!JSON.stringify(normalizeConfig({ host: 'a', pin: 'abcd' })).includes('abcd'));
});

test('the device: no switch, the preset list, the stop button', () => {
  const gladys = createFakeGladys({ selector: 'motionmount' });
  const presets = new Map([
    [2, { index: 2, name: 'Cuisine' }],
    [1, { index: 1, name: '' }],
  ]);
  const device = buildDevice(gladys, { id: 'f8a55f0d1234', name: '', presets }, { language: 'en' });
  assert.equal(device.external_id, 'ext:motionmount:motionmount:f8a55f0d1234');
  assert.equal(device.name, 'MotionMount 0d1234');
  for (const feature of device.features) {
    assert.notEqual(feature.category, 'switch');
    assert.ok(!(feature.type === 'binary' && feature.read_only === false), feature.external_id);
  }
  const preset = device.features.find((f) => f.external_id.endsWith(':preset'));
  assert.deepEqual(
    preset.supported_options.map((o) => [o.value, o.label]),
    [
      ['0', 'Wall'],
      ['1', 'Preset 1'],
      ['2', '2. Cuisine'],
    ],
  );
  assert.deepEqual(presetOptions(new Map(), 'fr'), [{ value: '0', label: 'Mur', sort_order: 0 }]);
  assert.deepEqual(parseExternalId(gladys, `${device.external_id}:stop`), {
    id: 'f8a55f0d1234',
    key: 'stop',
  });
  assert.equal(parseExternalId(gladys, 'ext:other:motionmount:f8a55f0d1234'), undefined);
  assert.equal(presetIndexOf('3'), 3);
  assert.equal(presetIndexOf(0), 0);
  assert.equal(presetIndexOf('8'), undefined);
  assert.equal(presetIndexOf(''), undefined);
  assert.equal(presetIndexOf('1.0'), undefined);
});

test('the PIN mark: 8 bits only, a brute force finds dozens of PINs', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const mark = pinMarkOf(salt, '192.168.1.50', '4321');
  assert.match(mark, /^[0-9a-f]{2}$/);
  let same = 0;
  for (let pin = 1; pin <= 9999; pin += 1) {
    if (pinMarkOf(salt, '192.168.1.50', String(pin)) === mark) {
      same += 1;
    }
  }
  assert.ok(same >= 15, `only ${same} PINs share the mark`);
});

test('the memory: repaired and bounded', () => {
  const now = Date.UTC(2026, 9, 24);
  const memory = normalizeMemory(
    {
      lastAttemptAt: now + 1e9,
      identity: { address: 'a', id: 'F8A55F0D1234' },
      pinBlock: { address: 'a', mark: 'zz' },
      pinDrops: { address: 'a', mark: 'ab', count: 9 },
      pin: '1234',
    },
    now,
  );
  assert.equal(memory.lastAttemptAt, now);
  assert.equal(memory.identity, undefined);
  assert.equal(memory.pinBlock, undefined);
  assert.deepEqual(memory.pinDrops, { address: 'a', mark: 'ab', count: 2 });
  assert.ok(!('pin' in memory));
  assert.match(memory.salt, /^[0-9a-f]{32}$/);
});
