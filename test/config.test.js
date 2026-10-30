import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, readId, readNumber, readRoutes } from '../src/config.js';

test('the first stop is required; the empty slots are off', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config.watches, []);
  assert.deepEqual(config.errors, [{ slot: 1, field: 'watch1_stop', code: 'required' }]);
  const two = normalizeConfig({ watch1_stop: 'place-pktrm', watch3_stop: ' 1 ' });
  assert.deepEqual(
    two.watches.map((w) => [w.slot, w.stop, w.direction, w.routes, w.name]),
    [
      [1, 'place-pktrm', null, [], null],
      [3, '1', null, [], null],
    ],
  );
  assert.deepEqual(two.errors, []);
  for (const raw of [null, [], 'x', 5]) assert.deepEqual(normalizeConfig(raw).watches, []);
});

test('stop ids: the characters of the MBTA ids only, never echoed', () => {
  for (const id of ['place-pktrm', '1', 'NEC-2287', 'door_x', 'Boat-Long'])
    assert.equal(readId(id), id);
  for (const id of ['a,b', 'a.b', 'a:b', '../x', 'a b', '-x', 'é', 'x'.repeat(65), 5, {}]) {
    assert.equal(readId(id), undefined, String(id));
  }
  assert.equal(readId('  '), null);
  const config = normalizeConfig({ watch1_stop: 'a,b' });
  assert.deepEqual(config.errors, [{ slot: 1, field: 'watch1_stop', code: 'id_invalid' }]);
  assert.deepEqual(config.watches, []);
  assert.equal(readId('x'.repeat(64)), 'x'.repeat(64));
});

test('routes: comma or semicolon separated, unique (case ignored), at most 10', () => {
  assert.deepEqual(readRoutes(' Red, 1 ;47,red,, '), { routes: ['Red', '1', '47'] });
  assert.deepEqual(readRoutes(''), { routes: [] });
  assert.deepEqual(readRoutes('Red Line'), { error: 'routes_invalid' });
  assert.deepEqual(readRoutes('a\u0007b'), { error: 'routes_invalid' });
  assert.deepEqual(readRoutes(7), { error: 'routes_invalid' });
  const ten = Array.from({ length: 10 }, (_, i) => `r${i}`).join(',');
  assert.equal(readRoutes(ten).routes.length, 10);
  assert.deepEqual(readRoutes(`${ten},r10`), { error: 'routes_too_many' });
});

test('direction: both (default), 0 or 1', () => {
  const read = (direction) => normalizeConfig({ watch1_stop: '1', watch1_direction: direction });
  assert.equal(read(undefined).watches[0].direction, null);
  assert.equal(read('').watches[0].direction, null);
  assert.equal(read('both').watches[0].direction, null);
  assert.equal(read('0').watches[0].direction, 0);
  assert.equal(read('1').watches[0].direction, 1);
  assert.equal(read(1).watches[0].direction, 1);
  assert.deepEqual(read('2').errors, [{ slot: 1, field: 'watch1_direction', code: 'direction' }]);
});

test('name: 60 characters at most, no control character', () => {
  const read = (name) => normalizeConfig({ watch1_stop: '1', watch1_name: name });
  assert.equal(read('  Bus   home ').watches[0].name, 'Bus home');
  assert.equal(read('é'.repeat(60)).watches[0].name, 'é'.repeat(60));
  assert.equal(read('é'.repeat(61)).errors[0].code, 'name_invalid');
  assert.equal(read('a\nb').errors[0].code, 'name_invalid');
  assert.equal(read('a\u009bb').errors[0].code, 'name_invalid');
});

test('refresh: whole seconds from 30 to 600, 60 by default; blank is the default, never 0', () => {
  const read = (value) => normalizeConfig({ watch1_stop: '1', refresh_seconds: value });
  assert.equal(read(undefined).refreshSeconds, 60);
  assert.equal(read('').refreshSeconds, 60);
  assert.deepEqual(read('').errors, []);
  assert.equal(read(30).refreshSeconds, 30);
  assert.equal(read('600').refreshSeconds, 600);
  for (const bad of [29, 601, 45.5, '1e2', 'abc', NaN, 0]) {
    const config = read(bad);
    assert.equal(config.refreshSeconds, 60, String(bad));
    assert.deepEqual(config.errors, [{ slot: null, field: 'refresh_seconds', code: 'refresh' }]);
  }
});

test('numbers: blank is absent, never 0', () => {
  assert.equal(readNumber(''), null);
  assert.equal(readNumber('  '), null);
  assert.equal(readNumber(null), null);
  assert.ok(Number.isNaN(readNumber('1e3')));
  assert.ok(Number.isNaN(readNumber(Infinity)));
  assert.ok(Number.isNaN(readNumber({})));
  assert.equal(readNumber(' 42 '), 42);
});

test('language: en by default, fr when chosen', () => {
  assert.equal(normalizeConfig({ watch1_stop: '1' }).language, 'en');
  assert.equal(normalizeConfig({ watch1_stop: '1', language: 'fr' }).language, 'fr');
  assert.equal(normalizeConfig({ watch1_stop: '1', language: 'de' }).language, 'en');
});
