// -----------------------------------------------------------------------------
// The MBTA client: the request it sends, every kind of answer, and the strict
// reading of the resources (real captured answers and broken ones).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT, MAX_BODY_BYTES, MAX_ITEMS, REQUEST_TIMEOUT } from '../src/constants.js';
import {
  alertsUrl,
  getJson,
  predictionsUrl,
  readAlert,
  readAlerts,
  readDateTime,
  readHttpDate,
  readPredictions,
  readRate,
  readRetryAfter,
  readRoutesList,
  readStops,
  routesUrl,
  stopsUrl,
} from '../src/mbta.js';
import { testClock, settle } from './kit/clock.mjs';
import { ALERTS, PREDICTIONS, ROUTES, STOPS, alertResource, prediction } from './helpers/setup.js';

const DATE = 'Fri, 30 Oct 2026 06:03:08 GMT';
const AT = Date.parse(DATE);

function answer(body, { status = 200, headers = {} } = {}) {
  const text = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/vnd.api+json', date: DATE, ...headers },
  });
}

test('the URLs: filters and sparse fields, ids joined by commas', () => {
  const base = 'http://x';
  assert.equal(
    stopsUrl(['place-pktrm', '1'], base),
    'http://x/stops?filter%5Bid%5D=place-pktrm%2C1&fields%5Bstop%5D=name%2Cplatform_name%2Clocation_type%2Cvehicle_type',
  );
  assert.match(
    routesUrl('place-pktrm', base),
    /^http:\/\/x\/routes\?filter%5Bstop%5D=place-pktrm&/,
  );
  const p = new URL(predictionsUrl(['place-pktrm', '1'], base));
  assert.equal(p.searchParams.get('filter[stop]'), 'place-pktrm,1');
  assert.equal(p.searchParams.get('include'), 'stop,route,trip');
  const a = new URL(alertsUrl({ stop: '1', direction: 1 }, ['1', '47'], base));
  assert.equal(a.searchParams.get('filter[stop]'), '1');
  assert.equal(a.searchParams.get('filter[datetime]'), 'NOW');
  assert.equal(a.searchParams.get('filter[route]'), '1,47');
  assert.equal(a.searchParams.get('filter[direction_id]'), '1');
  const b = new URL(alertsUrl({ stop: '1', direction: null }, [], base));
  assert.equal(b.searchParams.get('filter[route]'), null);
  assert.equal(b.searchParams.get('filter[direction_id]'), null);
  assert.match(b.searchParams.get('fields[alert]'), /active_period/);
});

test('GET: the JSON:API Accept, an honest User-Agent, no redirect, If-Modified-Since', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init;
    return answer({ data: [] }, { headers: { 'last-modified': 'Fri, 30 Oct 2026 06:03:05 GMT' } });
  };
  const result = await getJson('http://x/a', {
    fetchImpl,
    ifModifiedSince: 'Fri, 30 Oct 2026 06:00:00 GMT',
  });
  assert.equal(seen.headers.Accept, ACCEPT);
  assert.equal(ACCEPT, 'application/vnd.api+json');
  assert.match(seen.headers['User-Agent'], /^gladys-mbta\//);
  assert.doesNotMatch(seen.headers['User-Agent'], /Mozilla/);
  assert.equal(seen.headers['If-Modified-Since'], 'Fri, 30 Oct 2026 06:00:00 GMT');
  assert.equal(seen.redirect, 'error');
  assert.equal(seen.method, 'GET');
  assert.equal(result.ok, true);
  assert.equal(result.serverDate, AT);
  assert.equal(result.lastModified, AT - 3000);
  assert.equal(result.lastModifiedText, 'Fri, 30 Oct 2026 06:03:05 GMT');
  await getJson('http://x/a', { fetchImpl });
  assert.equal(seen.headers['If-Modified-Since'], undefined);
});

