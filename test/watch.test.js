// -----------------------------------------------------------------------------
// What a watched stop sees in a predictions answer: placing, filters, minutes
// counted on the server time, and the texts of the device.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAlert, readPredictions } from '../src/mbta.js';
import {
  alertText,
  bandOf,
  countWithin,
  departuresFor,
  effectOf,
  routeLabel,
  sortAlerts,
  summary,
} from '../src/watch.js';
import {
  PREDICTIONS,
  alertResource,
  prediction,
  predictionsDoc,
  routeResource,
  stopResource,
  tripResource,
  defaultIncluded,
} from './helpers/setup.js';

const AT = Date.parse('2026-10-30T12:00:00Z'); // 08:00 EDT
const MIN = 60000;
const station = { slot: 1, stop: 'place-pktrm', routes: [], direction: null };
const read = (data, included) => readPredictions(predictionsDoc(data, included));
const minutes = (result) => result.departures.map((d) => d.minutes);

test('a station sees its platforms; a platform or a bus stop only itself', () => {
  const r = read(
    [
      prediction('a', { stop: '70075', departure: AT + 5 * MIN }),
      prediction('b', { stop: '70076', departure: AT + 3 * MIN }),
      prediction('c', { stop: '1', route: '1', departure: AT + 2 * MIN }),
    ],
    [...defaultIncluded(), stopResource('1', null, 'Bus')],
  );
  assert.deepEqual(minutes(departuresFor(station, r, AT, { station: true })), [3, 5]);
  assert.deepEqual(
    minutes(departuresFor({ ...station, stop: '70075' }, r, AT, { station: false })),
    [5],
  );
  assert.deepEqual(
    minutes(departuresFor({ ...station, stop: '1' }, r, AT, { station: false })),
    [2],
  );
  // Not checked yet: read as a station, the platforms placed through the answer.
  assert.deepEqual(minutes(departuresFor(station, r, AT, { station: null })), [3, 5]);
});

test('a prediction whose platform the answer does not describe: incomplete, never fewer departures', () => {
  const r = read([prediction('a', { stop: '70099', departure: AT + 5 * MIN })], []);
  assert.deepEqual(departuresFor(station, r, AT, { station: true }), {
    ok: false,
    kind: 'incomplete',
  });
  assert.deepEqual(departuresFor(station, r, AT, { station: null }), {
    ok: false,
    kind: 'incomplete',
  });
  // A stop that is not a station needs no platform: exact match only.
  assert.deepEqual(departuresFor({ ...station, stop: '1' }, r, AT, { station: false }), {
    ok: true,
    departures: [],
  });
});

test('the minutes: counted on the server time, rounded down, 1 min of grace, 24 h at most', () => {
  const r = read([
    prediction('gone', { departure: AT - MIN - 1000 }),
    prediction('leaving', { departure: AT - MIN }),
    prediction('now', { departure: AT - 1000 }),
    prediction('59s', { departure: AT + 59000 }),
    prediction('1m', { departure: AT + MIN }),
    prediction('far', { departure: AT + 24 * 60 * MIN }),
    prediction('absurd', { departure: AT + 24 * 60 * MIN + 1000 }),
  ]);
  assert.deepEqual(minutes(departuresFor(station, r, AT, { station: true })), [0, 0, 0, 1, 1440]);
});

test('cancelled, skipped and last-stop predictions are not departures', () => {
  const r = read([
    prediction('c', { departure: AT + MIN, relationship: 'CANCELLED' }),
    prediction('s', { departure: AT + 2 * MIN, relationship: 'SKIPPED' }),
    prediction('last', { departure: null, arrival: AT + 3 * MIN }),
    prediction('added', { departure: AT + 4 * MIN, relationship: 'ADDED' }),
    prediction('odd', { departure: AT + 5 * MIN, relationship: 'SOMETHING' }),
  ]);
  assert.deepEqual(minutes(departuresFor(station, r, AT, { station: true })), [4, 5]);
});

test('route and direction filters', () => {
  const r = read([
    prediction('red0', { departure: AT + MIN }),
    prediction('red1', { stop: '70076', departure: AT + 2 * MIN, direction: 1 }),
    prediction('ora', { route: 'Orange', departure: AT + 3 * MIN }),
  ]);
  const of = (over, routeIds = []) =>
    minutes(departuresFor({ ...station, ...over }, r, AT, { station: true, routeIds }));
  assert.deepEqual(of({}), [1, 2, 3]);
  assert.deepEqual(of({}, ['Red']), [1, 2]);
  assert.deepEqual(of({}, ['Orange', 'Red']), [1, 2, 3]);
  assert.deepEqual(of({ direction: 1 }), [2]);
  assert.deepEqual(of({ direction: 0 }, ['Orange']), [3]);
});

