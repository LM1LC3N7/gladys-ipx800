# IPX800 for Gladys

Brings a **GCE Electronics IPX800 V4 or V5** into Gladys through its local HTTP
API: its relays, its digital inputs, the pilot-wire zones of its X-4FP
extensions and its X-THL sensors (temperature, humidity, luminosity).

> Never tested with a real device: written from the GCE documentation of the
> V4 API and from the open-source libraries of the Home Assistant
> integrations (pypx800, pypx800v5). Please report what you see on yours.
> Not affiliated with GCE Electronics.

## Setup

1. In the IPX800, create an **API key**: V5 under System > API, V4 under
   Network > API (tick the API access).
2. In Gladys, Integrations > IPX800: choose the model (V5 or V4), type the
   address of the IPX800 (e.g. `192.168.1.50`, give it a fixed address in
   your router) and the API key, then save.
3. "Test the connection" reads the IPX800 now (once an interval has passed
   since the last read) and shows what it found.
4. In Discover, create the devices you want.

The IPX800 wants the API key in the address of every request, over plain
http: anyone who can watch your local network can read it, as with the
IPX800's own apps. The key is kept by Gladys in its database, never shown
again, sent only to the IPX800, and never written in the logs nor in the
files of the integration.

## What you get

| On the IPX800                   | In Gladys                                                                | Code (in the name)         |
| ------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| Relay (V4 1-56, V5 1-8)         | read only, or a switch / light if you list it                            | `R3`                       |
| X-8R output (V5)                | the same                                                                 | `X8R12-3` (12: its id)     |
| Digital input (V4 1-56, V5 1-8) | a binary input (read only)                                               | `D3`                       |
| X-8D / X-24D input (V5)         | the same                                                                 | `X8D5-2`, `X24D6-10`       |
| X-4FP zone                      | pilot wire (Off, Frost protection, Eco, Comfort, Comfort -1, Comfort -2) | `FP5` (V4), `X4FP7-2` (V5) |
| X-THL                           | temperature (°C), humidity (%), luminosity (lux)                         | `THL1` (V4), `XTHL9` (V5)  |

**V5**: the integration lists the extensions itself. **V4**: the API answers
56 relays and 56 inputs whether they are wired or not; the integration shows
the 8 relays and 8 inputs of the IPX, and what you list in "Extensions of an
IPX800 V4", e.g. `R9-R16, D9-D16, FP1-FP4, THL1` (pilot-wire zone n of the
V4 is zone z of X-4FP e: n = 4 × (e − 1) + z).

The IPX800 is read every 10 seconds by default (5 s at least). A value the
IPX800 does not give (absent, a text, out of range) is not published: never
as 0.

## Relays: read only unless you list them

Every relay is **read only** by default. To drive one from Gladys, list it in
"Relays Gladys may drive", e.g. `R1, R3:light, X8R12-2` (`:light` makes it a
light, otherwise a switch). A switch or a light obeys every "turn everything
off" of Google, Alexa, the MCP and the scenes: never list a pump, a freezer,
a ventilation, a heating, a door strike nor a valve. A relay you remove from
the list is read only again at once (its old feature in Gladys stays, but
its commands are refused: delete it if you want).

## Pilot wire

- **Off** and **Frost protection** are sent at once, without the option,
  even during a pause after failed reads, with the queue of commands full,
  while a read is in progress (it is interrupted), and before the first read
  after a restart (the V5 ids are kept in `/data`). The same goes for
  switching off a relay you listed.
- **Eco, Comfort, Comfort -1, Comfort -2** drive the heating: they are off by
  default. Tick "Allow Eco and Comfort from Gladys" to allow them; every
  Gladys user, every scene and the Gladys app can then choose them. They are
  refused while the state cannot be written to `/data`.

An Off or Frost protection is refused only when: the configuration is not
read from Gladys yet; the address or the API key is missing; the zone is not
known (V4: not listed in the extensions; V5: never read, even before a
restart); the value is not one of the six modes. Off for a relay is refused
when the relay is not listed. When the IPX800 does not take it within
250 ms, it is kept and sent again by the next reads that show another mode,
and after a restart.

An Off or Frost protection that the reads do not show is sent again, 3 times
at most; then the status says so (check on site). It stays held until a
later command on that zone leaves (your click), another Off / Frost
protection, or, once applied, another mode read twice in a row (changed on
the IPX800 itself, by its scenarios or its page): never by the time.
Anything asked before an Off on the same zone and still waiting is
cancelled: it never leaves after it.

## Commands

A command is written within 3.5 s of the click or refused with "nothing was
sent". It is then read back from the IPX800: the value asked is a success;
another value is "not applied yet"; no answer in time is "sent, without
confirmation". Two more reads follow after 5 s and 20 s. The commands of a
scene are written one after the other, then read back once.

## Pauses and refusals

A failed read pauses 10 s, 30 s, 1 min, 2 min then 5 min (one minute at
least when the IPX800 answers 429 or 503), kept across restarts; Eco,
Comfort and switching a relay on are refused until the pause ends. An API key
refused by the IPX800 (401, 403) stops the reads until you change the key or
"Test the connection" succeeds.

## Limits

- X-8R, X-8D, X-24D, X-4FP and X-THL only; counters, X-4VR shutters,
  dimmers, X-PWM, virtual inputs and outputs are not in this version.
- One IPX800 per integration.
- http only (the IPX800 answers http on the local network).