test('GET: every kind of failure, never a throw', async () => {
  const run = (response) => getJson('http://x', { fetchImpl: async () => response });
  const rate = await run(
    answer('', {
      status: 429,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(AT / 1000 + 42) },
    }),
  );
  assert.deepEqual([rate.ok, rate.kind, rate.status, rate.retryAfter], [false, 'rate', 429, 42000]);
  const rateRetry = await run(answer('', { status: 429, headers: { 'retry-after': '90' } }));
  assert.equal(rateRetry.retryAfter, 90000);
  const server = await run(answer('', { status: 503, headers: { 'retry-after': '30' } }));
  assert.deepEqual([server.kind, server.status, server.retryAfter], ['server', 503, 30000]);
  assert.deepEqual([(await run(answer('Not acceptable', { status: 406 }))).kind], ['http']);
  const notModified = await run(answer(null, { status: 304 }));
  assert.equal(notModified.kind, 'http', 'a 304 without If-Modified-Since is unexpected');
  const html = await run(
    new Response('<html></html>', { headers: { 'content-type': 'text/html', date: DATE } }),
  );
  assert.equal(html.kind, 'format');
  assert.equal((await run(answer('{"data": ['))).kind, 'format');
  const big = await run(
    answer({ data: [] }, { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
  );
  assert.equal(big.kind, 'too_big');
  const network = await getJson('http://x', {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual([network.ok, network.kind], [false, 'network']);
});

test('GET: 304 to a conditional request', async () => {
  const result = await getJson('http://x', {
    fetchImpl: async () => answer(null, { status: 304 }),
    ifModifiedSince: DATE,
  });
  assert.deepEqual([result.ok, result.notModified], [true, true]);
});

test('GET: a body growing past the bound is cut before it is read in full', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 50) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const result = await getJson('http://x', {
    fetchImpl: async () =>
      new Response(stream, { headers: { 'content-type': 'application/vnd.api+json' } }),
  });
  assert.equal(result.kind, 'too_big');
  assert.ok(pulled <= MAX_BODY_BYTES / chunk.length + 3, `${pulled} chunks read`);
});

test('GET: a server that never answers times out', async () => {
  const clock = testClock();
  const pending = getJson('http://x', {
    timers: clock.timers,
    fetchImpl: (url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
      ),
  });
  await settle();
  await clock.advance(REQUEST_TIMEOUT);
  const result = await pending;
  assert.deepEqual([result.ok, result.kind], [false, 'timeout']);
});

test('dates: HTTP dates, Retry-After, the rate headers', () => {
  assert.equal(readHttpDate(DATE), AT);
  for (const bad of [
    '',
    'yesterday',
    '2026-10-30T06:03:08Z',
    null,
    'Fri, 30 Oct 2026 06:03:08 UTC',
  ]) {
    assert.equal(readHttpDate(bad), null, String(bad));
  }
  assert.equal(readRetryAfter('120', AT), 120000);
  assert.equal(readRetryAfter('Fri, 30 Oct 2026 06:04:08 GMT', AT), 60000);
  assert.equal(readRetryAfter('Fri, 30 Oct 2026 06:04:08 GMT', null), null);
  assert.equal(readRetryAfter('soon', AT), null);
  const headers = (h) => new Headers(h);
  assert.deepEqual(
    readRate(
      headers({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(AT / 1000 + 30) }),
      AT,
    ),
    { remaining: 3, resetIn: 30000 },
  );
  assert.deepEqual(readRate(headers({ 'x-ratelimit-remaining': '3' }), AT), {
    remaining: 3,
    resetIn: null,
  });
  // A reset in the past or more than 10 minutes ahead is not believed.
  assert.equal(
    readRate(
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(AT / 1000 - 5) }),
      AT,
    ).resetIn,
    null,
  );
  assert.equal(
    readRate(
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(AT / 1000 + 601) }),
      AT,
    ).resetIn,
    null,
  );
  assert.equal(
    readRate(
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(AT / 1000 + 600) }),
      AT,
    ).resetIn,
    600000,
  );
  assert.equal(readRate(headers({ 'x-ratelimit-remaining': 'many' }), AT), null);
  assert.equal(readRate(headers({}), AT), null);
});

