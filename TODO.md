# TODO - IPX800 v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1** (2026-10-27): IPX800 V4 (`/api/xdevices.json`) and V5
      (`/api/...`, ApiKey) through one lane of requests; relays (read only
      unless declared), digital inputs (V5: X-8D, X-24D too), X-4FP pilot wire
      (Off / Frost protection protective, Eco / Comfort behind
      `allow_heating_modes`), X-THL; guards of the protective commands in
      `/data`; "Test the connection"; fr/en docs. Tested against an
      in-memory IPX (V4 and V5) on a virtual clock, and a real local HTTP
      server on a real clock (x20).
- [x] **Review r4** (2026-10-27): APPROUVÉ, no blocker (4th round, rule of 5).
- [ ] **Next patch — review r4 leftovers**: at 900 ms per request, 5 zones
      clicked at once are all Off at 4.56 s but the last acks come back
      without confirmation (one request at a time); say in the docs that a
      local change to the value of our own unanswered command is first taken
      for it, and the Off is sent once more (s18b).
- [ ] **Milestone 2**: counters (lifetime counters: never 0 nor a drop
      published, an exit and a status signal on a reset), X-4VR shutters,
      X-Dimmer, X-PWM, virtual inputs / outputs; a real IPX800 V4 and V5.
- [ ] **Release**: review, `gi ci`, Release workflow, topic.

## To check on a real IPX800

- V4: what a wrong key answers (401, or a 200 with `"status": "Error"`, or a
  page): only 401 / 403 stop the reads here; an answer without
  `"status": "Success"` is a failed read (pause).
- V4: that `Get=all` holds the `FP<e> Zone <z>` texts and the
  `THL<n>-TEMP|HUM|LUM` values (as the Home Assistant integration reads them
  from it) and the exact texts (`Arret` or `Arrêt`: both taken).
- V5: there is no public reference of the API: the paths and fields come from
  pypx800v5 1.5.0. To check: `system/ipx?option=filter_id`, the `ebx/<type>`
  fields, that `PUT core/io/<stop id>` `{ "on": true }` switches the zone and
  turns the other modes off, the size of `core/io` on a full IPX.
- V5: the ids of the extensions (`_id`) as stable as the codes need them
  (they change only when an extension is removed and added again).
- How the IPX800 V4 copes with requests one after the other at 10 s (the
  default interval) and with a request cut (connection reset).
- V5 X-4FP: that a mode IO switched on turns the other modes of the zone off
  (pypx800v5 and Home Assistant only write the IO of the mode too). If not,
  the zone reads "several modes on" (shown in the status, the Off sent
  again): then write the other IOs off.
- V5: the ids kept in /data are used before the first read after a restart;
  an extension removed and added again may give its ids to other IOs.
- V4: the number of X-THL (14 taken here, from the numbering of their
  measurements up to 42 in the GCE wiki).

## Decisions

- **Version 0.1.0, set by hand once** in `package.json`, `package-lock.json`,
  the manifest `version` and the `docker_image` tag; every later version
  comes from Actions > Release.
