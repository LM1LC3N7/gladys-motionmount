// -----------------------------------------------------------------------------
// The integration: one MotionMount at the address typed in the configuration
// (and its optional PIN), one TCP connection kept open (the mount tells its
// changes on it), its state read again every interval, one Gladys device, the
// transport badge, the "Test the connection" button, and the commands.
// index.js only wires the SDK handlers to it.
//
// Commands:
//   - "Go to a preset" (the wall, or a preset 1..7 set on the mount) only when
//     "Allow moves" is on (off by default), checked on arrival, after the
//     reads and right before the line leaves. One move at a time (the lane).
//     Before acting, read fresh on the connection: the errors of the mount (an
//     obstruction, a motor or internal error refuses), the preset (set on the
//     mount, and its position within the bounds of the configuration). Sent
//     within 3.5 s of the click or refused unsent, answered by 4.3 s. Only in a
//     session whose identity (MAC) is the one of the device and whose PIN was
//     accepted (or not needed).
//   - "Stop" is always accepted: it is not behind the option, never waits in
//     the lane, goes before every request not written yet and holds the
//     connection (nothing else is written meanwhile), waits 1 s at most for
//     the request on the wire (then cuts the connection and opens a new one),
//     connects at once when the mount is not connected (through the waiting
//     time after a failure: one try), and cancels every move not written yet.
//     The protocol has no stop line: the stop reads the current position and
//     sends it as the target (`mount/preset/position`), so the motors stop
//     where they are. Checked again 1.5 s later, and sent again (3 times at
//     most) while the mount says it moves, unless a move was written after it.
//   - a line that may have reached the mount is never answered "not sent":
//     "sent, without confirmation", then reads; never written again by
//     itself. After such a move, the other moves wait for the preset to be
//     reached or 30 s.
//   - the ack never waits for a publication to Gladys.
// Connection: never sooner than the interval after the previous attempt (the
// Test button, a reconnection to Gladys, a configuration saved unchanged, a
// restart: the time of the last attempt is kept in /data), except the
// follow-up reads of a command and a stop; after a failure 30 s, 1, 2, 5 min,
// never sooner than the interval. A connection or a read of an older
// configuration publishes nothing (generation checked after every await).
// PIN: sent only when the mount says it is needed, once per connection;
// refused -> a final stop kept in /data (another PIN, or a success of the
// Test button, lifts it).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey, normalizeConfig } from './config.js';
import { FEATURES, KEYS, LIMITS, PRESETS, PRESSED, SECOND, TIMINGS } from './constants.js';
import {
  buildDevice,
  mountIds,
  nameOf,
  numberIn,
  parseExternalId,
  presetIndexOf,
} from './devices.js';
import { ERRORS, T, age, errorsText, join, reasonOf, word } from './i18n.js';
import { Lane } from './lane.js';
import { MotionMountError, RANK, openConnection } from './motionmount/client.js';
import {
  authOf,
  blocksMoves,
  boolOf,
  errorsOf,
  intOf,
  macOf,
  positionValue,
  readLine,
  stringOf,
  writeLine,
} from './motionmount/protocol.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, pinMarkOf } from './store.js';

/** The fields kept from a feature created in Gladys, when it is published again as it is. */
const KEPT_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'unit',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/** A position read far outside the travel is not a position. */
const plausible = (n, min, max) =>
  n !== undefined && n >= min - 20 && n <= max + 20 ? n : undefined;

const newSession = (number) => ({
  number,
  conn: undefined,
  /** The MAC read in this connection (undefined: not read, or unreadable). */
  id: undefined,
  name: '',
  /** unknown | ok | needed | refused | wait */
  auth: 'unknown',
  pinSent: false,
  extension: undefined,
  turn: undefined,
  moving: undefined,
  errors: undefined,
  presets: new Map(),
  ready: false,
  setup: undefined,
});

