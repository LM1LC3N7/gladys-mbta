// -----------------------------------------------------------------------------
// The fixed values of the integration: the MBTA V3 API, its pace, the bounds
// of what is read, and the keys shared with the manifest.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of the package (the release bumps it): the User-Agent follows. */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** The public MBTA V3 API (JSON:API), used without a key. */
export const API_BASE = 'https://api-v3.mbta.com';
/** The JSON:API media type: the API answers 406 to an Accept it does not serve. */
export const ACCEPT = 'application/vnd.api+json';

/** An honest User-Agent naming the integration, never a browser's. */
export const USER_AGENT = `gladys-mbta/${VERSION} (+https://github.com/LM1LC3N7/gladys-mbta)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/**
 * Without a key the API allows 20 requests per minute per address: 3 s at
 * least between the starts of two requests keeps under it whatever happens.
 */
export const REQUEST_GAP = 3 * SECOND;
/** One request never lasts longer (connection, answer and body). */
export const REQUEST_TIMEOUT = 20 * SECOND;
/** A body larger than this is cut before it is read in full (memory bound). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Items read per answer at most; a longer list is refused (never cut). */
export const MAX_ITEMS = 2000;
/**
 * When `x-ratelimit-remaining` falls to this, the next requests wait for
 * `x-ratelimit-reset` (bounded by RATE_HOLD_MAX).
 */
export const RATE_REMAINING_LOW = 2;
export const RATE_HOLD_MAX = 65 * SECOND;

/** The read interval of the departures, in seconds (config `refresh_seconds`). */
export const REFRESH_DEFAULT = 60;
export const REFRESH_MIN = 30;
export const REFRESH_MAX = 600;

/** The alerts are read every 5 minutes (a round within 5 s of it counts). */
export const ALERTS_INTERVAL = 5 * MINUTE;
export const ALERTS_SLACK = 5 * SECOND;
/** A failed alerts read is retried later, doubled, bounded. */
export const ALERTS_RETRY_MAX = HOUR;
/** A stop check (name, routes) that failed: retried 1 min later, doubled, bounded. */
export const CHECK_RETRY_FIRST = MINUTE;
export const CHECK_RETRY_MAX = 30 * MINUTE;
/** A stop the MBTA does not know is checked again after this. */
export const CHECK_MISSING_RETRY = 30 * MINUTE;

/** Pauses after a 429 (rate limit) and a 5xx, doubled each time, bounded. */
export const PAUSE_429_FIRST = 2 * MINUTE;
export const PAUSE_5XX_FIRST = MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;

/** `getConfig()` failing on a connection: retried forever, spaced out. */
export const CONFIG_RETRY_FIRST = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/**
 * The MBTA data behind an answer (its `Last-Modified`, refreshed every few
 * seconds on the live API) older than this, against the `Date` of the same
 * answer: the real-time feed is frozen, nothing is published.
 */
export const FEED_STALE = 10 * MINUTE;
/**
 * A server `Date` further than this from the local clock is not believed: the
 * local clock is wrong, or the answer is an old copy (a cache, a replay).
 * Nothing is published then. The latency of the answer fits in it.
 */
export const CLOCK_SKEW = 5 * MINUTE;
/** Departures counted on the counter: within this window. */
export const WINDOW_MINUTES = 60;
/** A departure further than this is ignored (an absurd time). */
export const HORIZON = 24 * HOUR;
/** A departure up to this much in the past is "leaving now" (0 min). */
export const LEAVING_GRACE = MINUTE;

/** Alert ids remembered per watch (scene trigger), and for how long. */
export const SEEN_MAX = 500;
export const SEEN_KEEP = 7 * 24 * HOUR;
/** Scene events fired per watch and per read, at most. */
export const SCENE_EVENTS_PER_READ = 10;

/** Watched stops (one Gladys device each). */
export const WATCH_SLOTS = [1, 2, 3, 4, 5];
export const ROUTES_MAX = 10;
export const NAME_MAX = 60;
export const ID_MAX = 64;
/** A stop or route id of the MBTA: letters, digits, `-` and `_` (no comma, dot, colon). */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const DIRECTIONS = Object.freeze(['both', '0', '1']);

/** Counters are bounded. */
export const COUNT_MAX = MAX_ITEMS;
/** The texts published on the device, in characters. */
export const SUMMARY_MAX = 600;
export const ALERT_TEXT_MAX = 600;
/** The texts handed to a scene (the core accepts 1000 characters). */
export const SCENE_TEXT_MAX = 900;

export const DEVICE_TYPE = 'watch';
export const FEATURES = Object.freeze({
  NEXT: 'next',
  SECOND: 'second',
  DEPARTURES: 'departures',
  SUMMARY: 'summary',
  ALERTS: 'alerts',
  ALERT_TEXT: 'alert_text',
});

export const ACTIONS = Object.freeze({ TEST: 'test' });
export const SCENE_TRIGGER = 'new_alert';
export const SOON_TRIGGER = 'departure_soon';
/** The thresholds of the "departure approaching" trigger, in minutes. */
export const SOON_THRESHOLDS = Object.freeze([1, 2, 3, 5, 10, 15]);
/** Departures remembered per watch for that trigger. */
export const SOON_MEMORY_MAX = 200;

/** The alert effects offered as a scene filter; any other is `OTHER`. */
export const ALERT_EFFECTS = Object.freeze([
  'DELAY',
  'SHUTTLE',
  'SUSPENSION',
  'DETOUR',
  'STOP_CLOSURE',
  'STATION_CLOSURE',
  'STOP_MOVE',
  'SERVICE_CHANGE',
  'SCHEDULE_CHANGE',
  'TRACK_CHANGE',
  'CANCELLATION',
  'SNOW_ROUTE',
  'OTHER',
]);
/** Severity bands of the scene filter: the MBTA severity runs from 0 to 10. */
export const SEVERITY_BANDS = Object.freeze(['severe', 'moderate', 'minor']);
export const severityBand = (severity) =>
  severity >= 7 ? 'severe' : severity >= 4 ? 'moderate' : 'minor';

/** The time zone of the MBTA (the times shown in the status and summaries). */
export const TIME_ZONE = 'America/New_York';

export const STATE_FILE = '/data/mbta-state.json';