- **SDK 0.16.0** (the latest on npm on 2026-10-27, `^0.16.0`).
- **Own client, no dependency**: no maintained IPX800 client on npm; the API
  details are ported from pypx800 2.6.0 and pypx800v5 1.5.0 (MIT), credited in
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`). The V4
  commands and their codes are also checked against the GCE wiki (API V4);
  the V5 has no public reference (see above).
- **Scope of milestone 1**: relays, digital inputs, X-4FP, X-THL. Counters
  are left for milestone 2 on purpose (lifetime counters need the guard of
  the energy modules); shutters, dimmers and PWM too (more commands to make
  safe).
- **Relays read only by default** (lesson of Velbus / Qbus): a relay becomes
  a switch or a light only when the user lists it in `relays`; the feature
  key is its kind (`readonly`, `switch`, `light`), a new kind adds a feature
  and keeps the old one. Commands are checked against the list of now,
  whatever feature they come from.
- **Protective commands**: pilot wire Off (0) and Frost protection (1), and
  switching off a listed relay. Never refused by the option, a pause, a
  refused key, the queue, a read or a command in progress; they cut the
  request in flight (a read cut is no failure), cancel the commands of the
  same target still waiting (and a command already taken from the queue is
  stopped right before its first byte), are tried again for 250 ms, then
  kept as a guard in `/data` and sent again by the reads that contradict
  them (3 times at most, counted when sent; the read back of the command
  itself never triggers one). A guard is lifted by a later command on the
  target that left (not by a 4xx / 429 answer), by another protective
  command, or, once confirmed, by another value read twice in a row (changed
  on the IPX itself); never by the time. At start, the guards not yet seen
  applied are sent before the first read.
- **Refusals of a protective command**: configuration not read from Gladys
  (the API key lives there only), address or key missing, target unknown
  (V4: not listed; V5: never read, the ids kept in `/data` otherwise),
  invalid value; switching off a relay not listed.
- **Heating modes** (Eco, Comfort, Comfort -1, Comfort -2): behind
  `allow_heating_modes` (off), checked on arrival and right before the
  request leaves; refused during a protective command on the same zone;
  `/data` must be written before the first byte (the lift of the guard).
- **One request at a time** (the V4 is a small embedded server): priorities
  protective > commands > read backs > polling; a protective command cuts
  any other request, a command cuts a polling read. The next connection
  opens only once the previous one is closed.
- **Commands**: written within 3.5 s or refused "nothing was sent"; the queue
  turn ends at the write; a read back that leaves after the write (shared by
  the commands of a scene, after all the writes waiting) confirms within
  4.3 s; a different value is "not applied yet"; no answer is "sent, without
  confirmation"; reads 5 s and 20 s later. No fresh read before writing: the
  commands are absolute (`SetR`, `ClearR`, `SetFPxx`, a mode IO on), the
  decision needs no state; the V5 ids are those of the last round.
- **Reads**: V4 `Get=all`; V5 `system/ipx`, `ebx/x8r|x8d|x24d|x4fp|xthl`,
  `core/io`, `core/ana`. A V5 extension list or `core/ana` failing (even 401) leaves those targets known, without value; `system/ipx` or `core/io`
  failing fails the round. A value that is no number / boolean / known text
  is unknown, never 0. V5 zone: exactly one mode IO on, else unknown.
- **Pace**: one round per interval (10 s, 5 to 300), the time of the
  attempt in `/data` before the read; failures 10 s, 30 s, 1, 2, 5 min, at
  least a minute on 429 / 503, the pause in `/data`; a 401 / 403 on the
  round is a refused key: a salted 8-bit tag in `/data`, no read until the
  key changes or the test button succeeds.
- **`/data`**: the controller key (hash of version, address, port), the
  pause, the refused tag, the V5 ids of the relays and zones, the guards;
  never the API key nor the address. Unreadable is not empty: nothing is
  written over it until it reads again (heating modes refused meanwhile).
- **Ids**: `ext:<selector>:<kind>:<code>` with the codes of `src/config.js`
  (V5 extensions by their IPX id). Frozen.
- **Units**: °C, %, lux only (core list).
- **Not in the manifest**: `keywords` and `countries` (need Gladys 5.3.0).

## Decisions after the review r1 (2026-10-27)

- **B1**: a protective command clicked cuts any request in flight but
  another clicked one: the lane has 5 priorities (clicked protective,
  guards and protective read backs, commands, read backs, polling). An Off
  not sent within 3.5 s is sent again as soon as the lane is free (and by the
  contradicting reads). The lane starts the next job a turn after one ends,
  so the read back of a protective command goes before the commands
  waiting. A request not started by its deadline leaves the queue.
- **B2**: a command puts the guard of its target back only where no newer
  one took its place (both branches).
- **B3**: the guards of a relay not listed are dropped (memory and /data) at
  start, at a new configuration, at a read and before a resend; a resend
  checks the list again right before its first byte.
- **I1**: a command before the configuration is read asks for it at once
  (2 s after the last read at most) and waits 3 s; a protective one is then
  kept in memory (never /data) and sent by the start that reads it; reads of
  the configuration again after 5 s, 15 s, then every minute (5 s while one
  is kept).
- **I2**: `connected` and `configUpdated` go through one chain, one at a
  time; a configuration superseded by a newer one waiting is skipped (a
  reconnection still resends the status and the Discovery list); the start
  checks its generation after each wait; commands wait (3 s at most) for the
  start in progress.
- **I3**: the read back of a command waits for the writes queued after it
  until 3.5 s after its click at most; the read back shared only when it left
  after the command's write left.
- Minors: a V5 zone with several modes on is `MULTI` (never published,
  status, Off sent again); a V4 answer `"status": "Error"` keeps the guard;
  /data guards only 0 for a relay, 0 or 1 for a zone; the retries of a
  clicked protective command stop when a newer command took its target;
  manifest texts without "always"; X-THL up to 14 on the V4.
- Known limit (one request at a time): a scene of 5 Off on an IPX taking
  900 ms a request writes 4 within the 3.5 s; the 5th is kept and leaves as
  soon as the lane is free (about 1 s later); their read backs come after
  the ack ("sent, without confirmation"). At 500-700 ms a request, all 5 are
  confirmed within the ack.
- s10 of the review: the lane waits 10 ms after a socket closed before the
  next connection (the HTTP request settles on the close of its socket, not
  of the request).

## Decisions after the review r2 (2026-10-27)

- **B1**: in a start, the protective commands leave right after the client
  is made, before any call to Gladys (status, Discovery): those clicked
  before the configuration was read, then the guards of /data; commands are
  let through in the same turn as that adoption, so no click can fall between
  the two (a click still waiting sends its own command; one that gave up is
  adopted by that start). A protective command kept for the configuration whose
  output is unknown or not listed is logged and shown in the status. The
  status of a failed configuration read is not awaited.
- **I1**: a request of a round that never left (out of the queue at its
  deadline) is no failure of the IPX: the round is rescheduled, like a cut.
- Minors: an Off not sent in time is sent again at the priority of a click
  (before the read backs); a clicked Off without answer for 1 s is cut when
  another one waits; /data is never written between the reset of a start
  and its read of /data; tests for the retries of a clicked Off, for
  "several modes on" against a confirmed guard, and for the connection
  closed before the next one opens (10 ms between two requests; Node closes
  the socket after a "Connection: close" exchange, no extra `end()`).

## Decisions after the review r3 (2026-10-27)

- **B1**: a clicked protective command checks that its guard is still its
  own right before each first byte (`beforeSend`, every try), and does not
  try again at all when a newer click took its target during the 50 ms wait
  (so it cuts nothing, the read back of that click included): an older Frost
  protection never leaves after a newer Off.
- **Own late writes**: every write that left is kept per target (memory
  only) until answered. A new guard notes the last write of ours on its
  target of another value, left less than 5 s before and not answered (in
  flight, cut, timed out): a read showing that value is our own command
  handled late, never "changed on the IPX": the guard is unconfirmed and
  sent again (3 times at most). The note ends with an answer, its first use,
  or a read showing the guard's value that left more than 5 s after that
  write.
- A guard resend cut by a click before its first byte goes again right
  behind that click (within its 5 s), not at the next read; at start, the
  Offs clicked before the configuration leave first, then the guards of
  /data (none started only to be cut). Test for R5 (adopted clicks at click
  priority: never cut by a later click).
- `npm test` runs with `--test-timeout=60000` (a stuck test never holds a
  runner).