test('API times: the offset is required and read exactly, impossible dates refused', () => {
  assert.equal(readDateTime('2026-10-30T02:12:05-04:00'), Date.parse('2026-10-30T06:12:05Z'));
  assert.equal(readDateTime('2026-11-01T01:30:00-05:00'), Date.parse('2026-11-01T06:30:00Z'));
  assert.equal(readDateTime('2026-11-01T01:30:00-04:00'), Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(readDateTime('2026-10-30T06:12:05Z'), Date.parse('2026-10-30T06:12:05Z'));
  assert.equal(readDateTime('2026-10-30T06:12:05.250+05:30'), Date.parse('2026-10-30T00:42:05Z'));
  for (const bad of [
    '2026-10-30T02:12:05',
    '2026-02-30T02:12:05-05:00',
    '2026-10-30T24:00:00-04:00',
    '2026-10-30T23:60:00-04:00',
    '2026-10-30T23:00:60-04:00',
    '2026-10-30 02:12:05-04:00',
    '',
    null,
    1793340000,
  ]) {
    assert.equal(readDateTime(bad), null, String(bad));
  }
});

test('the captured predictions: every prediction read, platforms mapped to their station', () => {
  const read = readPredictions(PREDICTIONS.body);
  assert.equal(read.predictions.length, 7);
  assert.equal(read.skipped, 0);
  const [first] = read.predictions;
  assert.equal(first.stop, '70199');
  assert.equal(first.route, 'Green-E');
  assert.equal(first.direction, 0);
  assert.equal(first.departure, Date.parse('2026-10-30T06:16:15Z'));
  assert.equal(first.relationship, 'ADDED');
  assert.equal(read.stops.get('70199').parent, 'place-pktrm');
  assert.equal(read.routes.get('Green-E').longName, 'Green Line E');
  assert.equal(read.trips.get(first.trip).headsign, 'Heath Street');
});

test('predictions: one that cannot be read refuses the whole answer', () => {
  const ok = prediction('a', { departure: AT + 60000 });
  const variants = {
    'no id': (p) => delete p.id,
    'not a prediction': (p) => (p.type = 'schedule'),
    'no route': (p) => delete p.relationships.route,
    'no stop': (p) => (p.relationships.stop.data = null),
    'stop id with a comma': (p) => (p.relationships.stop.data.id = 'a,b'),
    'direction 2': (p) => (p.attributes.direction_id = 2),
    'direction text': (p) => (p.attributes.direction_id = '0'),
    'departure unreadable': (p) => (p.attributes.departure_time = '2026-10-30T02:12:05'),
    'arrival unreadable': (p) => (p.attributes.arrival_time = 'soon'),
    'no attributes': (p) => delete p.attributes,
  };
  for (const [name, edit] of Object.entries(variants)) {
    const bad = structuredClone(ok);
    edit(bad);
    const read = readPredictions({ data: [ok, bad] });
    assert.deepEqual(read, { unreadable: true, skipped: 1 }, name);
  }
  // Null times are "none" (last stop, cancelled), not unreadable.
  const last = prediction('b', { departure: null });
  last.attributes.schedule_relationship = 'CANCELLED';
  const read = readPredictions({ data: [ok, last] });
  assert.equal(read.predictions.length, 2);
  assert.equal(read.predictions[1].departure, null);
  assert.equal(read.predictions[1].relationship, 'CANCELLED');
  // An unknown relationship is kept as such (not skipped, not cancelled).
  const odd = prediction('c', { departure: AT, relationship: 'DUPLICATED' });
  assert.equal(readPredictions({ data: [odd] }).predictions[0].relationship, 'UNKNOWN');
});

test('envelopes that are not a JSON:API list are refused', () => {
  const list = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => prediction(i, { departure: AT }));
  for (const body of [
    null,
    [],
    'x',
    { errors: [{ status: '400' }] },
    { data: [], errors: [] },
    { data: {} },
    { data: [], included: {} },
    { data: list },
  ]) {
    assert.equal(readPredictions(body), null, JSON.stringify(body)?.slice(0, 40));
    assert.equal(readAlerts(body), null);
    assert.equal(readStops(body), null);
    assert.equal(readRoutesList(body), null);
  }
  assert.equal(readPredictions({ data: list.slice(0, MAX_ITEMS) }).predictions.length, MAX_ITEMS);
});

