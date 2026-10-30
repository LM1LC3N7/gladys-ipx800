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
- [x] **First real device** (2026-10-29): cce66 (forum), IPX800 V5, two
      relays and an X-4FP: reads work; the relays came read only (by design)
      without anything saying so. Next patch: status hints, guide steps,
      read-only feature name; V5 API checked against cce66's GCE tools (see
      "V5 API against cce66's tools").
- [x] **Second real device** (2026-10-29, forum t/11448 #4): cce66, V5
      relays work both ways (< 1 s). With the address and key of his V4 typed
      in the same configuration, the devices made for the V5 drove the V4's
      relays and Discover showed nothing new (reproduced: same ids, the V4
      targets merged into the V5's devices). Fixed in the next patch:
      identity of the IPX800 (owner), up to 3 IPX800, wrong model said,
      Discover only from what is read, `deviceDeleted` republishes.
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

## V5 API against cce66's tools (2026-10-29)

Source: https://github.com/cce66/Utilitaires_IPX800_X-Pool_Ecodevices_X-Display-V2_ScanDevice_Broker-Monitor_Modbus2Mqtt_Hub
(commit e76f2b3, MIT, written with Claude Code): `GCE_IPX800V5_Api-Deck v2.html`
and `GCE_IPX800V5_Widget-Studio_v1.html`. Used for API facts only, no code
copied (nothing to credit in `THIRD_PARTY_NOTICES.md`). Not a GCE reference
either: a tester built by a user, so what it shows is what his IPX answers,
not a specification.

- Confirmed: `GET|PUT /api/<path>?ApiKey=<key>` (key in the query string,
  `Content-Type: application/json` on a PUT, as here); `option=filter_id` is
  a real option of the API; `system/ipx` has `ioRelayState`, `ioRelays`,
  `ioDInput` (8 each); `ebx/x8r|x8d|x24d|x4fp|xthl` are lists of objects with
  `_id` and `name`; X-8D `ioInput` (8), X-24D `ioInput` (24), X-8R `ioOutput`
  (8); X-4FP `ioComfort`, `ioEco`, `ioAntiFreeze`, `ioStop`, `ioComfort_1`,
  `ioComfort_2` (4 each, plus `ioAll*`); X-THL `anaTemp`, `anaHum`, `anaLum`;
  `core/io` items `{ _id, name, virtual, on }`; `core/ana` items
  `{ _id, name, virtual, unit, nbdecimal, value }`. V4 (`GCE_IPX800V4_Api-Deck`):
  `SetFPxx` codes 0 Comfort, 1 Eco, 2 Frost protection, 3 Off, 4 Comfort -1,
  5 Comfort -2, as here.
- Fixed: the X-8R id typed in "Relays Gladys may drive" was limited to 6
  digits while the layout takes ids up to 1e9; the Widget Studio's example
  extension `_id` is 4784128 (0x490000, 7 digits): such an X-8R output was
  published but could never be listed. Now 10 digits, up to 1e9.
- Fixed: X-THL has an `ioFault` IO ("Mesure erreur", on = fault): a sensor in
  fault publishes nothing (its analogs may hold anything) and the status
  names it. Optional: an answer without `ioFault_id`, or the IO not in
  `core/io`, reads as before.
- Not shown, so still open (questions below): the field names with
  `option=filter_id` (`ioRelays_id`...: as pypx800v5 reads them; the tools
  show only the names without the option, where they hold the values);
  X-8R `ioOutputState` (the tools show only `ioOutput`); `PUT core/io/<id>`
  `{ "on": bool }` (the tools send `{ "toggle": true }`, or `PUT
ebx/<type>/<id>` with arrays of `"on"`/`"off"`/`"toggle"`); whether a
  `core/ana` `value` needs `nbdecimal` (21.5 or 215: a raw 215 °C is out of
  range here and not published, so the risk is no value, never a wrong one).
- Different paths in the tools, not used here: writes through
  `PUT ebx/x4fp/<id>` / `PUT system/ipx` with arrays (absolute writes on one
  IO are kept: fewer side effects on the other zones); the Widget Studio
  reads `GET ebx/<type>/<n>` with an index `n` that is not the `_id` (its own
  comment), the Api-Deck uses the `_id`: not used here (the lists are read
  whole).

## Questions for cce66 (his tests on V3, V4, V5, Eco-Devices, X-Pool)

Only the V4 and V5 are in this integration (V3, Eco-Devices, X-Pool: other
APIs, other modules, not planned here).

8. V4 (2026-10-30): which model was chosen when the V4's address was typed
   (the relays of the V4 were driven, so most likely "V4"); after the
   update, the status of each IPX800 in its own slot.
9. V5: the answer of `GET /api/system/info` (is the field `macAdress`?).

10. V5: the answer of `GET /api/system/ipx?option=filter_id&ApiKey=…` (ids
    only, no key): are the fields `ioRelays_id`, `ioRelayState_id`,
    `ioDInput_id`?
11. V5: the answer of `GET /api/ebx/x4fp?option=filter_id` and
    `GET /api/ebx/x8r?option=filter_id` (`ioOutputState_id` there?), and of
    `ebx/xthl` if he has one (`ioFault_id`?).
12. V5 X-4FP: in the Gladys status, does "Mode unreadable (several modes on)"
    ever show? Off then Frost protection from Gladys: does the IPX page show
    only the last mode on for that zone?
13. V5 relays: after listing R1, R2 and "Update" in Discovery, does switching
    from Gladys work both ways, and does a change from the IPX page show in
    Gladys within the interval?
14. V5 `core/ana`: is an X-THL temperature `21.5` or `215` (with
    `nbdecimal` 1)?
15. V4 (if he tests one): what a wrong API key answers (401, or 200 with
    `"status": "Error"`), and the texts of `FP<e> Zone <z>` in `Get=all`
    (`Arret` or `Arrêt`, `Hors Gel`...).
16. The status: did the new hints (relays read only, waiting for "Update")
    say enough, in his own words?

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
  invalid value; switching off a relay not listed. Since the identity of the
  IPX800 (2026-10-30, r4): another IPX800 proven at the address (see
  "Identity"), a slot whose address another slot keeps; never an owner that
  is only not known.
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

## Decisions after the first real test (2026-10-29)

- **Read only stays the default** (no relay becomes a switch without the
  list); the status says it while no relay is listed ("N relay(s) read
  only: list them in Configuration → Relays Gladys may drive"), counted on
  the relays read this round. One listed relay present on the IPX ends that
  hint; one listed but absent does not.
- **"Waiting for Update"** is known, not guessed: a listed relay whose device
  is in `gladys.devices` (created by the user) without the feature of its
  kind. Gladys adds a feature only on "Update" in Discovery (the core's
  `structure_changed` compares the feature external ids, categories, types,
  units, min, max, step: not the names). A listed relay not created yet is
  not named (it gets its switch at creation). The status is redone on
  device created / updated / deleted of a relay, never during a failure.
- **Feature name** of `readonly` stays "State (read only)" / "État (lecture
  seule)" (review r1 of 61bf7f2, I1): a relay listed after its creation
  keeps that feature for life next to its switch, under the name it was
  created with (Gladys never renames it, no "Update" for a name, and one
  feature cannot be deleted alone): any hint in the name ("see Relays…")
  would be wrong forever once the relay is driven. The hint lives in the
  status and the guide only.
- **Guide order**: the relays to drive are listed at step 2 (same page as
  the address and the key), X-8R outputs after "Test the connection" (their
  code is in the Discover names), before creating the devices: they come as
  switches, no "Update", no read-only feature twice. "Update" stays
  documented for a relay listed later.
- **Status hint** (r1 m1): "list in … those Gladys must drive (never a pump,
  a ventilation, a door strike…)", singular for one relay; English says
  "Discover" (the tab's name, r1 m2).
- Review r1 m4: tests for the bound 1e9 shared by the layout and the list
  (M6), a fault not read this round no longer shown (M12), no "Connected"
  from a device event before the first read (M24).
- The docs still say "never tested with a real device" (a test of the
  manifest requires it): cce66 only reported the relays read; to change
  once he confirms commands (ask Louis).

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

## Decisions after the review r4 of 7786d42 (2026-10-30)

Reuses the design of the sister modules (gladys-ipx800-v3 a0c3ded,
gladys-ecodevices-ed3 8b59dc6, gladys-ecodevices-rt2 7ba14dc).

- **B1, /data bounded**: every read and save of /data waited
  `TIMINGS.storeWait` (1.5 s) at most. A read that does not answer is
  unreadable (`storeUnreadable`: owner unknown); a save that does not end is
  a failure (`saveFailed`, `storeLost` for the probe of a start). One read
  and one save at a time, shared: a save asked while one runs waits for it
  (within its 1.5 s) then writes the state of now (tickets: a save covers
  the calls made before it started); a save or read that hangs is never
  stacked on (the next calls fail at once: each would hold one of the 4
  threads of libuv's pool, which the DNS lookups of a hostname share, and
  the Offs would then stop), and once it ends the state of now is written.
  `fileStore` itself never waits more than 1.5 s behind the save before (a
  temporary file of its own, an older write that ends later is dropped, not
  renamed over the newer). The status: "Connected" stays true while the
  right IPX800 is read (the values are fresh), with "cannot be written to
  /data" (heating modes and Attach refused); a /data that cannot be read
  gives the "owner not known" status (Offs only, not connected). When /data
  reads again, the owner, salt and guards of the file are taken and the
  verdict worked out again (the MAC of the last round judged under the
  file's salt).
- **I1**: in the states where only Offs go (`presumed` at the address 0.1.2
  read, `unbound`, `unverified` at the address last checked), the reads
  still check the guards and send them again (3 times at most, then "check
  on site"), without publishing any value; the status lists them. Not
  `pending`: a V5 whose MAC is to be read again (after a failed round) gets
  nothing from a read back before that check (the next round reads it).
- **I2**: `unbound` (no owner, devices there: /data emptied, deleted,
  restored on another machine by Gladys Plus, which does not back up /data;
  or unreadable, or never written): Off / Frost protection go to the address
  typed whatever /data can hold; switching on, heating modes and values wait
  for Attach. The 0.1.2 devices holding codes the model cannot have are a
  proof of another model: their own verdict `unfit` (nothing sent, Offs of
  /data dropped). Attach is done only once /data keeps it (save checked,
  reverted otherwise); it keeps the Offs that were already going to this
  IPX800.
- **I3**: at a new session of the same controller (a new API key), the Offs
  held in memory are carried (merged with /data's) and so are the V5 ids of
  the relays and zones; another controller key carries nothing. A V5 Off
  with no id known (fresh, lost or unreadable /data) waits for the first
  round of the session (2.5 s after the click at most), then leaves.
- **I4**: two slots with the same address: the one whose owner was verified
  at that address (`owner.at` = its key, not the 0.1.2 presumption) keeps
  it, otherwise the first one; the other gets `duplicate_of` (and
  `duplicate_verified`), is not read, refuses everything with "same address
  as IPX800 #x" and its status names the address to correct. The hub reads
  the owners (bounded) only when two slots share an address, and hands the
  configurations saved to the slots in order.
- m1: forum draft `_lots/hors-lot/ipx800-reply-2.md`, branch 2 corrected
  (V5 back on top after the update with the V4 on top: nothing is sent to
  the devices until Attach; one block with " | "; delete the devices
  created while the V4 was on top, before Attach).
- m2: tests for N5, N13, N14 (a belt: a failed round also marks the IPX800
  unread, which Attach refuses first; the test reaches the state through
  `recheck`), N16.
- Kept as accepted in r4: case A of 0.1.2 (devices of the V5, V4 typed, then
  the update) sends the Off to the V4, as 0.1.2 did, said in the status.
- Mutants of this fix (96: the 58 of r4, anchors moved, and 38 on the new
  code), each against the whole suite: all killed but five equivalents. H2
  (a slot seeing every device: `createdDevices` filters by slot again); R4
  (no fail-fast behind a save that hangs: `bounded` with 0 ms gives the same
  failure one timer later); R15b (`applyRead` checking the guards where no
  Off may go: none is held there, or `resendGuard` refuses it at entry and
  before the byte); R20b (Attach keeping the Offs where no Off went: none is
  held there but Offs carried from a session of the same address, which
  were going to it); R28 (no owner check after waiting for the first round:
  `protective` refuses with the same text before the first byte).

## Decisions after the review r3 of fa59ae3 (2026-10-30)

- **I1**: the owner taken from a 0.1.2 file is a presumption (`presumed`):
  0.1.2 kept the controller it read last, not the one the devices were made
  for (cce66's state: V5 devices, V4 typed, then the update). Until "Attach
  the devices": Off / Frost protection only, to the address 0.1.2 read; no
  value published, Discover empty, not connected; the status names the
  IPX800 read (model, MAC or address, device count) and asks to put their
  IPX800 back or to attach. Devices with codes the model cannot have:
  `unbound` (`unfit` since r4), nothing sent (an Off before the first read
  neither; the Offs kept by 0.1.2 dropped). Every 0.1.2 user confirms once
  (two clicks).
- **I2**: no file, devices there, and the first save of a start fails
  (`storeLost`): owner unknown, as /data unreadable (Offs to the address
  typed, the rest refused, Attach refused while /data cannot be written).
- m1: a slot whose host:port is an earlier slot's is not read
  (`duplicate_of` from `slotConfigs`). Not detected: one V5 typed by name in
  one slot and by IP in another (its MAC would tell; not done).
- m2: an id `ipx4:`..`ipx9:` gets a plain refusal.
- m3: Attach works on `unverified` (MAC unreadable for good): the owner is
  then the address, said in the confirmation.
- m4: docs (intro, "does not drive another one" with its two limits, 0.1.2,
  Attach), a status of a non connected `unverified` without "Connected",
  the slots' status joined with " | " (Gladys shows it as one block).
- m5: tests for I10, I15, I16, I24, I28, I31, I32.

## Decisions after cce66's V4 (2026-10-30)

- **Identity (owner)**: the ids hold no trace of the IPX800 (the first slot
  keeps those of 0.1.2, scenes and all), so each slot's /data keeps the
  owner of its devices: a V5 by `macId(salt, MAC)` (the MAC of
  `GET /api/system/info` `macAdress`, as pypx800v5 1.5.0 reads it; never the
  MAC itself), a V4 by its controller key (model, address, port: the V4 API
  gives no MAC; `Get=all` holds none). Verdicts: `same`; `pending` (V5 at
  start and after a failed round: MAC read before an Off, 1.5 s at most for
  a click, then to the address last checked); `unverified` (MAC unreadable:
  Off / Frost protection only, at the address last checked; never a
  downgrade to the address); `different` (no command at all, guards
  dropped, no value published, Discover empty, status); `unbound` (devices
  whose owner is unknown: /data lost, or 0.1.2 devices that cannot be the
  configured model's; Off allowed only while /data is unreadable). A slot
  without devices takes the IPX800 read. The MAC is read every V5 round
  (one more request); read backs within 20 s of a command do not re-read it
  (a box replaced within 20 s is not a case).
- **Migration from 0.1.2** (changed by r3 I1, above): a file without
  `format` makes its controller key the owner, marked `legacy`; a device
  code the model cannot have makes it `unbound` (V5 only:
  `x8r|x8d|x24d|x4fp|xthl<id>`; V4 only: `fp`, `thl`, `r9+`, `d9+`).
  otherwise `presumed` until "Attach the devices" (Offs only, to the address
  0.1.2 read).
- **Attach the devices**: an action with the slot as a select field, two
  clicks within a minute on the same IPX800 read; refused when nothing was
  read, at start before the MAC is read, or /data unreadable / not
  writable; a V5 whose MAC cannot be read is attached by its address.
- **Several IPX800**: one integration, up to 3 slots (as air-Q, Remootio):
  `version_n`, `host_n` (port in the address), `api_key_n`, `relays_n`,
  `v4_extensions_n`; poll interval, heating option and language shared.
  Separate integrations were not chosen: Gladys installs one per store
  entry, and two V5 would need the same image twice. `src/hub.js` runs one
  IpxApp per slot (own lane, /data file `/data/ipx800-state-<n>.json`,
  guards) behind a view of Gladys (ids `ipx<n>:`, its devices, status and
  Discover put together, one state publisher for the 300 states a minute).
  A slot is used when an address or key is typed, or when it has devices.
- **Wrong model**: a round failing with an answer (404, not JSON, 401,
  `not_success`, size) asks once the API of the other model (V4 `Get=R`,
  V5 `system/ipx?option=filter_id`) with the same key; an answer: status
  "This IPX800 is a V4, but Model says V5", pause as a failure, no key
  refused, Discover empty. Not switched by itself (the owner and the
  controller key depend on the model).
- **Discover**: only the targets read by a round of this session, no failure
  since, the owner read; else an empty list (published too, the old one
  would stay otherwise). The created devices no longer added as they are.
  `deviceDeleted` republishes (r2 m1).

## Next patch (review r5, 607fc67)

- m1: test the 2.5 s cap for the Off of a V5 with no ids yet (slow first read; reviewer's p16-slow-first-read.mjs, mutant P16).
- Docs: the "back at the top, nothing sent until Rattacher" refusal is listed under "it is proven that"; it is a rule, not a proof.
