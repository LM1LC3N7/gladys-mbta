// -----------------------------------------------------------------------------
// The points of review r1: values that no longer apply, the device of a
// changed stop, the "departure approaching" trigger, and the guards that had
// no test (http pause, longer pause kept, alert ids pruned and capped,
// Retry-After of any length), the alerts read when the stop check fails, a
// Gladys that never answers, the times of the status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURES, PAUSE_MAX } from '../src/constants.js';
import { readRetryAfter } from '../src/mbta.js';
import { createMemoryStore } from '../src/store.js';
import {
  CAPTURED_AT,
  D,
  F,
  HOME,
  MINUTE,
  SECOND,
  alertEvents,
  alertResource,
  alertsDoc,
  createApi,
  createdDevices,
  defaultWorld,
  errorAnswer,
  json,
  prediction,
  predictionsDoc,
  published,
  setup,
  soonEvents,
  statusEn,
} from './helpers/setup.js';

const N = (key) => F(1, key);
const HOUR = 60 * MINUTE;

test('a following departure gone is replaced by its text, never left as a number', async () => {
  let list = [4, 9];
  const api = createApi((url) =>
    url.includes('/predictions')
      ? predictionsDoc(
          list.map((m, i) =>
            prediction(`p${i}`, { departure: CAPTURED_AT + m * MINUTE + 30 * SECOND }),
          ),
        )
      : defaultWorld(url),
  );
  const { begin, fake, wait } = await setup({ api });
  await begin();
  list = [2];
  await wait(MINUTE);
  list = [];
  await wait(MINUTE);
  const second = published(fake, N(FEATURES.SECOND));
  assert.equal(second.length, 3);
  assert.match(second[0], /in 9 min/);
  assert.equal(second[1], 'No following departure (read 02:04)');
  assert.equal(second[2], 'No following departure (read 02:05)');
  const next = published(fake, N(FEATURES.NEXT));
  assert.match(next[1], /in 1 min/);
  assert.equal(next[2], 'No predicted departure (read 02:05)');
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [2, 1, 0]);
  // Never a number on the departure features.
  for (const value of [...second, ...next]) assert.equal(typeof value, 'string');
});

test('the texts in French; leaving now', async () => {
  const api = createApi((url) =>
    url.includes('/predictions')
      ? predictionsDoc([prediction('a', { departure: CAPTURED_AT + 10 * SECOND })])
      : defaultWorld(url),
  );
  const config = { ...HOME, language: 'fr' };
  const { begin, fake } = await setup({ api, config });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.NEXT)), [
    'Red Line → Ashmont/Braintree part maintenant (02:03)',
  ]);
  assert.deepEqual(published(fake, N(FEATURES.SECOND)), ['Aucun départ suivant (lu à 02:03)']);
});

test('another stop in a slot is another device; the old one is named in the status', async () => {
  const devices = [...createdDevices(HOME), ...createdDevices({ watch1_stop: '1' })];
  const { begin, app, fake, wait } = await setup({ devices });
  await begin();
  assert.equal(fake.discoveredDevices[0].external_id, D(1));
  assert.match(statusEn(fake), /Not updated any more .*: MBTA stop 1\./);
  const before = published(fake, F(1, FEATURES.DEPARTURES, '1')).length;
  await app.start({ watch1_stop: '1' });
  await wait(20 * SECOND);
  assert.equal(fake.discoveredDevices[0].external_id, D(1, '1'));
  // The new stop publishes on its own device, never on the old stop's.
  assert.ok(published(fake, F(1, FEATURES.DEPARTURES, '1')).length > before);
  const old = published(fake, N(FEATURES.DEPARTURES)).length;
  await wait(2 * MINUTE);
  assert.equal(published(fake, N(FEATURES.DEPARTURES)).length, old);
  assert.match(statusEn(fake), /Not updated any more .*: MBTA stop place-pktrm\./);
});

