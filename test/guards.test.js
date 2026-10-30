// -----------------------------------------------------------------------------
// The boundaries of each guard, one test per side: a guard loosened or
// tightened by one step fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import {
  CAPTURED_AT,
  F,
  HOME,
  HOUR,
  MINUTE,
  PREDICTIONS,
  SECOND,
  alertResource,
  alertsDoc,
  predictionsDoc,
  createApi,
  defaultWorld,
  errorAnswer,
  json,
  published,
  setup,
  statusEn,
  alertEvents,
} from './helpers/setup.js';

const N = (key) => F(1, key);
const predictionsBody = () => structuredClone(PREDICTIONS.body);
const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');

test('a round is never run before it is due (a timer firing early is armed again)', async () => {
  const { begin, app, api, wait } = await setup();
  await begin();
  // Run the round by hand 10 s before it is due: nothing is read.
  app.nextDueMono = app.monotonic() + 10 * SECOND;
  await app.runCycle(app.gen);
  await wait(0);
  assert.equal(api.count('predictions'), 1);
  await wait(10 * SECOND + 10);
  assert.equal(api.count('predictions'), 2);
});

test('a round is never run during a pause', async () => {
  const { begin, app, api, wait } = await setup();
  await begin();
  app.nextDueMono = app.monotonic();
  app.pauseUntilMono = app.monotonic() + 30 * SECOND;
  await app.runCycle(app.gen);
  await wait(0);
  assert.equal(api.count('predictions'), 1);
  await wait(31 * SECOND);
  assert.equal(api.count('predictions'), 2);
});

test('Last-Modified up to 1 min after the Date is believed (clock skew), not more', async () => {
  for (const [ahead, expected] of [
    [55 * SECOND, [7]],
    [65 * SECOND, []],
  ]) {
    const api = createApi((url, a) =>
      url.includes('/predictions')
        ? json(PREDICTIONS.body, { date: a.clock.wall(), lastModified: a.clock.wall() + ahead })
        : defaultWorld(url),
    );
    const { begin, fake } = await setup({ api });
    await begin();
    assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), expected, `ahead ${ahead}`);
  }
});

test('a Date up to 5 min off the local clock is believed; more is a wrong clock or an old copy', async (t) => {
  for (const [off, expected] of [
    [4 * MINUTE, [0]],
    [-4 * MINUTE, [0]],
    [6 * MINUTE, []],
    [-6 * MINUTE, []],
    // An answer of 3 hours ago replayed whole (a cache): Date, Last-Modified
    // and departures consistent with each other, never fresh.
    [-3 * HOUR, []],
    [-20 * MINUTE, []],
  ]) {
    await t.test(`off ${off / MINUTE} min`, async () => {
      const api = createApi((url, a) =>
        url.includes('/predictions')
          ? json(predictionsDoc([]), {
              date: a.clock.wall() + off,
              lastModified: a.clock.wall() + off - 3 * SECOND,
            })
          : defaultWorld(url),
      );
      const { begin, fake } = await setup({ api });
      await begin();
      assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), expected);
      if (expected.length === 0) {
        assert.match(statusEn(fake), /differs from the clock of this machine.*\((\+|-)\d+ min\)/);
        assert.equal(fake.connectionStatus.connected, false);
      }
    });
  }
});

test('the alerts: a round within 5 s of the 5 minutes reads them, not one 6 s before', async () => {
  for (const [refresh, expected] of [
    [59, 292],
    [49, 340],
  ]) {
    const { begin, api, wait } = await setup({ config: { ...HOME, refresh_seconds: refresh } });
    await begin();
    await wait(7 * MINUTE);
    const alerts = api.calls.filter((c) => c.kind === 'alerts').map((c) => c.at);
    // 59 s: rounds at 0, 59, ..., 295 (5 s early, counts). 49 s: 294 is 6 s early,
    // so 343. The first alerts left at 6 s (after the stop check and the
    // departures), the later ones 3 s after the start of their round.
    assert.equal(Math.round((alerts[1] - alerts[0]) / SECOND), expected, `refresh ${refresh}`);
  }
});

