// -----------------------------------------------------------------------------
// The MBTA V3 API: one GET with the JSON:API `Accept` it requires (it answers
// 406 to anything else), an honest User-Agent, `If-Modified-Since`, a bounded
// time and a bounded body (cut before it is read in full); then each resource
// read strictly into a small object. Nothing here retries, waits or keeps
// state: the app paces the requests and decides.
//
// Format, as documented on https://api-v3.mbta.com/docs/swagger and checked
// on the live API (2026-10-30): times carry their offset
// (`2026-10-30T02:12:05-04:00`); `departure_time` is null at the last stop of
// a trip (nobody boards there); `Last-Modified` is the time of the MBTA data
// behind the answer and moves every few seconds, even for an empty list; the
// rate limit headers are `x-ratelimit-limit` (20 without a key),
// `x-ratelimit-remaining` and `x-ratelimit-reset` (Unix seconds); a request
// without any filter answers 400 with a JSON:API `errors` list.
// -----------------------------------------------------------------------------

import {
  ACCEPT,
  API_BASE,
  MAX_BODY_BYTES,
  MAX_ITEMS,
  PAUSE_MAX,
  REQUEST_TIMEOUT,
  USER_AGENT,
} from './constants.js';

const RETRY_AFTER_MAX_SECONDS = PAUSE_MAX / 1000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const TEXT_MAX = 2000;

const url = (base, path, params) => `${base}${path}?${new URLSearchParams(params)}`;

/** The stops of the watches, by id (name, platform, parent station). */
export function stopsUrl(ids, base = API_BASE) {
  return url(base, '/stops', {
    'filter[id]': ids.join(','),
    'fields[stop]': 'name,platform_name,location_type,vehicle_type',
  });
}

/** The routes calling at one stop (to check a route filter). */
export function routesUrl(stop, base = API_BASE) {
  return url(base, '/routes', {
    'filter[stop]': stop,
    'fields[route]': 'short_name,long_name,type,direction_destinations',
  });
}

/** Every prediction at the stops of the watches, with what labels them. */
export function predictionsUrl(stops, base = API_BASE) {
  return url(base, '/predictions', {
    'filter[stop]': stops.join(','),
    include: 'stop,route,trip',
    'fields[prediction]': 'arrival_time,departure_time,direction_id,schedule_relationship,status',
    'fields[stop]': 'name,platform_name',
    'fields[route]': 'short_name,long_name,type,direction_destinations',
    'fields[trip]': 'headsign',
  });
}

/** The alerts in effect now at a stop, for its routes and direction if set. */
export function alertsUrl(watch, routeIds, base = API_BASE) {
  const params = { 'filter[stop]': watch.stop, 'filter[datetime]': 'NOW' };
  if (routeIds.length > 0) params['filter[route]'] = routeIds.join(',');
  if (watch.direction !== null) params['filter[direction_id]'] = String(watch.direction);
  params['fields[alert]'] =
    'header,short_header,description,effect,severity,cause,lifecycle,timeframe,url,created_at,updated_at,active_period';
  return url(base, '/alerts', params);
}

/**
 * One GET. Resolves `{ ok: true, json, serverDate, lastModified, rate }`,
 * `{ ok: true, notModified: true, ... }` (304), or `{ ok: false, kind,
 * status?, retryAfter?, serverDate, rate }`, `kind` among `network`,
 * `timeout`, `rate` (429), `server` (5xx), `http` (other status), `format`,
 * `too_big`. Never throws.
 */
export async function getJson(
  target,
  { fetchImpl = fetch, timers = globalThis, ifModifiedSince = null } = {},
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  const headers = { Accept: ACCEPT, 'User-Agent': USER_AGENT };
  if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;
  let response;
  try {
    response = await fetchImpl(target, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    timers.clearTimeout(timer);
    return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate: null, rate: null };
  }
  const serverDate = readHttpDate(response.headers.get('date'));
  const rate = readRate(response.headers, serverDate);
  const lastModifiedText = response.headers.get('last-modified');
  const lastModified = readHttpDate(lastModifiedText);
  const base = { serverDate, rate };
  try {
    if (response.status === 429) {
      const retryAfter =
        readRetryAfter(response.headers.get('retry-after'), serverDate) ?? rate?.resetIn ?? null;
      return { ok: false, kind: 'rate', status: 429, retryAfter, ...base };
    }
    if (response.status >= 500) {
      return {
        ok: false,
        kind: 'server',
        status: response.status,
        retryAfter: readRetryAfter(response.headers.get('retry-after'), serverDate),
        ...base,
      };
    }
    if (response.status === 304 && ifModifiedSince) {
      return { ok: true, notModified: true, lastModified, lastModifiedText, ...base };
    }
    if (response.status !== 200) {
      return { ok: false, kind: 'http', status: response.status, ...base };
    }
    const type = response.headers.get('content-type') ?? '';
    if (!/\bjson\b/i.test(type)) return { ok: false, kind: 'format', status: 200, ...base };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { ok: false, kind: 'too_big', status: 200, ...base };
    }
    const text = await readBounded(response);
    if (text === null) return { ok: false, kind: 'too_big', status: 200, ...base };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, kind: 'format', status: 200, ...base };
    }
    return { ok: true, json, lastModified, lastModifiedText, ...base };
  } catch {
    return { ok: false, kind: timedOut ? 'timeout' : 'network', ...base };
  } finally {
    timers.clearTimeout(timer);
    // A body left unread is released, never kept open.
    response.body?.cancel?.().catch?.(() => {});
  }
}