test('departure approaching: a crossing between two reads, never a departure seen first close', async () => {
  let minutes = { a: 12, b: 3 };
  const api = createApi((url) =>
    url.includes('/predictions')
      ? predictionsDoc(
          Object.entries(minutes).map(([id, m]) =>
            prediction(id, { departure: CAPTURED_AT + m * MINUTE + 50 * SECOND }),
          ),
        )
      : defaultWorld(url),
  );
  const { begin, fake, wait } = await setup({ api });
  await begin();
  assert.equal(soonEvents(fake).length, 0, 'the first read only learns');
  // a: 12 -> 4 (crosses 10 and 5); b: 3 -> 2 (crosses 2); c: new at 2 min:
  // learnt, not announced.
  minutes = { a: 5, b: 3, c: 2 };
  await wait(MINUTE);
  const events = soonEvents(fake).map((e) => [e.data.route_id, e.data.threshold, e.data.minutes]);
  // In the order of the departures, the largest threshold first.
  assert.deepEqual(events, [
    ['Red', '2', 2],
    ['Red', '10', 4],
    ['Red', '5', 4],
  ]);
  assert.equal(soonEvents(fake)[0].data.device, D(1));
  await wait(MINUTE);
  // One minute later (same departure times): c (learnt at 2) gets to 1,
  // a gets to 3; in the order of the departures.
  assert.deepEqual(
    soonEvents(fake)
      .slice(3)
      .map((e) => [e.data.threshold, e.data.minutes]),
    [
      ['1', 1],
      ['3', 3],
    ],
  );
});

test('departure approaching: at most 10 events per read, the changed watch starts over', async () => {
  let at = 30;
  const api = createApi((url) =>
    url.includes('/predictions')
      ? predictionsDoc(
          Array.from({ length: 12 }, (_, i) =>
            prediction(`x${i}`, { departure: CAPTURED_AT + at * MINUTE + i * SECOND }),
          ),
        )
      : defaultWorld(url),
  );
  const { begin, app, fake, wait } = await setup({ api });
  await begin();
  at = 15;
  await wait(MINUTE);
  assert.equal(soonEvents(fake).length, 10);
  // Same stop, another direction: the memory of the watch is forgotten.
  await app.start({ ...HOME, watch1_direction: '0' });
  at = 8;
  await wait(20 * SECOND);
  assert.equal(soonEvents(fake).length, 10);
});

test('a 4xx of the departures pauses every read, doubled', async () => {
  const api = createApi((url, a) =>
    url.includes('/predictions') ? errorAnswer(a, 403) : defaultWorld(url),
  );
  const { begin, wait } = await setup({ api, config: { ...HOME, refresh_seconds: 30 } });
  await begin();
  for (let i = 0; i < 4; i += 1) await wait(MINUTE);
  // 403 at 3 s: paused 1 min (63 s), then 2 min (183 s), then 4 min.
  const at = api.calls
    .filter((c) => c.kind === 'predictions')
    .map((c) => Math.round(c.at / SECOND));
  assert.deepEqual(at, [3, 63, 183]);
});

test('a shorter pause never replaces a longer one', async () => {
  const { app } = await setup();
  app.load();
  app.startPause({ kind: 'rate', status: 429, retryAfter: 30 * MINUTE });
  app.startPause({ kind: 'server', status: 503 });
  assert.ok(app.pausedFor() > 29 * MINUTE);
  assert.ok(app.persisted.pause.until - CAPTURED_AT > 29 * MINUTE);
});

