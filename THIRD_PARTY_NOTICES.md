# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below. The ported parts were rewritten
in JavaScript; they are changed from the originals (another language, another
structure, only what this integration needs). None of the original code is
copied as is.

## pypx800 and pypx800v5

- Projects: [Aohzan/pypx800](https://github.com/Aohzan/pypx800) version 2.6.0
  ("Asynchronous Python client for the IPX800 v4 API") and
  [Aohzan/pypx800v5](https://github.com/Aohzan/pypx800v5) version 1.5.0
  (client of the IPX800 V5 API), by Matthieu (Aohzan), MIT licence; the
  libraries of the Home Assistant integrations
  [Aohzan/ipx800](https://github.com/Aohzan/ipx800) (3.17.0) and
  [Aohzan/ipx800v5](https://github.com/Aohzan/ipx800v5) (2.2.0), Apache-2.0,
  which were read for the meaning of the values (no code taken from them).
- What is ported (in `src/constants.js`, `src/ipx/model.js` and
  `src/ipx/client.js`): V4, the path `/api/xdevices.json`, the `key`
  parameter, `Get=all`, `SetR` / `ClearR`, `SetFPxx` and its codes, the keys
  `R<n>`, `D<n>`, `FP<e> Zone <z>` and their texts, `THL<n>-TEMP|HUM|LUM`, the
  `"status": "Success"` check; V5, the `ApiKey` parameter, `system/ipx` and
  `ebx/<type>` with `option=filter_id`, the IO and analog id fields of the
  IPX (`ioRelays_id`, `ioRelayState_id`, `ioDInput_id`) and of the X-8R,
  X-8D, X-24D, X-4FP and X-THL, `core/io` / `core/ana`, `PUT core/io/<id>`
  with `{ "on": ... }`, one mode IO per pilot-wire zone.
- Changes: rewritten in JavaScript for a Gladys external integration; one
  request at a time with priorities, bounded answers read as untrusted data,
  no retry loop on writes, the key never in an error nor a log.

### MIT licence of pypx800 and pypx800v5

```
MIT License

Copyright (c) 2020 Matthieu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-testkit (tests only)

`test/kit/` copies parts of the shared test kit of the same author
(Apache-2.0); it is not in the image.