test('the rate hold: remaining 2 holds the next request, 3 does not; 65 s at most', async (t) => {
  for (const [remaining, resetIn, held] of [
    ['2', 40, 40],
    ['3', 40, 0],
    ['0', 300, 65],
  ]) {
    await t.test(`remaining ${remaining}, reset in ${resetIn} s`, async () => {
      const api = createApi((url, a) => {
        if (url.includes('/stops')) {
          return json(defaultWorld(url), {
            date: a.clock.wall(),
            lastModified: a.clock.wall(),
            headers: {
              'x-ratelimit-remaining': remaining,
              'x-ratelimit-reset': String(Math.ceil((a.clock.wall() + resetIn * SECOND) / 1000)),
            },
          });
        }
        return defaultWorld(url);
      });
      const { app, wait } = await setup({ api });
      await app.start(HOME);
      for (let i = 0; i < 90; i += 1) await wait(SECOND);
      const [stops, predictions] = api.calls;
      const gap = Math.round((predictions.at - stops.at) / SECOND);
      assert.ok(gap >= Math.max(3, held) && gap <= Math.max(3, held) + 2, `gap ${gap}`);
    });
  }
});

test('an alert is announced when it changed within 2 h of the server time, not before', async () => {
  let list = [];
  const api = createApi((url) => (url.includes('/alerts') ? alertsDoc(list) : defaultWorld(url)));
  const { begin, fake, wait, clock } = await setup({ api });
  await begin();
  const t = clock.wall() + 5 * MINUTE;
  const at = (ms, over = {}) => ({
    created_at: isoUtc(ms),
    updated_at: null,
    active_period: [],
    ...over,
  });
  list = [
    alertResource('in', at(t - 119 * MINUTE)),
    alertResource('out', at(t - 121 * MINUTE)),
    // Created long ago, but its period started 10 minutes ago: announced.
    alertResource('started', {
      ...at(t - 48 * 60 * MINUTE),
      active_period: [{ start: isoUtc(t - 10 * MINUTE), end: null }],
    }),
    // A time far in the future is not a change.
    alertResource('future', at(t + 60 * MINUTE)),
    alertResource('none', { created_at: null, updated_at: null, active_period: [] }),
  ];
  await wait(5 * MINUTE);
  assert.deepEqual(
    alertEvents(fake)
      .map((e) => e.data.alert_id)
      .sort(),
    ['in', 'started'],
  );
});

test('at most 10 scene events per stop and read', async () => {
  let list = [];
  const api = createApi((url) => (url.includes('/alerts') ? alertsDoc(list) : defaultWorld(url)));
  const { begin, fake, wait, clock } = await setup({ api });
  await begin();
  const created = isoUtc(clock.wall());
  list = Array.from({ length: 12 }, (_, i) =>
    alertResource(`a${i}`, { created_at: created, severity: i % 11 }),
  );
  await wait(5 * MINUTE);
  assert.equal(alertEvents(fake).length, 10);
  // The most severe first.
  assert.equal(alertEvents(fake)[0].data.severity, 10);
  await wait(5 * MINUTE);
  assert.equal(alertEvents(fake).length, 10, 'the 2 left are learnt, never sent late');
});

