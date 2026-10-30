// -----------------------------------------------------------------------------
// The app end to end on the virtual clock: what is read, when, and what is
// published or refused.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT, FEATURES, REQUEST_GAP, VERSION } from '../src/constants.js';

/** The minutes of a departure text ("… in 4 min (08:09)"). */
const minutesOf = (text) => Number(/ in (\d+) min /.exec(text)?.[1]);
import { createMemoryStore } from '../src/store.js';
import {
  CAPTURED_AT,
  F,
  HOME,
  MINUTE,
  PREDICTIONS,
  SECOND,
  STOPS,
  TWO,
  alertResource,
  alertsDoc,
  createApi,
  defaultIncluded,
  defaultWorld,
  errorAnswer,
  fresh,
  json,
  prediction,
  predictionsDoc,
  published,
  setup,
  statusEn,
  stopResource,
  alertEvents,
} from './helpers/setup.js';

const N = (key) => F(1, key);

test('the first round: stop check, departures, alerts; published from the capture', async () => {
  const { begin, api, fake } = await setup();
  await begin();
  assert.deepEqual(
    api.calls.map((c) => c.kind),
    ['stops', 'predictions', 'alerts'],
  );
  for (const call of api.calls) {
    assert.equal(call.init.headers.Accept, ACCEPT);
    assert.ok(
      call.init.headers['User-Agent'].startsWith(`gladys-mbta/${VERSION} (+https://github`),
    );
    assert.equal(call.init.redirect, 'error');
  }
  // 3 s at least between the starts of two requests.
  for (let i = 1; i < api.calls.length; i += 1) {
    assert.ok(api.calls[i].at - api.calls[i - 1].at >= REQUEST_GAP);
  }
  // Green Line E at 06:16:15Z, D at 06:16:54Z, E at 06:59:38Z; read at 06:03:08Z.
  assert.deepEqual(published(fake, N(FEATURES.NEXT)), [
    'Green Line E → Heath Street in 13 min (02:16)',
  ]);
  assert.deepEqual(published(fake, N(FEATURES.SECOND)), [
    'Green Line E → Heath Street in 13 min (02:16)',
  ]);
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [7]);
  const [text] = published(fake, N(FEATURES.SUMMARY));
  assert.match(
    text,
    /^02:03 · Green Line E → Heath Street 13, 13, 13 min · Green Line D → Riverside/,
  );
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), [0]);
  assert.deepEqual(published(fake, N(FEATURES.ALERT_TEXT)), ['No alert']);
  assert.equal(fake.connectionStatus.connected, true);
  assert.match(statusEn(fake), /^MBTA – Park Street: next in 13 min \(Green Line E\), 7 departure/);
  // The device is named after the MBTA stop once it is known.
  assert.equal(fake.discoveredDevices[0].name, 'MBTA – Park Street');
});

test('one round per interval; the alerts every 5 minutes; the stop checked once', async () => {
  const { begin, api, wait } = await setup();
  await begin();
  await wait(9 * MINUTE + 39 * SECOND);
  assert.equal(api.count('stops'), 1);
  assert.equal(api.count('predictions'), 10);
  assert.equal(api.count('alerts'), 2);
  // The first round started with the stop check: measured from the second one.
  const starts = api.calls.filter((c) => c.kind === 'predictions').map((c) => c.at);
  for (let i = 2; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= MINUTE, `gap ${starts[i] - starts[i - 1]}`);
    assert.ok(starts[i] - starts[i - 1] < MINUTE + 4 * SECOND);
  }
  assert.ok(api.peak <= 1, 'one request at a time');
});