export class MotionMountApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'motionmount' }),
    store = fileStore(),
    open = openConnection,
    now = () => performance.now(),
    wall = Date.now,
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.open = open;
    this.now = now;
    this.wall = wall;
    this.timers = timers;
    this.timings = timings;
    this.publisher = new StatePublisher({ gladys, logger, now: wall, timers });
    this.config = normalizeConfig();
    this.connKey = undefined;
    this.memory = undefined;
    this.generation = 0;
    this.started = false;
    this.session = undefined;
    this.sessions = 0;
    this.opening = undefined;
    this.failures = 0;
    this.lastError = undefined;
    /** Monotonic time before which no connection is opened by the timer. */
    this.nextConnectAt = 0;
    /** When the last connection was tried (monotonic, exact) and the last refresh began. */
    this.attemptAt = -Infinity;
    this.refreshAt = -Infinity;
    /** When the last connection was tried (wall clock, exact; in /data at most once a minute). */
    this.lastAttemptWall = 0;
    this.timer = undefined;
    this.running = undefined;
    this.followUps = new Set();
    this.lane = new Lane();
    /** The moves not written yet (a STOP cancels them). */
    this.tickets = new Set();
    this.commandSeq = 0;
    /** The number of the last move whose line was WRITTEN. */
    this.lastMoveWritten = 0;
    /** The position asked by the last move accepted: { extension, turn }. */
    this.target = undefined;
    this.notReached = false;
    /** Monotonic time until which the other moves wait (a move sent without confirmation). */
    this.unconfirmedUntil = -Infinity;
    /** device external id -> device published in this run (a publication never shrinks). */
    this.known = new Map();
    this.lastStatus = undefined;
    this.published = undefined;
    this.badges = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    const restart = !this.memory;
    if (!this.memory) {
      this.memory = normalizeMemory(await this.store.load().catch(() => null), this.wall());
    }
    if (generation !== this.generation) {
      return;
    }
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    this.failures = 0;
    this.lastError = undefined;
    this.target = undefined;
    this.notReached = false;
    this.unconfirmedUntil = -Infinity;
    if (restart && this.memory.lastAttemptAt > 0) {
      // Written at most once a minute: the real last attempt may be up to a
      // minute later than the one kept. Never sooner than the interval.
      const last = Math.min(
        this.wall(),
        this.memory.lastAttemptAt + this.timings.attemptPersistEvery,
      );
      this.nextConnectAt = this.now() + Math.max(0, last + this.interval - this.wall());
    } else {
      // New address or PIN: at once.
      this.nextConnectAt = this.now();
    }
    await this.tidyMemory();
    if (generation !== this.generation) {
      return;
    }
    this.published = undefined;
    this.badges = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    await this.publishAll();
    if (generation === this.generation && this.config.address) {
      this.schedule();
    }
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.followUps.clear();
    for (const ticket of this.tickets) {
      ticket.cancelled = true;
    }
    this.publisher.stop();
    this.closeSession();
    if (this.memory && this.lastAttemptWall > this.memory.lastAttemptAt) {
      this.memory.lastAttemptAt = this.lastAttemptWall;
      return this.saveMemory();
    }
    return Promise.resolve();
  }

  closeSession() {
    const session = this.session;
    this.session = undefined;
    session?.conn?.close('closed');
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery tab, badges) and the
   * last states, without reading the mount again. Blocks stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { republish: true });
  }

  /**
   * A configuration saved. A new address or PIN starts over; anything else
   * (interval, moves, bounds, language) applies at once, without a read.
   */
  async configUpdated(raw = {}, { republish = false } = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    const next = normalizeConfig(raw);
    if (connectionKey(next) !== this.connKey) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = next;
    if (previous.allowMoves !== next.allowMoves) {
      this.logger.info(`Moves ${next.allowMoves ? 'allowed' : 'disabled'}`);
    }
    if (previous.pollInterval !== next.pollInterval && this.timer && !this.running) {
      this.schedule();
    }
    if (republish) {
      this.published = undefined;
      this.badges = undefined;
      this.lastStatus = undefined;
    } else if (previous.language !== next.language) {
      this.published = undefined;
    }
    await this.publishAll({ states: republish });
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** What /data holds for another address, or a block of another PIN, is dropped. */
  async tidyMemory() {
    const m = this.memory;
    const before = JSON.stringify([m.identity, m.pinBlock, m.pinDrops]);
    const mark = this.config.pin ? pinMarkOf(m.salt, this.config.key, this.config.pin) : undefined;
    if (m.identity && m.identity.address !== this.config.key) {
      m.identity = undefined;
    }
    if (m.pinBlock && (m.pinBlock.address !== this.config.key || m.pinBlock.mark !== mark)) {
      m.pinBlock = undefined;
    }
    if (m.pinDrops && (m.pinDrops.address !== this.config.key || m.pinDrops.mark !== mark)) {
      m.pinDrops = undefined;
    }
    if (JSON.stringify([m.identity, m.pinBlock, m.pinDrops]) !== before) {
      await this.saveMemory();
    }
  }

  // --- PIN -------------------------------------------------------------------

  pinMark() {
    return pinMarkOf(this.memory.salt, this.config.key, this.config.pin);
  }

  pinBlocked() {
    const block = this.memory?.pinBlock;
    return Boolean(
      block &&
      this.config.pin &&
      block.address === this.config.key &&
      block.mark === this.pinMark(),
    );
  }

  /** The PIN refused: a final stop for that PIN, never tried again by itself. */
  async blockPin() {
    const previous = this.memory.pinBlock;
    this.memory.pinBlock = {
      address: this.config.key,
      mark: this.pinMark(),
      failures: (previous?.failures ?? 0) + 1,
    };
    this.memory.pinDrops = undefined;
    await this.saveMemory();
    this.logger.warn(
      'PIN refused by the mount; not tried again until it changes or the Test button',
    );
  }

  /** The connection dropped right after the PIN was sent: the second time in a row is a refusal. */
  async pinDropped() {
    const mark = this.pinMark();
    const drops = this.memory.pinDrops;
    const count =
      drops && drops.address === this.config.key && drops.mark === mark ? drops.count + 1 : 1;
    if (count >= 2) {
      await this.blockPin();
      return;
    }
    this.memory.pinDrops = { address: this.config.key, mark, count };
    await this.saveMemory();
  }

  async clearPinHolds() {
    if (this.memory.pinBlock || this.memory.pinDrops) {
      this.memory.pinBlock = undefined;
      this.memory.pinDrops = undefined;
      await this.saveMemory();
    }
  }

  // --- Connection ------------------------------------------------------------

  alive(session) {
    return Boolean(session && session.conn?.alive && this.session === session);
  }

  /** The time of a connection attempt: exact in memory, in /data at most once a minute. */
  async noteAttempt() {
    this.attemptAt = this.now();
    this.lastAttemptWall = this.wall();
    if (this.lastAttemptWall - this.memory.lastAttemptAt >= this.timings.attemptPersistEvery) {
      this.memory.lastAttemptAt = this.lastAttemptWall;
      await this.saveMemory();
    }
  }

  /**
   * Opens a connection and starts its setup in the background; one opening at
   * a time (a STOP arriving meanwhile shares it).
   * @returns {Promise<object>} the session
   */
  openSession({ timeout = this.timings.connectTimeout, trial = false } = {}) {
    if (this.alive(this.session)) {
      return Promise.resolve(this.session);
    }
    if (!this.opening) {
      this.opening = this.doOpen({ timeout, trial }).finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  async doOpen({ timeout, trial }) {
    const generation = this.generation;
    const address = this.config.address;
    if (!address) {
      throw new MotionMountError('unreachable');
    }
    // Written BEFORE the connection: a restart in the middle never connects sooner.
    await this.noteAttempt();
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.configChanged);
    }
    this.sessions += 1;
    const session = newSession(this.sessions);
    let conn;
    try {
      conn = await this.open(address, {
        timeout: Math.max(100, timeout),
        timings: this.timings,
        now: this.now,
        onNotify: (key, value) => this.notified(session, key, value),
        onClose: (reason) => this.closed(session, reason),
      });
    } catch (err) {
      if (generation === this.generation) {
        this.failed(err);
      }
      throw err;
    }
    if (generation !== this.generation) {
      conn.close('closed');
      throw this.refusal(ERRORS.configChanged);
    }
    session.conn = conn;
    this.session = session;
    this.logger.info(`Connected to the MotionMount at ${this.config.key}`);
    session.setup = this.setup(session, { trial }).catch((err) => {
      if (this.alive(session)) {
        this.logger.warn(`Reading the mount failed: ${reasonOf(err).en}`);
      }
    });
    return session;
  }

  /** A failed or lost connection: the next try waits 30 s, 1, 2, 5 min, never less than the interval. */
  failed(err) {
    const wait = Math.max(
      this.interval,
      this.timings.backoff[Math.min(this.failures, this.timings.backoff.length - 1)],
    );
    this.failures += 1;
    this.lastError = err;
    this.nextConnectAt = this.now() + wait;
    this.logger.warn(`MotionMount: ${reasonOf(err).en}; next try in ${age(wait)}`);
  }

  closed(session, reason) {
    if (this.session !== session) {
      return;
    }
    this.session = undefined;
    if (session.pinSent && session.auth === 'unknown' && this.config.pin) {
      this.pinDropped().catch(() => {});
    }
    this.failed(new MotionMountError(reason === 'unreachable' ? 'closed' : reason));
    this.badges = undefined;
    if (this.started) {
      this.schedule();
      this.publishAll({ states: false }).catch(() => {});
    }
  }

  /** One read on the connection of `session`: the raw value, or undefined when the mount refuses (#4xx). */
  async read(session, key, { rank = RANK.read, timeout, optional = false } = {}) {
    try {
      return await session.conn.read(key, readLine(key), { rank, timeout });
    } catch (err) {
      if (optional && err?.kind === 'refused') {
        return undefined;
      }
      throw err;
    }
  }

  /** The first reads of a connection: identity, name, PIN, state, presets. */
  async setup(session, { trial = false } = {}) {
    const generation = this.generation;
    this.refreshAt = this.now();
    const mac = await this.read(session, KEYS.mac, { optional: true });
    session.id = macOf(mac);
    session.name = stringOf(await this.read(session, KEYS.name, { optional: true })) ?? '';
    await this.authenticate(session, { trial });
    await this.readState(session);
    await this.readPresets(session);
    if (!this.alive(session) || generation !== this.generation) {
      return;
    }
    session.ready = true;
    this.failures = 0;
    this.lastError = undefined;
    await this.noteIdentity(session);
    if (this.alive(session)) {
      this.schedule();
      await this.publishAll();
    }
  }

  /** The identity at the address, and when it was last read (at most once a minute in /data). */
  async noteIdentity(session) {
    if (!session.id) {
      // An identity that cannot be read is not "another mount": nothing changes.
      return;
    }
    const kept = this.memory.identity;
    const wall = this.wall();
    if (kept?.id && kept.id !== session.id) {
      this.logger.warn(`Another MotionMount answers at ${this.config.key} now`);
    }
    if (
      kept?.id !== session.id ||
      kept.address !== this.config.key ||
      wall - kept.readAt >= this.timings.attemptPersistEvery
    ) {
      this.memory.identity = { address: this.config.key, id: session.id, readAt: wall };
      await this.saveMemory();
    }
  }

  /**
   * The PIN: sent only when the mount says it is needed and it may be tried,
   * once per connection, never when it was refused (except for the Test
   * button: once). The status read after it decides.
   */
  async authenticate(session, { rank = RANK.read, trial = false, timeout } = {}) {
    const status = authOf(
      await this.read(session, KEYS.authStatus, { rank, timeout, optional: true }),
    );
    if (!status) {
      // Older firmware without authentication: nothing asked.
      session.auth = 'ok';
      return;
    }
    if (status.authenticated) {
      session.auth = 'ok';
      if (this.config.pin && session.pinSent) {
        await this.clearPinHolds();
      }
      return;
    }
    if (!this.config.pin) {
      session.auth = 'needed';
      return;
    }
    if (this.pinBlocked() && !trial) {
      session.auth = 'refused';
      return;
    }
    if (!status.canTry) {
      session.auth = 'wait';
      return;
    }
    if (trial) {
      // The Test button: the user asks for one more try.
      session.pinSent = false;
    }
    if (!session.pinSent) {
      const line = writeLine(KEYS.pin, this.config.pin);
      try {
        await session.conn.write(KEYS.pin, line, {
          rank,
          timeout,
          beforeSend: () => {
            if (session.pinSent) {
              const skip = new Error('already sent');
              skip.skip = true;
              throw skip;
            }
            session.pinSent = true;
          },
        });
      } catch (err) {
        // A refusal code or a PIN sent by another path: the status decides.
        if (!err?.answered && !err?.skip) {
          throw err;
        }
      }
    }
    const after = authOf(await this.read(session, KEYS.authStatus, { rank, timeout }));
    if (after?.authenticated) {
      session.auth = 'ok';
      this.logger.info('PIN accepted by the mount');
      await this.clearPinHolds();
      return;
    }
    if (session.auth !== 'refused') {
      session.auth = 'refused';
      await this.blockPin();
    }
  }

  /** Position, motion and errors (the notifications of the answers set them, see notified()). */
  async readState(session, { rank = RANK.read, timeout } = {}) {
    for (const key of [KEYS.extension, KEYS.turn, KEYS.moving, KEYS.errorStatus]) {
      await this.read(session, key, { rank, timeout, optional: true });
    }
  }

  /** The presets 1..7 set on the mount: their name and position. */
  async readPresets(session) {
    const presets = new Map();
    for (let n = PRESETS.first; n <= PRESETS.last; n += 1) {
      if (boolOf(await this.read(session, KEYS.presetActive(n), { optional: true })) !== true) {
        continue;
      }
      const name = stringOf(await this.read(session, KEYS.presetName(n), { optional: true })) ?? '';
      presets.set(n, { index: n, name });
    }
    const before = JSON.stringify([...session.presets.values()]);
    session.presets = presets;
    if (JSON.stringify([...presets.values()]) !== before) {
      this.published = undefined;
    }
  }

  /** A `key = value` line of the mount (an answer or a notification). */
  notified(session, key, value) {
    if (this.session !== session && session.conn) {
      return;
    }
    switch (key) {
      case KEYS.extension:
        session.extension = plausible(intOf(value), 0, 100);
        break;
      case KEYS.turn:
        session.turn = plausible(intOf(value), -100, 100);
        break;
      case KEYS.moving:
        session.moving = boolOf(value);
        break;
      case KEYS.errorStatus:
        session.errors = errorsOf(value);
        break;
      default:
        return;
    }
    this.checkTarget(session);
    if (session.ready) {
      this.queueStates();
    }
  }

  /** A move is confirmed only by the mount at rest at the position asked. */
  checkTarget(session) {
    const target = this.target;
    if (
      target &&
      session.moving === false &&
      session.extension !== undefined &&
      session.turn !== undefined &&
      Math.abs(session.extension - target.extension) <= LIMITS.positionTolerance &&
      Math.abs(session.turn - target.turn) <= LIMITS.positionTolerance
    ) {
      this.target = undefined;
      this.notReached = false;
      this.unconfirmedUntil = -Infinity;
      this.badges = undefined;
    }
  }

  // --- Timer -----------------------------------------------------------------

  /** The next refresh (connected) or connection (not connected). */
  schedule() {
    this.clearTimer();
    if (!this.config.address) {
      return;
    }
    const at = this.alive(this.session) ? this.refreshAt + this.interval : this.nextConnectAt;
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('Refresh failed'));
        }
      },
      Math.max(SECOND, at - this.now()),
    );
  }

  /** One run at a time: a tick during a run joins it. */
  tick(options = {}) {
    if (!this.running) {
      this.running = this.run(options).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ trial = false } = {}) {
    const generation = this.generation;
    if (!this.config.address) {
      await this.updateStatus();
      return;
    }
    try {
      const now = this.now();
      if (this.alive(this.session)) {
        if (trial || now >= this.refreshAt + this.interval) {
          await this.refresh(this.session, { trial });
        }
      } else if (trial || now >= this.nextConnectAt) {
        const session = await this.openSession({ trial });
        await session.setup;
      }
    } catch (err) {
      if (!err?.refusal) {
        this.logger.debug?.(`Run: ${reasonOf(err).en}`);
      }
    } finally {
      if (generation === this.generation) {
        this.schedule();
        await this.publishAll();
      }
    }
  }

  /** The periodic reads of a connected mount. */
  async refresh(session, { trial = false } = {}) {
    if (!session.ready) {
      await session.setup;
      return;
    }
    this.refreshAt = this.now();
    if (!session.id) {
      session.id = macOf(await this.read(session, KEYS.mac, { optional: true }));
      await this.noteIdentity(session);
      this.published = undefined;
    }
    if (session.auth !== 'ok' || trial) {
      await this.authenticate(session, { trial });
    }
    await this.readState(session);
    await this.readPresets(session);
  }

  // --- Status ----------------------------------------------------------------

  /** The state of the mount, for the status. */
  mountState() {
    const session = this.session;
    if (this.alive(session) && session.ready) {
      if (!session.id) {
        return { kind: 'noId', wait: age(this.interval) };
      }
      const text = errorsText(session.errors, 'fr');
      return {
        kind: 'ok',
        extension: session.extension,
        turn: session.turn,
        moving: session.moving,
        errors: text,
        errorsEn: errorsText(session.errors, 'en'),
      };
    }
    if (this.alive(session) || this.opening) {
      return { kind: 'connecting' };
    }
    const wait = age(Math.max(0, this.nextConnectAt - this.now()));
    if (!this.lastError) {
      return { kind: 'waiting', wait };
    }
    return { kind: 'unreachable', wait, reason: reasonOf(this.lastError) };
  }

  /** The PIN state to show (undefined: nothing to say). */
  pinState() {
    if (this.pinBlocked()) {
      return 'refused';
    }
    const session = this.session;
    if (this.alive(session) && ['needed', 'refused', 'wait'].includes(session.auth)) {
      return session.auth;
    }
    return undefined;
  }

  /** `[connected, message]`. */
  status() {
    const config = this.config;
    const notes = [
      config.credentialsInHost ? T.credentialsInHost : undefined,
      config.invalid ? T.invalid(config.invalid) : undefined,
      config.local ? T.local : undefined,
      config.pinInvalid ? T.pinInvalid : undefined,
    ];
    if (!config.address) {
      return [false, join(T.noHost, ...notes)];
    }
    const state = this.mountState();
    const session = this.session;
    const name =
      this.alive(session) && session.ready && session.id
        ? `${nameOf(session)} (${config.key})`
        : config.key;
    const other =
      this.alive(session) && session.id && this.createdIds().some((id) => id !== session.id);
    return [
      state.kind === 'ok',
      join(
        T.mountLine(name, state),
        T.pinLine(this.pinState()),
        other ? T.otherMount : undefined,
        T.moves(config.allowMoves, config.maxExtension, config.maxTurn),
        ...notes,
      ),
    ];
  }

  async updateStatus() {
    let connected;
    let message;
    try {
      [connected, message] = this.status();
    } catch (err) {
      // Never a dead status: a value not understood is said so.
      this.logger.error(`Status failed: ${err?.message ?? 'error'}`);
      [connected, message] = [false, ERRORS.generic];
    }
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Gladys ----------------------------------------------------------------

  /** The mount ids of the devices of this integration created in Gladys. */
  createdIds() {
    return (this.gladys.devices ?? [])
      .map((d) => parseExternalId(this.gladys, d?.external_id))
      .filter((t) => t && t.key === undefined)
      .map((t) => t.id);
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async publishAll({ states = true } = {}) {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    if (states) {
      this.queueStates();
      await this.flush();
    }
    await this.publishBadges();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery tab: the mount read in this run. A created device never
   * loses a feature (Gladys would otherwise mark it changed, and "Update"
   * would drop their history), and a device seen earlier in this run stays.
   */
  async publishDevices() {
    const session = this.session;
    if (this.alive(session) && session.ready && session.id) {
      const device = buildDevice(this.gladys, session, { language: this.config.language });
      const created = (this.gladys.devices ?? []).find((d) => d.external_id === device.external_id);
      const published = new Set(device.features.map((f) => f.external_id));
      for (const feature of created?.features ?? []) {
        if (!published.has(feature.external_id)) {
          const kept = {};
          for (const field of KEPT_FIELDS) {
            if (feature[field] !== undefined && feature[field] !== null) {
              kept[field] = feature[field];
            }
          }
          device.features.push(kept);
        }
      }
      this.known.set(device.external_id, device);
    }
    const devices = [...this.known.values()];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** The values of a connected mount, for the created features only (the ack never waits for it). */
  queueStates(created = this.createdFeatures()) {
    const session = this.session;
    if (!this.alive(session) || !session.ready || !session.id) {
      return;
    }
    const ids = mountIds(this.gladys, session.id);
    const push = (key, value) => {
      const id = ids.feature(key);
      if (created.has(id) && value !== undefined) {
        this.publisher.push(id, value);
      }
    };
    push(
      FEATURES.EXTENSION,
      session.extension === undefined ? undefined : { state: session.extension },
    );
    push(FEATURES.TURN, session.turn === undefined ? undefined : { state: session.turn });
    push(
      FEATURES.MOVING,
      session.moving === undefined ? undefined : { state: session.moving ? 1 : 0 },
    );
    push(
      FEATURES.STATUS,
      session.errors === undefined
        ? undefined
        : { text: errorsText(session.errors, this.config.language) },
    );
  }

  /** The badge of a created mount. */
  badgeOf(id) {
    const session = this.session;
    if (!this.alive(session) || !session.ready || session.id !== id) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (this.target && this.unconfirmedUntil > this.now()) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
    }
    if (session.errors && blocksMoves(session.errors)) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: T.badge.errors({
          en: errorsText(session.errors, 'en'),
          fr: errorsText(session.errors, 'fr'),
        }),
      };
    }
    if (this.notReached) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.notReached };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishBadges() {
    // Not tried yet since the start: no badge rather than a wrong one.
    if (!this.session && !this.lastError) {
      return;
    }
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const target = parseExternalId(this.gladys, device?.external_id);
      if (target && target.key === undefined) {
        entries.push({ external_id: device.external_id, ...this.badgeOf(target.id) });
      }
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badges) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badges = json;
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values and its badge at once. */
  async deviceCreated(device) {
    this.badges = undefined;
    const created = this.createdFeatures();
    for (const feature of device?.features ?? []) {
      created.add(feature.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badges = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
    await this.updateStatus();
  }

  /** The Discovery tab asks for a scan: the mount of the last reads, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * "Test the connection": a connection (or a refresh) now, unless one was
   * tried less than an interval ago (then its result). A PIN refused is tried
   * once (the user asks; a success lifts the block).
   */
  async testConnection() {
    if (!this.config.address) {
      return this.status()[1];
    }
    const now = this.now();
    const last = this.alive(this.session) ? this.refreshAt : this.attemptAt;
    if (now < last + this.interval) {
      await this.updateStatus();
      return join(T.test.recent(age(last + this.interval - now)), this.status()[1]);
    }
    await this.tick({ trial: true });
    return this.status()[1];
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config.language));
    error.refusal = true;
    return error;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (target?.key === FEATURES.STOP) {
      if (numberIn(value, PRESSED, PRESSED) !== PRESSED) {
        throw this.refusal(ERRORS.badValue);
      }
      return this.stopNow(received);
    }
    if (target?.key !== FEATURES.PRESET) {
      throw this.refusal(ERRORS.readOnly);
    }
    const index = presetIndexOf(value);
    if (index === undefined) {
      throw this.refusal(ERRORS.badValue);
    }
    if (!this.config.allowMoves) {
      throw this.refusal(ERRORS.movesDisabled);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    this.commandSeq += 1;
    const ticket = {
      id: target.id,
      index,
      seq: this.commandSeq,
      generation: this.generation,
      cancelled: false,
    };
    this.tickets.add(ticket);
    try {
      return await this.lane.run(() => this.move(ticket, received));
    } finally {
      this.tickets.delete(ticket);
    }
  }

  /** The checks of a move, on the latest configuration and session: on arrival, after the reads, before writing. */
  checkMove(ticket, session, sendBy) {
    if (ticket.cancelled) {
      throw this.refusal(ERRORS.stopped);
    }
    if (ticket.generation !== this.generation) {
      throw this.refusal(ERRORS.configChanged);
    }
    if (!this.config.allowMoves) {
      throw this.refusal(ERRORS.movesDisabled);
    }
    if (!this.alive(session) || !session.ready) {
      throw this.refusal(ERRORS.notConnected);
    }
    if (session.id !== ticket.id) {
      throw this.refusal(ERRORS.identity);
    }
    if (session.auth === 'needed') {
      throw this.refusal(ERRORS.pinNeeded);
    }
    if (session.auth === 'refused') {
      throw this.refusal(ERRORS.pinRefused);
    }
    if (session.auth === 'wait') {
      throw this.refusal(ERRORS.pinWait);
    }
    if (session.auth !== 'ok') {
      throw this.refusal(ERRORS.notConnected);
    }
    const now = this.now();
    if (now < this.unconfirmedUntil) {
      throw this.refusal(ERRORS.unconfirmedGuard(age(this.unconfirmedUntil - now)));
    }
    if (now > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
  }

  /** A move to a preset: fresh reads, the checks, then the line. */
  async move(ticket, received) {
    const sendBy = received + this.timings.commandSendBy;
    const answerBy = received + this.timings.commandAnswerBy;
    const session = this.session;
    const check = () => this.checkMove(ticket, session, sendBy);
    check();
    const left = () => Math.max(50, sendBy - this.now());
    const readNow = (key, optional = false) =>
      this.read(session, key, { rank: RANK.command, timeout: left(), optional });
    let extension = 0;
    let turn = 0;
    let errors;
    try {
      errors = errorsOf(await readNow(KEYS.errorStatus));
      if (ticket.index !== PRESETS.wall) {
        if (boolOf(await readNow(KEYS.presetActive(ticket.index), true)) !== true) {
          throw this.refusal(ERRORS.unknownPreset);
        }
        extension = intOf(await readNow(KEYS.presetExtension(ticket.index)));
        turn = intOf(await readNow(KEYS.presetTurn(ticket.index)));
      }
    } catch (err) {
      if (err?.refusal) {
        throw err;
      }
      if (this.now() > sendBy) {
        throw this.refusal(ERRORS.tooSlow);
      }
      // A read has no effect: nothing was sent.
      throw this.refusal(ERRORS.readFailed(reasonOf(err)));
    }
    if (!errors || extension === undefined || turn === undefined) {
      throw this.refusal(ERRORS.readFailed(reasonOf({ kind: 'invalid' })));
    }
    if (blocksMoves(errors)) {
      throw this.refusal(
        ERRORS.mountErrors({ en: errorsText(errors, 'en'), fr: errorsText(errors, 'fr') }),
      );
    }
    if (
      extension < 0 ||
      extension > this.config.maxExtension ||
      Math.abs(turn) > this.config.maxTurn
    ) {
      throw this.refusal(ERRORS.outOfBounds(extension, turn));
    }
    check();
    const name = `MotionMount: preset ${ticket.index}`;
    try {
      await session.conn.write(KEYS.presetIndex, writeLine(KEYS.presetIndex, ticket.index), {
        rank: RANK.command,
        timeout: Math.max(200, answerBy - this.now()),
        tag: 'move',
        // The very last check, right before the line leaves.
        beforeSend: () => {
          check();
          ticket.previous = this.lastMoveWritten;
          this.lastMoveWritten = Math.max(this.lastMoveWritten, ticket.seq);
        },
      });
    } catch (err) {
      if (err?.beforeSend) {
        throw err;
      }
      if (err?.answered) {
        // Refused by the mount: nothing done; it no longer counts as written.
        if (ticket.previous !== undefined && this.lastMoveWritten === ticket.seq) {
          this.lastMoveWritten = ticket.previous;
        }
        this.logger.warn(`${name} refused (${reasonOf(err).en})`);
        throw this.refusal(ERRORS.refused(reasonOf(err)));
      }
      if (!err?.sent) {
        this.logger.warn(`${name} NOT sent (${reasonOf(err).en})`);
        throw this.refusal(ERRORS.notSent(reasonOf(err)));
      }
      // Written, no answer: it may be moving. Confirmed only by the mount at rest there.
      if (ticket.generation === this.generation) {
        this.target = { extension, turn };
        this.notReached = false;
        this.unconfirmedUntil = this.now() + this.timings.unconfirmedGuard;
        this.badges = undefined;
        this.followUp();
      }
      this.logger.warn(`${name} sent, NOT confirmed (${reasonOf(err).en})`);
      throw this.refusal(ERRORS.sentUnconfirmed(reasonOf(err)));
    }
    this.logger.info(`${name} sent`);
    if (ticket.generation !== this.generation) {
      return;
    }
    this.target = ticket.cancelled ? undefined : { extension, turn };
    this.notReached = false;
    this.badges = undefined;
    this.followUp();
  }

  /**
   * STOP: never behind the lane nor the option; every move not written yet is
   * cancelled first, even when this STOP fails.
   */
  async stopNow(received) {
    for (const ticket of this.tickets) {
      ticket.cancelled = true;
    }
    this.target = undefined;
    this.notReached = false;
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    this.commandSeq += 1;
    const stopSeq = this.commandSeq;
    const { cut } = await this.sendStop({
      sendBy: received + this.timings.commandSendBy,
      answerBy: received + this.timings.commandAnswerBy,
    });
    this.logger.info('MotionMount: stop sent');
    this.followUp();
    this.checkStop(stopSeq, 1, cut);
  }

  /**
   * The stop itself, on the connection held for it: the current position read
   * and sent back as the target. A connection busy past 1 s with another
   * request is cut and opened again.
   * @returns {Promise<{ cut: boolean }>} cut: a move was on the wire when the connection was cut
   */
  async sendStop({ sendBy, answerBy }) {
    const generation = this.generation;
    const left = () => sendBy - this.now();
    let cut = false;
    let session;
    let release;
    try {
      session = await this.openSession({
        timeout: Math.min(this.timings.connectTimeout, left() - 300),
      });
      release = session.conn.hold();
      const current = session.conn.current;
      if (current && current.rank !== RANK.stop) {
        const idle = await session.conn.waitIdle(
          Math.max(0, Math.min(this.timings.stopWaitInFlight, left() - 1500)),
        );
        if (!idle) {
          cut = current.tag === 'move';
          this.logger.warn('MotionMount: the connection is busy, cut for the stop');
          release();
          session.conn.close('timeout');
          session = await this.openSession({
            timeout: Math.min(this.timings.connectTimeout, left() - 300),
          });
          release = session.conn.hold();
        }
      }
    } catch (err) {
      release?.();
      if (err?.refusal) {
        throw err;
      }
      throw this.refusal(this.now() > sendBy ? ERRORS.tooSlow : ERRORS.notSent(reasonOf(err)));
    }
    let extension;
    let turn;
    try {
      const timeout = () => Math.max(50, left());
      if (session.auth !== 'ok') {
        await this.authenticate(session, { rank: RANK.stop, timeout: timeout() });
      }
      extension = intOf(
        await this.read(session, KEYS.extension, { rank: RANK.stop, timeout: timeout() }),
      );
      turn = intOf(await this.read(session, KEYS.turn, { rank: RANK.stop, timeout: timeout() }));
    } catch (err) {
      release();
      if (err?.refusal) {
        throw err;
      }
      // A read (or the PIN) failed: the stop line was not written.
      throw this.refusal(this.now() > sendBy ? ERRORS.tooSlow : ERRORS.notSent(reasonOf(err)));
    }
    if (extension === undefined || turn === undefined) {
      release();
      throw this.refusal(ERRORS.positionUnknown);
    }
    try {
      await session.conn.write(
        KEYS.presetPosition,
        writeLine(KEYS.presetPosition, positionValue(extension, turn)),
        {
          rank: RANK.stop,
          timeout: Math.max(200, answerBy - this.now()),
          tag: 'stop',
          beforeSend: () => {
            if (this.now() > sendBy) {
              throw this.refusal(ERRORS.tooSlow);
            }
          },
        },
      );
    } catch (err) {
      if (err?.beforeSend) {
        throw err;
      }
      const reason = reasonOf(err);
      if (err?.answered) {
        this.logger.warn(`MotionMount: stop refused (${reason.en})`);
        throw this.refusal(ERRORS.refused(reason));
      }
      if (!err?.sent) {
        throw this.refusal(this.now() > sendBy ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (generation === this.generation) {
        this.followUp();
      }
      this.logger.warn(`MotionMount: stop sent, NOT confirmed (${reason.en})`);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    } finally {
      release();
    }
    return { cut };
  }

  /**
   * After a stop: 1.5 s later, while the mount still says it moves (or a move
   * was cut on the wire), stop again, 3 times at most, unless a move was
   * written after the stop (the user wants it).
   */
  checkStop(stopSeq, round, cut) {
    if (round > this.timings.stopResends) {
      return;
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(async () => {
      this.followUps.delete(handle);
      if (generation !== this.generation || this.lastMoveWritten > stopSeq) {
        return;
      }
      try {
        let moving = cut && round === 1;
        const session = this.session;
        if (!moving && this.alive(session) && session.ready) {
          moving =
            boolOf(await this.read(session, KEYS.moving, { rank: RANK.stop, optional: true })) ===
            true;
        }
        if (!moving || generation !== this.generation || this.lastMoveWritten > stopSeq) {
          return;
        }
        const now = this.now();
        await this.sendStop({
          sendBy: now + this.timings.commandSendBy,
          answerBy: now + this.timings.commandAnswerBy,
        });
        this.logger.info('MotionMount: stop sent again (the mount still moved)');
        this.checkStop(stopSeq, round + 1, false);
      } catch (err) {
        this.logger.warn(
          `MotionMount: checking the stop failed (${err?.refusal ? err.message : reasonOf(err).en})`,
        );
      }
    }, this.timings.stopCheck);
    this.followUps.add(handle);
  }

  /**
   * Reads after a command, spaced over the travel; one series at a time (a
   * new command replaces it). These reads may connect again sooner than the
   * interval. After the last one, a preset not reached shows on the badge.
   */
  followUp() {
    for (const handle of this.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.followUps.clear();
    const generation = this.generation;
    this.timings.followUps.forEach((delay, index) => {
      const last = index === this.timings.followUps.length - 1;
      const handle = this.timers.setTimeout(async () => {
        this.followUps.delete(handle);
        if (generation !== this.generation) {
          return;
        }
        try {
          let session = this.session;
          if (!this.alive(session)) {
            session = await this.openSession();
            await session.setup;
          } else {
            await this.readState(session);
          }
          if (generation !== this.generation) {
            return;
          }
          if (last && this.target) {
            // The travel is over and the preset was never reached at rest.
            this.target = undefined;
            this.notReached = true;
            this.badges = undefined;
          }
          await this.publishAll();
        } catch (err) {
          this.logger.debug?.(
            `Follow-up read failed: ${err?.refusal ? err.message : reasonOf(err).en}`,
          );
        }
      }, delay);
      this.followUps.add(handle);
    });
  }
}
