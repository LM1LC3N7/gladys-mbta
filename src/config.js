// -----------------------------------------------------------------------------
// The configuration filled in by the user, read strictly: an empty field is
// absent (never 0), a number is a plain decimal, an id holds only the
// characters the MBTA uses in its ids. A refused field is named by its key,
// never echoed back.
// -----------------------------------------------------------------------------

import {
  DIRECTIONS,
  ID_PATTERN,
  NAME_MAX,
  REFRESH_DEFAULT,
  REFRESH_MAX,
  REFRESH_MIN,
  ROUTES_MAX,
  WATCH_SLOTS,
} from './constants.js';

export const LANGUAGES = ['en', 'fr'];

// Any control character (C0, DEL, C1): never in a name or an id.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The keys of the fields of a watched stop (manifest `config_schema`). */
export const watchKeys = (slot) => ({
  name: `watch${slot}_name`,
  stop: `watch${slot}_stop`,
  routes: `watch${slot}_routes`,
  direction: `watch${slot}_direction`,
});

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * A number typed by the user: `null` when blank, `NaN` when not a plain
 * decimal (`Number('')` is 0, `Number('1e3')` 1000: both refused here).
 */
export function readNumber(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  return /^[-+]?\d{1,6}(\.\d{1,6})?$/.test(text) ? Number(text) : NaN;
}

/** A free text: `null` when blank, `undefined` when refused (control byte). */
function readText(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' || CONTROL.test(value)) return undefined;
  return value.trim().replace(/\s+/g, ' ');
}

/** An MBTA id: `null` when blank, `undefined` when refused. */
export function readId(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return ID_PATTERN.test(id) ? id : undefined;
}

/** Route ids or names, comma or semicolon separated, unique, bounded. */
export function readRoutes(value) {
  if (isBlank(value)) return { routes: [] };
  if (typeof value !== 'string' || CONTROL.test(value)) return { error: 'routes_invalid' };
  const routes = [];
  const seen = new Set();
  for (const part of value.split(/[,;]/)) {
    const route = part.trim();
    if (!route) continue;
    if (!ID_PATTERN.test(route)) return { error: 'routes_invalid' };
    const key = route.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(route);
  }
  if (routes.length > ROUTES_MAX) return { error: 'routes_too_many' };
  return { routes };
}

function readWatch(raw, slot) {
  const keys = watchKeys(slot);
  const stop = readId(raw[keys.stop]);
  if (stop === null) {
    // An empty slot is off; the first one is required.
    return slot === 1 ? { errors: [{ slot, field: keys.stop, code: 'required' }] } : {};
  }
  const errors = [];
  if (stop === undefined) errors.push({ slot, field: keys.stop, code: 'id_invalid' });
  const routes = readRoutes(raw[keys.routes]);
  if (routes.error) errors.push({ slot, field: keys.routes, code: routes.error });
  const rawDirection = isBlank(raw[keys.direction]) ? 'both' : String(raw[keys.direction]).trim();
  if (!DIRECTIONS.includes(rawDirection)) {
    errors.push({ slot, field: keys.direction, code: 'direction' });
  }
  const name = readText(raw[keys.name]);
  if (name === undefined || (name && [...name].length > NAME_MAX)) {
    errors.push({ slot, field: keys.name, code: 'name_invalid' });
  }
  if (errors.length > 0) return { errors };
  return {
    watch: {
      slot,
      name: name || null,
      stop,
      routes: routes.routes,
      direction: rawDirection === 'both' ? null : Number(rawDirection),
    },
    errors: [],
  };
}

/**
 * The configuration the app runs with. `watches` holds the valid ones only;
 * `errors` names each refused field (never its value).
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const language = LANGUAGES.includes(source.language) ? source.language : 'en';
  let refreshSeconds = readNumber(source.refresh_seconds);
  if (refreshSeconds === null) refreshSeconds = REFRESH_DEFAULT;
  if (
    Number.isNaN(refreshSeconds) ||
    !Number.isInteger(refreshSeconds) ||
    refreshSeconds < REFRESH_MIN ||
    refreshSeconds > REFRESH_MAX
  ) {
    errors.push({ slot: null, field: 'refresh_seconds', code: 'refresh' });
    refreshSeconds = REFRESH_DEFAULT;
  }
  const watches = [];
  for (const slot of WATCH_SLOTS) {
    const result = readWatch(source, slot);
    if (result.watch) watches.push(result.watch);
    errors.push(...(result.errors ?? []));
  }
  return { language, refreshSeconds, watches, errors };
}
