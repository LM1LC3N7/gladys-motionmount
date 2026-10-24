// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The PIN is kept
// here only: never logged, never in /data (only a marker of a PIN the mount
// REFUSED, 8 bits of a salted hash, see src/store.js), never in a status or an
// error; an invalid one is never shown back (it may be a pasted secret).
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, MAX_EXTENSION, MAX_TURN, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  poll_interval: POLL_INTERVAL.default,
  allow_moves: false,
  max_extension: MAX_EXTENSION.default,
  max_turn: MAX_TURN.default,
  language: 'fr',
};

/** The optional fields without a default in the manifest (the PIN is a secret). */
const OPTIONAL = { pin: '' };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (23 by default). Credentials ("user:pass@host") are refused and
 * never shown; names in .local are refused (mDNS does not resolve in the
 * container).
 * The text typed is never kept for display (it may be a secret pasted in the
 * wrong field): an invalid entry only gives its length.
 * @returns {{ address?: { host: string, port: number }, invalid?: number, credentials?: boolean, local?: boolean }}
 */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (text.includes('@')) {
    return { credentials: true };
  }
  if (text.length > 260) {
    return { invalid: text.length };
  }
  const shown = text.length;
  text = text.replace(/^(?:tcp|telnet):\/\//i, '').replace(/\/.*$/, '');
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return { invalid: shown };
  }
  const [, host, portText] = match;
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return { invalid: shown };
  }
  if (/\.local\.?$/.test(host)) {
    return { local: true, invalid: shown };
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  return valid ? { address: { host, port } } : { invalid: shown };
}

/** `host` or `host:port` (port 23 left out): the address in /data and in the statuses. */
export const addressKey = (address) =>
  address ? (address.port === DEFAULT_PORT ? address.host : `${address.host}:${address.port}`) : '';

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

/**
 * The PIN of the "User" level of the mount: 1 to 4 digits, 1 to 9999
 * (python-MotionMount `authenticate`). Only digits: nothing else can enter the
 * line it is written in.
 * @returns {{ pin: string, invalid: boolean }} `pin` '' when none (or invalid)
 */
export function pinOf(value) {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    return { pin: '', invalid: false };
  }
  if (!/^\d{1,4}$/.test(text) || Number(text) < 1) {
    return { pin: '', invalid: true };
  }
  return { pin: String(Number(text)), invalid: false };
}

/**
 * @returns {{ address?: { host: string, port: number }, key: string, invalid?: number,
 *   local: boolean, credentialsInHost: boolean, pin: string, pinInvalid: boolean,
 *   pollInterval: number, allowMoves: boolean, maxExtension: number, maxTurn: number,
 *   language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const parsed = parseHost(typeof c.host === 'string' ? c.host : '');
  const { pin, invalid: pinInvalid } = pinOf(c.pin);
  return {
    address: parsed.address,
    key: addressKey(parsed.address),
    invalid: parsed.invalid,
    local: Boolean(parsed.local),
    credentialsInHost: Boolean(parsed.credentials),
    pin,
    pinInvalid,
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    allowMoves: strictTrue(c.allow_moves),
    maxExtension: bounded(c.max_extension, MAX_EXTENSION),
    maxTurn: bounded(c.max_turn, MAX_TURN),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What the connection depends on: a change starts it over (compared in memory only). */
export const connectionKey = (config) => JSON.stringify([config.key, config.pin]);
