// -----------------------------------------------------------------------------
// The cases of review r1 (stop on a stale or busy connection, an implausible
// position, the re-sends of a stop, a half-read session, the Test button
// after a restart, an invalid address, a PIN held after cuts...), against the
// fake MotionMount on 127.0.0.1.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MotionMountApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { RETRY_START, registerHandlers } from '../src/handlers.js';
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
    connect = true,
    clock = fakeClock(),
    timings = {},
    host,
  } = {},
) {
  const mount = await fakeMount(mountState);
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { host: host ?? mount.host, ...config },
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
    timings: { ...TIMINGS, ...timings },
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
  const fire = async (ms) => {
    for (const timer of timeouts.filter((x) => !x.done && x.ms === ms)) {
      timer.done = true;
      await timer.fn();
    }
  };
  const pending = (ms) => timeouts.filter((x) => !x.done && x.ms === ms).length;
  return { gladys, app, mount, logs, store, clock, fire, pending };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const stopPress = (gladys, mac = MAC) =>
  gladys.fake.setValue({ external_id: id(mac) }, { external_id: id(mac, 'stop') }, 1);
const presetPress = (gladys, value) =>
  gladys.fake.setValue({ external_id: id(MAC) }, { external_id: id(MAC, 'preset') }, value);
const stopWrites = (mount) => mount.writes('mount/preset/position');
const presetWrites = (mount) => mount.writes('mount/preset/index');

test('S1: a stale connection (the mount stopped answering on it): the stop opens a new one in time', async (t) => {
  const { gladys, mount } = await setup(t);
  mount.freeze();
  const started = performance.now();
  const ack = await stopPress(gladys);
  assert.equal(ack.success, true, ack.error);
  assert.ok(performance.now() - started < TIMINGS.commandSendBy, 'within 3.5 s');
  assert.equal(mount.connections, 2);
  assert.equal(stopWrites(mount).length, 1);
});

test('S6: two stops while a read hangs: one stop, both acknowledged', async (t) => {
  const { gladys, app, mount } = await setup(t, { timings: { requestTimeout: 3000 } });
  mount.quirk('mount/isMoving', 'silent');
  const refresh = app.readState(app.session).catch(() => {});
  await wait(50);
  const [a, b] = await Promise.all([stopPress(gladys), stopPress(gladys)]);
  assert.equal(a.success, true, a.error);
  assert.equal(b.success, true, b.error);
  assert.equal(stopWrites(mount).length, 1);
  await refresh;
});

test('S12: a stop whose write hangs never holds the next one more than 1 s', async (t) => {
  const { gladys, mount } = await setup(t);
  mount.quirk('mount/preset/position', 'silent');
  const first = stopPress(gladys);
  await wait(100);
  const started = performance.now();
  const second = await stopPress(gladys);
  assert.equal(second.success, true, second.error);
  assert.ok(performance.now() - started < 2000);
  assert.equal(stopWrites(mount).length, 2);
  assert.match((await first).error, /sans confirmation/);
});

test('S17: many presses at once join one stop (never "too many requests")', async (t) => {
  const { gladys, mount } = await setup(t);
  const acks = await Promise.all(Array.from({ length: 80 }, () => stopPress(gladys)));
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks.find((a) => !a.success)),
  );
  assert.ok(stopWrites(mount).length <= 2);
});

test('S10: an implausible position is never written; a hair outside is the bound', async (t) => {
  const { gladys, mount } = await setup(t, {
    config: { max_extension: 40, max_turn: 30 },
    mountState: { extension: 20, turn: 10 },
  });
  mount.quirk('mount/extension/current', 'raw', { text: 'mount/extension/current = 999\n' });
  mount.quirk('mount/turn/current', 'raw', { text: 'mount/turn/current = -4000\n' });
  const ack = await stopPress(gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas comprise/);
  assert.deepEqual(stopWrites(mount), []);
  mount.quirk('mount/extension/current', 'raw', { text: 'mount/extension/current = 101\n' });
  mount.quirk('mount/turn/current', 'raw', { text: 'mount/turn/current = -101\n' });
  assert.equal((await stopPress(gladys)).success, true);
  assert.deepEqual(stopWrites(mount), ['mount/preset/position = [0064ff9c]']);
});

