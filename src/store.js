// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), so that a restart never connects again before its time nor
// loops on a refused PIN:
//   - `lastAttemptAt`: when the mount was last connected to (written at most
//     once a minute: src/app.js waits that minute more after a restart);
//   - `pinBlock`: the PIN at that address is held: `kind` 'refused' (the
//     mount said so: a status not authenticated, or a refusal code, right
//     after the PIN) or 'drops' (the connection dropped right after the PIN,
//     twice in a row). Never tried again by itself (a stop still sends it,
//     once per press, after drops only); another PIN lifts it (even typed
//     while the container was stopped), the Test button tries once and lifts
//     it on a success. `pinDrops`: the drops counted so far.
// NO SECRET: no PIN. A PIN has 9999 values, so even a salted hash of it would
// be found back by trying them all: only 8 bits of a salted hash are kept (one
// in 256 PINs shares them; about 39 of the 9999 do), enough to see that the
// PIN typed changed. The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

export const STATE_FILE = '/data/motionmount-state.json';

export function fileStore(path = process.env.DATA_FILE || STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 16 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** 8 bits of the salted hash of a PIN at an address (2 hex digits): a marker, not a fingerprint. */
export const pinMarkOf = (salt, address, pin) =>
  createHash('sha256').update(`${salt}:${address}:${pin}`).digest('hex').slice(0, 2);

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const address = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : undefined;
const count = (value, max) => (Number.isInteger(value) && value > 0 ? Math.min(value, max) : 1);
const mark = (value) =>
  typeof value === 'string' && /^[0-9a-f]{2}$/.test(value) ? value : undefined;

/**
 * The persisted state, repaired and bounded: a last attempt never in the
 * future (a clock that jumped, a file edited by hand).
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const block = object(data.pinBlock);
  const drops = object(data.pinDrops);
  return {
    salt:
      typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
        ? data.salt
        : randomBytes(16).toString('hex'),
    lastAttemptAt: Math.min(
      Math.max(0, Number.isFinite(data.lastAttemptAt) ? data.lastAttemptAt : 0),
      now,
    ),
    pinBlock:
      address(block.address) && mark(block.mark)
        ? {
            address: block.address,
            mark: block.mark,
            kind: block.kind === 'drops' ? 'drops' : 'refused',
            failures: count(block.failures, 100),
          }
        : undefined,
    pinDrops:
      address(drops.address) && mark(drops.mark)
        ? { address: drops.address, mark: drops.mark, count: count(drops.count, 2) }
        : undefined,
  };
}
