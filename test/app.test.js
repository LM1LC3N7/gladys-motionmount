// -----------------------------------------------------------------------------
// MotionMountApp with the SDK's fake Gladys, the exact handlers of the
// container (src/handlers.js), a fake MotionMount on 127.0.0.1 (real TCP), a
// fake wall clock and a memory store. The timers of the app are recorded,
// never fired by themselves (a test fires them); the connection keeps its
// real (short) timeouts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MotionMountApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { MAC, OTHER_MAC, fakeClock, fakeMount } from './helpers/fakeMount.js';

const SELECTOR = 'motionmount';
const PIN = '4321';
const id = (mac, key) => `ext:${SELECTOR}:motionmount:${mac}${key ? `:${key}` : ''}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(
  t,
  {
    config = {},
    mountState = {},
    store = memoryStore(),
    devices = [],
    connect = true,
    clock = fakeClock(),
    timings = {},
  } = {},
) {
  const mount = await fakeMount(mountState);
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { host: mount.host, ...config },
    devices,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const timeouts = [];
  const timers = {
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, done: false });
      return timeouts.length;
    },
    clearTimeout: (handle) => {
      if (timeouts[handle - 1]) timeouts[handle - 1].done = true;
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const app = new MotionMountApp({
    gladys,
    logger,
    store,
    wall: clock.now,
    timers,
    timings: { ...TIMINGS, requestTimeout: 300, connectTimeout: 500, ...timings },
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  if (connect) {
    await app.tick();
  }
  t.after(async () => {
    await app.stop();
    await mount.close();
  });
  /** Fires the pending timers whose delay is `ms` (or all with `undefined`). */
  const fire = async (ms) => {
    for (const timer of timeouts.filter((x) => !x.done && (ms === undefined || x.ms === ms))) {
      timer.done = true;
      await timer.fn();
    }
  };
  return { gladys, app, mount, logs, store, clock, timeouts, fire };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (gladys, mac = MAC) =>
  gladys.fake.devices.find((d) => d.external_id === id(mac)) ??
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(mac));
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

function press(gladys, key, value, mac = MAC) {
  const device = deviceOf(gladys, mac);
  return gladys.fake.setValue(device, featureOf(device, key), value);
}

const status = (gladys) => gladys.fake.connectionStatus;
const presetWrites = (mount) => mount.writes('mount/preset/index');
const stopWrites = (mount) => mount.writes('mount/preset/position');

test('connects, publishes the mount with its presets, then its states once created', async (t) => {
  const { gladys, app } = await setup(t);
  const device = deviceOf(gladys);
  assert.ok(device, 'published');
  assert.equal(device.name, 'Salon');
  const preset = featureOf(device, 'preset');
  assert.deepEqual(
    preset.supported_options.map((o) => o.value),
    ['0', '1', '2'],
  );
  assert.ok(!device.features.some((f) => f.category === 'switch'));
  await createAll(gladys);
  await app.flush();
  assert.equal(
    gladys.fake.lastState(id(MAC, 'extension'))?.state ??
      gladys.fake.lastState(id(MAC, 'extension')),
    0,
  );
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Déplacements désactivés/);
});

test('moves are disabled by default: refused, nothing written', async (t) => {
  const { gladys, mount } = await setup(t);
  await createAll(gladys);
  const ack = await press(gladys, 'preset', '1');
  assert.equal(ack.success, false);
  assert.match(ack.error, /désactivés/);
  assert.deepEqual(presetWrites(mount), []);
});

test('a preset when allowed: fresh reads, then the line; the mount gets there', async (t) => {
  const { gladys, mount, timeouts } = await setup(t, { config: { allow_moves: true } });
  await createAll(gladys);
  mount.lines.length = 0;
  const ack = await press(gladys, 'preset', '1');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(mount.lines, [
    'mount/errorStatus',
    'mount/preset/1/active',
    'mount/preset/1/extension',
    'mount/preset/1/turn',
    'mount/preset/index = 1',
  ]);
  assert.equal(mount.state.extension, 60);
  assert.ok(
    timeouts.some((x) => !x.done && x.ms === TIMINGS.followUps[0]),
    'follow-up reads',
  );
  // The wall is preset 0: no preset read.
  assert.equal((await press(gladys, 'preset', 0)).success, true);
  assert.deepEqual(presetWrites(mount), ['mount/preset/index = 1', 'mount/preset/index = 0']);
});

test('bounds, unknown presets, bad values and errors of the mount refuse, nothing written', async (t) => {
  const { gladys, mount } = await setup(t, {
    config: { allow_moves: true, max_extension: 80, max_turn: 90 },
  });
  await createAll(gladys);
  let ack = await press(gladys, 'preset', '2');
  assert.equal(ack.success, false);
  assert.match(ack.error, /bornes/);
  ack = await press(gladys, 'preset', '3');
  assert.match(ack.error, /pas défini/);
  for (const bad of ['', '8', 'abc', null, '1.5']) {
    assert.equal((await press(gladys, 'preset', bad)).success, false, String(bad));
  }
  mount.state.errorStatus = (1 << 11) * 65536;
  ack = await press(gladys, 'preset', '1');
  assert.match(ack.error, /obstacle détecté/);
  assert.deepEqual(presetWrites(mount), []);
  // Read-only features refuse.
  assert.equal((await press(gladys, 'extension', 10)).success, false);
});

test('a move for another mount (an address given to another one) is refused', async (t) => {
  const { gladys, app, mount } = await setup(t, {
    config: { allow_moves: true },
    devices: [],
  });
  await createAll(gladys);
  // Another mount now answers at the address.
  mount.state.mac = OTHER_MAC;
  mount.dropAll();
  await wait(50);
  app.attemptAt = -Infinity;
  await app.tick({ trial: true });
  const ack = await press(gladys, 'preset', '1', MAC);
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre MotionMount/);
  assert.deepEqual(presetWrites(mount), []);
  assert.match(status(gladys).message.fr, /autre MotionMount/);
});

test('stop always works, moves disabled included: the current position sent back as the target', async (t) => {
  const { gladys, mount } = await setup(t, { mountState: { extension: 42, turn: -17 } });
  await createAll(gladys);
  const ack = await press(gladys, 'stop', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(stopWrites(mount), ['mount/preset/position = [002affef]']);
  assert.deepEqual(mount.state.lastPosition, { extension: 42, turn: -17 });
  assert.equal((await press(gladys, 'stop', 0)).success, false, 'only the pressed value');
});

test('stop cancels a move waiting behind another one, and goes first', async (t) => {
  const { gladys, mount } = await setup(t, {
    config: { allow_moves: true },
    timings: { requestTimeout: 2000 },
  });
  await createAll(gladys);
  // The first move's reads hang a little: the second waits in the lane.
  mount.quirk('mount/errorStatus', 'silent');
  const first = press(gladys, 'preset', '1');
  const second = press(gladys, 'preset', '2');
  await wait(100);
  const stop = await press(gladys, 'stop', 1);
  assert.equal(stop.success, true, stop.error);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.success, false);
  assert.equal(b.success, false);
  assert.match(b.error, /arrêt est arrivé/);
  assert.deepEqual(presetWrites(mount), [], 'no move written');
  assert.equal(stopWrites(mount).length, 1);
});

test('stop when the connection hangs: cut, connected again, sent within the budget', async (t) => {
  const { gladys, app, mount } = await setup(t, { timings: { requestTimeout: 3000 } });
  await createAll(gladys);
  mount.quirk('mount/isMoving', 'silent');
  const refresh = app.readState(app.session).catch(() => {});
  await wait(50);
  const started = performance.now();
  const ack = await press(gladys, 'stop', 1);
  assert.equal(ack.success, true, ack.error);
  assert.ok(performance.now() - started < TIMINGS.commandSendBy, 'within 3.5 s');
  assert.equal(mount.connections, 2);
  assert.equal(stopWrites(mount).length, 1);
  await refresh;
});

test('stop before the first connection (after a restart): it connects at once', async (t) => {
  const { gladys, app, mount } = await setup(t, {
    connect: false,
    devices: [],
  });
  assert.equal(mount.connections, 0);
  assert.equal(app.session, undefined);
  const ack = await gladys.fake.setValue(
    { external_id: id(MAC) },
    { external_id: id(MAC, 'stop') },
    1,
  );
  assert.equal(ack.success, true, ack.error);
  assert.equal(stopWrites(mount).length, 1);
});

test('stop is sent again while the mount still moves, never after a newer move', async (t) => {
  const { gladys, mount, fire } = await setup(t, {
    config: { allow_moves: true },
    mountState: { moveAtOnce: false },
  });
  await createAll(gladys);
  assert.equal((await press(gladys, 'preset', '1')).success, true);
  // The mount keeps saying it moves after the stop.
  const ack = await press(gladys, 'stop', 1);
  assert.equal(ack.success, true, ack.error);
  mount.state.moving = true;
  await fire(TIMINGS.stopCheck);
  assert.equal(stopWrites(mount).length, 2, 'sent again');
  // A newer move written: no more stop.
  mount.state.moving = true;
  assert.equal((await press(gladys, 'preset', '2')).success, true);
  await fire(TIMINGS.stopCheck);
  assert.equal(stopWrites(mount).length, 2);
});

test('a move without answer: "sent, without confirmation", the next move waits', async (t) => {
  const { gladys, mount, app } = await setup(t, { config: { allow_moves: true } });
  await createAll(gladys);
  mount.quirk('mount/preset/index', 'silent');
  const ack = await press(gladys, 'preset', '1');
  assert.equal(ack.success, false);
  assert.match(ack.error, /sans confirmation/);
  app.attemptAt = -Infinity;
  await app.tick({ trial: true });
  const next = await press(gladys, 'preset', '2');
  assert.equal(next.success, false);
  assert.match(next.error, /pas encore confirmé/);
  // The stop is never held by it.
  assert.equal((await press(gladys, 'stop', 1)).success, true);
});

test('PIN: sent once when asked, never in the logs, /data nor the status', async (t) => {
  const store = memoryStore();
  const { gladys, mount, logs } = await setup(t, {
    config: { pin: PIN, allow_moves: true },
    mountState: { pin: PIN },
    store,
  });
  await createAll(gladys);
  assert.equal(mount.writes('configuration/authentication/pin').length, 1);
  assert.equal((await press(gladys, 'preset', '1')).success, true);
  const everything = JSON.stringify([logs, store.data, status(gladys)]);
  assert.ok(!everything.includes(PIN), 'no PIN anywhere');
});

test('PIN refused: a final stop kept in /data (a mark only), lifted by another PIN', async (t) => {
  const store = memoryStore();
  const { gladys, app, mount, logs } = await setup(t, {
    config: { pin: '1111', allow_moves: true },
    mountState: { pin: PIN },
    store,
  });
  await createAll(gladys);
  assert.equal(mount.writes('configuration/authentication/pin').length, 1);
  assert.match(store.data.pinBlock.mark, /^[0-9a-f]{2}$/);
  assert.match(status(gladys).message.fr, /refusé/);
  assert.match((await press(gladys, 'preset', '1')).error, /refusé/);
  // Not tried again: next read, a reconnection, a restart.
  mount.dropAll();
  await wait(50);
  await app.tick({});
  app.nextConnectAt = 0;
  await app.tick({});
  assert.equal(mount.writes('configuration/authentication/pin').length, 1);
  assert.ok(!JSON.stringify([logs, store.data]).includes('1111'));
  // Another PIN: tried, accepted, block lifted.
  await gladys.fake.configUpdated({ host: mount.host, pin: PIN, allow_moves: true });
  await app.tick({});
  assert.equal(mount.writes('configuration/authentication/pin').length, 2);
  assert.equal(store.data.pinBlock, undefined);
  assert.equal((await press(gladys, 'preset', '1')).success, true);
});

test('Test button: tries a refused PIN once, never sooner than the interval', async (t) => {
  const { gladys, app, mount } = await setup(t, {
    config: { pin: '1111' },
    mountState: { pin: PIN },
  });
  assert.equal(mount.writes('configuration/authentication/pin').length, 1);
  let text = await app.testConnection();
  assert.match(text.fr, /il y a moins d’un intervalle/);
  app.refreshAt -= 120_000;
  mount.state.pin = '1111';
  text = await app.testConnection();
  assert.match(text.fr, /connecté/);
  assert.equal(mount.writes('configuration/authentication/pin').length, 2);
  assert.equal(app.session.auth, 'ok');
  assert.ok(!app.pinBlocked());
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('no PIN typed, the mount asks one: said in the status, moves refused', async (t) => {
  const { gladys, mount } = await setup(t, {
    config: { allow_moves: true },
    mountState: { pin: PIN },
  });
  await createAll(gladys);
  assert.match(status(gladys).message.fr, /demande son code PIN/);
  assert.match((await press(gladys, 'preset', '1')).error, /code PIN/);
  assert.deepEqual(presetWrites(mount), []);
  assert.equal(mount.writes('configuration/authentication/pin').length, 0);
});

test('a restart never connects sooner than the interval', async (t) => {
  const clock = fakeClock();
  const store = memoryStore({ lastAttemptAt: clock.now() - 10_000 });
  const { app, mount } = await setup(t, { store, clock, connect: false });
  await app.tick();
  assert.equal(mount.connections, 0);
  assert.ok(app.nextConnectAt - performance.now() > 50_000);
});

test('a lost connection: a next try spaced by the interval, the status says it', async (t) => {
  const { gladys, app, mount } = await setup(t);
  mount.dropAll();
  await wait(50);
  assert.equal(app.session, undefined);
  await app.tick();
  assert.equal(mount.connections, 1, 'not again at once');
  assert.match(status(gladys).message.fr, /injoignable|prochaine connexion/);
});

test('a reconnection to Gladys republishes without reading the mount again', async (t) => {
  const { gladys, mount } = await setup(t);
  const before = mount.lines.length;
  await gladys.disconnect();
  await gladys.connect();
  assert.equal(mount.lines.length, before);
  assert.equal(mount.connections, 1);
});

test('notifications move the states; an obstruction shows on the badge', async (t) => {
  const { gladys, app, mount } = await setup(t);
  await createAll(gladys);
  mount.notify('mount/extension/current', '35');
  mount.notify('mount/errorStatus', String((1 << 11) * 65536));
  await wait(50);
  await app.flush();
  await app.publishAll();
  const ext = gladys.fake.lastState(id(MAC, 'extension'));
  assert.equal(ext?.state ?? ext, 35);
  const text = gladys.fake.lastState(id(MAC, 'status'));
  assert.match(JSON.stringify(text), /obstacle/);
  const badge = gladys.fake.transports?.at?.(-1) ?? gladys.fake.transports;
  assert.match(JSON.stringify(badge), /degraded/);
});
