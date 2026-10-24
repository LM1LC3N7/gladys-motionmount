// -----------------------------------------------------------------------------
// A fake MotionMount on 127.0.0.1 (a real TCP server, the loopback only): the
// line protocol of python-MotionMount, the PIN of the "User" level, presets,
// error status, notifications. Every line received is recorded; a key can be
// left unanswered (to see a timeout) or close the connection.
// -----------------------------------------------------------------------------

import net from 'node:net';

export const MAC = 'f8a55f0d1234';
export const OTHER_MAC = 'f8a55f0d9999';

export function fakeClock(start = Date.UTC(2026, 9, 24, 10, 0, 0)) {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

const hexOf = (bytes) => `[${Buffer.from(bytes).toString('hex')}]`;

export async function fakeMount(initial = {}) {
  const state = {
    mac: MAC,
    name: 'Salon',
    extension: 0,
    turn: 0,
    moving: false,
    errorStatus: 0,
    pin: undefined,
    failures: 0,
    presets: {
      1: { active: true, name: 'Canapé', extension: 60, turn: -40 },
      2: { active: true, name: 'Cuisine', extension: 100, turn: 100 },
      3: { active: false, name: '', extension: 0, turn: 0 },
    },
    /** The mount moves at once to a preset asked (false: it stays "moving" until finish()). */
    moveAtOnce: true,
    ...initial,
  };
  /** key -> 'silent' | 'close' | 'refuse' (once each, or always with `always`). */
  const quirks = new Map();
  const lines = [];
  const sockets = new Set();
  let connections = 0;

  const send = (socket, text) => {
    if (!socket.destroyed) {
      socket.write(`${text}\n`);
    }
  };
  const broadcast = (text) => {
    for (const socket of sockets) {
      send(socket, text);
    }
  };

  function valueOf(key, socket) {
    if (key === 'mac') {
      return state.mac === undefined ? undefined : hexOf(Buffer.from(state.mac, 'hex'));
    }
    if (key === 'configuration/name') return `"${state.name}"`;
    if (key === 'mount/extension/current') return String(state.extension);
    if (key === 'mount/turn/current') return String(state.turn);
    if (key === 'mount/isMoving') return state.moving ? '1' : '0';
    if (key === 'mount/errorStatus') return String(state.errorStatus);
    if (key === 'configuration/authentication/status') {
      const authenticated = state.pin === undefined || socket.authenticated;
      return hexOf([(authenticated ? 0x80 : 0) | Math.min(state.failures, 0x7f)]);
    }
    const preset = /^mount\/preset\/(\d)\/(active|name|extension|turn)$/.exec(key);
    if (preset) {
      const p = state.presets[preset[1]];
      if (!p) return preset[2] === 'active' ? '0' : undefined;
      if (preset[2] === 'active') return p.active ? '1' : '0';
      if (preset[2] === 'name') return `"${p.name}"`;
      return String(p[preset[2]]);
    }
    return undefined;
  }

  function moveTo(extension, turn) {
    if (state.moveAtOnce) {
      state.extension = extension;
      state.turn = turn;
      state.moving = false;
      broadcast(`mount/extension/current = ${extension}`);
      broadcast(`mount/turn/current = ${turn}`);
    } else {
      state.moving = true;
      state.pending = { extension, turn };
      broadcast('mount/isMoving = 1');
    }
  }

  function write(socket, key, value) {
    const needsPin = state.pin !== undefined && !socket.authenticated;
    if (key === 'configuration/authentication/pin') {
      if (String(state.pin) === value) {
        socket.authenticated = true;
        state.failures = 0;
      } else {
        state.failures += 1;
      }
      return '#202';
    }
    if (needsPin) {
      return '#401';
    }
    if (key === 'mount/preset/index') {
      const n = Number(value);
      if (n === 0) {
        moveTo(0, 0);
        return '#202';
      }
      const p = state.presets[n];
      if (!p || !p.active) return '#404';
      moveTo(p.extension, p.turn);
      return '#202';
    }
    if (key === 'mount/preset/position') {
      const bytes = Buffer.from(value.slice(1, -1), 'hex');
      const extension = bytes.readUInt16BE(0);
      const turn = bytes.readInt16BE(2);
      state.stops = (state.stops ?? 0) + 1;
      state.lastPosition = { extension, turn };
      // The motors stop where they are (the target is the current position).
      state.moving = false;
      state.pending = undefined;
      state.extension = extension;
      state.turn = turn;
      return '#202';
    }
    return '#405';
  }

  function handle(socket, line) {
    lines.push(line);
    if (socket.frozen) {
      // A stale connection: open, but nothing answers on it any more.
      return;
    }
    const [key, value] = line.includes(' = ') ? line.split(' = ') : [line, undefined];
    const quirk = quirks.get(key);
    if (quirk) {
      if (!quirk.always) quirks.delete(key);
      if (quirk.kind === 'silent') return;
      if (quirk.kind === 'close') {
        socket.destroy();
        return;
      }
      if (quirk.kind === 'refuse') {
        send(socket, '#403');
        return;
      }
      if (quirk.kind === 'raw') {
        socket.write(quirk.text);
        return;
      }
    }
    if (value !== undefined) {
      send(socket, write(socket, key, value));
      return;
    }
    const answer = valueOf(key, socket);
    send(socket, answer === undefined ? '#404' : `${key} = ${answer}`);
  }

  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.authenticated = false;
    let partial = '';
    socket.on('data', (chunk) => {
      partial += chunk.toString('utf8');
      let at;
      while ((at = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, at);
        partial = partial.slice(at + 1);
        handle(socket, line);
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    lines,
    port,
    host: `127.0.0.1:${port}`,
    get connections() {
      return connections;
    },
    get open() {
      return sockets.size;
    },
    /** The next request of `key` (or every one with always) is: silent, close, refuse, raw text. */
    quirk(key, kind, { always = false, text } = {}) {
      quirks.set(key, { kind, always, text });
    },
    clearQuirks() {
      quirks.clear();
    },
    notify(key, value) {
      broadcast(`${key} = ${value}`);
    },
    /** A slow move reaches its target. */
    finish() {
      if (state.pending) {
        state.extension = state.pending.extension;
        state.turn = state.pending.turn;
        state.pending = undefined;
      }
      state.moving = false;
      broadcast(`mount/extension/current = ${state.extension}`);
      broadcast(`mount/turn/current = ${state.turn}`);
      broadcast('mount/isMoving = 0');
    },
    /** The connections open now stop answering (a mount restarted, a cable cut); new ones answer. */
    freeze() {
      for (const socket of sockets) {
        socket.frozen = true;
      }
    },
    dropAll() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    writes: (key) => lines.filter((l) => l.startsWith(`${key} = `)),
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