test('the alert ids seen: forgotten after 7 days, 500 at most', async () => {
  const day = 24 * HOUR;
  const seen = {};
  for (let i = 0; i < 600; i += 1) seen[`n${i}`] = CAPTURED_AT - i * SECOND;
  seen.old = CAPTURED_AT - 7 * day - HOUR;
  seen.recent = CAPTURED_AT - 6 * day;
  const store = createMemoryStore({ lastAttemptAt: CAPTURED_AT - HOUR });
  const { app, wait } = await setup({ store });
  app.load();
  app.persisted.watches[1] = {
    fingerprint: app.fingerprint({ slot: 1, stop: 'place-pktrm', routes: [], direction: null }),
    seen,
  };
  await app.start(HOME);
  await wait(20 * SECOND);
  const kept = app.persisted.watches[1].seen;
  assert.equal(Object.keys(kept).length, 500);
  assert.equal(kept.old, undefined);
  // The most recent are kept (here the 499 newest of the old ones are newer than 6 days).
  assert.ok('n0' in kept);
  assert.ok(!('n599' in kept));
  // With fewer ids, one of 6 days stays and one of 7 days and 1 hour goes.
  app.persisted.watches[1].seen = { old: seen.old, recent: seen.recent };
  await app.announceNew(
    { slot: 1, stop: 'place-pktrm', routes: [], direction: null },
    [],
    CAPTURED_AT,
    app.gen,
  );
  assert.deepEqual(Object.keys(app.persisted.watches[1].seen), ['recent']);
});

test('Retry-After of any length: bounded to 6 h', async () => {
  assert.equal(readRetryAfter('9999999', null), PAUSE_MAX);
  assert.equal(readRetryAfter('123456789012345678901234567890', null), PAUSE_MAX);
  assert.equal(readRetryAfter('21600', null), PAUSE_MAX);
  assert.equal(readRetryAfter('21599', null), PAUSE_MAX - 1000);
  const api = createApi((url, a) =>
    url.includes('/predictions')
      ? errorAnswer(a, 503, { 'retry-after': '99999999' })
      : defaultWorld(url),
  );
  const { begin, app } = await setup({ api });
  await begin();
  assert.ok(app.pausedFor() > PAUSE_MAX - MINUTE);
});

test('a failing stop check never holds the alerts; the alerts that are there are published', async () => {
  const api = createApi((url, a) => {
    if (url.includes('/stops')) return errorAnswer(a, 503);
    if (url.includes('/alerts')) return alertsDoc([alertResource(1)]);
    return defaultWorld(url);
  });
  const { begin, fake } = await setup({ api });
  await begin();
  assert.equal(api.count('alerts'), 1);
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), [1]);
  assert.match(statusEn(fake), /1 alert\(s\)/);
  assert.match(statusEn(fake), /Stop check: MBTA server error \(HTTP 503\)/);
  assert.doesNotMatch(statusEn(fake), /alerts: No departure/);
});

test('a Gladys that never answers a publication never holds the next round', async () => {
  const { app, gladys, api, wait } = await setup();
  gladys.publishStates = () => new Promise(() => {});
  app.start(HOME);
  for (let i = 0; i < 200; i += 1) await wait(SECOND);
  assert.ok(api.count('predictions') >= 3, `${api.count('predictions')} reads`);
  // Never two rounds at once.
  assert.ok(api.peak <= 1);
});

test('the read times of the status come from the MBTA server', async () => {
  const api = createApi((url, a) =>
    url.includes('/predictions')
      ? json(predictionsDoc([]), {
          date: a.clock.wall() + 3 * MINUTE,
          lastModified: a.clock.wall() + 3 * MINUTE - SECOND,
        })
      : defaultWorld(url),
  );
  const { begin, fake } = await setup({ api });
  await begin();
  assert.match(
    statusEn(fake),
    /no predicted departure, 0 departure\(s\) within 60 min, read Oct 30, 02:06 ET/,
  );
});

test('the version and the User-Agent follow the package.json next to the module', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mbta-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const source = await readFile(new URL('../src/constants.js', import.meta.url), 'utf8');
  await writeFile(join(dir, 'src', 'constants.js'), source);
  const copy = await import(new URL(`file://${join(dir, 'src', 'constants.js')}`).href);
  assert.equal(copy.VERSION, '9.8.7');
  assert.ok(copy.USER_AGENT.startsWith('gladys-mbta/9.8.7 ('));
});

test('alert events are still told apart from departure events', async () => {
  const { begin, fake } = await setup();
  await begin();
  assert.deepEqual(alertEvents(fake), []);
});