test('the captured stops: name, station or not, an unknown id simply absent', () => {
  const stops = readStops(STOPS.body);
  assert.deepEqual([...stops.keys()], ['place-pktrm', '1', '70199']);
  assert.equal(stops.get('place-pktrm').station, true);
  assert.equal(stops.get('1').station, false);
  assert.equal(stops.get('70199').station, false);
  assert.equal(stops.get('70199').parent, 'place-pktrm');
  assert.equal(stops.has('bogus-xyz'), false);
  // An entry that cannot be read refuses the answer (never "unknown stop").
  const broken = structuredClone(STOPS.body);
  broken.data[1].attributes.name = '';
  assert.equal(readStops(broken), null);
  // A location type that is not there: read as a station (the stricter reading).
  const vague = structuredClone(STOPS.body);
  delete vague.data[1].attributes.location_type;
  assert.equal(readStops(vague).get('1').station, true);
});

test('the captured routes', () => {
  const routes = readRoutesList(ROUTES.body);
  assert.ok(routes.some((r) => r.id === 'Red' && r.longName === 'Red Line' && r.type === 1));
  const broken = structuredClone(ROUTES.body);
  broken.data[0].id = '';
  assert.equal(readRoutesList(broken), null);
});

test('the captured alerts: every alert read; one unreadable refuses the count', () => {
  const read = readAlerts(ALERTS.body);
  assert.equal(read.alerts.length, 4);
  const [first] = read.alerts;
  assert.equal(first.id, '1040762');
  assert.equal(first.severity, 8);
  assert.equal(first.effect, 'SCHEDULE_CHANGE');
  assert.equal(first.periods[0].start, Date.parse('2026-10-26T07:00:00Z'));
  assert.equal(first.periods[0].end, Date.parse('2026-11-02T08:00:00Z'));
  assert.deepEqual(
    readAlerts({
      data: [alertResource(1), { id: '2', type: 'alert', attributes: { header: '' } }],
    }),
    {
      unreadable: true,
    },
  );
});

test('an alert read strictly: bounded texts, odd values replaced, never invented', () => {
  const alert = readAlert(
    alertResource(9, {
      header: `  Line\u0007one\n${'x'.repeat(3000)}`,
      severity: 11,
      effect: 'weird effect',
      cause: null,
      url: 'javascript:alert(1)',
      active_period: [{ start: 'soon' }, { start: '2026-10-30T01:00:00-04:00', end: null }, 7],
    }),
  );
  assert.equal(alert.header.startsWith('Line one '), true);
  assert.equal([...alert.header].length, 2000);
  assert.equal(alert.severity, null);
  assert.equal(alert.effect, 'UNKNOWN_EFFECT');
  assert.equal(alert.cause, 'UNKNOWN_CAUSE');
  assert.equal(alert.url, '');
  assert.deepEqual(alert.periods, [{ start: Date.parse('2026-10-30T05:00:00Z'), end: null }]);
  assert.equal(readAlert(alertResource(1, { severity: 0 })).severity, 0);
  assert.equal(readAlert(alertResource(1, { severity: 10 })).severity, 10);
  assert.equal(readAlert(alertResource(1, { severity: 4.5 })).severity, null);
  assert.equal(readAlert({ ...alertResource(1), type: 'route' }), null);
});

test('GET: a JSON body sent as another type is refused', async () => {
  const result = await getJson('http://x', {
    fetchImpl: async () =>
      new Response('{"data": []}', { headers: { 'content-type': 'text/plain', date: DATE } }),
  });
  assert.equal(result.kind, 'format');
});
