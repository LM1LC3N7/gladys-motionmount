# TODO — Vogel's MotionMount v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-10-24): TCP line protocol (python-MotionMount
      2.3.1), one mount, one persistent connection with notifications, identity
      (MAC), optional PIN, positions, motion, error status, preset list behind
      `allow_moves` with bounds, Stop (current position as target) outside
      every queue, follow-up reads, en/fr, docs, cover. Tested against a
      simulated MotionMount only.
- [x] **Milestone 1 fixes — review r1** (2026-10-24): stop on a stale or busy
      connection (reads 1.5 s, one retry on a new connection, a stop write
      cut after 1 s, presses joined), only a plausible stop target, stop
      re-sends after an unconfirmed stop and through failed re-sends, a failed
      first read closes the connection, #4xx after the PIN is a refusal, Test
      button spacing after a restart, no invalid address shown back, PIN held
      after cuts still sent by a stop, refusal reasons, deadlines counted
      from the arrival, stop waits for the start, getConfig retried,
      identity of the stopped mount, dead /data identity removed, docs.
- [ ] **Milestone 2 — real mount**: run against a real MotionMount (see "To
      check"); turn the answers into fixtures.
- [ ] **Milestone 3 — more**: several mounts, a "go to position" (extension,
      turn) bounded by the same options, the current preset as the state of
      the list, zeroconf discovery (`_tvm7675._tcp`) through `scanNetwork`.
- [ ] **Milestone 4 — first release**: Release workflow, topic, GHCR package
      public.

## To check on a real MotionMount

- That `mount/preset/position = [current]` really stops a move under way (and
  how much it moves back, given the rounding); whether a firmware has a real
  stop line.
- The answer of a write (`#202` only, or also a notification first) and of a
  wrong PIN (`#202` then a status without bit 7, or `#401`/`#403`).
- Whether reads need the PIN, and whether authentication is per connection.
- Which notifications the mount sends by itself during a move
  (`mount/extension/current`, `mount/isMoving`...) and how often.
- The value of `mount/errorStatus` during an obstruction.
- How many connections the mount accepts at once (the stop cuts and reopens
  one).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-motionmount:0.1.0`):
  the first patch release gives 0.1.1.
- **python-MotionMount (MIT, Vogel's Products)** is ported, not run: the
  protocol only. Its full licence is in THIRD_PARTY_NOTICES.md, copied into
  the image. `LICENSE` is Apache-2.0 without a name.
- **One MotionMount per integration** in v1 (a home rarely has two; several
  mounts would need address=PIN pairs).
- **Features**: extension and turn as read-only `unknown/integer` (no unit:
  percent of the travel, the core lists none for these categories), moving as
  read-only `unknown/binary`, status as `text/text`, "go to a preset" as
  `text/select` (the wall + the active presets, `supported_options` upserted
  at each publication), stop as `button/push`. No switch, no writable binary.
  No direct position command in v1 (presets only).
- **Identity rule** (frozen): the MAC read from `mac`; none (older firmware, all
  zeros) -> not published, read again at each refresh; moves refused; stop
  still works.
- **Stop**: the protocol has no stop line; the current position (read fresh,
  rank `stop`) is written as the target with `mount/preset/position`. Not
  behind `allow_moves`. Holds the connection; waits 1 s at most for the request
  on the wire, then cuts and reconnects; connects at once through the backoff
  (one try). Checked 1.5 s later, sent again while `isMoving` is 1 (3 times at
  most), unless a move was written after it; a move cut on the wire forces one
  more stop. The stop guard is not kept in /data (a restart in those 5 s loses
  the re-sends; said in the docs).
- **Stop target**: only a plausible position (integers within 0..100 and
  -100..100, ±5 brought back to the bound); further, nothing written
  ("position not understood"). `positionValue` throws out of range: never a
  silent clamp.
- **Stop on a stale connection**: each read 1.5 s at most; a read failing
  before the line opens a new connection and tries once more within the
  3.5 s; a request on the wire (a stop write included) is waited 1 s at most,
  then cut. Presses while the stop line is not written join it.
- **Stop and the PIN**: a PIN refused by the mount (status not authenticated
  or a refusal code right after it) is not sent again by the stop (it would
  fail again); the mount then refuses the stop (#401), said in the docs. A PIN
  held after two cuts right after it (`kind: 'drops'`) is still sent by a
  stop, once per press. A cut decided by the integration never counts.
- **Moves**: one at a time (lane); fresh reads before each (error status, the
  preset active, its extension and turn); refused on an obstruction, motor,
  internal or TV width error (not on HDMI-CEC); bounds checked on the preset
  read. A move written without an answer: "sent, without confirmation", the
  next moves wait for the preset reached at rest or 30 s.
- **Ranks on the wire**: stop (0) before commands (1) before reads (2), among
  the requests not written yet; one request on the wire at a time, as the
  library (the answers carry no number). An unanswered request closes the
  connection (1.5 s; a command waits up to its 4.3 s).
- **PIN**: digits only (1..9999); sent only when the status says not
  authenticated and tries are allowed, once per connection; refused -> final,
  8-bit mark in /data (brute force test: dozens of PINs share it); a connection
  dropped right after the PIN, twice in a row, is a refusal. Lifted by another
  PIN (mark differs; one in 256 new PINs shares the mark: then the Test button)
  or the Test button (one try).
- **Connection spacing**: never sooner than the interval (30..600 s, default 60) after the last attempt, kept in /data (at most once a minute, before
  connecting); backoff 30 s, 1, 2, 5 min; follow-up reads (2, 8, 20, 45 s) and
  the stop may connect sooner.
- **Bounds**: lines 512 bytes, 2000 lines per 10 s, 64 requests waiting,
  /data file 16 KB.