test('nothing is published from a frozen feed, a missing date or Last-Modified', async (t) => {
  const cases = {
    stale: (api) =>
      json(PREDICTIONS.body, {
        date: api.clock.wall(),
        lastModified: api.clock.wall() - 11 * MINUTE,
      }),
    'no Last-Modified': (api) => json(PREDICTIONS.body, { date: api.clock.wall() }),
    'Last-Modified in the future': (api) =>
      json(PREDICTIONS.body, {
        date: api.clock.wall(),
        lastModified: api.clock.wall() + 2 * MINUTE,
      }),
    'no Date': (api) =>
      json(PREDICTIONS.body, { date: null, lastModified: api.clock.wall() - SECOND }),
    'Date two days off': (api) =>
      json(PREDICTIONS.body, {
        date: api.clock.wall() - 48 * 60 * MINUTE,
        lastModified: api.clock.wall() - 48 * 60 * MINUTE,
      }),
  };
  for (const [name, answer] of Object.entries(cases)) {
    await t.test(name, async () => {
      const api = createApi((url, a) =>
        url.includes('/predictions') ? answer(a) : defaultWorld(url),
      );
      const { begin, fake } = await setup({ api });
      await begin();
      assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
      assert.deepEqual(published(fake, N(FEATURES.NEXT)), []);
      assert.deepEqual(published(fake, N(FEATURES.SUMMARY)), []);
      assert.equal(fake.connectionStatus.connected, false);
      assert.match(statusEn(fake), /nothing published/);
    });
  }
});

test('a frozen feed 9:59 old is published; 10:01 is not (the boundary)', async () => {
  for (const [age, expected] of [
    [9 * MINUTE + 59 * SECOND, [7]],
    [10 * MINUTE + SECOND, []],
  ]) {
    const api = createApi((url, a) =>
      url.includes('/predictions')
        ? json(PREDICTIONS.body, { date: a.clock.wall(), lastModified: a.clock.wall() - age })
        : defaultWorld(url),
    );
    const { begin, fake } = await setup({ api });
    await begin();
    assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), expected, `age ${age}`);
  }
});

test('an answer that cannot be read publishes nothing, never 0', async (t) => {
  const bad = prediction('bad', { departure: CAPTURED_AT + MINUTE + 30 * SECOND });
  bad.attributes.departure_time = 'soon';
  const cases = {
    'one unreadable prediction': predictionsDoc([
      prediction('a', { departure: CAPTURED_AT + 5 * MINUTE + 30 * SECOND }),
      bad,
    ]),
    'an errors document': { errors: [{ status: '400' }] },
    'not a list': { data: {} },
  };
  for (const [name, body] of Object.entries(cases)) {
    await t.test(name, async () => {
      const api = createApi((url) => (url.includes('/predictions') ? body : defaultWorld(url)));
      const { begin, fake } = await setup({ api });
      await begin();
      assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
      assert.deepEqual(published(fake, N(FEATURES.SUMMARY)), []);
      assert.equal(fake.connectionStatus.connected, false);
    });
  }
  await t.test('an HTML page', async () => {
    const api = createApi((url, a) =>
      url.includes('/predictions')
        ? new Response('<html></html>', {
            headers: { 'content-type': 'text/html', date: new Date(a.clock.wall()).toUTCString() },
          })
        : defaultWorld(url),
    );
    const { begin, fake } = await setup({ api });
    await begin();
    assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
    assert.match(statusEn(fake), /MBTA answer not readable/);
  });
});

test('an empty stop is 0 only once the MBTA confirmed the stop', async () => {
  const empty = predictionsDoc([]);
  // The stop check fails (network): an empty answer is not "no departure".
  let stopsDown = true;
  const api = createApi((url) => {
    if (url.includes('/stops')) return stopsDown ? 'network' : STOPS.body;
    if (url.includes('/predictions')) return empty;
    return defaultWorld(url);
  });
  const { begin, fake, wait } = await setup({ api });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), [], 'no alert read for an unchecked stop');
  assert.match(statusEn(fake), /could not be checked yet: nothing published/);
  assert.match(statusEn(fake), /Stop check: MBTA could not be reached/);
  stopsDown = false;
  await wait(MINUTE);
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [0]);
  // Never a number for a departure that does not exist: the texts say so.
  assert.deepEqual(published(fake, N(FEATURES.NEXT)), ['No predicted departure (read 02:04)']);
  assert.deepEqual(published(fake, N(FEATURES.SECOND)), ['No following departure (read 02:04)']);
  assert.match(published(fake, N(FEATURES.SUMMARY))[0], /No predicted departure/);
  // The alerts skipped while unchecked come with the next round, not 5 min later.
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), [0]);
});

test('departures of an unchecked stop are published (the stop evidently exists)', async () => {
  const api = createApi((url) => (url.includes('/stops') ? 'network' : defaultWorld(url)));
  const { begin, fake } = await setup({ api });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [7]);
});

