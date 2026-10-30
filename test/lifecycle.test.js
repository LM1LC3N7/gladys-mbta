// -----------------------------------------------------------------------------
// Starts, restarts, configurations in a row, /data, pauses across restarts,
// timers that fire a little early, the configuration read on a connection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { settle } from './kit/clock.mjs';
import {
  CAPTURED_AT,
  F,
  HOME,
  MINUTE,
  SECOND,
  alertResource,
  alertsDoc,
  createApi,
  defaultWorld,
  errorAnswer,
  json,
  PREDICTIONS,
  published,
  setup,
  statusEn,
  alertEvents,
} from './helpers/setup.js';

const N = (key) => F(1, key);

test('configurations saved in a row apply one by one, the last one winning', async () => {
  const { app, gladys, api, wait, fake } = await setup({ config: HOME });
  let slow = true;
  const original = gladys.publishDiscoveredDevices.bind(gladys);
  gladys.publishDiscoveredDevices = async (devices) => {
    if (slow) {
      slow = false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return original(devices);
  };
  const saves = [];
  for (let i = 0; i < 20; i += 1) {
    saves.push(
      app.start({ watch1_stop: i % 2 === 0 ? 'place-pktrm' : '1', refresh_seconds: 30 + i }),
    );
  }
  await Promise.all(saves);
  await app.idle();
  await wait(20 * SECOND);
  assert.equal(app.config.refreshSeconds, 49);
  assert.equal(app.config.watches[0].stop, '1');
  // Only the first and the last configurations were applied; one round.
  assert.equal(api.count('predictions'), 1);
  assert.match(api.calls.find((c) => c.kind === 'predictions').url, /filter%5Bstop%5D=1&/);
  assert.equal(fake.discoveredDevices[0].name, 'MBTA – Washington St opp Ruggles St');
});

test('a slow Discovery of an older save never publishes over a newer configuration', async () => {
  const { app, gladys, api, wait } = await setup({ config: HOME });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const original = gladys.publishDiscoveredDevices.bind(gladys);
  let first = true;
  gladys.publishDiscoveredDevices = async (devices) => {
    if (first) {
      first = false;
      await gate;
    }
    return original(devices);
  };
  const a = app.start({ watch1_stop: 'place-pktrm' });
  const b = app.start({ watch1_stop: '1' });
  release();
  await Promise.all([a, b]);
  await wait(20 * SECOND);
  for (const call of api.calls) assert.doesNotMatch(call.url, /place-pktrm/);
});

test('a restart never reads sooner than the interval (time of the attempt in /data)', async () => {
  const store = createMemoryStore({ lastAttemptAt: CAPTURED_AT - 20 * SECOND });
  const { app, api, wait } = await setup({ store });
  await app.start(HOME);
  await wait(39 * SECOND);
  assert.equal(api.calls.length, 0);
  await wait(2 * SECOND);
  assert.equal(api.count('stops'), 1);
  // The time of the attempt reaches /data before the first request.
  assert.ok(store.data.lastAttemptAt >= CAPTURED_AT + 40 * SECOND);
});

test('the attempt time is saved before the request leaves', async () => {
  const store = createMemoryStore();
  const api = createApi((url) => {
    assert.ok(store.data?.lastAttemptAt >= CAPTURED_AT, 'saved before');
    return defaultWorld(url);
  });
  const { begin } = await setup({ store, api });
  await begin();
  assert.ok(api.calls.length > 0);
});

test('a /data that cannot tell the last attempt: the first read waits 30 s', async (t) => {
  const cases = {
    unreadable: () => createMemoryStore(undefined, { status: 'unreadable' }),
    'date in the future': () => createMemoryStore({ lastAttemptAt: CAPTURED_AT + 3600 * SECOND }),
    'not writable': () => {
      const store = createMemoryStore();
      store.failSave = true;
      return store;
    },
  };
  for (const [name, make] of Object.entries(cases)) {
    await t.test(name, async () => {
      const store = make();
      const { app, api, wait, fake } = await setup({ store });
      await app.start(HOME);
      await wait(29 * SECOND);
      assert.equal(api.calls.length, 0);
      assert.match(statusEn(fake), /first read waits 30 s|could not be written|unreadable/);
      await wait(2 * SECOND);
      assert.equal(api.count('stops'), 1);
    });
  }
});

test('an unreadable /data is never written over', async () => {
  const store = createMemoryStore(undefined, { status: 'unreadable' });
  const { app, wait } = await setup({ store });
  await app.start(HOME);
  await wait(2 * MINUTE);
  await app.stop();
  assert.equal(store.saves, 0);
});

test('a frozen /data never holds a round: the next ones still come', async () => {
  const store = createMemoryStore();
  const { app, api, wait } = await setup({ store });
  store.hold = new Promise(() => {});
  // Not awaited: the start itself waits for its bounded save (2 s).
  app.start(HOME);
  for (let i = 0; i < 180; i += 1) await wait(SECOND);
  // The first round waited 30 s (/data could not be written): rounds at 30, 90, 150 s.
  assert.equal(api.count('predictions'), 3);
  for (let i = 0; i < 60; i += 1) await wait(SECOND);
  assert.equal(api.count('predictions'), 4);
});

test('a pause kept in /data holds the reads after a restart; one over 6 h is not believed', async () => {
  {
    const store = createMemoryStore({
      lastAttemptAt: CAPTURED_AT - 10 * MINUTE,
      pause: { until: CAPTURED_AT + 3 * MINUTE, kind: 'rate', status: 429, level429: 1 },
    });
    const { app, api, wait, fake } = await setup({ store });
    await app.start(HOME);
    await wait(2 * MINUTE + 59 * SECOND);
    assert.equal(api.calls.length, 0);
    assert.match(statusEn(fake), /asked to slow down \(429\): reads paused until/);
    await wait(2 * SECOND);
    assert.equal(api.count('stops'), 1);
  }
  {
    const store = createMemoryStore({
      lastAttemptAt: CAPTURED_AT - 10 * MINUTE,
      pause: { until: CAPTURED_AT + 7 * 60 * MINUTE, kind: 'rate', level429: 1 },
    });
    const { app, api, wait } = await setup({ store });
    await app.start(HOME);
    await wait(SECOND);
    assert.equal(api.count('stops'), 1);
  }
});

test('the pauses grow 429: 2, 4, 8 min; 5xx: 1, 2, 4 min; bounded to 6 h', async () => {
  const { app } = await setup();
  app.load();
  const lengths = [];
  for (let i = 0; i < 3; i += 1) {
    app.pauseUntilMono = null;
    app.startPause({ kind: 'rate', status: 429 });
    lengths.push(Math.round(app.pausedFor() / SECOND));
  }
  for (let i = 0; i < 3; i += 1) {
    app.pauseUntilMono = null;
    app.startPause({ kind: 'server', status: 503 });
    lengths.push(Math.round(app.pausedFor() / SECOND));
  }
  app.pauseUntilMono = null;
  app.startPause({ kind: 'http', status: 400 });
  lengths.push(Math.round(app.pausedFor() / SECOND));
  app.pauseUntilMono = null;
  app.startPause({ kind: 'server', status: 503, retryAfter: 100 * 3600 * SECOND });
  lengths.push(Math.round(app.pausedFor() / SECOND));
  app.pauseUntilMono = null;
  app.startPause({ kind: 'http', status: 400, retryAfter: 5 * SECOND });
  lengths.push(Math.round(app.pausedFor() / SECOND));
  assert.deepEqual(lengths, [120, 240, 480, 60, 120, 240, 60, 6 * 3600, 120]);
});

test('a 429 that arrives after a new configuration still pauses', async () => {
  let hold;
  const api = createApi((url, a) => {
    if (url.includes('/predictions') && !hold) {
      hold = true;
      return new Promise((resolve) => {
        a.clock.timers.setTimeout(() => resolve(errorAnswer(a, 429)), 5 * SECOND);
      });
    }
    return defaultWorld(url);
  });
  const store = createMemoryStore();
  const { app, wait } = await setup({ api, store });
  await app.start(HOME);
  await wait(4 * SECOND);
  // The request of the predictions is out; the configuration is saved again.
  await app.start({ ...HOME, refresh_seconds: 90 });
  await wait(10 * SECOND);
  assert.ok(app.pausedFor() > 60 * SECOND);
  assert.equal(store.data.pause.kind, 'rate');
  const before = api.count('predictions');
  await wait(MINUTE);
  assert.equal(api.count('predictions'), before, 'held by the pause');
});

test('a timer firing a little before the end of the interval never skips the round', async () => {
  const { begin, app, api, wait } = await setup();
  await begin();
  // Pretend the timer fires 1 ms early: the round is armed again, not skipped.
  app.nextDueMono += 1;
  await wait(40 * SECOND + 10);
  assert.equal(api.count('predictions'), 2);
});

test('a timer firing a little before the end of a pause never skips the round', async () => {
  let down = true;
  const api = createApi((url, a) =>
    url.includes('/predictions') && down ? errorAnswer(a, 503) : defaultWorld(url),
  );
  const { begin, app, wait } = await setup({ api });
  await begin();
  down = false;
  app.pauseUntilMono += 2;
  await wait(44 * SECOND);
  assert.equal(api.count('predictions'), 2);
});

test('an exception inside a round never leaves the app without a next round', async () => {
  const { begin, app, api, wait, lines } = await setup();
  await begin();
  const original = app.readDepartures.bind(app);
  let once = true;
  app.readDepartures = async (gen) => {
    if (once) {
      once = false;
      throw new TypeError('boom');
    }
    return original(gen);
  };
  await wait(2 * MINUTE);
  assert.ok(lines.some((l) => /Read failed \(TypeError\)/.test(l)));
  assert.ok(api.count('predictions') >= 2);
});

test('an unchanged configuration saved again never reads sooner', async () => {
  const { begin, app, api, wait } = await setup();
  await begin();
  for (let i = 0; i < 5; i += 1) await app.start(HOME);
  await wait(30 * SECOND);
  assert.equal(api.count('predictions'), 1);
  await wait(15 * SECOND);
  assert.equal(api.count('predictions'), 2);
});

test('a reconnection never reads sooner; getConfig failing is retried until it works', async () => {
  const { begin, app, gladys, api, wait, fake } = await setup();
  await begin();
  await app.disconnected();
  const original = gladys.getConfig.bind(gladys);
  let fails = 2;
  gladys.getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('Gladys busy');
    }
    return original();
  };
  const connecting = app.connected();
  await settle(10);
  assert.match(statusEn(fake), /could not be read from Gladys; next try in 5 s/);
  await wait(5 * SECOND);
  assert.match(statusEn(fake), /next try in 10 s/);
  await wait(10 * SECOND);
  await connecting;
  assert.equal(api.count('predictions'), 1, 'not read sooner than the interval');
  await wait(30 * SECOND);
  assert.equal(api.count('predictions'), 2);
});