test('/data is read strictly: a pause of an unknown kind, a bad salt, odd watches', async () => {
  const salt = 'a'.repeat(32);
  const store = createMemoryStore({
    lastAttemptAt: CAPTURED_AT - 10 * MINUTE,
    salt,
    pause: { until: 'soon', kind: 'boom', status: 999, level429: -1, level5xx: 99, levelHttp: 2 },
    watches: {
      1: { fingerprint: 'f', seen: { a: CAPTURED_AT, b: 'x', ['c'.repeat(121)]: CAPTURED_AT } },
      7: { fingerprint: 'g', seen: {} },
      2: { seen: {} },
    },
  });
  const { app } = await setup({ store });
  app.load();
  assert.equal(app.persisted.salt, salt);
  assert.deepEqual(app.persisted.pause, {
    until: null,
    kind: 'rate',
    status: null,
    level429: 0,
    level5xx: 0,
    levelHttp: 2,
  });
  assert.deepEqual(Object.keys(app.persisted.watches), ['1']);
  assert.deepEqual(Object.keys(app.persisted.watches[1].seen), ['a']);
  const fresh = await setup({ store: createMemoryStore({ salt: 'xyz' }) });
  fresh.app.load();
  assert.match(fresh.app.persisted.salt, /^[0-9a-f]{32}$/);
  assert.notEqual(fresh.app.persisted.salt, 'xyz');
});

test('the stop ids never reach /data in clear (salted fingerprints only)', async () => {
  const store = createMemoryStore();
  const { begin, app } = await setup({ store });
  await begin();
  await app.stop();
  assert.doesNotMatch(JSON.stringify(store.data), /pktrm/);
  assert.ok(store.data.watches[1].fingerprint);
});

test('a stop check that fails is retried 1, 2, 4 min later', async () => {
  const api = createApi((url, a) =>
    url.includes('/stops') ? errorAnswer(a, 500) : defaultWorld(url),
  );
  const { begin, wait } = await setup({ api });
  await begin();
  for (let i = 0; i < 8; i += 1) await wait(MINUTE);
  const checks = api.calls.filter((c) => c.kind === 'stops').map((c) => Math.round(c.at / MINUTE));
  assert.deepEqual(checks, [0, 1, 3, 7]);
  // A failing check is secondary: no pause, the departures every minute.
  assert.equal(api.count('predictions'), 9);
});

test('the status says the departures are stale after 3 intervals (5 min at least)', async () => {
  let down = false;
  const api = createApi((url) =>
    url.includes('/predictions') && down ? 'network' : defaultWorld(url),
  );
  const { begin, app, wait } = await setup({ api, config: { ...HOME, refresh_seconds: 120 } });
  await begin();
  assert.equal(app.staleAfter(), 6 * MINUTE);
  down = true;
  await wait(5 * MINUTE + 30 * SECOND);
  assert.doesNotMatch(app.composeStatus().message.en, /stale/);
  await wait(MINUTE);
  assert.match(app.composeStatus().message.en, /, stale, nothing published since/);
  app.config.refreshSeconds = 30;
  assert.equal(app.staleAfter(), 5 * MINUTE);
});

test('the alerts are said stale after 70 minutes without a good read', async () => {
  let down = false;
  const api = createApi((url, a) =>
    url.includes('/alerts') && down ? errorAnswer(a, 500) : defaultWorld(url),
  );
  const { begin, fake, wait } = await setup({ api });
  await begin();
  down = true;
  for (let i = 0; i < 69; i += 1) await wait(MINUTE);
  assert.doesNotMatch(statusEn(fake), /alerts: .*stale/);
  for (let i = 0; i < 2; i += 1) await wait(MINUTE);
  assert.match(
    statusEn(fake),
    /alerts: MBTA server error \(HTTP 500\); last data .*, stale, nothing/,
  );
});

test('a pause that starts while a request waits its turn holds that request', async () => {
  // The departures of a first round answer 429 late; meanwhile a new
  // configuration starts a round whose stop check waits behind them.
  let first = true;
  const api = createApi((url, a) => {
    if (url.includes('/predictions') && first) {
      first = false;
      return new Promise((resolve) => {
        a.clock.timers.setTimeout(() => resolve(errorAnswer(a, 429)), 5 * SECOND);
      });
    }
    return defaultWorld(url);
  });
  const { app, wait } = await setup({ api });
  await app.start(HOME);
  await wait(4 * SECOND);
  await app.start({ watch1_stop: '1' });
  await wait(10 * SECOND);
  assert.equal(api.count('stops'), 1, 'the stop check of the new stop waits for the pause');
  assert.ok(app.pausedFor() > MINUTE);
});