test('a stop unknown to the MBTA: nothing published, checked again after 30 min', async () => {
  const config = { watch1_stop: 'bogus-xyz' };
  const { begin, fake, api, wait } = await setup({ config });
  await begin();
  assert.deepEqual(published(fake, F(1, FEATURES.DEPARTURES)), []);
  assert.deepEqual(published(fake, F(1, FEATURES.ALERTS)), []);
  assert.match(statusEn(fake), /does not know this stop id/);
  assert.equal(api.count('alerts'), 0);
  // Checked at 3 s: the round of 30:00 checks it again (never one round later).
  await wait(29 * MINUTE);
  assert.equal(api.count('stops'), 1);
  await wait(45 * SECOND);
  assert.equal(api.count('stops'), 2);
});

test('a route filter: resolved by id or bus number, a route not calling refused', async () => {
  const routes = {
    data: [
      { id: 'Red', type: 'route', attributes: { short_name: '', long_name: 'Red Line', type: 1 } },
      { id: '741', type: 'route', attributes: { short_name: 'SL1', long_name: 'Logan', type: 3 } },
    ],
  };
  const body = predictionsDoc([
    prediction('red', { departure: CAPTURED_AT + 4 * MINUTE + 30 * SECOND }),
    prediction('sl1', { route: '741', departure: CAPTURED_AT + 2 * MINUTE + 30 * SECOND }),
    prediction('ora', { route: 'Orange', departure: CAPTURED_AT + MINUTE + 30 * SECOND }),
  ]);
  const world = (url) => {
    if (url.includes('/routes')) return routes;
    if (url.includes('/predictions')) return body;
    return defaultWorld(url);
  };
  {
    const config = { watch1_stop: 'place-pktrm', watch1_routes: 'red, sl1' };
    const { begin, fake, api } = await setup({ config, api: createApi(world) });
    await begin();
    assert.deepEqual(published(fake, N(FEATURES.NEXT)).map(minutesOf), [2]);
    assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [2]);
    const alerts = api.calls.find((c) => c.kind === 'alerts');
    assert.match(alerts.url, /filter%5Broute%5D=Red%2C741/);
  }
  {
    const config = { watch1_stop: 'place-pktrm', watch1_routes: 'Red, 99' };
    const { begin, fake, api } = await setup({ config, api: createApi(world) });
    await begin();
    assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
    assert.match(statusEn(fake), /does not call at this stop: check the routes \(99\)/);
    assert.equal(api.count('alerts'), 0);
  }
});

test('the direction filter', async () => {
  const body = predictionsDoc([
    prediction('s', { departure: CAPTURED_AT + 4 * MINUTE + 30 * SECOND, direction: 0 }),
    prediction('n', {
      stop: '70076',
      departure: CAPTURED_AT + 2 * MINUTE + 30 * SECOND,
      direction: 1,
    }),
  ]);
  const world = (url) => (url.includes('/predictions') ? body : defaultWorld(url));
  const { begin, fake, api } = await setup({
    config: { watch1_stop: 'place-pktrm', watch1_direction: '0' },
    api: createApi(world),
  });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.NEXT)).map(minutesOf), [4]);
  assert.match(api.calls.find((c) => c.kind === 'alerts').url, /filter%5Bdirection_id%5D=0/);
});

test('two stops in one predictions request; a bus stop matched directly', async () => {
  const body = predictionsDoc(
    [
      prediction('red', { departure: CAPTURED_AT + 4 * MINUTE + 30 * SECOND }),
      prediction('bus', {
        stop: '1',
        route: '1',
        departure: CAPTURED_AT + 9 * MINUTE + 30 * SECOND,
      }),
    ],
    [...defaultIncluded(), stopResource('1', null, 'Washington St opp Ruggles St')],
  );
  const world = (url) => (url.includes('/predictions') ? body : defaultWorld(url));
  const { begin, fake, api } = await setup({ config: TWO, api: createApi(world) });
  await begin();
  assert.equal(api.count('predictions'), 1);
  assert.match(api.calls.find((c) => c.kind === 'predictions').url, /place-pktrm%2C1&/);
  assert.deepEqual(published(fake, F(1, FEATURES.NEXT)).map(minutesOf), [4]);
  assert.deepEqual(published(fake, F(2, FEATURES.NEXT)).map(minutesOf), [9]);
  assert.equal(api.count('alerts'), 2);
  assert.equal(fake.discoveredDevices[1].name, 'Bus home');
});