test('S2: a stop written without an answer is checked 1.5 s later and sent again', async (t) => {
  const { gladys, mount, fire, pending } = await setup(t);
  mount.quirk('mount/preset/position', 'silent');
  const ack = await stopPress(gladys);
  assert.match(ack.error, /sans confirmation/);
  assert.equal(pending(TIMINGS.stopCheck), 1);
  await fire(TIMINGS.stopCheck);
  assert.equal(stopWrites(mount).length, 2, 'in doubt, stopped again');
});

test('S3: a re-send refused keeps the remaining rounds', async (t) => {
  const { gladys, mount, fire, pending } = await setup(t);
  assert.equal((await stopPress(gladys)).success, true);
  mount.state.moving = true;
  mount.quirk('mount/preset/position', 'refuse');
  await fire(TIMINGS.stopCheck);
  assert.equal(pending(TIMINGS.stopCheck), 1, 'next round armed');
  mount.state.moving = true;
  await fire(TIMINGS.stopCheck);
  assert.equal(stopWrites(mount).length, 3);
  // At rest: no more round.
  await fire(TIMINGS.stopCheck);
  assert.equal(pending(TIMINGS.stopCheck), 0);
});

test('S9: the check reads the motion on a new connection when the old one is gone', async (t) => {
  const { gladys, mount, fire } = await setup(t);
  assert.equal((await stopPress(gladys)).success, true);
  mount.dropAll();
  await wait(50);
  mount.state.moving = true;
  await fire(TIMINGS.stopCheck);
  assert.equal(stopWrites(mount).length, 2);
  assert.equal(mount.connections, 2);
});

test('S13: a move cut by a stop leaves no guard nor target behind', async (t) => {
  const { gladys, app, mount } = await setup(t, { config: { allow_moves: true } });
  await createAll(gladys);
  mount.quirk('mount/preset/index', 'silent');
  const move = presetPress(gladys, '1');
  await wait(100);
  assert.equal((await stopPress(gladys)).success, true);
  await move;
  assert.equal(app.target, undefined);
  assert.ok(app.unconfirmedUntil < performance.now());
});

test('S8: a configuration saved during a move: the refusal says so', async (t) => {
  const { gladys, mount } = await setup(t, {
    config: { allow_moves: true },
    timings: { requestTimeout: 2000 },
  });
  await createAll(gladys);
  mount.quirk('mount/errorStatus', 'silent');
  const move = presetPress(gladys, '1');
  await wait(50);
  await gladys.fake.configUpdated({ host: mount.host, allow_moves: true, pin: '12' });
  assert.match((await move).error, /configuration a changé/);
  assert.deepEqual(presetWrites(mount), []);
});

test('S15: a setup that fails never stays half-read: closed, said, tried again later', async (t) => {
  const { gladys, app, mount } = await setup(t, { connect: false });
  const readPresets = app.readPresets.bind(app);
  app.readPresets = async () => {
    throw new Error('not understood');
  };
  await app.tick();
  await wait(30);
  assert.equal(app.session, undefined);
  assert.equal(mount.open, 0, 'the connection is closed');
  assert.match(gladys.fake.connectionStatus.message.fr, /injoignable/);
  assert.ok(app.nextConnectAt > performance.now() + 20_000, 'next try after the wait');
  app.readPresets = readPresets;
});

