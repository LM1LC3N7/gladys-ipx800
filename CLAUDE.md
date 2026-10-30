# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the GCE IPX800 V4 and V5: a
Node.js service (Node 22+, ESM, no build step) in its own sandboxed Docker
container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency, and to the IPX800 through its local HTTP API.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store .   # store admission checks
node scripts/cover.mjs cover.png          # the store cover (dev only)
```

## Architecture

```
index.js              SDK wiring only: handlers registered before connect()
src/handlers.js       the SDK handlers, shared with the tests
src/hub.js            IpxHub: up to 3 IpxApp (slots), one view of Gladys each
src/app.js            IpxApp: one IPX800: lifecycle, rounds, identity (owner),
                      guards, commands, status
src/ipx/http.js       one HTTP request: bounded, deadline, cut, settles once closed
src/ipx/client.js     the lane (one request at a time, priorities) and the API paths
src/ipx/model.js      what the answers mean (pure): targets, values, writes
src/devices.js        targets -> Gladys devices and states (pure)
src/publisher.js      states within the Gladys rate limit
src/store.js          /data: pace, pause, refused key tag, V5 ids, guards
src/config.js         DEFAULTS (mirror the manifest) + normalization, codes
src/constants.js      API, modes, keys, limits, timings
src/i18n.js           French and English texts
test/helpers/         fake IPX (V4 and V5) on the virtual clock and over real
                      HTTP (httpIpx.js), app setup
test/kit/             parts of the shared test kit (clocks, HTTP server)
```

Safety rules (see TODO.md "Decisions"): relays read only unless listed;
pilot wire Off and Frost protection (and switching a listed relay off) are
protective: never refused by an option, a pause, a queue or a read, they cut
the request in flight and are kept in /data and sent again; Eco and Comfort
behind `allow_heating_modes` (off); one request to the IPX at a time; the API
key (in the query string of every request) is never logged, nor put in an
error, a status or /data; success only after a read back.

## Rules

- **External ids are forever** (`ext:<selector>:<kind>:<code>`, the slot n >= 2
  as `ext:<selector>:ipx<n>:<kind>:<code>`), and so are the feature keys and
  the manifest keys (`<key>_<n>` for the slots).
- **A device never drives another IPX800**: the owner of each slot is in /data
  (V5: salted hash of the MAC of `system/info`; V4: controller key); any
  command, value, guard or Discover entry goes only when the IPX800 read is
  the owner (see "Identity" in src/app.js and TODO.md).
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  they agree.
- **Changelog** under `## [Unreleased]`.
- **Manifest texts** are `{ "en", "fr" }`; user-facing text is bilingual.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.1.
