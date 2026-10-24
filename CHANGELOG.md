# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-24

### Fixed

- A periodic read is no longer put off by 1 s when its timer fires a hair
  before its due time.

### Added

- Vogel's MotionMount motorized TV mounts (Signature, TVM 7675 Pro) over their
  local TCP protocol: extension, turn, motion and error status of the mount,
  "Go to a preset" (the wall or a preset set on the mount) and a Stop button.
- Moves are off by default ("Allow moves"), bounded by a maximum extension and
  turn, and refused while the mount reports an obstruction or an error.
- Stop is not behind the option, goes before every other request, connects at
  once when needed (and again, once, when the connection is stale), cancels
  the moves not sent yet, writes only a plausible position, and is checked and
  sent again while the mount still moves.
- Optional PIN of the User level, sent only when the mount asks for it; a
  refused PIN is never tried again by itself.

[Unreleased]: https://github.com/LM1LC3N7/gladys-motionmount/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-motionmount/releases/tag/v0.1.1