test('a 5xx of the departures pauses every read; the pause is kept in /data', async () => {
  let down = true;
  const api = createApi((url, a) =>
    url.includes('/predictions') && down ? errorAnswer(a, 503) : defaultWorld(url),
  );
  const store = createMemoryStore();
  const { begin, fake, wait } = await setup({ api, store });
  await begin();
  assert.equal(api.count('predictions'), 1);
  assert.equal(api.count('alerts'), 0, 'the alerts wait for the pause too');
  assert.ok(store.data.pause.until > CAPTURED_AT);
  assert.equal(store.data.pause.kind, 'server');
  assert.match(statusEn(fake), /MBTA server error \(HTTP 503\): reads paused until/);
  down = false;
  // The 503 came at 3 s (after the stop check): paused until 63 s.
  await wait(40 * SECOND);
  assert.equal(api.count('predictions'), 1);
  await wait(5 * SECOND);
  assert.equal(api.count('predictions'), 2);
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [7]);
  await wait(5 * SECOND);
  assert.equal(store.data.pause.until, null);
});

test('a 429 anywhere pauses every read, at least until the rate window resets', async () => {
  let refuse = true;
  const api = createApi((url, a) => {
    if (url.includes('/alerts') && refuse) {
      const reset = Math.ceil((a.clock.wall() + 5 * MINUTE) / 1000);
      return errorAnswer(a, 429, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      });
    }
    return defaultWorld(url);
  });
  const { begin, fake, wait } = await setup({ api });
  await begin();
  refuse = false;
  assert.match(statusEn(fake), /MBTA asked to slow down \(429\): reads paused/);
  // The 429 came at 6 s: paused 5 min (the rate window), until 306 s.
  await wait(4 * MINUTE + 40 * SECOND);
  assert.equal(api.count('predictions'), 1, 'the departures wait for the 429 pause');
  await wait(30 * SECOND);
  assert.equal(api.count('predictions'), 2);
});

test('a failure of the alerts never holds the departures, and is spaced out', async () => {
  const api = createApi((url, a) =>
    url.includes('/alerts') ? errorAnswer(a, 500) : defaultWorld(url),
  );
  const { begin, fake, wait } = await setup({ api });
  await begin();
  await wait(14 * MINUTE + 30 * SECOND);
  assert.equal(api.count('predictions'), 15, 'no pause for an alerts failure');
  // Alerts at 0, then 5 min later, then 10 min after that.
  const alerts = api.calls.filter((c) => c.kind === 'alerts').map((c) => c.at);
  assert.equal(alerts.length, 2);
  assert.ok(alerts[1] - alerts[0] >= 5 * MINUTE - 5 * SECOND && alerts[1] - alerts[0] < 6 * MINUTE);
  await wait(MINUTE);
  assert.equal(api.count('alerts'), 3);
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), []);
  assert.match(statusEn(fake), /alerts: MBTA server error \(HTTP 500\); no data yet/);
  assert.equal(fake.connectionStatus.connected, true);
});

test('alerts: count, most severe text, scene event for a new one only', async () => {
  let list = [alertResource(1, { severity: 3 })];
  const api = createApi((url) => (url.includes('/alerts') ? alertsDoc(list) : defaultWorld(url)));
  const { begin, fake, wait, clock } = await setup({ api });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), [1]);
  assert.equal(alertEvents(fake).length, 0, 'the first read only learns');
  const now = clock.wall();
  list = [
    alertResource(1, { severity: 3 }),
    alertResource(2, {
      severity: 8,
      effect: 'SUSPENSION',
      header: 'Synthetic severe.',
      created_at: new Date(now).toISOString().replace('Z', '+00:00').replace(/\.\d+/, ''),
      updated_at: null,
    }),
    // New to the watch but changed 3 hours ago: not announced.
    alertResource(3, {
      created_at: '2026-10-29T23:00:00-04:00',
      updated_at: '2026-10-29T23:00:00-04:00',
      active_period: [{ start: '2026-10-29T23:00:00-04:00', end: null }],
    }),
  ];
  await wait(5 * MINUTE);
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), [1, 3]);
  assert.equal(published(fake, N(FEATURES.ALERT_TEXT)).at(-1), 'Synthetic severe. (2 more alerts)');
  assert.equal(alertEvents(fake).length, 1);
  const { key, data } = alertEvents(fake)[0];
  assert.equal(key, 'new_alert');
  assert.equal(data.alert_id, '2');
  assert.equal(data.effect, 'SUSPENSION');
  assert.equal(data.severity_band, 'severe');
  assert.equal(data.device, 'ext:mbta:watch:1-place-pktrm');
  await wait(5 * MINUTE);
  assert.equal(alertEvents(fake).length, 1, 'never twice');
});