test('the status after a restart in a pause names the end of the pause as the next read', async () => {
  const store = createMemoryStore({
    lastAttemptAt: CAPTURED_AT - 10 * MINUTE,
    pause: { until: CAPTURED_AT + 3 * MINUTE, kind: 'server', status: 503, level5xx: 1 },
  });
  const { app, fake } = await setup({ store });
  await app.start(HOME);
  assert.match(statusEn(fake), /Next read Oct 30, 02:06 ET\./);
});

test('the status names why nothing was published', async (t) => {
  const bad = { ...predictionsBody(), data: [{ id: 'x', type: 'prediction' }] };
  const cases = {
    'no usable time': [
      (a) => json(PREDICTIONS.body, { date: null, lastModified: a.clock.wall() }),
      /carries no usable time/,
    ],
    'items that cannot be read': [
      (a) => json(bad, { date: a.clock.wall(), lastModified: a.clock.wall() }),
      /items that cannot be read/,
    ],
    'frozen feed': [
      (a) => json(PREDICTIONS.body, { date: a.clock.wall(), lastModified: a.clock.wall() - HOUR }),
      /frozen feed/,
    ],
  };
  for (const [name, [answer, text]] of Object.entries(cases)) {
    await t.test(name, async () => {
      const api = createApi((url, a) =>
        url.includes('/predictions') ? answer(a) : defaultWorld(url),
      );
      const { begin, fake } = await setup({ api });
      await begin();
      assert.match(statusEn(fake), text);
    });
  }
});

test('a route filter not checked yet (the route check failed) never makes an empty stop 0', async () => {
  const api = createApi((url) => {
    if (url.includes('/routes')) return 'network';
    if (url.includes('/predictions')) return { data: [], jsonapi: { version: '1.0' } };
    return defaultWorld(url);
  });
  const {
    begin,
    fake,
    api: calls,
  } = await setup({
    api,
    config: { watch1_stop: 'place-pktrm', watch1_routes: 'Red' },
  });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
  // The alerts are read anyway (the check never holds them), but an empty
  // answer for an unchecked filter publishes nothing either.
  assert.equal(calls.count('alerts'), 1);
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), []);
  assert.match(statusEn(fake), /alerts: No alert, and the stop could not be checked yet/);
  assert.match(statusEn(fake), /could not be checked yet/);
});

test('alerts skipped by a pause stay due; never a request during a pause', async () => {
  const { begin, app } = await setup();
  await begin();
  const before = new Map(app.alertsDue);
  let calls = 0;
  app.call = async () => {
    calls += 1;
    return { ok: false, kind: 'paused' };
  };
  // The pause found when the request's turn comes: still due.
  app.alertsDue.clear();
  await app.readAllAlerts(app.gen, app.monotonic());
  assert.equal(calls, 1);
  assert.equal(app.alertsDue.size, 0, 'still due for the next round');
  // A pause known before: no request attempted at all.
  calls = 0;
  app.pauseUntilMono = app.monotonic() + MINUTE;
  await app.readAllAlerts(app.gen, app.monotonic());
  assert.equal(calls, 0);
  assert.equal(app.alertsDue.size, 0);
  assert.ok(before.size === 1);
});

test('a stop the MBTA does not know is checked again in the round of the 30th minute', async () => {
  // The answer takes 2 s: the round of 30:00 is 29:58 after it, within the 5 s.
  const api = createApi((url, a) =>
    url.includes('/stops')
      ? new Promise((resolve) =>
          a.clock.timers.setTimeout(() => resolve(defaultWorld(url)), 2 * SECOND),
        )
      : defaultWorld(url),
  );
  const { begin, wait } = await setup({ api, config: { watch1_stop: 'bogus-xyz' } });
  await begin();
  await wait(29 * MINUTE);
  assert.equal(api.count('stops'), 1);
  await wait(45 * SECOND);
  assert.equal(api.count('stops'), 2);
});