test('after a disconnection nothing is read', async () => {
  const { begin, app, api, wait } = await setup();
  await begin();
  await app.disconnected();
  await wait(10 * MINUTE);
  assert.equal(api.count('predictions'), 1);
});

test('the rate limit running low holds the next request until the window resets', async () => {
  const api = createApi((url, a) => {
    if (url.includes('/stops')) {
      const reset = Math.ceil((a.clock.wall() + 40 * SECOND) / 1000);
      return json(defaultWorld(url), {
        date: a.clock.wall(),
        lastModified: a.clock.wall(),
        headers: { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(reset) },
      });
    }
    return defaultWorld(url);
  });
  const { app, wait } = await setup({ api });
  await app.start(HOME);
  await wait(30 * SECOND);
  assert.equal(api.count('predictions'), 0);
  await wait(15 * SECOND);
  assert.equal(api.count('predictions'), 1);
});

test('the alerts seen survive a restart: no scene event twice', async () => {
  const store = createMemoryStore();
  let list = [alertResource(1)];
  const world = (url) => (url.includes('/alerts') ? alertsDoc(list) : defaultWorld(url));
  {
    const { begin, app } = await setup({ store, api: createApi(world) });
    await begin();
    await app.stop();
  }
  list = [alertResource(1), alertResource(2, { created_at: '2026-10-30T02:00:00-04:00' })];
  {
    const { app, wait, fake } = await setup({
      store,
      api: createApi(world),
      start: CAPTURED_AT + 2 * MINUTE,
    });
    await app.start(HOME);
    await wait(30 * SECOND);
    assert.deepEqual(
      alertEvents(fake).map((e) => e.data.alert_id),
      ['2'],
    );
  }
  {
    const { app, wait, fake } = await setup({
      store,
      api: createApi(world),
      start: CAPTURED_AT + 4 * MINUTE,
    });
    await app.start(HOME);
    await wait(30 * SECOND);
    assert.equal(alertEvents(fake).length, 0);
  }
});

