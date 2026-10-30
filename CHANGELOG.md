# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Up to three IPX800 in one installation (a V5 and a V4, say): "IPX800 #2"
  and "IPX800 #3" in the configuration, each with its model, address, API
  key, relays Gladys may drive and V4 extensions; their devices have their
  own ids and names ("IPX800 n°2 · Relais 1 (R1)"), the status one part per
  IPX800 (one block, separated by " | "). The first one keeps the fields and
  the device ids of 0.1.2.
- "Attach the devices" (two clicks): after replacing an IPX800, its devices
  drive the new one.

### Fixed

- A device created for one IPX800 drove another one once the address, the
  port or the model of the configuration changed (the relays listed applied
  to the wrong box, and a "turn everything off" with them). The devices now
  belong to their IPX800 (a V5 by its MAC address, read at every read; a V4
  by its address): another IPX800 gets none of their commands, not even an
  Off, the Offs kept for the old one are dropped, none of its values is
  published onto them, and the status says what to do. The devices of 0.1.2
  are "to be confirmed" (0.1.2 kept only the last IPX800 it read): only Off
  and Frost protection go, to the address 0.1.2 read, until "Attach the
  devices" confirms the IPX800 read (nothing at all when they hold codes
  that model cannot have, or with another address typed). Devices whose
  IPX800 is not known (`/data` emptied, Gladys restored on another machine,
  `/data` unreadable or never written) get their Off and Frost protection at
  the address typed, nothing else until "Attach the devices". Two IPX800
  slots with the same address: the one whose devices' IPX800 was checked at
  that address keeps it, the other is not read and its status says which
  address to correct.
- A V4 chosen as "V5" (or the reverse) is recognized and said in the status
  and by "Test the connection", instead of "does not answer" or a refused
  key.
- The Discover list only holds what the IPX800 really read: it empties while
  the IPX800 does not answer, refuses the key, is another one or of another
  model, and with an empty address (a V4 no longer lists its configured
  targets before any read).
- A device deleted: the Discover list is published again at once (a relay
  removed from the list and recreated right away no longer gets back its
  switch).
- `/data` that does not answer (a frozen disk) no longer stops anything:
  every read and save of it is waited 1.5 s at most (then unreadable, or not
  written, and said in the status), one at a time; the reads, the status,
  "Test the connection" and the Offs go on.
- The Offs held in memory, and the V5 ids, survive a new session (a new API
  key saved) even when `/data` cannot keep them; an Off with no V5 id known
  yet waits for the first read (2.5 s at most) instead of being refused.
- Where only Off and Frost protection go (devices to confirm, IPX800 not
  known), an Off the IPX800 does not apply is sent again by the reads, as
  elsewhere.

## [0.1.2] - 2026-10-29

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-ipx800/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-ipx800/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-ipx800/releases/tag/v0.1.1
