# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Vogel's MotionMount motorized
TV mounts: a Node.js service (Node 22+, ESM, no build step) in its own
sandboxed Docker container, talking to Gladys through
`@gladysassistant/integration-sdk` (its only runtime dependency) and to the
mount over its local TCP line protocol (port 23), ported from
python-MotionMount (MIT, see `THIRD_PARTY_NOTICES.md`).

## Commands

```bash
npm install
npm test                                  # node --test
node --test test/app.test.js              # one file
npm run lint
npm run format:check
npm run cover                             # cover.png
```

## Architecture

```
index.js                     SDK wiring only
src/handlers.js              the SDK handlers (shared with the tests)
src/app.js                   MotionMountApp: connection, setup, reads, status, commands
src/motionmount/client.js    one TCP connection: ranked queue, hold, bounds
src/motionmount/protocol.js  lines, values, error status, position (pure)
src/devices.js               the Gladys device, external ids (pure)
src/config.js                normalized configuration (PIN only here)
src/store.js                 /data: last attempt, identity, PIN refusal mark
src/publisher.js             states within 300/min
src/i18n.js                  every text, en + fr
test/helpers/fakeMount.js    a fake MotionMount on 127.0.0.1
```

## Safety rules (a motorized mount can pinch or hit)

- Moves ("go to a preset") stay behind `allow_moves` (off by default), checked
  on arrival, after the fresh reads and in `beforeSend`. Never a `switch` nor a
  writable binary: a "turn everything off" must never move the TV.
- Positions are bounded (`max_extension`, `max_turn`), checked on the preset
  read just before acting; a move is refused while the mount reports an
  obstruction, a motor, internal or TV width error.
- Stop is not behind the option nor the lane; it reads only what it needs
  (the authentication status and the PIN when the mount asks, then the
  position it sends back, each read 1.5 s at most), holds the connection
  (`RANK.stop`, `hold()`), waits 1 s at most for the request on the wire (a
  stop included), retries once on a new connection when a read fails before
  the line, connects at once when needed, cancels the moves not written yet.
  It writes only a plausible position (`stopTargetOf`), never a far value
  brought into range. Never put it behind anything else.
- A line that may have left is never told "not sent"; never retried by the
  integration; the ack never waits for a publication to Gladys.
- The PIN never reaches a log, /data, a status nor an error; only digits enter
  its line; refused -> final (8-bit mark only), lifted by another PIN or the
  Test button.
- Never connect sooner than the interval except the follow-up reads of a
  command and a stop; a reconnection to Gladys reads nothing.
- Docs list the exact refusal cases of a command; no absolute claims.

## Rules

- **External ids are forever**: `gladys.externalIds('motionmount', mac)`.
- **A device published again never loses a feature**.
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  the four places agree (never a pinned value).
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **Manifest** texts are `{ en, fr }`; never write that a secret is encrypted
  (Gladys keeps it in clear in its database); never a `default` on a secret.
- **Style**: Prettier, ESLint, comments in English. Tests never leave the
  loopback. No Bluetooth.
