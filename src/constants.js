// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration), the vocabulary of the MotionMount protocol and the tuning of
// the integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Languages of the feature names (manifest `language` options). */
export const LANGUAGES = ['fr', 'en'];

/** Bounds of the read interval (seconds), mirrored by the manifest. */
export const POLL_INTERVAL = { min: 30, max: 600, default: 60 };

/** Bounds of the extension a preset may reach (percent of the arm), mirrored by the manifest. */
export const MAX_EXTENSION = { min: 0, max: 100, default: 100 };

/** Bounds of the turn a preset may reach (percent, both sides), mirrored by the manifest. */
export const MAX_TURN = { min: 0, max: 100, default: 100 };

/** The TCP port of the MotionMount (the one Home Assistant and Vogel's use). */
export const DEFAULT_PORT = 23;

/**
 * The protocol of the MotionMount (published by Vogel's in python-MotionMount,
 * MIT): one line per request over TCP, `key\n` to read, `key = value\n` to
 * write. A read is answered `key = value`; a write `#202` (accepted) or
 * `#<code>` (refused: 400, 401, 403, 404, 405, 414). The mount also sends
 * `key = value` lines of its own when a value changes (notifications).
 */
export const KEYS = {
  mac: 'mac',
  name: 'configuration/name',
  extension: 'mount/extension/current',
  turn: 'mount/turn/current',
  moving: 'mount/isMoving',
  targetExtension: 'mount/extension/target',
  targetTurn: 'mount/turn/target',
  errorStatus: 'mount/errorStatus',
  authStatus: 'configuration/authentication/status',
  pin: 'configuration/authentication/pin',
  presetIndex: 'mount/preset/index',
  presetPosition: 'mount/preset/position',
  presetActive: (n) => `mount/preset/${n}/active`,
  presetName: (n) => `mount/preset/${n}/name`,
  presetExtension: (n) => `mount/preset/${n}/extension`,
  presetTurn: (n) => `mount/preset/${n}/turn`,
};

/** User presets 1..7; preset 0 is the fixed wall position (extension 0, turn 0). */
export const PRESETS = { wall: 0, first: 1, last: 7 };

/** The protocol ranges of a position (python-MotionMount `go_to_position`). */
export const RANGE = { extension: [0, 100], turn: [-100, 100] };

/** The feature keys (frozen: the external ids end with them). */
export const FEATURES = {
  EXTENSION: 'extension',
  TURN: 'turn',
  MOVING: 'moving',
  STATUS: 'status',
  PRESET: 'preset',
  STOP: 'stop',
};

/** Gladys BUTTON_PUSH: the one value of a `button/push` command. */
export const PRESSED = 1;

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin for the other paths. */
  statesPerMinute: 250,
  /** Bytes of one line from the mount (the longest is a name of 32 characters). */
  lineBytes: 512,
  /** Lines in one window of `TIMINGS.floodWindow`: beyond, a flood, the connection is closed. */
  linesPerWindow: 2000,
  /** Characters of a name read from the mount kept in Gladys. */
  name: 60,
  /** Characters of a transport badge message (SDK limit). */
  badgeMessage: 200,
  /** Distance (in percent) under which a position read equals the one asked. */
  positionTolerance: 3,
  /** Requests waiting on one connection: beyond, a new one is refused at once. */
  queue: 64,
};

export const TIMINGS = {
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /** Opening the TCP connection. */
  connectTimeout: 2 * SECOND,
  /** One request on the connection (a LAN device answers in milliseconds). */
  requestTimeout: 1500,
  /** Lines are counted over this window (flood guard). */
  floodWindow: 10 * SECOND,
  /** TCP keep-alive probes of an idle connection. */
  keepAlive: 30 * SECOND,
  /** A timer may fire this much before its monotonic due time: still due. */
  timerSlack: 20,
  /** The last connection time is written to /data at most this often. */
  attemptPersistEvery: MINUTE,
  /** Delays after a failed or lost connection (never sooner than the interval). */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /**
   * Gladys acks a set_value within 5 s: a command not sent within 3.5 s of
   * its arrival is refused, never sent late; its answer is awaited until 4.3 s.
   */
  commandSendBy: 3500,
  commandAnswerBy: 4300,
  /** A STOP waits this long at most for the request on the wire; then the connection is cut. */
  stopWaitInFlight: SECOND,
  /** A STOP is checked (and sent again while the mount still moves) at this pace, 3 times at most. */
  stopCheck: 1500,
  stopResends: 3,
  /** After a move sent without confirmation, other moves wait for an idle read or this long. */
  unconfirmedGuard: 30 * SECOND,
  /** The mount is read again at these delays after a command (a full travel takes ~15 s). */
  followUps: [2 * SECOND, 8 * SECOND, 20 * SECOND, 45 * SECOND],
};
