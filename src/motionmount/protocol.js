// -----------------------------------------------------------------------------
// The line protocol of the MotionMount (pure). Ported from python-MotionMount
// (MIT, Vogel's Products, see THIRD_PARTY_NOTICES.md): the request lines, the
// answers (`#<code>` or `key = value`), the value forms (integer, quoted
// string, `[hex bytes]`, 0/1), the position of `mount/preset/position` (an
// unsigned 16-bit extension and a signed 16-bit turn, big endian, in hex), and
// the aggregation of the error status.
//
// Strict on both sides: a key or a value we send never holds anything but the
// characters it needs (never a CR, LF or control character: a line protocol);
// a value read that is not exactly of its form is "unknown", never 0.
// -----------------------------------------------------------------------------

import { LIMITS, RANGE } from '../constants.js';

const KEY = /^[A-Za-z0-9/]{1,64}$/;
const VALUE = /^(?:-?\d{1,6}|\[[0-9a-f]{2,16}\])$/;
const INTEGER = /^-?\d{1,10}$/;

/** The line of a read of `key`. */
export function readLine(key) {
  if (!KEY.test(key)) {
    throw new Error('invalid key');
  }
  return `${key}\n`;
}

/** The line of a write of `value` (an integer or `[hex]`) to `key`. */
export function writeLine(key, value) {
  const text = String(value);
  if (!KEY.test(key) || !VALUE.test(text)) {
    throw new Error('invalid request');
  }
  return `${key} = ${text}\n`;
}

/**
 * One line received (its end of line removed), as
 * `{ kind: 'code', code }`, `{ kind: 'value', key, value }` or `{ kind: 'junk' }`.
 */
export function parseLine(line) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text.length === 0 || text.length > LIMITS.lineBytes) {
    return { kind: 'junk' };
  }
  if (text[0] === '#') {
    return /^#\d{3}$/.test(text) ? { kind: 'code', code: Number(text.slice(1)) } : { kind: 'junk' };
  }
  const at = text.indexOf('=');
  if (at <= 0) {
    return { kind: 'junk' };
  }
  const key = text.slice(0, at).trim();
  const value = text.slice(at + 1).trim();
  if (!KEY.test(key)) {
    return { kind: 'junk' };
  }
  return { kind: 'value', key, value };
}

/** An integer value, or undefined (an empty text is not 0). */
export function intOf(value) {
  if (typeof value !== 'string' || !INTEGER.test(value)) {
    return undefined;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A 0/1 value, or undefined. */
export function boolOf(value) {
  return value === '0' ? false : value === '1' ? true : undefined;
}

/** A `[hex]` value as a Buffer, or undefined. */
export function bytesOf(value) {
  if (typeof value !== 'string' || !/^\[(?:[0-9a-fA-F]{2}){1,32}\]$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value.slice(1, -1), 'hex');
}

/** A quoted string value (the quotes removed), without control characters, or undefined. */
export function stringOf(value, max = LIMITS.name) {
  if (typeof value !== 'string' || value.length > LIMITS.lineBytes) {
    return undefined;
  }
  const inner =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  let out = '';
  for (const char of inner) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/** The identity of a `mac` value: 12 lower-case hex digits, or undefined (missing, all zero). */
export function macOf(value) {
  const bytes = bytesOf(value);
  if (!bytes || bytes.length !== 6 || bytes.every((b) => b === 0)) {
    return undefined;
  }
  return bytes.toString('hex');
}

/**
 * The authentication status byte: bit 7 = authenticated (or no PIN set on
 * the mount); the rest counts the failed attempts: beyond 3, the mount makes
 * a client wait (count - 3) * 3 s before the next try.
 */
export function authOf(value) {
  const bytes = bytesOf(value);
  if (!bytes || bytes.length < 1) {
    return undefined;
  }
  const status = bytes[0];
  const authenticated = (status & 0x80) === 0x80;
  return {
    authenticated,
    canTry: authenticated || status <= 3,
    waitSeconds: authenticated || status <= 3 ? 0 : (status - 3) * 3,
  };
}

/**
 * The aggregated errors of `mount/errorStatus` (python-MotionMount
 * `system_status`): the active errors in bits 16..30 (new firmware), or, when
 * none is set there, the old form (bit 31 = an error, bit 10 motor, bit 4
 * HDMI-CEC, anything else internal). Undefined when the value is not a
 * 32-bit unsigned integer.
 */
export function errorsOf(value) {
  const n = typeof value === 'number' ? value : intOf(value);
  if (n === undefined || n < 0 || n > 0xffffffff) {
    return undefined;
  }
  const errors = { motor: false, cec: false, obstruction: false, tvWidth: false, internal: false };
  const active = (n >>> 16) & 0x7fff;
  if (active === 0) {
    if ((n >>> 31) & 1) {
      if (n & (1 << 10)) {
        errors.motor = true;
      } else if (n & (1 << 4)) {
        errors.cec = true;
      } else {
        errors.internal = true;
      }
    }
  } else {
    errors.motor = Boolean(active & (1 << 10));
    errors.cec = Boolean(active & (1 << 4));
    errors.obstruction = Boolean(active & (1 << 11));
    errors.tvWidth = Boolean(active & (1 << 12));
    errors.internal = Boolean(active & 0b1111100000);
  }
  return errors;
}

/** Whether an error forbids a move (the mount must be looked at first). */
export const blocksMoves = (errors) =>
  Boolean(errors && (errors.motor || errors.obstruction || errors.internal || errors.tvWidth));

/** The value of `mount/preset/position`: `[EEEETTTT]`, extension and turn clamped to the protocol ranges. */
export function positionValue(extension, turn) {
  const e = Math.min(RANGE.extension[1], Math.max(RANGE.extension[0], Math.round(extension)));
  const t = Math.min(RANGE.turn[1], Math.max(RANGE.turn[0], Math.round(turn)));
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16BE(e, 0);
  bytes.writeInt16BE(t, 2);
  return `[${bytes.toString('hex')}]`;
}
