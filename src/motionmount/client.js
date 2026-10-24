// -----------------------------------------------------------------------------
// One TCP connection to a MotionMount (plain TCP on the home network, no
// account, no cloud): the lines of src/motionmount/protocol.js, ONE request on
// the wire at a time (the answers carry no request number: they are matched
// in order, as python-MotionMount does), the `key = value` notifications of
// the mount passed on as they come.
//
// - Requests are ranked: RANK.stop (a STOP and its reads) before RANK.command
//   (a move and its reads) before RANK.read (the periodic reads), among those
//   not written yet; while a STOP holds the connection (`hold()`), only
//   RANK.stop requests are written.
// - `beforeSend` runs right before the line is written: it may refuse (the
//   request then never leaves, and the error says so).
// - A request not answered in time closes the connection: a late answer
//   would otherwise be taken for the answer of the next request.
// - Bounded: a line of LIMITS.lineBytes at most (a longer one closes the
//   connection), LIMITS.linesPerWindow lines per TIMINGS.floodWindow (a real
//   flood closes it; every line received is still decoded), LIMITS.queue
//   requests waiting. Text is split on "\n" as it arrives (no concatenation
//   of the whole stream).
// - Errors carry our own words, never a line of the mount nor a request (a
//   PIN is written in one): `kind`, `sent` (the line may have reached the
//   mount), `answered` (the mount answered with a refusal: nothing done).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { LIMITS, TIMINGS } from '../constants.js';
import { parseLine } from './protocol.js';

/** The order of the requests waiting on a connection (lower first). */
export const RANK = Object.freeze({ stop: 0, command: 1, read: 2 });

export class MotionMountError extends Error {
  /**
   * @param {string} kind unreachable | timeout | closed | refused | busy | flood | invalid | late
   * @param {{ sent?: boolean, answered?: boolean, code?: number }} [details]
   */
  constructor(kind, { sent = false, answered = false, code } = {}) {
    super(code === undefined ? kind : `${kind} (#${code})`);
    this.name = 'MotionMountError';
    this.kind = kind;
    this.sent = sent;
    this.answered = answered;
    this.code = code;
  }
}

/** A system error code (ECONNREFUSED...) is ours to show; anything else is not. */
export const systemCode = (err) => {
  const code = err?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : undefined;
};

export class Connection {
  /**
   * @param {net.Socket} socket an open socket
   * @param {{ onNotify?: (key: string, value: string) => void, onClose?: (reason: string) => void,
   *   now?: () => number, timings?: object }} [options]
   */
  constructor(
    socket,
    { onNotify, onClose, now = () => performance.now(), timings = TIMINGS } = {},
  ) {
    this.socket = socket;
    this.onNotify = onNotify ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.now = now;
    this.timings = timings;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.queue = [];
    this.inFlight = undefined;
    this.holds = 0;
    this.closed = false;
    this.closeReason = undefined;
    this.windowStart = now();
    this.windowLines = 0;
    this.idleWaiters = [];
    socket.setNoDelay(true);
    socket.setKeepAlive(true, timings.keepAlive);
    socket.on('data', (chunk) => this.received(chunk));
    socket.on('error', (err) => this.close(systemCode(err) ? 'unreachable' : 'closed'));
    socket.on('close', () => this.close('closed'));
    socket.on('end', () => this.close('closed'));
  }

  get alive() {
    return !this.closed;
  }

  /** What is on the wire now: `{ kind, key, rank, tag }` or undefined. */
  get current() {
    return this.inFlight;
  }