test('labels: a bus by its number, a line by its name; headsign from the trip or the route', () => {
  const r = read(
    [
      prediction('a', { departure: AT + MIN, trip: 't1' }),
      prediction('b', { stop: '70076', departure: AT + 2 * MIN, direction: 1, trip: 'none' }),
      prediction('c', { route: '741', departure: AT + 3 * MIN, trip: 't3' }),
      prediction('d', { route: 'X', departure: AT + 4 * MIN, trip: 'none' }),
    ],
    [
      ...defaultIncluded(),
      tripResource('t1', 'Ashmont'),
      tripResource('t3', 'Logan Airport'),
      routeResource('741', {
        short_name: 'SL1',
        long_name: 'Logan Airport - South Station',
        type: 3,
      }),
    ],
  );
  const { departures } = departuresFor(station, r, AT, { station: true });
  assert.deepEqual(
    departures.map((d) => [d.label, d.headsign]),
    [
      ['Red Line', 'Ashmont'],
      ['Red Line', 'Alewife'],
      ['SL1', 'Logan Airport'],
      ['X', ''],
    ],
  );
  assert.equal(routeLabel(null, 'Y'), 'Y');
  assert.equal(routeLabel({ type: 3, shortName: '', longName: 'L' }, 'Y'), 'L');
  assert.equal(routeLabel({ type: 2, shortName: '', longName: '' }, 'CR-X'), 'CR-X');
});

test('sorted by time, then id; the counter counts the next 60 minutes', () => {
  const r = read([
    prediction('b', { departure: AT + 5 * MIN }),
    prediction('a', { departure: AT + 5 * MIN }),
    prediction('c', { departure: AT + 59 * MIN + 59000 }),
    prediction('d', { departure: AT + 60 * MIN }),
  ]);
  const { departures } = departuresFor(station, r, AT, { station: true });
  assert.deepEqual(
    departures.map((d) => d.id),
    ['prediction-a', 'prediction-b', 'prediction-c', 'prediction-d'],
  );
  assert.equal(countWithin(departures), 3);
});

test('the captured answer: Park Street at 02:03 EDT', () => {
  const r = readPredictions(PREDICTIONS.body);
  const at = Date.parse(PREDICTIONS.date);
  const { departures } = departuresFor(station, r, at, { station: true });
  assert.deepEqual(
    departures.map((d) => d.minutes),
    [13, 13, 13, 13, 13, 56, 56],
  );
  assert.equal(
    summary(departures, at, 'en'),
    '02:03 · Green Line E → Heath Street 13, 13, 13 min · Green Line D → Riverside 13, 13 min · Green Line E → Medford/Tufts 56, 56 min',
  );
});

test('the summary: read time first, groups of 3 at most, bounded, in both languages', () => {
  const d = (minutes, label = 'Red Line', headsign = 'Ashmont', route = 'Red') => ({
    minutes,
    label,
    headsign,
    route,
    at: AT + minutes * MIN,
  });
  assert.equal(summary([], AT, 'en'), '08:00 · No predicted departure');
  assert.equal(summary([], AT, 'fr'), '08:00 · Aucun départ prévu');
  assert.equal(
    summary([d(1), d(2), d(3), d(4), d(5, '1', '', '1')], AT, 'en'),
    '08:00 · Red Line → Ashmont 1, 2, 3 min · 1 5 min',
  );
  assert.equal(summary([d(75)], AT, 'en'), '08:00 · next: Red Line → Ashmont in 75 min');
  assert.equal(summary([d(75)], AT, 'fr'), '08:00 · prochain : Red Line → Ashmont dans 75 min');
  const many = Array.from({ length: 100 }, (_, i) => d(i % 60, 'x'.repeat(40), `h${i}`, `r${i}`));
  const text = summary(many, AT, 'en');
  assert.equal([...text].length, 600);
  assert.ok(text.endsWith('…'));
  // Times in Eastern time, daylight time and standard time.
  assert.match(summary([], Date.parse('2026-11-01T06:30:00Z'), 'en'), /^01:30/);
  assert.match(summary([], Date.parse('2026-11-01T05:30:00Z'), 'en'), /^01:30/);
  assert.match(summary([], Date.parse('2026-03-08T07:30:00Z'), 'en'), /^03:30/);
  assert.match(summary([], Date.parse('2026-10-31T04:00:00Z'), 'en'), /^00:00/);
});

test('alerts: most severe first, then the latest; the text and the scene values', () => {
  const alerts = [
    readAlert(alertResource(1, { severity: 3, header: 'Minor one.' })),
    readAlert(alertResource(2, { severity: 8, header: 'Severe one.', effect: 'SHUTTLE' })),
    readAlert(
      alertResource(3, {
        severity: 8,
        header: 'Severe, newer.',
        updated_at: '2026-10-30T02:00:00-04:00',
      }),
    ),
    readAlert(alertResource(4, { severity: null, effect: 'ELEVATOR_CLOSURE' })),
  ];
  assert.deepEqual(
    sortAlerts(alerts).map((a) => a.id),
    ['3', '2', '1', '4'],
  );
  assert.equal(alertText(alerts, 'en'), 'Severe, newer. (3 more alerts)');
  assert.equal(alertText(alerts.slice(0, 2), 'fr'), 'Severe one. (1 autre alerte)');
  assert.equal(alertText([], 'en'), 'No alert');
  assert.equal(alertText([], 'fr'), 'Aucune alerte');
  assert.equal(alertText(alerts.slice(0, 1), 'en'), 'Minor one.');
  const long = readAlert(alertResource(5, { header: 'y'.repeat(1500) }));
  assert.equal([...alertText([long], 'en')].length, 600);
  assert.deepEqual(alerts.map(effectOf), ['DELAY', 'SHUTTLE', 'DELAY', 'OTHER']);
  assert.deepEqual(alerts.map(bandOf), ['minor', 'severe', 'severe', null]);
  const band = (severity) => bandOf({ severity });
  assert.deepEqual([0, 3, 4, 6, 7, 10].map(band), [
    'minor',
    'minor',
    'moderate',
    'moderate',
    'severe',
    'severe',
  ]);
});
