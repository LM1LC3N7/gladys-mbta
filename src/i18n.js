// -----------------------------------------------------------------------------
// Every text the integration writes, in English and French: the device names
// and summaries (in the language of the configuration), the status and the
// test button (both languages, Gladys picks). Times are shown in Eastern
// time, the time zone of the MBTA; MBTA texts (stop names, alerts) stay in
// English, the only language of the API.
// -----------------------------------------------------------------------------

import { TIME_ZONE } from './constants.js';

const TEXTS = {
  en: {
    noDeparture: 'No predicted departure',
    nextIn: ({ label, minutes }) => `next: ${label} in ${minutes} min`,
    noAlert: 'No alert',
    noNext: ({ clock }) => `No predicted departure (read ${clock})`,
    noSecond: ({ clock }) => `No following departure (read ${clock})`,
    departsIn: ({ label, minutes, clock }) => `${label} in ${minutes} min (${clock})`,
    leavingNow: ({ label, clock }) => `${label} leaving now (${clock})`,
    moreAlerts: ({ count }) => (count === 1 ? '1 more alert' : `${count} more alerts`),
    watchDefault: ({ stop }) => `MBTA stop ${stop}`,
    watchNamed: ({ name }) => `MBTA – ${name}`,
    nextFeature: 'Next departure',
    secondFeature: 'Following departure',
    departuresFeature: 'Predicted departures (60 min)',
    summaryFeature: 'Departures',
    alertsFeature: 'Alerts in effect',
    alertTextFeature: 'Alert',
  },
  fr: {
    noDeparture: 'Aucun départ prévu',
    nextIn: ({ label, minutes }) => `prochain : ${label} dans ${minutes} min`,
    noAlert: 'Aucune alerte',
    noNext: ({ clock }) => `Aucun départ prévu (lu à ${clock})`,
    noSecond: ({ clock }) => `Aucun départ suivant (lu à ${clock})`,
    departsIn: ({ label, minutes, clock }) => `${label} dans ${minutes} min (${clock})`,
    leavingNow: ({ label, clock }) => `${label} part maintenant (${clock})`,
    moreAlerts: ({ count }) => (count === 1 ? '1 autre alerte' : `${count} autres alertes`),
    watchDefault: ({ stop }) => `Arrêt MBTA ${stop}`,
    watchNamed: ({ name }) => `MBTA – ${name}`,
    nextFeature: 'Prochain départ',
    secondFeature: 'Départ suivant',
    departuresFeature: 'Départs prévus (60 min)',
    summaryFeature: 'Départs',
    alertsFeature: 'Alertes en cours',
    alertTextFeature: 'Alerte',
  },
};

export function t(language, key, params = {}) {
  const text = (TEXTS[language] ?? TEXTS.en)[key];
  return typeof text === 'function' ? text(params) : text;
}

function parts(ms) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
}

/** The hour and minute in Eastern time, `"02:05"` (summaries). */
export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '?';
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

const MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  fr: [
    'janv.',
    'févr.',
    'mars',
    'avr.',
    'mai',
    'juin',
    'juil.',
    'août',
    'sept.',
    'oct.',
    'nov.',
    'déc.',
  ],
};

/** A time in Eastern time: "Oct 30, 14:05 ET" / "30 oct., 14 h 05 (heure de l'Est)". */
export function formatTime(ms, language) {
  if (!Number.isFinite(ms)) return '?';
  const p = parts(ms);
  const month = Number(p.month);
  if (language === 'fr') {
    return `${Number(p.day)} ${MONTHS.fr[month - 1]}, ${p.hour} h ${p.minute} (heure de l'Est)`;
  }
  return `${MONTHS.en[month - 1]} ${Number(p.day)}, ${p.hour}:${p.minute} ET`;
}

const ERRORS = {
  required: { en: 'is required', fr: 'est obligatoire' },
  id_invalid: {
    en: 'is not an MBTA stop id (letters, digits, - and _ only, e.g. place-pktrm or 1)',
    fr: "n'est pas un identifiant d'arrêt MBTA (lettres, chiffres, - et _ seulement, ex. place-pktrm ou 1)",
  },
  routes_invalid: {
    en: 'holds an invalid route (letters, digits, - and _ only, comma separated)',
    fr: 'contient une ligne invalide (lettres, chiffres, - et _ seulement, séparées par des virgules)',
  },
  routes_too_many: { en: 'names more than 10 routes', fr: 'nomme plus de 10 lignes' },
  direction: { en: 'is not a known direction', fr: "n'est pas une direction connue" },
  name_invalid: {
    en: 'is invalid (60 characters at most, no control character)',
    fr: 'est invalide (60 caractères au plus, sans caractère de contrôle)',
  },
  refresh: {
    en: 'must be a whole number of seconds between 30 and 600 (60 used)',
    fr: 'doit être un nombre entier de secondes entre 30 et 600 (60 utilisé)',
  },
};

