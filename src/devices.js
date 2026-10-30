// -----------------------------------------------------------------------------
// One Gladys device per watched stop, read-only. Its id is the slot of the
// stop in the configuration and the MBTA id of the stop (`watch:1-place-pktrm`):
// another stop in a slot is another device, never an old device (with the
// values of the old stop) under a new stop. The route filter and the direction
// can change without a new device: every read publishes every value again.
//
// Features: the next and the following departure (texts: a departure that no
// longer exists is replaced by "no departure", never left as a number), the
// predicted departures within 60 minutes and the alerts in effect (counters,
// for the scenes), the summary and the most severe alert (texts).
// No `poll_frequency`: the app reads the MBTA at its own pace.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { COUNT_MAX, DEVICE_TYPE, FEATURES } from './constants.js';
import { t, watchLabel } from './i18n.js';

/** The ids of a watch: its slot and its stop (`ext:mbta:watch:1-place-pktrm`). */
export const watchIds = (gladys, watch) =>
  gladys.externalIds(DEVICE_TYPE, `${watch.slot}-${watch.stop}`);

/** The prefix of every watch device of the integration. */
export const watchPrefix = (gladys) => gladys.externalId(`${DEVICE_TYPE}:`);

export function buildDevice(gladys, watch, language, stopName = null) {
  const ids = watchIds(gladys, watch);
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
    params: [
      { name: 'watch', value: String(watch.slot) },
      { name: 'stop', value: watch.stop },
    ],
    features: [
      text(FEATURES.NEXT, t(language, 'nextFeature')),
      text(FEATURES.SECOND, t(language, 'secondFeature')),
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
