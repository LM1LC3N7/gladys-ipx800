# gladys-ipx800

[Gladys Assistant](https://gladysassistant.com) integration for the **GCE
Electronics IPX800 V4 and V5**, through their local HTTP API and an API key:
relays (read only unless you list them), digital inputs, pilot-wire zones of
the X-4FP, X-THL sensors.

- Pilot wire: Off and Frost protection go first, without any option; Eco and Comfort are
  off by default.
- Relays: read only unless listed in "Relays Gladys may drive".
- The API key is never written in the logs nor in `/data`.

Never tested with a real device. Not affiliated with GCE Electronics.

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
```

See `CLAUDE.md` (architecture, rules) and `TODO.md` (status, decisions).
Licensed under the Apache License 2.0; ported logic credited in
`THIRD_PARTY_NOTICES.md`.
