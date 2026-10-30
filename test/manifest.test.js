// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  ACTIONS,
  ALERT_EFFECTS,
  DIRECTIONS,
  REFRESH_DEFAULT,
  REFRESH_MAX,
  REFRESH_MIN,
  SCENE_TRIGGER,
  SEVERITY_BANDS,
  SOON_THRESHOLDS,
  SOON_TRIGGER,
  WATCH_SLOTS,
} from '../src/constants.js';
import { LANGUAGES, normalizeConfig, watchKeys } from '../src/config.js';
import { buildDevices } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');
const SEMVER = /^\d+\.\d+\.\d+$/;

const FIVE = Object.fromEntries(WATCH_SLOTS.map((slot) => [`watch${slot}_stop`, `s${slot}`]));

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; one version in the four places, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, SEMVER);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-mbta:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(pkg.name, 'gladys-mbta');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(
    pkg.dependencies['@gladysassistant/integration-sdk'],
    /^\^\d+\.\d+\.\d+$/,
    'never pinned',
  );
  assert.deepEqual(manifest.categories, ['transport']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene_triggers need 5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.equal(manifest.location, undefined, 'the house location is never asked');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-mbta\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code; no key prefixed gladys_; no secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  const expected = ['intro', 'language', 'refresh_seconds'];
  for (const slot of WATCH_SLOTS) {
    const keys = watchKeys(slot);
    expected.push(`watch${slot}`, keys.name, keys.stop, keys.routes, keys.direction);
    assert.equal(fields[keys.stop].required, slot === 1);
    assert.deepEqual(
      fields[keys.direction].options.map((o) => o.value),
      DIRECTIONS,
    );
    assert.equal(fields[keys.direction].default, 'both');
    // The example name is not the key.
    assert.doesNotMatch(fields[keys.name].placeholder.en, /watch\d/);
  }
  assert.deepEqual(Object.keys(fields), expected);
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/i);
  assert.equal(fields.refresh_seconds.default, REFRESH_DEFAULT);
  assert.equal(fields.refresh_seconds.min, REFRESH_MIN);
  assert.equal(fields.refresh_seconds.max, REFRESH_MAX);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.ok(!manifest.config_schema.some((f) => ['secret', 'password'].includes(f.type)));
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  // The defaults of the manifest are those of the code.
  const defaults = normalizeConfig({ watch1_stop: 'place-pktrm' });
  assert.equal(defaults.refreshSeconds, fields.refresh_seconds.default);
  assert.equal(defaults.language, fields.language.default);
  assert.equal(defaults.watches[0].direction, null);
  // Every select default is one of its options; every option a valid config.
  for (const field of manifest.config_schema.filter((f) => f.type === 'select')) {
    assert.ok(
      field.options.some((o) => o.value === field.default),
      field.key,
    );
  }
  for (const value of DIRECTIONS) {
    assert.deepEqual(normalizeConfig({ watch1_stop: '1', watch1_direction: value }).errors, []);
  }
});

test('actions, scene trigger and handlers agree; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(index.includes('app.connected()'));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  assert.deepEqual(
    manifest.scene_triggers.map((s) => s.key),
    [SCENE_TRIGGER, SOON_TRIGGER],
  );
  // A scene without a stop would fire for every stop: the stop is required.
  for (const t of manifest.scene_triggers) {
    const device = t.fields.find((f) => f.key === 'device');
    assert.equal(device.required, true, t.key);
    assert.equal(device.source, 'devices');
  }
  const soon = manifest.scene_triggers[1];
  const threshold = soon.fields.find((f) => f.key === 'threshold');
  assert.equal(threshold.required, true);
  assert.deepEqual(
    threshold.options.map((o) => o.value),
    SOON_THRESHOLDS.map(String),
  );
  const trigger = manifest.scene_triggers[0];
  const options = (key) => trigger.fields.find((f) => f.key === key).options.map((o) => o.value);
  assert.deepEqual(options('effect'), [...ALERT_EFFECTS]);
  assert.deepEqual(options('severity_band'), [...SEVERITY_BANDS]);
  assert.equal(trigger.fields.find((f) => f.key === 'device').source, 'devices');
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const file of ['src/mbta.js', 'src/app.js']) {
    const code = read(file).replace(/\/\/.*$/gm, '');
    for (const word of ["'POST'", "'PUT'", "'DELETE'", 'Mozilla']) {
      assert.ok(!code.includes(word), `${file}: never ${word}`);
    }
  }
});