test('a successful check resets the spacing of the next failure', async () => {
  let down = 2;
  const api = createApi((url, a) => {
    if (url.includes('/stops') && down > 0) {
      down -= 1;
      return errorAnswer(a, 500);
    }
    return defaultWorld(url);
  });
  const { begin, app, wait } = await setup({ api });
  await begin();
  // Fails at 0 and 1 min, succeeds at 3 min.
  for (let i = 0; i < 4; i += 1) await wait(MINUTE);
  assert.equal(app.checkLevel, 0);
  // A new stop, a new failure: retried 1 minute later, not 4.
  down = 1;
  await app.start({ watch1_stop: '1' });
  for (let i = 0; i < 2; i += 1) await wait(MINUTE);
  const checks = api.calls.filter((c) => c.kind === 'stops').map((c) => Math.round(c.at / MINUTE));
  assert.deepEqual(checks.slice(-2), [4, 5]);
});

test('an alert whose period starts in a few minutes is not announced yet', async () => {
  let list = [];
  const api = createApi((url) => (url.includes('/alerts') ? alertsDoc(list) : defaultWorld(url)));
  const { begin, fake, wait, clock } = await setup({ api });
  await begin();
  const t = clock.wall() + 5 * MINUTE;
  list = [
    alertResource('soon', {
      created_at: isoUtc(t - 48 * 60 * MINUTE),
      updated_at: null,
      active_period: [{ start: isoUtc(t + 3 * MINUTE), end: null }],
    }),
  ];
  await wait(5 * MINUTE);
  assert.equal(alertEvents(fake).length, 0);
});

test('a disconnection while the configuration is read: nothing starts', async () => {
  const { app, gladys, api, wait } = await setup();
  let release;
  gladys.getConfig = () => new Promise((resolve) => (release = resolve));
  const connecting = app.connected();
  await wait(0);
  await app.disconnected();
  release(HOME);
  await connecting;
  await wait(5 * MINUTE);
  assert.equal(api.calls.length, 0);
  assert.equal(app.config, null);
});

test('during a long pause the status turns stale and not connected, without reading', async () => {
  // The departures were read at 0:03; the alerts answer 429 for 30 minutes.
  const api = createApi((url, a) =>
    url.includes('/alerts') ? errorAnswer(a, 429, { 'retry-after': '1800' }) : defaultWorld(url),
  );
  const { begin, fake, wait } = await setup({ api });
  await begin();
  assert.equal(fake.connectionStatus.connected, true);
  assert.match(statusEn(fake), /read Oct 30, 02:03 ET; alerts/);
  const sent = fake.connectionStatuses.length;
  for (let i = 0; i < 4; i += 1) await wait(MINUTE);
  assert.equal(fake.connectionStatus.connected, true, 'within 5 minutes');
  for (let i = 0; i < 2; i += 1) await wait(MINUTE);
  assert.equal(api.count('predictions'), 1, 'no read during the pause');
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(statusEn(fake), /read Oct 30, 02:03 ET \(stale\)/);
  assert.match(statusEn(fake), /reads paused until/);
  // A status only when it changes: the stale turn and the next-read time, not one per wake.
  const more = fake.connectionStatuses.length - sent;
  assert.ok(more >= 1 && more <= 3, `${more} statuses`);
});

test('a configuration saved during a long pause keeps the status waking', async () => {
  const api = createApi((url, a) =>
    url.includes('/alerts') ? errorAnswer(a, 429, { 'retry-after': '1800' }) : defaultWorld(url),
  );
  const { begin, app, fake, wait } = await setup({ api });
  await begin();
  await wait(MINUTE);
  await app.start(HOME);
  for (let i = 0; i < 6; i += 1) await wait(MINUTE);
  assert.equal(api.count('predictions'), 1);
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(statusEn(fake), /\(stale\)/);
});