/** The body as text, or `null` past `max` bytes (the rest never read). */
async function readBounded(response, max = MAX_BODY_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/** An HTTP date (`Fri, 30 Oct 2026 06:00:01 GMT`) in ms, or `null`. */
export function readHttpDate(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `Retry-After` in ms (seconds or an HTTP date read against the server's). */
export function readRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // Any number of digits: a huge value is a long pause, bounded to 6 h here.
  if (/^\d+$/.test(text)) return Math.min(Number(text), RETRY_AFTER_MAX_SECONDS) * 1000;
  const at = readHttpDate(text);
  if (at !== null && serverDate !== null) return Math.max(0, at - serverDate);
  return null;
}

/**
 * The rate limit headers: `{ remaining, resetIn }` (ms until the window
 * resets, read against the server `Date`), or `null` when absent or unreadable.
 */
export function readRate(headers, serverDate) {
  const remainingText = headers.get('x-ratelimit-remaining');
  const resetText = headers.get('x-ratelimit-reset');
  if (typeof remainingText !== 'string' || !/^\d{1,7}$/.test(remainingText.trim())) return null;
  const remaining = Number(remainingText.trim());
  let resetIn = null;
  if (serverDate !== null && typeof resetText === 'string' && /^\d{9,11}$/.test(resetText.trim())) {
    const delta = Number(resetText.trim()) * 1000 - serverDate;
    if (delta >= 0 && delta <= 10 * 60 * 1000) resetIn = delta;
  }
  return { remaining, resetIn };
}

/**
 * A time of the API with its offset, in ms, or `null`. A time without offset
 * is refused: the MBTA always sends one, a time without it cannot be placed.
 */
export function readDateTime(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // An impossible date (February 30, 24:00) does not come back the same.
  if (new Date(utc).toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${s}`) return null;
  const sign = zone[0] === '-' ? -1 : 1;
  const offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60000;
  return utc - offset;
}

/** A text from the API, bounded, without control bytes; `''` when absent. */
export function readString(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\s,]/.test(value);
const relation = (resource, name) => {
  const data = resource.relationships?.[name]?.data;
  return isObject(data) && isId(data.id) ? data.id : null;
};

/**
 * The resources of a JSON:API document (`data` must be a list), or `null`
 * when the envelope is not one: an `errors` document, an HTML page, a list
 * longer than MAX_ITEMS (never cut: a cut list would miss departures).
 */
function readDocument(json) {
  if (!isObject(json) || 'errors' in json) return null;
  if (!Array.isArray(json.data) || json.data.length > MAX_ITEMS) return null;
  const included = json.included === undefined ? [] : json.included;
  if (!Array.isArray(included) || included.length > MAX_ITEMS) return null;
  return { data: json.data, included };
}

/**
 * The stops of a `/stops` answer: `Map(id -> { name, platform, parent, station })`,
 * or `null`. An entry that cannot be read makes the whole answer unreadable
 * (a stop not listed means "unknown to the MBTA": never guessed).
 */
export function readStops(json) {
  const doc = readDocument(json);
  if (!doc) return null;
  const stops = new Map();
  for (const item of doc.data) {
    if (!isObject(item) || item.type !== 'stop' || !isId(item.id)) return null;
    const name = readString(item.attributes?.name, 120);
    if (!name) return null;
    stops.set(item.id, {
      name,
      platform: readString(item.attributes?.platform_name, 120),
      parent: relation(item, 'parent_station'),
      // A station groups platforms: its predictions name the platforms.
      // Unknown location type: taken as a station (the stricter reading).
      station: item.attributes?.location_type !== 0,
    });
  }
  return stops;
}

function readRoute(item) {
  if (!isObject(item) || item.type !== 'route' || !isId(item.id)) return null;
  const a = isObject(item.attributes) ? item.attributes : {};
  const destinations = Array.isArray(a.direction_destinations)
    ? a.direction_destinations.slice(0, 2).map((d) => readString(d, 80))
    : [];
  return {
    id: item.id,
    shortName: readString(a.short_name, 40),
    longName: readString(a.long_name, 120),
    type: Number.isInteger(a.type) ? a.type : null,
    destinations,
  };
}

/** The routes of a `/routes` answer, or `null` when one cannot be read. */
export function readRoutesList(json) {
  const doc = readDocument(json);
  if (!doc) return null;
  const routes = [];
  for (const item of doc.data) {
    const route = readRoute(item);
    if (!route) return null;
    routes.push(route);
  }
  return routes;
}

const RELATIONSHIPS = ['SCHEDULED', 'ADDED', 'UNSCHEDULED', 'CANCELLED', 'SKIPPED', 'NO_DATA'];

/** One prediction, or `null` when it lacks what identifies or places it. */
export function readPrediction(item) {
  if (!isObject(item) || item.type !== 'prediction' || !isId(item.id)) return null;
  const a = item.attributes;
  if (!isObject(a)) return null;
  const route = relation(item, 'route');
  const stop = relation(item, 'stop');
  if (!route || !stop) return null;
  if (a.direction_id !== 0 && a.direction_id !== 1) return null;
  // A time that is there must be readable; null is "none" (last stop).
  const time = (value) => (value === null || value === undefined ? null : readDateTime(value));
  const departure = time(a.departure_time);
  const arrival = time(a.arrival_time);
  if (departure === null && a.departure_time != null) return null;
  if (arrival === null && a.arrival_time != null) return null;
  const relationship =
    a.schedule_relationship === null || a.schedule_relationship === undefined
      ? 'SCHEDULED'
      : RELATIONSHIPS.includes(a.schedule_relationship)
        ? a.schedule_relationship
        : 'UNKNOWN';
  return {
    id: item.id,
    route,
    stop,
    trip: relation(item, 'trip'),
    direction: a.direction_id,
    departure,
    arrival,
    relationship,
    status: readString(a.status, 120),
  };
}

/**
 * A `/predictions` answer: `{ predictions, skipped, stops, routes, trips }`
 * (the included resources by id), `{ unreadable, skipped }` when any
 * prediction cannot be read (never "no departure"), or `null`
 * when the envelope is not a JSON:API list.
 */
export function readPredictions(json) {
  const doc = readDocument(json);
  if (!doc) return null;
  const predictions = [];
  let skipped = 0;
  for (const item of doc.data) {
    const prediction = readPrediction(item);
    if (prediction) predictions.push(prediction);
    else skipped += 1;
  }
  // One prediction that cannot be read could be the next departure of a
  // watch: the whole answer is refused rather than published short.
  if (skipped > 0) return { unreadable: true, skipped };
  const stops = new Map();
  const routes = new Map();
  const trips = new Map();
  for (const item of doc.included) {
    if (!isObject(item) || !isId(item.id)) continue;
    if (item.type === 'stop') {
      stops.set(item.id, {
        name: readString(item.attributes?.name, 120),
        platform: readString(item.attributes?.platform_name, 120),
        parent: relation(item, 'parent_station'),
      });
    } else if (item.type === 'route') {
      const route = readRoute(item);
      if (route) routes.set(item.id, route);
    } else if (item.type === 'trip') {
      trips.set(item.id, { headsign: readString(item.attributes?.headsign, 120) });
    }
  }
  return { predictions, skipped, stops, routes, trips };
}

/** One alert, or `null` when it lacks its id or its text. */
export function readAlert(item) {
  if (!isObject(item) || item.type !== 'alert' || !isId(item.id)) return null;
  const a = item.attributes;
  if (!isObject(a)) return null;
  const header = readString(a.header);
  if (!header) return null;
  const severity =
    Number.isInteger(a.severity) && a.severity >= 0 && a.severity <= 10 ? a.severity : null;
  return {
    id: item.id,
    header,
    shortHeader: readString(a.short_header, 400),
    description: readString(a.description),
    effect: /^[A-Z_]{1,40}$/.test(a.effect ?? '') ? a.effect : 'UNKNOWN_EFFECT',
    severity,
    cause: /^[A-Z_]{1,40}$/.test(a.cause ?? '') ? a.cause : 'UNKNOWN_CAUSE',
    lifecycle: /^[A-Z_]{1,40}$/.test(a.lifecycle ?? '') ? a.lifecycle : 'UNKNOWN',
    timeframe: readString(a.timeframe, 200),
    url: /^https:\/\/[^\s]{1,400}$/.test(a.url ?? '') ? a.url : '',
    created: readDateTime(a.created_at),
    updated: readDateTime(a.updated_at),
    periods: readPeriods(a.active_period),
  };
}

/** The active periods of an alert: `[{ start, end }]` (`end` null when open). */
function readPeriods(value) {
  if (!Array.isArray(value)) return [];
  const periods = [];
  for (const period of value.slice(0, 50)) {
    if (!isObject(period)) continue;
    const start = readDateTime(period.start);
    if (start === null) continue;
    const end = period.end === null || period.end === undefined ? null : readDateTime(period.end);
    periods.push({ start, end });
  }
  return periods;
}

/**
 * An `/alerts` answer: `{ alerts }`, `{ unreadable }` when an alert cannot be
 * read (a count missing one would be wrong), or `null` (not a JSON:API list).
 */
export function readAlerts(json) {
  const doc = readDocument(json);
  if (!doc) return null;
  const alerts = [];
  for (const item of doc.data) {
    const alert = readAlert(item);
    if (!alert) return { unreadable: true };
    alerts.push(alert);
  }
  return { alerts };
}