test('the data of the departure trigger is declared, flat, bounded', async () => {
  const soon = manifest.scene_triggers[1];
  const declared = new Set([...soon.fields, ...soon.variables].map((f) => f.key));
  const { MbtaApp } = await import('../src/app.js');
  const app = new MbtaApp({
    gladys: createFakeGladys({ selector: 'mbta' }),
    store: { load: () => ({ status: 'absent', data: {} }), save: async () => {} },
  });
  app.load();
  const watch = { slot: 1, stop: '1', routes: [], direction: null };
  const d = (minutes) => ({
    id: 'p1',
    minutes,
    at: Date.parse('2026-10-30T12:00:00Z'),
    route: '1',
    label: '1',
    headsign: 'Harvard',
  });
  app.departuresSoon(watch, [d(7)]);
  const [event] = app.departuresSoon(watch, [d(4)]);
  const data = { device: 'ext:mbta:watch:1-1', ...event };
  for (const key of Object.keys(data)) assert.ok(declared.has(key), key);
  assert.deepEqual(data, {
    device: 'ext:mbta:watch:1-1',
    threshold: '5',
    minutes: 4,
    route: '1',
    route_id: '1',
    headsign: 'Harvard',
    departure_time: '08:00',
  });
});

test('the scene data keys are declared (variables and fields), at most 30', async () => {
  const { sceneData } = await import('../src/app.js');
  const { readAlert } = await import('../src/mbta.js');
  const { alertResource } = await import('./helpers/setup.js');
  for (const over of [{}, { severity: null, url: 'https://www.mbta.com/x', description: 'd' }]) {
    const data = sceneData('ext:mbta:watch:1-place-pktrm', readAlert(alertResource('x', over)));
    const trigger = manifest.scene_triggers[0];
    const declared = new Set([...trigger.fields, ...trigger.variables].map((f) => f.key));
    for (const key of Object.keys(data)) assert.ok(declared.has(key), key);
    assert.ok(Object.keys(data).length <= 30);
    for (const value of Object.values(data)) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
      assert.notEqual(value, undefined);
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
      if (typeof value === 'string') assert.ok(value.length <= 1000);
    }
  }
});

test('the published devices follow the core rules (supported_options, units)', async () => {
  const gladys = createFakeGladys({ selector: 'mbta' });
  const devices = buildDevices(gladys, normalizeConfig(FIVE));
  assert.equal(devices.length, 5);
  // The rules of the core, from its clone when present (normalizeSupportedOptions).
  const core = new URL('../../../Gladys/server/utils/constants.js', import.meta.url);
  let unitsByCategory = null;
  if (existsSync(core)) {
    const require = createRequire(core);
    unitsByCategory = require(core.pathname).DEVICE_FEATURE_UNITS_BY_CATEGORY;
  }
  for (const device of devices) {
    const ids = new Set();
    for (const feature of device.features) {
      assert.ok(!ids.has(feature.external_id));
      ids.add(feature.external_id);
      const options = feature.supported_options ?? [];
      // Label a plain non-empty string without outer spaces, value integer or
      // string, unique, no other key: a single error rejects the Discovery.
      const values = new Set();
      for (const option of options) {
        assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0 && option.label === option.label.trim());
        assert.ok(Number.isInteger(option.value) || typeof option.value === 'string');
        assert.ok(!values.has(String(option.value)));
        values.add(String(option.value));
      }
      assert.equal(options.length, 0);
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.type, 'binary');
      if (feature.unit && unitsByCategory) {
        assert.ok(unitsByCategory[feature.category]?.includes(feature.unit), feature.external_id);
      }
    }
  }
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /MassDOT Developers License Agreement/);
  assert.match(notices, /MBTA/);
});

test('MassDOT is acknowledged as the provider (§4.1); the fixtures are not under Apache', () => {
  const intro = manifest.config_schema.find((f) => f.key === 'intro');
  assert.match(intro.description.en, /Data: MassDOT \/ MBTA/);
  assert.match(intro.description.fr, /Données : MassDOT \/ MBTA/);
  assert.ok(
    intro.links.some((l) => l.url.startsWith('https://cdn.mbta.com/') && l.url.endsWith('.pdf')),
  );
  for (const file of ['README.md', 'docs/en.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(read(file), /Data: MassDOT \/ MBTA/, file);
    assert.doesNotMatch(read(file), /mass\.gov/, file);
  }
  assert.match(read('docs/fr.md'), /Données : MassDOT \/ MBTA/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /not covered by the Apache License/);
});

test('the docs say what the data is not', () => {
  for (const file of ['docs/en.md', 'README.md']) {
    assert.match(read(file), /not an official source/i, file);
    assert.match(read(file), /MassDOT Developers License Agreement/, file);
  }
  assert.match(read('docs/fr.md'), /pas une source officielle/i);
});
