# gladys-motionmount

[Gladys Assistant](https://gladysassistant.com) external integration for
**Vogel's MotionMount** motorized TV mounts (Signature, TVM 7675 Pro): the
mount becomes a Gladys device of the Discovery tab (extension, turn, motion,
errors, go to a preset, stop), over its local TCP protocol (port 23), on the
local network only. Unofficial, not affiliated with Vogel's.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Development version.** Tested against a simulated MotionMount only: it has
> never been tested with a real MotionMount yet. Feedback and bug reports are
> welcome in the [GitHub issues](https://github.com/LM1LC3N7/gladys-motionmount/issues).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (MotionMountApp) ⇄ src/motionmount/client.js ⇄ TCP <mount>:23
                                   ├─ src/motionmount/protocol.js  lines, values, errors (pure)
                                   ├─ src/lane.js                  one move at a time
                                   ├─ src/devices.js               the Gladys device, ids (pure)
                                   ├─ src/publisher.js             states within 300/min
                                   └─ src/store.js                 /data: last attempt, identity, PIN refusal mark
```

- **Protocol** (from python-MotionMount, MIT, Vogel's Products): one line per
  request, `key` to read, `key = value` to write; answers `key = value` or
  `#<code>` (`#202` accepted). One request on the wire at a time (answers carry
  no number); the mount also sends `key = value` notifications. Lines bounded
  (512 bytes), a flood closes the connection, an unanswered request closes it
  (a late answer would shift the next one).
- **Device**: `unknown/integer` extension (0..100) and turn (-100..100),
  `unknown/binary` moving, `text/text` status, `text/select` "go to a preset"
  (wall + presets 1..7 as `supported_options`), `button/push` stop. Never a
  `switch`. Identity rule (it fixes the external ids): the MAC address read from
  the mount; `ext:<selector>:motionmount:<12 hex digits>`.
- **Moves**: behind `allow_moves` (off by default), checked on arrival, after
  the fresh reads (error status, preset set and within `max_extension` /
  `max_turn`) and right before the line leaves; one at a time; sent within
  3.5 s or refused; only in a session whose MAC is the device's and whose PIN
  was accepted (or not needed).
- **Stop**: the protocol has none; the current position is read and sent back
  as the target (`mount/preset/position`), only when plausible (within the
  travel, ±5 brought back to the bound; further: nothing written). Outside the
  lane and the option, before every request not written yet, holds the
  connection, waits 1 s at most for the request on the wire (a previous stop
  included; then cuts and reconnects), each read 1.5 s at most, a new
  connection and one more try when a read fails before the line, connects at
  once when needed, cancels the moves not written yet; presses before the line
  leaves join it. Checked 1.5 s later (answered or not) and sent again while
  the mount moves or cannot tell, 3 rounds at most, kept when a re-send fails,
  ended by a move written after it.
- **Connection**: kept open; read again every interval (60 s); after a failure
  30 s, 1, 2, 5 min and at least the interval; the last attempt kept in
  `/data`, so a restart (timer and Test button) waits for it too. A stop, its
  checks and the follow-up reads of a command may connect sooner. A first read
  that fails closes the connection.
- **PIN**: sent only when the mount asks for it, once per connection; refused
  (status not authenticated or a refusal code after it) -> final; two cuts in
  a row right after it -> held too (a stop still sends it, once per press).
  Kept in `/data` as an 8-bit mark only (no hash a brute force over 9999 PINs
  could invert), lifted by another PIN or the Test button (one try).

## Development

```bash
npm install
npm test                 # node --test (a fake MotionMount on 127.0.0.1)
npm run lint
npm run format:check
npm run cover            # regenerates cover.png (800×534)
```

## License

Apache-2.0 (see `LICENSE`). The protocol knowledge comes from
python-MotionMount (MIT, Vogel's Products): see `THIRD_PARTY_NOTICES.md`.
