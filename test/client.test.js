// -----------------------------------------------------------------------------
// The TCP connection against real sockets on 127.0.0.1: framing, bounds,
// order of the requests, the hold of a STOP, the last check before writing,
// and a request left unanswered.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RANK, openConnection } from '../src/motionmount/client.js';
import { TIMINGS } from '../src/constants.js';

/** A server that hands each line to `onLine(socket, line)`. */
async function server(t, onLine) {
  const lines = [];
  const sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    let partial = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      partial += chunk.toString();
      let at;
      while ((at = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, at);
        partial = partial.slice(at + 1);
        lines.push(line);
        onLine(socket, line);
      }
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        srv.close(resolve);
      }),
  );
  return { address: { host: '127.0.0.1', port: srv.address().port }, lines, srv };
}

const timings = { ...TIMINGS, requestTimeout: 300 };

test('an answer split across packets, a notification, a refusal', async (t) => {
  const { address } = await server(t, (socket, line) => {
    if (line === 'mount/turn/current') {
      socket.write('mount/isMov');
      setTimeout(() => socket.write('ing = 1\nmount/turn/cur'), 5);
      setTimeout(() => socket.write('rent = -7\r\n'), 10);
    } else {
      socket.write('#404\n');
    }
  });
  const notes = [];
  const conn = await openConnection(address, {
    timings,
    onNotify: (key, value) => notes.push([key, value]),
  });
  t.after(() => conn.close());
  assert.equal(await conn.read('mount/turn/current', 'mount/turn/current\n'), '-7');
  assert.deepEqual(notes, [
    ['mount/isMoving', '1'],
    ['mount/turn/current', '-7'],
  ]);
  await assert.rejects(
    conn.read('nope', 'nope\n'),
    (err) => err.kind === 'refused' && err.answered && err.code === 404,
  );
});

test('a line too long closes the connection; nothing waits forever', async (t) => {
  const { address } = await server(t, (socket) => socket.write('x'.repeat(2000)));
  let reason;
  const conn = await openConnection(address, { timings, onClose: (r) => (reason = r) });
  await assert.rejects(conn.read('mac', 'mac\n'), (err) => err.kind === 'invalid' && err.sent);
  assert.equal(reason, 'invalid');
  assert.equal(conn.alive, false);
  await assert.rejects(conn.read('mac', 'mac\n'), (err) => err.kind === 'closed' && !err.sent);
});

test('a flood closes the connection, every line still decoded until then', async (t) => {
  const { address } = await server(t, (socket) => {
    socket.write('mount/isMoving = 1\n'.repeat(2500));
  });
  let count = 0;
  let reason;
  const conn = await openConnection(address, {
    timings,
    onNotify: () => (count += 1),
    onClose: (r) => (reason = r),
  });
  await assert.rejects(conn.read('mac', 'mac\n'));
  assert.equal(reason, 'flood');
  assert.ok(count > 1000 && count <= 2001, `${count} lines decoded`);
});

test('an unanswered request closes the connection (a late answer would shift the next one)', async (t) => {
  const { address, lines } = await server(t, (socket, line) => {
    if (line !== 'mount/isMoving') {
      socket.write(`${line} = 1\n`);
    }
  });
  const conn = await openConnection(address, { timings });
  const first = conn.read('mount/isMoving', 'mount/isMoving\n');
  const second = conn.read('mac', 'mac\n');
  await assert.rejects(first, (err) => err.kind === 'timeout' && err.sent);
  await assert.rejects(second, (err) => err.kind === 'closed' && !err.sent);
  assert.deepEqual(lines, ['mount/isMoving']);
});

test('ranks: a stop before a command before a read; a hold lets only the stop through', async (t) => {
  let release;
  const { address, lines } = await server(t, (socket, line) => {
    if (line === 'first') {
      release = () => socket.write('first = 1\n');
    } else if (line.includes(' = ')) {
      socket.write('#202\n');
    } else {
      socket.write(`${line} = 1\n`);
    }
  });
  const conn = await openConnection(address, { timings: { ...timings, requestTimeout: 2000 } });
  t.after(() => conn.close());
  const first = conn.read('first', 'first\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const read = conn.read('r', 'r\n', { rank: RANK.read });
  const command = conn.write('c', 'c = 1\n', { rank: RANK.command });
  const unhold = conn.hold();
  const stop = conn.write('s', 's = 1\n', { rank: RANK.stop });
  release();
  await first;
  await stop;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(lines, ['first', 's = 1'], 'nothing but the stop while held');
  unhold();
  await Promise.all([read, command]);
  assert.deepEqual(lines, ['first', 's = 1', 'c = 1', 'r']);
});

test('beforeSend refuses at the last moment: nothing written', async (t) => {
  const { address, lines } = await server(t, (socket) => socket.write('#202\n'));
  const conn = await openConnection(address, { timings });
  t.after(() => conn.close());
  await assert.rejects(
    conn.write('k', 'k = 1\n', {
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    (err) => err.beforeSend && err.sent === false,
  );
  await conn.write('k', 'k = 2\n');
  assert.deepEqual(lines, ['k = 2']);
});

test('waitIdle: true once the request on the wire is answered, false after the wait', async (t) => {
  let answer;
  const { address } = await server(t, (socket, line) => {
    answer = () => socket.write(`${line} = 1\n`);
  });
  const conn = await openConnection(address, { timings: { ...timings, requestTimeout: 2000 } });
  t.after(() => conn.close());
  const pending = conn.read('a', 'a\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await conn.waitIdle(50), false);
  setTimeout(() => answer(), 20);
  assert.equal(await conn.waitIdle(1000), true);
  await pending;
});

test('a refused connection is "unreachable", nothing sent', async () => {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  await assert.rejects(
    openConnection({ host: '127.0.0.1', port }, { timeout: 500 }),
    (err) => err.kind === 'unreachable' && !err.sent,
  );
});
