// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted MBTA and a virtual clock
// (gladys-testkit `testClock`: each clock read moves 1 µs, timers fire only
// through `advance`). The MBTA answers through a `world(url, api, call)`
// function: a JSON body (200, dated by the virtual clock with a fresh
// `Last-Modified`), a Response, 'timeout' (never answers), 'network'
// (refused), or a promise of one of them (a slow answer).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MbtaApp } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevices } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { settle, testClock } from '../kit/clock.mjs';

export const SELECTOR = 'mbta';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

/** Answers captured on the live API on 2026-10-30 (trimmed, alert texts replaced). */
export const PREDICTIONS = fixture('predictions-park-street');
export const ALERTS = fixture('alerts');
export const STOPS = fixture('stops');
export const ROUTES = fixture('routes-park-street');

/** The time of the predictions capture (its `Date` header). */
export const CAPTURED_AT = Date.parse(PREDICTIONS.date);

export const HOME = { watch1_stop: 'place-pktrm' };
export const TWO = { watch1_stop: 'place-pktrm', watch2_stop: '1', watch2_name: 'Bus home' };

/** The time `begin` lets the first round run: 6 requests 3 s apart fit. */
export const BEGIN = 20 * SECOND;

export const F = (slot, key) => `ext:${SELECTOR}:watch:${slot}:${key}`;

/** An ISO time with the Boston offset of the capture (EDT). */
export const iso = (ms) => {
  const local = new Date(ms - 4 * HOUR).toISOString().slice(0, 19);
  return `${local}-04:00`;
};

/** A prediction resource as the API sends it. */
export function prediction(id, over = {}) {
  const {
    stop = '70075',
    route = 'Red',
    trip = `trip-${id}`,
    departure,
    arrival = departure,
    direction = 0,
    relationship = null,
    status = null,
  } = over;
  return {
    attributes: {
      arrival_time: arrival === null ? null : iso(arrival),
      departure_time: departure === null ? null : iso(departure),
      direction_id: direction,
      schedule_relationship: relationship,
      status,
    },
    id: `prediction-${id}`,
    relationships: {
      route: { data: { id: route, type: 'route' } },
      stop: { data: { id: stop, type: 'stop' } },
      trip: { data: { id: trip, type: 'trip' } },
      vehicle: { data: null },
    },
    type: 'prediction',
  };
}

export const stopResource = (id, parent = null, name = 'Park Street', platform = null) => ({
  attributes: { name, platform_name: platform },
  id,
  relationships: { parent_station: { data: parent ? { id: parent, type: 'stop' } : null } },
  type: 'stop',
});
export const routeResource = (id, attrs = {}) => ({
  attributes: {
    direction_destinations: ['Ashmont/Braintree', 'Alewife'],
    long_name: 'Red Line',
    short_name: '',
    type: 1,
    ...attrs,
  },
  id,
  type: 'route',
});
export const tripResource = (id, headsign) => ({ attributes: { headsign }, id, type: 'trip' });

/** A predictions document: the Red Line platforms of Park Street by default. */
export function predictionsDoc(data, included = defaultIncluded()) {
  return { data, included, jsonapi: { version: '1.0' } };
}
export const defaultIncluded = () => [
  stopResource('70075', 'place-pktrm', 'Park Street', 'Ashmont/Braintree'),
  stopResource('70076', 'place-pktrm', 'Park Street', 'Alewife'),
  routeResource('Red'),
];

export function alertResource(id, over = {}) {
  return {
    attributes: {
      active_period: [{ start: '2026-10-30T01:00:00-04:00', end: null }],
      cause: 'UNKNOWN_CAUSE',
      created_at: '2026-10-30T01:00:00-04:00',
      description: null,
      effect: 'DELAY',
      header: `Synthetic alert ${id}.`,
      lifecycle: 'NEW',
      severity: 5,
      short_header: '',
      timeframe: '',
      updated_at: '2026-10-30T01:30:00-04:00',
      url: null,
      ...over,
    },
    id: String(id),
    type: 'alert',
  };
}
export const alertsDoc = (data) => ({ data, jsonapi: { version: '1.0' } });

export function json(body, { status = 200, date, lastModified, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/vnd.api+json; charset=utf-8',
      ...(date === null ? {} : { date: new Date(date).toUTCString() }),
      ...(lastModified === null || lastModified === undefined
        ? {}
        : { 'last-modified': new Date(lastModified).toUTCString() }),
      ...headers,
    },
  });
}

/** A dated JSON:API answer: `Date` now, `Last-Modified` 3 s before. */
export const fresh = (api, body, extra = {}) =>
  json(body, { date: api.clock.wall(), lastModified: api.clock.wall() - 3 * SECOND, ...extra });

export const errorAnswer = (api, status, headers = {}) =>
  json(
    { errors: [{ status: String(status), code: 'error' }], jsonapi: { version: '1.0' } },
    { status, date: api.clock.wall(), headers },
  );

const abortable = (signal, kind) =>
  new Promise((_, reject) => {
    if (kind === 'network') reject(new TypeError('fetch failed'));
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

/** The path of a request: `predictions`, `alerts`, `stops`, `routes`. */
export const kindOf = (url) => new URL(url).pathname.slice(1);

/** The default MBTA: the captured answers. */
export function defaultWorld(url) {
  switch (kindOf(url)) {
    case 'stops':
      return STOPS.body;
    case 'routes':
      return ROUTES.body;
    case 'predictions':
      return PREDICTIONS.body;
    case 'alerts':
      return alertsDoc([]);
    default:
      return 'network';
  }
}

/** A scripted MBTA: every request is recorded with the virtual time. */
export function createApi(world = defaultWorld) {
  const api = { world, calls: [], open: 0, peak: 0, clock: null };
  api.fetch = async (url, init) => {
    const call = {
      url: String(url),
      kind: kindOf(String(url)),
      init,
      at: api.clock.elapsed,
      wall: api.clock.wall(),
    };
    api.calls.push(call);
    api.open += 1;
    api.peak = Math.max(api.peak, api.open);
    try {
      const answer = await api.world(call.url, api, call);
      if (answer === 'timeout' || answer === 'network')
        return await abortable(init?.signal, answer);
      if (answer instanceof Response) return answer;
      return fresh(api, answer);
    } finally {
      api.open -= 1;
    }
  };
  api.count = (kind) => api.calls.filter((c) => c.kind === kind).length;
  return api;
}

/** The devices of a configuration as created by the user in Gladys. */
export function createdDevices(config) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevices(gladys, normalizeConfig(config));
}

export async function setup({
  config = HOME,
  devices,
  store = createMemoryStore(),
  api = createApi(),
  created = true,
  start = CAPTURED_AT,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: devices ?? (created ? createdDevices(config) : []),
  });
  await gladys.connect();
  const clock = testClock({ start });
  clock.wall = () => clock.now() + wall.offset;
  api.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new MbtaApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.wall(),
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: api.fetch,
  });
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  /** Starts and lets the first round end (its requests are 3 s apart). */
  const begin = async (cfg = config) => {
    await app.start(cfg);
    await wait(0);
    await wait(BEGIN);
  };
  return { app, gladys, fake: gladys.fake, clock, store, api, wait, begin, lines, wall };
}

/** The values published for a feature, in order. */
export const published = (fake, id) =>
  fake.states
    .filter((s) => s.device_feature_external_id === id)
    .map((s) => (s.text !== undefined ? s.text : s.state));

/** The status message in English. */
export const statusEn = (fake) => fake.connectionStatus?.message?.en ?? '';