/** "Field watch1_stop is required" in both languages. */
export function configErrors(errors) {
  const line = (lang) =>
    errors
      .map(
        (e) =>
          `${lang === 'fr' ? 'Le champ' : 'Field'} ${e.field} ${ERRORS[e.code]?.[lang] ?? e.code}`,
      )
      .join('; ');
  return { en: line('en'), fr: line('fr') };
}

const FAILURES = {
  network: { en: 'MBTA could not be reached', fr: 'MBTA injoignable' },
  timeout: { en: 'MBTA did not answer in time', fr: "le MBTA n'a pas répondu à temps" },
  rate: { en: 'MBTA asked to slow down (429)', fr: 'le MBTA demande de ralentir (429)' },
  server: { en: 'MBTA server error', fr: 'erreur du serveur du MBTA' },
  http: { en: 'unexpected answer from the MBTA', fr: 'réponse inattendue du MBTA' },
  format: { en: 'MBTA answer not readable', fr: 'réponse du MBTA illisible' },
  too_big: { en: 'MBTA answer too large', fr: 'réponse du MBTA trop grande' },
  unreadable: {
    en: 'the MBTA sends items that cannot be read (its format may have changed), nothing published',
    fr: 'le MBTA envoie des éléments illisibles (son format a peut-être changé), rien publié',
  },
  incomplete: {
    en: 'the MBTA answer misses the platforms of the station, nothing published',
    fr: 'la réponse du MBTA ne dit pas les quais de la station, rien publié',
  },
  no_date: {
    en: 'the MBTA answer carries no usable time, nothing published',
    fr: "la réponse du MBTA n'a pas d'heure utilisable, rien publié",
  },
  stale: {
    en: 'the MBTA real-time data is not updated (frozen feed), nothing published',
    fr: 'les données temps réel du MBTA ne sont plus mises à jour (flux figé), rien publié',
  },
  stop_missing: {
    en: 'the MBTA does not know this stop id: check it on mbta.com',
    fr: "le MBTA ne connaît pas cet identifiant d'arrêt : vérifiez-le sur mbta.com",
  },
  stop_unchecked: {
    en: 'no departure, and the stop could not be checked yet: nothing published',
    fr: "aucun départ, et l'arrêt n'a pas encore pu être vérifié : rien publié",
  },
  alerts_unchecked: {
    en: 'no alert, and the stop could not be checked yet: nothing published',
    fr: "aucune alerte, et l'arrêt n'a pas encore pu être vérifié : rien publié",
  },
  clock: {
    en: 'the time of the MBTA answer differs from the clock of this machine (set the clock of the machine, or a cache serves an old answer): nothing published',
    fr: "l'heure de la réponse du MBTA diffère de l'horloge de cette machine (réglez l'horloge de la machine, ou un cache sert une vieille réponse) : rien publié",
  },
  route_missing: {
    en: 'a route of the filter does not call at this stop: check the routes',
    fr: 'une ligne du filtre ne dessert pas cet arrêt : vérifiez les lignes',
  },
  paused: { en: 'not read (pause)', fr: 'non lu (pause)' },
};

export function failure(kind, status, lang) {
  const text = FAILURES[kind]?.[lang] ?? FAILURES.http[lang];
  const full = status && kind !== 'rate' ? `${text} (HTTP ${status})` : text;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

/** The bilingual messages of the status and the test button. */
export const M = {
  starting: {
    en: 'Starting: the first read of the MBTA comes shortly.',
    fr: 'Démarrage : la première lecture du MBTA arrive sous peu.',
  },
  configRetry: ({ seconds }) => ({
    en: `The configuration could not be read from Gladys; next try in ${seconds} s.`,
    fr: `La configuration n'a pas pu être lue dans Gladys ; nouvel essai dans ${seconds} s.`,
  }),
  noWatch: {
    en: 'No valid stop: fill in the stop id of stop 1 (e.g. place-pktrm for Park Street).',
    fr: "Aucun arrêt valide : renseignez l'identifiant de l'arrêt 1 (ex. place-pktrm pour Park Street).",
  },
};

/** The device name: the name typed, else the MBTA name of the stop, else its id. */
export function watchLabel(watch, language, stopName = null) {
  if (watch.name) return watch.name;
  if (stopName) return t(language, 'watchNamed', { name: stopName });
  return t(language, 'watchDefault', { stop: watch.stop });
}