  /** While held, only RANK.stop requests are written (a STOP and its reads). */
  hold() {
    this.holds += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.holds -= 1;
        this.pump();
      }
    };
  }

  /** Reads `key`; resolves with the raw value text. */
  read(key, line, options = {}) {
    return this.request({ ...options, kind: 'read', key, line });
  }

  /** Writes a line; resolves when the mount answers #202. */
  write(key, line, options = {}) {
    return this.request({ ...options, kind: 'write', key, line });
  }

  request({ kind, key, line, rank = RANK.read, beforeSend, timeout, tag }) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new MotionMountError('closed'));
        return;
      }
      if (this.queue.length >= LIMITS.queue) {
        reject(new MotionMountError('busy'));
        return;
      }
      const entry = { kind, key, line, rank, beforeSend, timeout, tag, resolve, reject };
      const at = this.queue.findIndex((e) => e.rank > rank);
      this.queue.splice(at === -1 ? this.queue.length : at, 0, entry);
      this.pump();
    });
  }

  pump() {
    while (!this.closed && !this.inFlight) {
      const at = this.holds > 0 ? this.queue.findIndex((e) => e.rank === RANK.stop) : 0;
      if (at === -1 || this.queue.length === 0) {
        break;
      }
      const [entry] = this.queue.splice(at, 1);
      try {
        entry.beforeSend?.();
      } catch (err) {
        // Refused at the last moment: nothing written.
        err.beforeSend = true;
        err.sent = false;
        entry.reject(err);
        continue;
      }
      this.inFlight = entry;
      entry.timer = setTimeout(
        () => {
          if (this.inFlight === entry) {
            // A late answer would be read as the answer of the next request.
            this.close('timeout');
          }
        },
        Math.max(50, entry.timeout ?? this.timings.requestTimeout),
      );
      this.socket.write(entry.line);
    }
    if (!this.inFlight) {
      for (const resolve of this.idleWaiters.splice(0)) {
        resolve(true);
      }
    }
  }

  /** Resolves true when nothing is on the wire, false after `ms`. */
  waitIdle(ms) {
    if (!this.inFlight || this.closed) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((r) => r !== done);
        resolve(false);
      }, ms);
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.idleWaiters.push(done);
    });
  }

  settle(error, value) {
    const entry = this.inFlight;
    this.inFlight = undefined;
    clearTimeout(entry.timer);
    if (error) {
      entry.reject(error);
    } else {
      entry.resolve(value);
    }
    this.pump();
  }

  received(chunk) {
    if (this.closed) {
      return;
    }
    const text = this.decoder.write(chunk);
    // Linear: one pass with an index, each line sliced once.
    let start = 0;
    let at = text.indexOf('\n', start);
    while (at !== -1) {
      if (this.partial.length + (at - start) > LIMITS.lineBytes) {
        this.close('invalid');
        return;
      }
      const line = this.partial + text.slice(start, at);
      this.partial = '';
      this.line(line);
      if (this.closed) {
        return;
      }
      start = at + 1;
      at = text.indexOf('\n', start);
    }
    if (this.partial.length + (text.length - start) > LIMITS.lineBytes) {
      this.close('invalid');
      return;
    }
    this.partial += text.slice(start);
  }

  line(line) {
    const now = this.now();
    if (now - this.windowStart >= this.timings.floodWindow) {
      this.windowStart = now;
      this.windowLines = 0;
    }
    this.windowLines += 1;
    const parsed = parseLine(line);
    if (parsed.kind === 'code') {
      if (this.inFlight) {
        this.settle(
          parsed.code === 202
            ? undefined
            : new MotionMountError('refused', { answered: true, code: parsed.code }),
          true,
        );
      }
    } else if (parsed.kind === 'value') {
      // Always decoded, even past the flood limit: the last value is kept.
      try {
        this.onNotify(parsed.key, parsed.value);
      } catch {
        // A listener failing never breaks the connection.
      }
      if (this.inFlight?.kind === 'read' && this.inFlight.key === parsed.key) {
        this.settle(undefined, parsed.value);
      }
    }
    if (this.windowLines > LIMITS.linesPerWindow) {
      this.close('flood');
    }
  }

  close(reason = 'closed') {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = reason;
    const entry = this.inFlight;
    this.inFlight = undefined;
    if (entry) {
      clearTimeout(entry.timer);
      entry.reject(
        new MotionMountError(reason === 'unreachable' ? 'closed' : reason, { sent: true }),
      );
    }
    for (const waiting of this.queue.splice(0)) {
      waiting.reject(new MotionMountError('closed'));
    }
    for (const resolve of this.idleWaiters.splice(0)) {
      resolve(true);
    }
    this.socket.destroy();
    try {
      this.onClose(reason);
    } catch {
      // Nothing to do.
    }
  }
}

/**
 * Opens a connection to `{ host, port }` within `timeout` ms.
 * @returns {Promise<Connection>}
 */
export function openConnection(address, { timeout = TIMINGS.connectTimeout, ...options } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host: address.host, port: address.port });
    const fail = (kind) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new MotionMountError(kind));
    };
    const timer = setTimeout(() => fail('unreachable'), Math.max(50, timeout));
    socket.once('error', () => fail('unreachable'));
    socket.once('connect', () => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(new Connection(socket, options));
    });
  });
}
