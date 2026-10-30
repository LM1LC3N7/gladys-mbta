// -----------------------------------------------------------------------------
// One Gladys device per watched stop, read-only. Its id is the slot of the
// stop in the configuration (`watch:1` to `watch:5`), fixed forever: changing
// the stop of a slot keeps the device and its history.
//
// Features: the next and the following departure (minutes), the predicted
// departures within 60 minutes, the alerts in effect (counters) and two texts.
// No `poll_frequency`: the app reads the MBTA at its own pace.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COUNT_MAX, DEVICE_TYPE, FEATURES, MINUTES_MAX } from './constants.js';
import { t, watchLabel } from './i18n.js';

export const watchIds = (gladys, slot) => gladys.externalIds(DEVICE_TYPE, String(slot));

export function buildDevice(gladys, watch, language, stopName = null) {
  const ids = watchIds(gladys, watch.slot);
  const minutes = (key, name) => ({
    name,
    external_id: ids.feature(key),
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.MINUTES,
    min: 0,
    max: MINUTES_MAX,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  });
  const counter = (key, name, history) => ({
    name,
    external_id: ids.feature(key),
    category: C.COUNTER_SENSOR,
    type: T.SENSOR.INTEGER,
    min: 0,
    max: COUNT_MAX,
    read_only: true,
    has_feedback: false,
    keep_history: history,
  });
  const text = (key, name) => ({
    name,
    external_id: ids.feature(key),
    category: C.TEXT,
    type: T.TEXT.TEXT,
    // The core columns are NOT NULL; a text has no range (0/0 as the core UI).
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  });
  return {
    name: watchLabel(watch, language, stopName),
    external_id: ids.device,
    params: [{ name: 'watch', value: String(watch.slot) }],
    features: [
      minutes(FEATURES.NEXT, t(language, 'nextFeature')),
      minutes(FEATURES.SECOND, t(language, 'secondFeature')),
      counter(FEATURES.DEPARTURES, t(language, 'departuresFeature'), false),
      text(FEATURES.SUMMARY, t(language, 'summaryFeature')),
      counter(FEATURES.ALERTS, t(language, 'alertsFeature'), true),
      text(FEATURES.ALERT_TEXT, t(language, 'alertTextFeature')),
    ],
  };
}

/** `names`: the MBTA name of each stop id, when known. */
export function buildDevices(gladys, config, names = new Map()) {
  return config.watches.map((watch) =>
    buildDevice(gladys, watch, config.language, names.get(watch.stop) ?? null),
  );
}