test('S15b: the mount answers #401 to the status read after the PIN', async (t) => {
  const store = memoryStore();
  // A scripted mount: the second status read is refused.
  let statusReads = 0;
  const srv = net.createServer((socket) => {
    socket.on('error', () => {});
    let partial = '';
    socket.on('data', (chunk) => {
      partial += chunk.toString();
      let at;
      while ((at = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, at);
        partial = partial.slice(at + 1);
        if (line === 'configuration/authentication/status') {
          statusReads += 1;
          socket.write(statusReads === 1 ? `${line} = [00]\n` : '#401\n');
        } else if (line === 'mac') socket.write('mac = [f8a55f0d1234]\n');
        else if (line.includes(' = ')) socket.write('#202\n');
        else if (/active$/.test(line)) socket.write(`${line} = 0\n`);
        else if (/current$|isMoving|errorStatus/.test(line)) socket.write(`${line} = 0\n`);
        else socket.write('#404\n');
      }
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { gladys, app } = await setup(t, {
    host: `127.0.0.1:${srv.address().port}`,
    config: { pin: '1111' },
    store,
  });
  assert.equal(store.data.pinBlock?.kind, 'refused');
  assert.equal(app.session?.ready, true, 'not a zombie: read to the end');
  assert.match(gladys.fake.connectionStatus.message.fr, /refusé/);
  app.closeSession();
  await new Promise((resolve) => setImmediate(resolve));
});

test('S4: the Test button right after a restart waits for the interval', async (t) => {
  const clock = fakeClock();
  const store = memoryStore({ lastAttemptAt: clock.now() - 10_000 });
  const { app, mount } = await setup(t, { store, clock, connect: false });
  await app.tick();
  const text = await app.testConnection();
  assert.equal(mount.connections, 0);
  assert.match(text.fr, /il y a moins d’un intervalle/);
});

test('S5: an invalid address is never shown back, only its length', async (t) => {
  const { gladys } = await setup(t, { host: PIN, connect: false });
  const message = JSON.stringify(gladys.fake.connectionStatus);
  assert.ok(!message.includes(PIN));
  assert.match(message, /4 caractères/);
  const long = `${'x'.repeat(300)}`;
  await gladys.fake.configUpdated({ host: long });
  assert.ok(!JSON.stringify(gladys.fake.connectionStatus).includes('xxxx'));
});

test('S11: a PIN held after two cuts: the stop still sends it (once per press), the status says why', async (t) => {
  const store = memoryStore();
  const { gladys, app, mount } = await setup(t, {
    config: { pin: PIN },
    mountState: { pin: PIN },
    store,
    connect: false,
  });
  for (let i = 0; i < 2; i += 1) {
    mount.quirk('configuration/authentication/pin', 'close');
    app.nextConnectAt = 0;
    await app.tick();
    await wait(50);
  }
  assert.equal(store.data.pinBlock?.kind, 'drops');
  assert.match(gladys.fake.connectionStatus.message.fr, /coupée deux fois/);
  const ack = await stopPress(gladys);
  assert.equal(ack.success, true, ack.error);
  assert.equal(stopWrites(mount).length, 1);
  // A cut decided by the integration (a stop) never counts as a cut after the PIN.
  assert.equal(store.data.pinDrops, undefined);
});

test('S7: a stop during the start waits for the configuration', async (t) => {
  const mount = await fakeMount();
  t.after(() => mount.close());
  const gladys = createFakeGladys({ selector: SELECTOR, config: { host: mount.host } });
  const app = new MotionMountApp({
    gladys,
    store: memoryStore(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  t.after(() => app.stop());
  const stop = app.setValue({ external_id: id(MAC) }, { external_id: id(MAC, 'stop') }, 1);
  await wait(30);
  await app.connected({ host: mount.host });
  await stop;
  assert.equal(stopWrites(mount).length, 1);
});

test('a start whose configuration cannot be read is tried again by a timer', async (t) => {
  const gladys = createFakeGladys({ selector: SELECTOR, config: {} });
  const timeouts = [];
  const timers = {
    setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const app = new MotionMountApp({
    gladys,
    store: memoryStore(),
    timers,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  t.after(() => app.stop());
  // The SDK reads the configuration while connecting; the handler's read then fails once.
  let calls = 0;
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) throw new Error('down');
    return getConfig();
  };
  registerHandlers(gladys, app, { error() {} });
  await gladys.connect();
  await wait(10);
  assert.equal(app.started, false);
  const retry = timeouts.find((x) => x.ms === RETRY_START);
  assert.ok(retry, 'retry armed');
  await retry.fn();
  await wait(10);
  assert.equal(app.started, true);
});

test('stop on another mount than the device pressed: sent, but said', async (t) => {
  const { gladys, mount } = await setup(t);
  const ack = await stopPress(gladys, OTHER_MAC);
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre adresse MAC/);
  assert.equal(stopWrites(mount).length, 1);
});

test('the Test button during a periodic read still tries the refused PIN once', async (t) => {
  const { app, mount } = await setup(t, { config: { pin: '1111' }, mountState: { pin: PIN } });
  assert.equal(mount.writes('configuration/authentication/pin').length, 1);
  mount.state.pin = '1111';
  app.refreshAt -= 120_000;
  const periodic = app.tick();
  const text = await app.testConnection();
  await periodic;
  assert.equal(mount.writes('configuration/authentication/pin').length, 2);
  assert.equal(app.session.auth, 'ok');
  assert.match(text.fr, /connecté/);
});
