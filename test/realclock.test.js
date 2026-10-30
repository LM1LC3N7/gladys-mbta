// -----------------------------------------------------------------------------
// The app on the REAL moving clock (performance.now, Date.now, setTimeout)
// sped up 20 times, against a real local HTTP server playing the MBTA: the
// rounds really start at the interval (measured on the method that decides),
// two requests are 3 s apart, the timers stay bounded. The app is stopped in
// a `finally`: a failing test never leaves a process running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MbtaApp } from '../src/app.js';
import { ACCEPT, REQUEST_GAP } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { STOPS, alertsDoc, iso, prediction, predictionsDoc, F } from './helpers/setup.js';

const SPEED = 20;
const REFRESH = 30;

test('real clock x20: one round per interval, requests 3 s apart, bounded timers', async () => {
  const clock = realClock({ speed: SPEED });
  const requests = [];
  const sent = [];
  const server = createServer((req, res) => {
    requests.push({ at: clock.monotonic(), url: req.url, headers: req.headers });
    const now = Date.now();
    let body;
    if (req.url.startsWith('/stops')) body = STOPS.body;
    else if (req.url.startsWith('/alerts')) body = alertsDoc([]);
    else body = predictionsDoc([prediction('a', { departure: now + 5 * 60000 + 30000 })]);
    res.writeHead(200, {
      'content-type': 'application/vnd.api+json; charset=utf-8',
      date: new Date(now).toUTCString(),
      'last-modified': new Date(now - 2000).toUTCString(),
    });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = { watch1_stop: 'place-pktrm', refresh_seconds: REFRESH };
  const gladys = createFakeGladys({ selector: 'mbta', config });
  await gladys.connect();
  const quiet = () => {};
  const app = new MbtaApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    apiBase: `http://127.0.0.1:${server.address().port}`,
    // The time each request leaves (the server's view is blurred by latency x20).
    fetchImpl: (url, init) => {
      sent.push(clock.monotonic());
      return fetch(url, init);
    },
  });
  const spy = spyOn(app, 'round', clock);
  try {
    await app.start(config);
    const gaps = await measurePeriod(spy, { count: 3, period: REFRESH * 1000 });
    assert.equal(gaps.length, 2);
  } finally {
    await app.stop();
    clock.close();
    spy.restore();
    await new Promise((resolve) => server.close(resolve));
  }
  // Round 1: stops, predictions, alerts; rounds 2 and 3: predictions (the last may be cut by the stop).
  assert.ok(requests.length >= 4, `${requests.length} requests`);
  assert.ok(sent.length >= requests.length);
  for (let i = 1; i < sent.length; i += 1) {
    const gap = sent[i] - sent[i - 1];
    // The exact 3 s is tested on the virtual clock; here the event loop blurs it x20.
    assert.ok(gap >= 0.9 * REQUEST_GAP, `gap ${Math.round(gap)} ms`);
  }
  assert.equal(requests[0].headers.accept, ACCEPT);
  assert.match(requests[0].headers['user-agent'], /^gladys-mbta\//);
  assert.ok(requests.some((r) => r.url.startsWith('/predictions?filter%5Bstop%5D=place-pktrm')));
  assert.ok(clock.timersSet < 60, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(iso(Date.parse('2026-10-30T12:00:00Z')), '2026-10-30T08:00:00-04:00');
  const states = gladys.fake.states.filter(
    (s) => s.device_feature_external_id === F(1, 'departures'),
  );
  // No device created in this fake Gladys: nothing published, the status tells.
  assert.equal(states.length, 0);
});