test('an alert answer with an unreadable alert publishes no count', async () => {
  const api = createApi((url) =>
    url.includes('/alerts')
      ? alertsDoc([alertResource(1), { id: '2', type: 'alert' }])
      : defaultWorld(url),
  );
  const { begin, fake } = await setup({ api });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.ALERTS)), []);
  assert.match(statusEn(fake), /alerts: The MBTA sends items that cannot be read/);
});

test('the test button and Discovery never read', async () => {
  const { begin, app, api } = await setup();
  await begin();
  const before = api.calls.length;
  for (let i = 0; i < 5; i += 1) {
    const message = app.testConnection();
    assert.match(message.en, /Park Street/);
    await app.scan();
  }
  assert.equal(api.calls.length, before);
});

test('a network failure publishes nothing and does not pause', async () => {
  const api = createApi((url) => (url.includes('/predictions') ? 'network' : defaultWorld(url)));
  const { begin, fake, wait } = await setup({ api });
  await begin();
  await wait(MINUTE);
  assert.equal(api.count('predictions'), 2);
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
  assert.match(statusEn(fake), /departures: MBTA could not be reached; no data yet/);
});

test('a failure after a success: the status tells the last data and that nothing is published', async () => {
  let down = false;
  const api = createApi((url) =>
    url.includes('/predictions') && down ? 'network' : defaultWorld(url),
  );
  const { begin, fake, wait } = await setup({ api });
  await begin();
  down = true;
  await wait(MINUTE);
  assert.match(statusEn(fake), /last data Oct 30, 02:03 ET, nothing published since/);
  assert.equal(fake.connectionStatus.connected, false, 'the last read failed');
  await wait(5 * MINUTE);
  assert.match(statusEn(fake), /last data Oct 30, 02:03 ET, stale, nothing published since/);
  assert.equal(fake.connectionStatus.connected, false);
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [7]);
});

test('If-Modified-Since: a 304 reuses the answer, judged on its Last-Modified', async () => {
  const api = createApi((url, a, call) => {
    if (url.includes('/predictions') && call.init.headers['If-Modified-Since']) {
      return new Response(null, {
        status: 304,
        headers: { date: new Date(a.clock.wall()).toUTCString() },
      });
    }
    return defaultWorld(url);
  });
  const { begin, fake, wait } = await setup({ api });
  await begin();
  await wait(MINUTE);
  const second = api.calls.filter((c) => c.kind === 'predictions')[1];
  assert.ok(second.init.headers['If-Modified-Since']);
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), [7, 7]);
  // 304 after 304: the data behind them (first answer at 3 s) passes 10 minutes
  // old at the round of 660 s.
  await wait(11 * MINUTE);
  assert.equal(published(fake, N(FEATURES.DEPARTURES)).length, 11);
  assert.match(statusEn(fake), /frozen feed/);
});

test('fresh() helper keeps the default Last-Modified 3 s before Date', () => {
  const api = { clock: { wall: () => CAPTURED_AT } };
  const response = fresh(api, {});
  assert.equal(
    Date.parse(response.headers.get('date')) - Date.parse(response.headers.get('last-modified')),
    3 * SECOND,
  );
});

test('the alerts of a slot are read again with a moved stop', async () => {
  const { begin, api, app } = await setup({ config: HOME });
  await begin();
  assert.equal(api.count('alerts'), 1);
  await app.start({ watch1_stop: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  const { settle } = await import('./kit/clock.mjs');
  await settle(10);
  await api.clock.advance(10 * SECOND);
  await settle(10);
  assert.equal(api.count('alerts'), 2);
  assert.equal(api.count('stops'), 2);
});
