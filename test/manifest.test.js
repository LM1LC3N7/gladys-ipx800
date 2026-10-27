// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, POLL_INTERVAL, VERSIONS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, the same version everywhere (semver, never pinned), no keywords nor countries yet', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-ipx800:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.match(
    pkg.dependencies['@gladysassistant/integration-sdk'],
    /^\^/,
    'the SDK is never pinned',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['lighting', 'climate']);
  assert.equal(manifest.keywords, undefined, 'keywords need gladys_version >= 5.3.0');
  assert.equal(manifest.countries, undefined, 'countries need gladys_version >= 5.3.0');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    const flat = docs.replace(/\n>?\s*/g, ' ');
    assert.match(flat, /not affiliated with GCE|sans lien avec GCE/i);
    assert.match(
      flat,
      lang === 'en' ? /never tested with a real device/i : /jamais testé avec un vrai appareil/i,
    );
    assert.match(flat, /off by default|désactivés par défaut/i);
  }
  for (const file of [
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'docs/en.md',
    'docs/fr.md',
  ]) {
    assert.doesNotMatch(read(file), /encrypt|chiffr|hach/i, `${file}: nothing is encrypted`);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /encrypt|chiffr|hach/i);
  assert.match(read('TODO.md'), /## Decisions/);
  assert.match(read('TODO.md'), /0\.1\.0/);
  assert.match(read('CHANGELOG.md'), /## \[Unreleased\]/);
});

test('the licenses ship with the image; LICENSE is the standard text, without a name', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.doesNotMatch(license, /Louis|lmilcent|LM1LC3N7|Milcent/i);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Aohzan\/pypx800v5/);
  assert.match(notices, /Aohzan\/pypx800\b/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.ok(existsSync(new URL('../cover.png', import.meta.url)));
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code; heating modes off; the key a secret without default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const key of Object.keys(fields)) {
    assert.doesNotMatch(key, /^gladys_/i, 'a gladys_ key is never received');
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(
    fields.version.options.map((o) => o.value),
    VERSIONS,
  );
  assert.equal(fields.allow_heating_modes.default, false);
  assert.equal(fields.api_key.type, 'secret');
  assert.equal(fields.api_key.default, undefined, 'no default for a secret');
  assert.equal(fields.host.required, true);
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL_INTERVAL.min, POLL_INTERVAL.max, POLL_INTERVAL.default],
  );
  for (const field of manifest.config_schema) {
    if (field.placeholder !== undefined)
      assert.equal(typeof field.placeholder, 'object', field.key);
    for (const option of field.options ?? []) {
      assert.equal(typeof option.value, 'string');
      for (const lang of ['en', 'fr']) assert.equal(typeof option.label[lang], 'string');
    }
  }
  const intro = fields.intro;
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
    assert.match(
      intro.description[lang],
      /Never tested with a real device|Jamais testé avec un vrai appareil/,
    );
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the published features: supported options (none here) and units from the core list only', async () => {
  const { buildDevice } = await import('../src/devices.js');
  const { createFakeGladys } = await import('@gladysassistant/integration-sdk/testing');
  const gladys = createFakeGladys({ selector: 'ipx' });
  const units = {
    'temperature-sensor': ['celsius'],
    'humidity-sensor': ['percent'],
    'light-sensor': ['lux'],
  };
  for (const target of [
    { code: 'r1', kind: 'relay', n: 1 },
    { code: 'd1', kind: 'input', n: 1 },
    { code: 'fp1', kind: 'pilot-wire', n: 1 },
    { code: 'thl1', kind: 'thl', n: 1 },
  ]) {
    for (const relayKind of [undefined, 'switch', 'light']) {
      const device = buildDevice(gladys, target, { language: 'fr', relayKind });
      for (const f of device.features) {
        if (f.unit !== undefined)
          assert.ok(units[f.category]?.includes(f.unit), `${f.category} ${f.unit}`);
        for (const o of f.supported_options ?? []) assert.equal(typeof o.label, 'string');
        if (f.category === 'switch' || f.category === 'light') {
          assert.equal(
            f.read_only,
            relayKind === undefined,
            `a ${f.category} is commandable only when declared`,
          );
        }
      }
    }
  }
});