test('a changed stop starts a new baseline: no scene event for what is already there', async () => {
  const store = createMemoryStore();
  const world = (url) =>
    url.includes('/alerts') ? alertsDoc([alertResource(Math.random())]) : defaultWorld(url);
  const { begin, app, wait, fake } = await setup({ store, api: createApi(world) });
  await begin();
  await app.start({ watch1_stop: '1' });
  await wait(20 * SECOND);
  assert.equal(alertEvents(fake).length, 0);
});

test('the status stays within 1500 characters', async () => {
  const config = {};
  for (let slot = 1; slot <= 5; slot += 1) {
    config[`watch${slot}_stop`] = 'bogus-xyz';
    config[`watch${slot}_name`] = 'A'.repeat(60);
  }
  const { begin, fake } = await setup({ config });
  await begin();
  assert.ok([...fake.connectionStatus.message.en].length <= 1500);
  assert.ok([...fake.connectionStatus.message.fr].length <= 1500);
});

test('the published values only reach created devices', async () => {
  const { begin, fake } = await setup({ created: false });
  await begin();
  assert.deepEqual(published(fake, N(FEATURES.DEPARTURES)), []);
  assert.equal(fake.discoveredDevices.length, 1);
});

test('the capture fixture is what the tests think it is', () => {
  assert.equal(PREDICTIONS.body.data.length, 7);
  assert.equal(CAPTURED_AT, Date.parse('2026-10-30T06:03:08Z'));
});
