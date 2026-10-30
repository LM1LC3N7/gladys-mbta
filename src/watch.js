// -----------------------------------------------------------------------------
// What a watched stop sees: its departures in a predictions answer (the
// stop, its platforms when it is a station, its routes and direction), the
// minutes to wait counted against the server time of the answer, and the
// texts of the device. Pure functions, no clock read.
// -----------------------------------------------------------------------------

import {
  ALERT_EFFECTS,
  ALERT_TEXT_MAX,
  HORIZON,
  LEAVING_GRACE,
  MINUTE,
  SUMMARY_MAX,
  WINDOW_MINUTES,
  severityBand,
} from './constants.js';
import { formatClock, t } from './i18n.js';

const SKIP = new Set(['CANCELLED', 'SKIPPED']);

/** The label of a route: the number of a bus, the name of a line. */
export function routeLabel(route, id) {
  if (!route) return id;
  if (route.type === 3) return route.shortName || route.longName || id;
  return route.longName || route.shortName || id;
}

/**
 * The departures of a watch in a predictions answer read at `at` (server
 * time, ms): `{ ok: true, departures }` sorted by time, or `{ ok: false,
 * kind: 'incomplete' }` when a prediction cannot be placed (its platform is
 * missing from the answer while the watch may be its station).
 *
 * `station`: true, false, or null when the stop was not checked yet (then
 * read as a station: the stricter reading). `routeIds`: the route filter,
 * resolved to MBTA ids (empty: every route).
 */
export function departuresFor(watch, read, at, { station = null, routeIds = [] } = {}) {
  const routes = new Set(routeIds);
  const departures = [];
  for (const p of read.predictions) {
    let belongs = p.stop === watch.stop;
    if (!belongs && station !== false) {
      const platform = read.stops.get(p.stop);
      if (!platform) return { ok: false, kind: 'incomplete' };
      belongs = platform.parent === watch.stop;
    }
    if (!belongs) continue;
    if (routes.size > 0 && !routes.has(p.route)) continue;
    if (watch.direction !== null && p.direction !== watch.direction) continue;
    if (SKIP.has(p.relationship)) continue;
    // No departure time: the last stop of the trip, nobody boards there.
    if (p.departure === null) continue;
    const ahead = p.departure - at;
    if (ahead < -LEAVING_GRACE || ahead > HORIZON) continue;
    const route = read.routes.get(p.route);
    const headsign = read.trips.get(p.trip)?.headsign || route?.destinations?.[p.direction] || '';
    departures.push({
      id: p.id,
      at: p.departure,
      minutes: Math.max(0, Math.floor(ahead / MINUTE)),
      route: p.route,
      label: routeLabel(route, p.route),
      headsign,
    });
  }
  departures.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  return { ok: true, departures };
}

/** The departures counted on the counter: within the next 60 minutes. */
export const countWithin = (departures) =>
  departures.filter((d) => d.minutes < WINDOW_MINUTES).length;

const bound = (text, max) => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

/**
 * The summary text: the read time (so that a summary left behind by a
 * failed read shows its age), then the departures by route and headsign:
 * `"02:05 · Red Line → Ashmont 3, 9 min · 1 → Harvard 12 min"`.
 */
export function summary(departures, at, language) {
  const head = formatClock(at);
  if (departures.length === 0) return `${head} · ${t(language, 'noDeparture')}`;
  const shown = departures.filter((d) => d.minutes < WINDOW_MINUTES);
  if (shown.length === 0) {
    const first = departures[0];
    return bound(
      `${head} · ${t(language, 'nextIn', { label: groupLabel(first), minutes: first.minutes })}`,
      SUMMARY_MAX,
    );
  }
  const groups = new Map();
  for (const d of shown) {
    const key = `${d.route}\u0000${d.headsign}`;
    if (!groups.has(key)) groups.set(key, { label: groupLabel(d), minutes: [] });
    const group = groups.get(key);
    if (group.minutes.length < 3) group.minutes.push(d.minutes);
  }
  const parts = [...groups.values()].map((g) => `${g.label} ${g.minutes.join(', ')} min`);
  return bound(`${head} · ${parts.join(' · ')}`, SUMMARY_MAX);
}

/**
 * The text of the next or the following departure, with its clock time (in
 * Eastern time, from the server) so that a text left behind by a failed read
 * still tells the truth: `"Red Line → Ashmont in 4 min (08:09)"`. Without
 * that departure: `"No following departure (read 08:05)"`, never a number.
 */
export function departureText(d, at, language, which = 'next') {
  if (!d) {
    return t(language, which === 'next' ? 'noNext' : 'noSecond', { clock: formatClock(at) });
  }
  const label = groupLabel(d);
  return d.minutes === 0
    ? t(language, 'leavingNow', { label, clock: formatClock(d.at) })
    : t(language, 'departsIn', { label, minutes: d.minutes, clock: formatClock(d.at) });
}

const groupLabel = (d) => (d.headsign ? `${d.label} → ${d.headsign}` : d.label);

/** The alerts sorted: most severe first, then the most recently updated. */
export function sortAlerts(alerts) {
  return [...alerts].sort(
    (a, b) =>
      (b.severity ?? -1) - (a.severity ?? -1) ||
      (b.updated ?? 0) - (a.updated ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** The alert text of the device: the most severe alert, and how many more. */
export function alertText(alerts, language) {
  if (alerts.length === 0) return t(language, 'noAlert');
  const [top] = sortAlerts(alerts);
  const more =
    alerts.length > 1 ? ` (${t(language, 'moreAlerts', { count: alerts.length - 1 })})` : '';
  return bound(`${top.header}${more}`, ALERT_TEXT_MAX);
}

/** The effect of an alert as offered to the scene filter. */
export const effectOf = (alert) => (ALERT_EFFECTS.includes(alert.effect) ? alert.effect : 'OTHER');

export const bandOf = (alert) => (alert.severity === null ? null : severityBand(alert.severity));
