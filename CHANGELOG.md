# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Relays read only by default now say so: while no relay is listed, the
  status counts the relays read only and points to Configuration → "Relays
  Gladys may drive" for those Gladys must drive (with the "turn everything
  off" caution); it names the listed relays whose device still waits for
  "Update" in Discover. The guide lists the relays to drive at setup, before
  creating the devices (they then come as switches), and keeps "Update" for
  relays listed later. Relays stay read only unless listed.

### Fixed

- V5: an X-8R whose id has more than 6 digits (the GCE tools show ids such
  as 4784128) can be listed in "Relays Gladys may drive".
- V5: an X-THL whose "measurement fault" IO (`ioFault`) is on publishes no
  measurement (Gladys keeps showing the last one), and the status names it.

## [0.1.1] - 2026-10-27

### Added

- First version: GCE IPX800 V4 and V5 through the local HTTP API (API key):
  relays (read only unless listed), digital inputs (X-8D, X-24D on the V5),
  pilot-wire zones of the X-4FP (Off and Frost protection sent first, Eco and
  Comfort behind an option, off by default), X-THL sensors; "Test the
  connection".

[Unreleased]: https://github.com/LM1LC3N7/gladys-ipx800/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-ipx800/releases/tag/v0.1.1
