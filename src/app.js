// -----------------------------------------------------------------------------
// The integration: reads the predicted departures and the alerts of each
// watched stop from the MBTA V3 API, publishes what each stop sees, fires
// the "new alert" scene trigger, and tells in the status exactly where each
// stop stands.
//
// Pace and courtesy toward the source (20 requests per minute without a key):
//   - one request at a time, 3 s at least between the starts of two, and a
//     hold until the window resets when `x-ratelimit-remaining` runs low;
//   - one predictions request per round for every stop; the alerts every
//     5 minutes, one request per stop; the stop check (name, routes) once;
//   - the read period is measured from the start of a round, never shorter
//     than the interval: neither a restart (the time of the last attempt is in
//     /data, written before the round), nor a reconnection, a saved but
//     unchanged configuration, Discovery or the test button reads sooner;
//   - a 429 pauses every read, a 5xx of the predictions too (bounded, doubled,
//     kept in /data); the alerts and the stop check are secondary: their
//     failures never hold the departures.
//
// Never a value without proof: a departure is counted against the `Date` of
// the answer that carries it, and the answer must show MBTA data updated
// within 10 minutes (`Last-Modified`); a failed, stale or unreadable read
// publishes nothing (never 0), and the status says since when.
//
// Clocks: the decisions (gap, pause, period) use the monotonic clock, read
// once per decision; the wall clock serves only /data (restart) and the times
// shown.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import {
  ALERTS_INTERVAL,
  ALERTS_RETRY_MAX,
  ALERTS_SLACK,
  CHECK_MISSING_RETRY,
  CHECK_RETRY_FIRST,
  CHECK_RETRY_MAX,
  CONFIG_RETRY_FIRST,
  CONFIG_RETRY_MAX,
  CLOCK_SKEW,
  FEATURES,
  FEED_STALE,
  HOUR,
  MINUTE,
  PAUSE_429_FIRST,
  PAUSE_5XX_FIRST,
  PAUSE_MAX,
  PAUSE_MIN,
  RATE_HOLD_MAX,
  RATE_REMAINING_LOW,
  REFRESH_MIN,
  REQUEST_GAP,
  SCENE_EVENTS_PER_READ,
  SCENE_TEXT_MAX,
  SCENE_TRIGGER,
  SECOND,
  SOON_MEMORY_MAX,
  SOON_THRESHOLDS,
  SOON_TRIGGER,
  SEEN_KEEP,
  SEEN_MAX,
} from './constants.js';
import { normalizeConfig } from './config.js';
import { buildDevices, watchIds, watchPrefix } from './devices.js';
import { M, configErrors, failure, formatClock, formatTime, watchLabel } from './i18n.js';
import {
  alertsUrl,
  getJson,
  predictionsUrl,
  readAlerts,
  readPredictions,
  readRoutesList,
  readStops,
  routesUrl,
  stopsUrl,
} from './mbta.js';
import { createFileStore } from './store.js';
import {
  alertText,
  bandOf,
  countWithin,
  departureText,
  departuresFor,
  effectOf,
  sortAlerts,
  summary,
} from './watch.js';

const SAVE_BOUND = 2 * SECOND;
const GLADYS_BOUND = 10 * SECOND;
const STATUS_MAX = 1500;
const LANGS = ['en', 'fr'];
/** A `Last-Modified` this much after the `Date` of its answer is not believed. */
const FUTURE_SLACK = MINUTE;
/** An alert is announced to the scenes when it changed within this. */
const FRESH_ALERT = 2 * HOUR;

const isTime = (value) => Number.isFinite(value) && value > 0;
/** The answers that pause every read: 429 always, 5xx and others of the predictions. */
const PAUSING = ['rate', 'server', 'http'];
const NO_PAUSE = () => ({
  until: null,
  kind: null,
  status: null,
  level429: 0,
  level5xx: 0,
  levelHttp: 0,
});

/** A route filter resolved against the routes of a stop: ids, or what is missing. */
export function resolveRoutes(filter, routes) {
  const ids = [];
  const missing = [];
  for (const wanted of filter) {
    const key = wanted.toLowerCase();
    const route =
      routes.find((r) => r.id === wanted) ??
      routes.find((r) => r.id.toLowerCase() === key) ??
      routes.find((r) => r.shortName && r.shortName.toLowerCase() === key);
    if (route) {
      if (!ids.includes(route.id)) ids.push(route.id);
    } else missing.push(wanted);
  }
  return { ids, missing };
}

const routesKey = (watch) => `${watch.stop}|${watch.routes.join(',')}`;

export class MbtaApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    apiBase,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;

    /** Bumped by every start and stop: an older round goes quiet. */
    this.gen = 0;
    /** Bumped by every connection and disconnection (config retry loop). */
    this.connGen = 0;
    this.config = null;
    this.cycleTimer = null;
    this.sleeps = new Set();
    this.pendingStart = undefined;
    this.starting = null;

    this.lastRequestMono = -Infinity;
    this.rateHoldMono = null;
    this.inflight = null;
    this.pauseUntilMono = null;
    this.nextDueMono = null;
    this.lastStatus = null;
    this.lastFingerprints = null;

    /** Per stop id: `{ status: 'found' | 'missing', name, station, checkedMono }`. */
    this.stopInfo = new Map();
    /** Per stop and route filter: `{ status: 'ok' | 'missing', ids, missing, checkedMono }`. */
    this.routeInfo = new Map();
    this.checkLevel = 0;
    this.checkDueMono = null;
    this.checkFailure = null;
    this.publishedNames = null;

    /** Per watch fingerprint: the minutes of each departure seen at the last read. */
    this.soon = new Map();
    /** Whether a round runs (a timer firing meanwhile waits for its end). */
    this.inRound = false;
    /** Per slot: `{ dueMono, level }` of the next alerts read. */
    this.alertsDue = new Map();

    /** Per URL: the last answer, for `If-Modified-Since` (cleared by a new configuration). */
    this.conditional = new Map();
    /** Per slot: `{ fingerprint, dep, alerts }`, what the status tells. */
    this.results = new Map();

    this.loaded = false;
    this.storeStatus = 'absent';
    this.persisted = { watches: {} };

    /** The start of the process, and the last round started in it. */
    this.startMono = this.monotonic();
    this.lastAttemptMono = null;
    /** Whether /data tells the last attempt (null: not known yet). */
    this.dataTells = null;
    this.saveFailed = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * A connection to Gladys: read the configuration, then start. A failing
   * `getConfig()` is retried forever, spaced out (5 s doubled up to 5 min),
   * with the status saying so.
   */
  async connected() {
    const conn = ++this.connGen;
    // A new connection: Gladys gets the status again, even unchanged.
    this.lastStatus = null;
    let delay = CONFIG_RETRY_FIRST;
    for (;;) {
      let raw;
      try {
        raw = await this.gladys.getConfig();
      } catch (err) {
        if (conn !== this.connGen) return;
        this.logger.warn(
          `Configuration not read (${err?.name ?? 'Error'}); retry in ${delay / SECOND} s`,
        );
        await this.setStatus(
          false,
          M.configRetry({ seconds: Math.round(delay / SECOND) }),
          this.gen,
        );
        await this.sleep(delay);
        if (conn !== this.connGen) return;
        delay = Math.min(delay * 2, CONFIG_RETRY_MAX);
        continue;
      }
      if (conn !== this.connGen) return;
      await this.start(raw);
      return;
    }
  }

  async disconnected() {
    this.connGen += 1;
    await this.stop();
  }

  /**
   * Apply a configuration. Configurations saved in a row apply one after the
   * other, the last one winning: a start asked while one runs is kept and
   * applied next (only the latest of them).
   */
  start(raw) {
    this.pendingStart = { raw };
    if (!this.starting) {
      this.starting = (async () => {
        try {
          while (this.pendingStart) {
            const { raw: next } = this.pendingStart;
            this.pendingStart = undefined;
            await this.applyConfig(next);
          }
        } finally {
          this.starting = null;
        }
      })();
    }
    return this.starting;
  }

  async stop() {
    this.gen += 1;
    this.cancelTimers();
    await this.persist();
  }

  /** Waits for the start in progress and the request in flight (tests). */
  async idle() {
    while (this.starting || this.inflight) {
      await this.starting;
      await this.inflight;
    }
  }

  cancelTimers() {
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    for (const sleep of this.sleeps) {
      this.timers.clearTimeout(sleep.timer);
      sleep.resolve();
    }
    this.sleeps.clear();
  }

  /** A wait on the injected timers, released at once by a stop. */
  sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve };
      entry.timer = this.timers.setTimeout(
        () => {
          this.sleeps.delete(entry);
          resolve();
        },
        Math.max(0, ms),
      );
      this.sleeps.add(entry);
    });
  }

  async applyConfig(raw) {
    this.gen += 1;
    const gen = this.gen;
    this.cancelTimers();
    const config = normalizeConfig(raw);
    this.config = config;
    this.conditional.clear();
    this.load();
    for (const error of config.errors) {
      this.logger.warn(`Configuration: field ${error.field} refused (${error.code})`);
    }
    await this.publishDevices();
    if (gen !== this.gen) return;
    if (config.watches.length === 0) {
      const errors = configErrors(config.errors);
      await this.setStatus(
        false,
        { en: `${M.noWatch.en} ${errors.en}`.trim(), fr: `${M.noWatch.fr} ${errors.fr}`.trim() },
        gen,
      );
      return;
    }
    // Forget what the changed watches saw; keep what the others saw.
    const fingerprints = new Map(
      config.watches.map((watch) => [watch.slot, this.fingerprint(watch)]),
    );
    for (const slot of [...this.results.keys()]) {
      if (this.results.get(slot).fingerprint !== fingerprints.get(slot)) this.results.delete(slot);
    }
    if (this.dataTells === null) await this.checkData();
    if (gen !== this.gen) return;
    const changed =
      this.lastFingerprints !== null &&
      JSON.stringify([...fingerprints]) !== JSON.stringify([...this.lastFingerprints]);
    this.lastFingerprints = fingerprints;
    if (changed) {
      // New stops: their alerts and their check come with the next round.
      this.alertsDue.clear();
      this.checkDueMono = null;
      this.checkLevel = 0;
    }

    // When is the first round due? One clock read for the decision.
    const wall = this.now();
    const mono = this.monotonic();
    const interval = config.refreshSeconds * SECOND;
    let wait = 0;
    const last = this.persisted.lastAttemptAt;
    if (!changed) {
      if (this.lastAttemptMono !== null) {
        // A round already ran in this process: its monotonic time decides.
        wait = Math.max(0, this.lastAttemptMono + interval - mono);
      } else if (!this.dataTells) {
        // /data cannot tell the last attempt (unreadable, not writable, a
        // date in the future): a restart never reads at once.
        wait = Math.max(0, this.startMono + REFRESH_MIN * SECOND - mono);
      } else if (isTime(last)) {
        wait = Math.max(0, last + interval - wall);
      }
    }
    const pause = this.persisted.pause;
    if (pause && isTime(pause.until) && pause.until > wall && pause.until - wall <= PAUSE_MAX) {
      const left = pause.until - wall;
      if (this.pauseUntilMono === null || this.pauseUntilMono < mono + left) {
        this.pauseUntilMono = mono + left;
      }
    }
    if (this.pauseUntilMono !== null && this.pauseUntilMono > mono) {
      wait = Math.max(wait, this.pauseUntilMono - mono);
    }
    this.nextDueMono = mono + wait;
    await this.updateStatus(gen);
    if (gen !== this.gen) return;
    // Woken at least every interval: a long pause keeps the status true.
    this.scheduleCycle(Math.min(wait, interval), gen);
  }

  /**
   * Whether /data tells when the MBTA was last read: readable, with no date in
   * the future, and writable (checked by writing it back before any read).
   */
  async checkData() {
    const last = this.persisted.lastAttemptAt;
    if (this.storeStatus === 'unreadable') this.dataTells = false;
    else if (isTime(last) && last > this.now()) {
      this.logger.warn('The last attempt in /data is in the future: not believed');
      this.dataTells = false;
    } else {
      // Readable is not enough: a /data that cannot be written (read-only,
      // frozen) would keep an old attempt time and let every restart read.
      this.dataTells = await this.persist();
      if (!this.dataTells) this.saveFailed = true;
    }
  }

  scheduleCycle(delay, gen) {
    if (gen !== this.gen) return;
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = this.timers.setTimeout(
      () => {
        this.cycleTimer = null;
        this.runCycle(gen).catch((err) => {
          this.logger.error(`Read failed (${err?.name ?? 'Error'})`);
          // Never left without a next round: armed again at the interval.
          if (gen === this.gen && this.config) {
            const interval = this.config.refreshSeconds * SECOND;
            this.nextDueMono = this.monotonic() + interval;
            this.scheduleCycle(interval, gen);
          }
        });
      },
      Math.max(0, delay),
    );
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    let result;
    try {
      result = this.store.load();
    } catch {
      result = { status: 'unreadable', data: {} };
    }
    this.storeStatus = result.status;
    if (result.status === 'unreadable') {
      this.logger.warn(
        'The state file of /data is unreadable: left untouched, running from memory',
      );
    }
    const data = result.data ?? {};
    const persisted = { watches: {} };
    if (isTime(data.lastAttemptAt)) persisted.lastAttemptAt = data.lastAttemptAt;
    if (data.pause && typeof data.pause === 'object') {
      const level = (n) => (Number.isInteger(n) && n >= 0 && n <= 30 ? n : 0);
      persisted.pause = {
        until: isTime(data.pause.until) ? data.pause.until : null,
        kind: PAUSING.includes(data.pause.kind) ? data.pause.kind : 'rate',
        status:
          Number.isInteger(data.pause.status) &&
          data.pause.status >= 100 &&
          data.pause.status <= 599
            ? data.pause.status
            : null,
        level429: level(data.pause.level429),
        level5xx: level(data.pause.level5xx),
        levelHttp: level(data.pause.levelHttp),
      };
    }
    if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt))
      persisted.salt = data.salt;
    else persisted.salt = randomBytes(16).toString('hex');
    if (data.watches && typeof data.watches === 'object') {
      for (const [slot, watch] of Object.entries(data.watches)) {
        if (!/^[1-5]$/.test(slot) || !watch || typeof watch.fingerprint !== 'string') continue;
        const seen = {};
        if (watch.seen && typeof watch.seen === 'object') {
          for (const [id, at] of Object.entries(watch.seen).slice(0, SEEN_MAX)) {
            if (id.length <= 120 && isTime(at)) seen[id] = at;
          }
        }
        persisted.watches[slot] = { fingerprint: watch.fingerprint, seen };
      }
    }
    this.persisted = persisted;
  }

  /** A salted fingerprint of a watch: never its stop in clear in /data. */
  fingerprint(watch) {
    return createHash('sha256')
      .update(
        JSON.stringify([this.persisted.salt ?? '', watch.stop, watch.routes, watch.direction]),
      )
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * A call to Gladys, never waited for more than 10 s (the SDK cuts each call
   * at 15 s; this bound holds whatever the SDK does): a Gladys that does not
   * answer never holds a round. Rejects when late, as a failed call.
   */
  async bounded(fn) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new Error('Gladys did not answer')),
        GLADYS_BOUND,
      );
    });
    try {
      return await Promise.race([Promise.resolve().then(fn), late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** Saves /data without ever waiting more than SAVE_BOUND for it. */
  async persist() {
    if (!this.loaded || this.storeStatus === 'unreadable') return false;
    let timer;
    const bound = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('late'), SAVE_BOUND);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve(this.store.save(this.persisted)).then(() => 'saved'),
        bound,
      ]);
      if (outcome === 'late') this.logger.warn('Saving /data is slow: going on without waiting');
      return outcome === 'saved';
    } catch (err) {
      this.logger.warn(`Saving /data failed (${err?.code ?? err?.name ?? 'Error'})`);
      return false;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- Discovery, actions ----------------------------------------------------

  /** The MBTA names of the stops checked so far. */
  stopNames() {
    const names = new Map();
    for (const [id, info] of this.stopInfo) if (info.status === 'found') names.set(id, info.name);
    return names;
  }

  async publishDevices() {
    const config = this.config ?? normalizeConfig(this.gladys.config);
    try {
      const names = this.stopNames();
      this.publishedNames = JSON.stringify([...names]);
      await this.bounded(() =>
        this.gladys.publishDiscoveredDevices(buildDevices(this.gladys, config, names)),
      );
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery: the stops of the configuration, never a read. */
  scan() {
    return this.publishDevices();
  }

  /**
   * The test button: what the last read of each stop gave and when the next
   * one comes. It never reads (the interval and the gap hold for it too).
   */
  testConnection() {
    return this.composeStatus().message;
  }

  // --- The read round --------------------------------------------------------

  async runCycle(gen) {
    if (gen !== this.gen) return;
    // A timer may fire a little before the end of a pause or of the
    // interval: armed again for what is left, the round is never skipped.
    // During a long pause it wakes every interval to keep the status true
    // (data said stale, no longer "connected"), without reading.
    const mono0 = this.monotonic();
    const left = Math.max(this.pausedFor(mono0), (this.nextDueMono ?? mono0) - mono0);
    if (left > 0) {
      this.nextDueMono = mono0 + left;
      this.scheduleCycle(Math.min(left + 5, this.config.refreshSeconds * SECOND), gen);
      await this.updateStatus(gen);
      return;
    }
    // A round still running (a slow Gladys): this one comes right after it.
    if (this.inRound) {
      this.scheduleCycle(SECOND, gen);
      return;
    }
    this.inRound = true;
    try {
      await this.round(gen);
    } finally {
      this.inRound = false;
    }
  }

  /** One round: the stop check if needed, the departures, the alerts when due. */
  async round(gen) {
    const config = this.config;
    const start = this.monotonic();
    this.lastAttemptMono = start;
    this.nextDueMono = start + config.refreshSeconds * SECOND;
    // The time of the attempt is in /data before the first request.
    this.persisted.lastAttemptAt = this.now();
    // The next round is armed first: neither a slow /data nor a Gladys that
    // does not answer a publication holds it back (armed again below, after
    // a pause found by this round).
    this.scheduleCycle(config.refreshSeconds * SECOND, gen);
    const saved = await this.persist();
    this.saveFailed = !saved && this.storeStatus !== 'unreadable';
    if (gen !== this.gen) return;
    await this.checkStops(gen);
    if (gen !== this.gen) return;
    await this.readDepartures(gen);
    if (gen !== this.gen) return;
    await this.readAllAlerts(gen, start);
    if (gen !== this.gen) return;
    // Armed again for what is left, after a pause this round may have found.
    const mono = this.monotonic();
    let delay = Math.max(0, this.nextDueMono - mono);
    if (this.pauseUntilMono !== null && this.pauseUntilMono > mono) {
      delay = Math.max(delay, this.pauseUntilMono - mono);
      this.nextDueMono = mono + delay;
    }
    this.scheduleCycle(Math.min(delay, config.refreshSeconds * SECOND), gen);
    const savedAfter = await this.persist();
    if (this.storeStatus !== 'unreadable') this.saveFailed = this.saveFailed || !savedAfter;
    if (gen !== this.gen) return;
    if (this.publishedNames !== JSON.stringify([...this.stopNames()])) {
      await this.publishDevices();
      if (gen !== this.gen) return;
    }
    await this.updateStatus(gen);
  }

  /** The pause left, in ms (0 when none). */
  pausedFor(mono = this.monotonic()) {
    if (this.pauseUntilMono === null) return 0;
    return Math.max(0, this.pauseUntilMono - mono);
  }

  /**
   * One request, when its turn comes: after the one in flight, 3 s after the
   * start of the previous one, after the rate limit window when it ran low.
   * `null` when stopped meanwhile. A 429 pauses every read, and a pausing
   * answer of the departures (5xx, other statuses) too, even when the
   * configuration changed while the request was out.
   */
  async call(url, gen, { pausing = false } = {}) {
    for (;;) {
      if (gen !== this.gen) return null;
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      const mono = this.monotonic();
      const wait = Math.max(
        this.lastRequestMono + REQUEST_GAP - mono,
        this.rateHoldMono === null ? 0 : this.rateHoldMono - mono,
      );
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      break;
    }
    // A pause started meanwhile (a late 429 of an older round) holds this one.
    if (this.pausedFor() > 0) return { ok: false, kind: 'paused' };
    this.lastRequestMono = this.monotonic();
    const cached = this.conditional.get(url);
    const job = getJson(url, {
      fetchImpl: this.fetchImpl,
      timers: this.timers,
      ifModifiedSince: cached?.lastModifiedText ?? null,
    });
    this.inflight = job.then(
      () => {},
      () => {},
    );
    let result;
    try {
      result = await job;
    } finally {
      this.inflight = null;
    }
    const mono = this.monotonic();
    if (
      result.rate &&
      result.rate.remaining <= RATE_REMAINING_LOW &&
      result.rate.resetIn !== null
    ) {
      this.rateHoldMono = mono + Math.min(result.rate.resetIn, RATE_HOLD_MAX);
    }
    if (!result.ok && (result.kind === 'rate' || (pausing && PAUSING.includes(result.kind)))) {
      this.startPause(result);
      // Stopped or restarted meanwhile: the pause still reaches /data.
      if (gen !== this.gen) await this.persist();
    }
    // A 304 only answers a conditional request, sent only with a cached answer.
    if (result.ok && result.notModified) {
      return {
        ...result,
        json: cached.json,
        lastModified: result.lastModified ?? cached.lastModified,
      };
    }
    if (result.ok && result.lastModifiedText) {
      this.conditional.set(url, {
        lastModifiedText: result.lastModifiedText,
        lastModified: result.lastModified,
        json: result.json,
      });
    }
    return result;
  }

  /**
   * Whether an answer shows fresh MBTA data: a believable server time, and a
   * `Last-Modified` within 10 minutes of it. `{ at }` or `{ kind }`.
   */
  freshness(answer) {
    const at = answer.serverDate;
    if (at === null || at === undefined) return { kind: 'no_date' };
    // An answer dated more than 5 minutes away from this machine: its clock is
    // wrong, or the answer is an old copy. Never counted as fresh.
    const skew = at - this.now();
    if (Math.abs(skew) > CLOCK_SKEW) {
      this.logger.warn('The Date of the MBTA answer differs from the local clock: not used');
      return { kind: 'clock', detail: Math.round(skew / MINUTE) };
    }
    const lm = answer.lastModified;
    if (lm === null || lm === undefined || lm > at + FUTURE_SLACK || at - lm > FEED_STALE) {
      return { kind: 'stale' };
    }
    return { at };
  }

  /** Whether a watch has its stop and route filter checked. */
  checked(watch) {
    if (this.stopInfo.get(watch.stop)?.status !== 'found') return false;
    return watch.routes.length === 0 || this.routeInfo.get(routesKey(watch))?.status === 'ok';
  }

  /**
   * The stop check (secondary: a failure never holds the departures): the
   * stops not known yet, then the route filters not resolved yet.
   */
  async checkStops(gen) {
    const mono = this.monotonic();
    // A round within 5 s of the retry time counts: never a round skipped for it.
    if (this.checkDueMono !== null && mono < this.checkDueMono - ALERTS_SLACK) return;
    // Checked again 30 min later (a round within 5 s of it counts).
    const due = (info) =>
      !info ||
      (info.status === 'missing' && mono - info.checkedMono >= CHECK_MISSING_RETRY - ALERTS_SLACK);
    const watches = this.config.watches;
    const stops = [...new Set(watches.map((w) => w.stop))].filter((id) =>
      due(this.stopInfo.get(id)),
    );
    let failed = null;
    if (stops.length > 0) {
      const answer = await this.call(stopsUrl(stops, this.apiBase), gen);
      if (answer === null || gen !== this.gen) return;
      const read = answer.ok ? readStops(answer.json) : null;
      if (read) {
        const at = this.monotonic();
        for (const id of stops) {
          const stop = read.get(id);
          this.stopInfo.set(
            id,
            stop
              ? { status: 'found', name: stop.name, station: stop.station, checkedMono: at }
              : { status: 'missing', checkedMono: at },
          );
          if (!stop) this.logger.warn('A stop of the configuration is unknown to the MBTA');
        }
      } else failed = answer.ok ? { kind: 'format' } : answer;
    }
    for (const watch of watches) {
      if (failed || watch.routes.length === 0) continue;
      if (this.stopInfo.get(watch.stop)?.status !== 'found') continue;
      const key = routesKey(watch);
      if (!due(this.routeInfo.get(key))) continue;
      const answer = await this.call(routesUrl(watch.stop, this.apiBase), gen);
      if (answer === null || gen !== this.gen) return;
      const routes = answer.ok ? readRoutesList(answer.json) : null;
      if (!routes) {
        failed = answer.ok ? { kind: 'format' } : answer;
        break;
      }
      const { ids, missing } = resolveRoutes(watch.routes, routes);
      this.routeInfo.set(key, {
        status: missing.length === 0 ? 'ok' : 'missing',
        ids,
        missing,
        checkedMono: this.monotonic(),
      });
      if (missing.length > 0) {
        this.logger.warn(`Watch ${watch.slot}: ${missing.length} route(s) not calling at the stop`);
      }
    }
    if (failed) {
      this.checkLevel = Math.min(this.checkLevel + 1, 10);
      const delay = Math.min(CHECK_RETRY_FIRST * 2 ** (this.checkLevel - 1), CHECK_RETRY_MAX);
      this.checkDueMono = mono + delay;
      this.checkFailure = { kind: failed.kind, status: failed.status };
      this.logger.warn(
        `Stop check failed (${failed.kind}); retry in ${Math.round(delay / SECOND)} s`,
      );
    } else {
      this.checkLevel = 0;
      this.checkDueMono = null;
      this.checkFailure = null;
    }
  }

  /** The route ids a watch filters on: resolved when checked, else as typed. */
  routeIdsOf(watch, read = null) {
    if (watch.routes.length === 0) return [];
    const info = this.routeInfo.get(routesKey(watch));
    if (info?.status === 'ok') return info.ids;
    // Not checked yet: resolved against the routes of the answer itself.
    const routes = read ? [...read.routes.values()] : [];
    const { ids, missing } = resolveRoutes(watch.routes, routes);
    return [...ids, ...missing];
  }

  /** Why a watch cannot be read at all (its stop or route filter refused), or null. */
  refusal(watch) {
    if (this.stopInfo.get(watch.stop)?.status === 'missing') return 'stop_missing';
    if (watch.routes.length > 0 && this.routeInfo.get(routesKey(watch))?.status === 'missing') {
      return 'route_missing';
    }
    return null;
  }

  /** The departures of every watch: one request. */
  async readDepartures(gen) {
    const watches = this.config.watches;
    if (this.pausedFor() > 0) {
      for (const watch of watches) this.recordFailure(watch, 'dep', { kind: 'paused' });
      return;
    }
    const stops = [...new Set(watches.map((w) => w.stop))];
    const answer = await this.call(predictionsUrl(stops, this.apiBase), gen, { pausing: true });
    if (answer === null || gen !== this.gen) return;
    if (!answer.ok) {
      this.logger.warn(
        `Departures not read (${answer.kind}${answer.status ? ` ${answer.status}` : ''})`,
      );
      for (const watch of watches) this.recordFailure(watch, 'dep', answer);
      return;
    }
    // The source answered: the pauses end.
    this.pauseUntilMono = null;
    if (this.persisted.pause) this.persisted.pause = NO_PAUSE();
    const fresh = this.freshness(answer);
    const read = fresh.kind ? null : readPredictions(answer.json);
    let kind = fresh.kind ?? null;
    if (!kind && !read) kind = 'format';
    if (!kind && read.unreadable) kind = 'unreadable';
    if (kind) {
      this.logger.warn(`Departures not published (${kind})`);
      for (const watch of watches) {
        this.recordFailure(watch, 'dep', { kind, detail: fresh.detail });
      }
      return;
    }
    for (const watch of watches) {
      if (gen !== this.gen) return;
      await this.onDepartures(watch, read, fresh.at);
    }
  }

  async onDepartures(watch, read, at) {
    const refused = this.refusal(watch);
    if (refused) {
      this.recordFailure(watch, 'dep', { kind: refused });
      return;
    }
    const stop = this.stopInfo.get(watch.stop);
    const result = departuresFor(watch, read, at, {
      station: stop?.status === 'found' ? stop.station : null,
      routeIds: this.routeIdsOf(watch, read),
    });
    if (!result.ok) {
      this.recordFailure(watch, 'dep', { kind: result.kind });
      return;
    }
    const { departures } = result;
    // "No departure" is only told for a stop (and routes) the MBTA confirmed:
    // a mistyped id would read as an empty stop.
    if (departures.length === 0 && !this.checked(watch)) {
      this.recordFailure(watch, 'dep', { kind: 'stop_unchecked' });
      return;
    }
    const count = countWithin(departures);
    const language = this.config.language;
    this.setResult(watch, 'dep', {
      ok: true,
      // Times of the status from the server (`Date`), as the summary.
      readAt: at,
      readMono: this.monotonic(),
      count,
      next: departures[0] ?? null,
    });
    const ids = watchIds(this.gladys, watch);
    const soon = this.departuresSoon(watch, departures);
    if (this.isCreated(ids)) {
      // Every value at every read: a departure gone is replaced by its text
      // "no departure", never left behind.
      const states = [
        {
          device_feature_external_id: ids.feature(FEATURES.NEXT),
          text: departureText(departures[0], at, language, 'next'),
        },
        {
          device_feature_external_id: ids.feature(FEATURES.SECOND),
          text: departureText(departures[1], at, language, 'second'),
        },
        { device_feature_external_id: ids.feature(FEATURES.DEPARTURES), state: count },
        {
          device_feature_external_id: ids.feature(FEATURES.SUMMARY),
          text: summary(departures, at, language),
        },
      ];
      try {
        await this.bounded(() => this.gladys.publishStates(states));
      } catch (err) {
        this.logger.warn(`Watch ${watch.slot}: departures not published (${err?.name ?? 'Error'})`);
      }
    }
    for (const event of soon) {
      try {
        await this.bounded(() =>
          this.gladys.publishSceneEvent(SOON_TRIGGER, { device: ids.device, ...event }),
        );
      } catch (err) {
        this.logger.warn(`Watch ${watch.slot}: scene event not sent (${err?.name ?? 'Error'})`);
      }
    }
  }

  /**
   * The "departure approaching" trigger: a departure whose minutes crossed a
   * threshold between two reads of this watch (from more than the threshold
   * to the threshold or less). A departure seen for the first time (first
   * read, after a start, or appearing already close) is only learnt.
   */
  departuresSoon(watch, departures) {
    const key = this.fingerprint(watch);
    const before = this.soon.get(watch.slot);
    const previous = before && before.key === key ? before.minutes : null;
    const events = [];
    if (previous) {
      for (const d of departures) {
        const was = previous.get(d.id);
        if (was === undefined) continue;
        // The largest threshold first: the order of the crossings.
        for (const threshold of [...SOON_THRESHOLDS].reverse()) {
          if (was > threshold && d.minutes <= threshold) {
            events.push({
              threshold: String(threshold),
              minutes: d.minutes,
              route: d.label,
              route_id: d.route,
              headsign: d.headsign,
              departure_time: formatClock(d.at),
            });
          }
        }
      }
    }
    const minutes = new Map();
    for (const d of departures.slice(0, SOON_MEMORY_MAX)) minutes.set(d.id, d.minutes);
    this.soon.set(watch.slot, { key, minutes });
    return events.slice(0, SCENE_EVENTS_PER_READ);
  }

  isCreated(ids) {
    return !!this.gladys.devices?.some((device) => device.external_id === ids.device);
  }

  /**
   * The alerts of each watch that is due (every 5 min; a round within 5 s of
   * it counts), one request each; secondary, spaced out on failure. A watch
   * skipped (pause, stop not checked yet) stays due for the next round.
   */
  async readAllAlerts(gen, start) {
    for (const watch of this.config.watches) {
      if (gen !== this.gen) return;
      const due = this.alertsDue.get(watch.slot);
      if (due && start < due.dueMono - ALERTS_SLACK) continue;
      const refused = this.refusal(watch);
      if (refused) {
        this.recordFailure(watch, 'alerts', { kind: refused });
        continue;
      }
      if (this.pausedFor() > 0) {
        this.recordFailure(watch, 'alerts', { kind: 'paused' });
        continue;
      }
      const url = alertsUrl(watch, this.routeIdsOf(watch), this.apiBase);
      const answer = await this.call(url, gen);
      if (answer === null || gen !== this.gen) return;
      if (!answer.ok) {
        if (answer.kind !== 'paused') this.alertsFailed(watch, start);
        this.logger.warn(`Watch ${watch.slot}: alerts not read (${answer.kind})`);
        this.recordFailure(watch, 'alerts', answer);
        continue;
      }
      const fresh = this.freshness(answer);
      const read = fresh.kind ? null : readAlerts(answer.json);
      let kind = fresh.kind ?? null;
      if (!kind && !read) kind = 'format';
      if (!kind && read.unreadable) kind = 'unreadable';
      if (kind) {
        this.alertsFailed(watch, start);
        this.logger.warn(`Watch ${watch.slot}: alerts not published (${kind})`);
        this.recordFailure(watch, 'alerts', { kind, detail: fresh.detail });
        continue;
      }
      // Read even when the stop check failed (it never holds the alerts), but
      // "no alert" is only told for a stop the MBTA confirmed: not marked as
      // read, so read again at the next round until it is.
      if (read.alerts.length === 0 && !this.checked(watch)) {
        this.recordFailure(watch, 'alerts', { kind: 'alerts_unchecked' });
        continue;
      }
      this.alertsDue.set(watch.slot, { dueMono: start + ALERTS_INTERVAL, level: 0 });
      await this.onAlerts(watch, read.alerts, fresh.at, gen);
    }
  }

  /** A failed alerts read: the next one 5 min later, then doubled, bounded to 1 h. */
  alertsFailed(watch, start) {
    const level = Math.min((this.alertsDue.get(watch.slot)?.level ?? 0) + 1, 10);
    const delay = Math.min(ALERTS_INTERVAL * 2 ** (level - 1), ALERTS_RETRY_MAX);
    this.alertsDue.set(watch.slot, { dueMono: start + delay, level });
  }

  async onAlerts(watch, alerts, at, gen) {
    this.setResult(watch, 'alerts', {
      ok: true,
      readAt: at,
      readMono: this.monotonic(),
      count: alerts.length,
    });
    const ids = watchIds(this.gladys, watch);
    if (this.isCreated(ids)) {
      try {
        await this.bounded(() =>
          this.gladys.publishStates([
            { device_feature_external_id: ids.feature(FEATURES.ALERTS), state: alerts.length },
            {
              device_feature_external_id: ids.feature(FEATURES.ALERT_TEXT),
              text: alertText(alerts, this.config.language),
            },
          ]),
        );
      } catch (err) {
        this.logger.warn(`Watch ${watch.slot}: alerts not published (${err?.name ?? 'Error'})`);
      }
    }
    if (gen !== this.gen) return;
    await this.announceNew(watch, alerts, at, gen);
  }

  /**
   * The scene trigger: an alert seen for the first time at this watch,
   * created, updated or started within 2 h of the server time. The first
   * read of a watch (or of a changed one, or after an unreadable /data)
   * only learns what is there.
   */
  async announceNew(watch, alerts, at, gen) {
    const fingerprint = this.fingerprint(watch);
    const wall = this.now();
    const previous = this.persisted.watches[watch.slot];
    const baseline = !previous || previous.fingerprint !== fingerprint;
    const seen = baseline ? {} : previous.seen;
    const fresh = [];
    if (!baseline) {
      for (const alert of sortAlerts(alerts)) {
        if (seen[alert.id] !== undefined) continue;
        const started = alert.periods.map((p) => p.start).filter((s) => s <= at);
        const times = [alert.created, alert.updated, ...started].filter(
          (v) => v !== null && v <= at + 5 * MINUTE,
        );
        const latest = times.length > 0 ? Math.max(...times) : null;
        if (latest !== null && at - latest <= FRESH_ALERT) fresh.push(alert);
      }
    }
    for (const alert of alerts) seen[alert.id] = wall;
    // Bounded: entries not seen for 7 days go, then the oldest past SEEN_MAX.
    const kept = Object.entries(seen)
      .filter(([, when]) => wall - when <= SEEN_KEEP)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEEN_MAX);
    this.persisted.watches[watch.slot] = { fingerprint, seen: Object.fromEntries(kept) };
    const device = watchIds(this.gladys, watch).device;
    for (const alert of fresh.slice(0, SCENE_EVENTS_PER_READ)) {
      if (gen !== this.gen) return;
      try {
        await this.bounded(() =>
          this.gladys.publishSceneEvent(SCENE_TRIGGER, sceneData(device, alert)),
        );
      } catch (err) {
        this.logger.warn(`Watch ${watch.slot}: scene event not sent (${err?.name ?? 'Error'})`);
      }
    }
  }

  setResult(watch, part, value) {
    const fingerprint = this.fingerprint(watch);
    const before = this.results.get(watch.slot);
    const entry =
      before && before.fingerprint === fingerprint
        ? before
        : { fingerprint, dep: null, alerts: null };
    entry[part] = value;
    this.results.set(watch.slot, entry);
  }

  recordFailure(watch, part, result) {
    const fingerprint = this.fingerprint(watch);
    const before = this.results.get(watch.slot);
    const kept = before && before.fingerprint === fingerprint ? before[part] : null;
    this.setResult(watch, part, {
      ok: false,
      failure: { kind: result.kind, status: result.status, detail: result.detail },
      // The last success, for the status: data from then.
      lastOkAt: kept?.ok ? kept.readAt : (kept?.lastOkAt ?? null),
      lastOkMono: kept?.ok ? kept.readMono : (kept?.lastOkMono ?? null),
    });
  }

  startPause(result) {
    const pause = this.persisted.pause ?? NO_PAUSE();
    let duration;
    if (result.kind === 'rate') {
      pause.level429 = Math.min(pause.level429 + 1, 30);
      duration = PAUSE_429_FIRST * 2 ** (pause.level429 - 1);
    } else if (result.kind === 'server') {
      pause.level5xx = Math.min(pause.level5xx + 1, 30);
      duration = PAUSE_5XX_FIRST * 2 ** (pause.level5xx - 1);
    } else {
      // 400, 403, 404...: spaced out like a server error.
      pause.levelHttp = Math.min(pause.levelHttp + 1, 30);
      duration = PAUSE_5XX_FIRST * 2 ** (pause.levelHttp - 1);
    }
    pause.kind = result.kind;
    pause.status = Number.isInteger(result.status) ? result.status : null;
    if (Number.isFinite(result.retryAfter) && result.retryAfter > duration)
      duration = result.retryAfter;
    duration = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, duration));
    const mono = this.monotonic();
    this.pauseUntilMono = Math.max(this.pauseUntilMono ?? 0, mono + duration);
    pause.until = this.now() + (this.pauseUntilMono - mono);
    this.persisted.pause = pause;
  }

  // --- Status ----------------------------------------------------------------

  /** Departures older than this are said stale: 3 intervals, 5 minutes at least. */
  staleAfter() {
    return Math.max(3 * this.config.refreshSeconds * SECOND, 5 * MINUTE);
  }

  composeStatus() {
    const config = this.config;
    if (!config) return { connected: false, message: M.starting };
    const lines = { en: [], fr: [] };
    const push = (en, fr) => {
      lines.en.push(en);
      lines.fr.push(fr);
    };
    const mono = this.monotonic();
    const wall = this.now();
    const toWall = (m) => wall + (m - mono);
    const staleAfter = this.staleAfter();
    const alertsStale = ALERTS_RETRY_MAX + 10 * MINUTE;
    let anyOk = false;
    const paused = this.pausedFor(mono);
    if (paused > 0) {
      const kind = this.persisted.pause?.kind ?? 'rate';
      const status = this.persisted.pause?.status ?? null;
      push(
        `${failure(kind, status, 'en')}: reads paused until ${formatTime(wall + paused, 'en')}.`,
        `${failure(kind, status, 'fr')} : lectures en pause jusqu'à ${formatTime(wall + paused, 'fr')}.`,
      );
    }
    const why = (f) => {
      const text = { en: failure(f.kind, f.status, 'en'), fr: failure(f.kind, f.status, 'fr') };
      if (f.kind === 'clock' && Number.isFinite(f.detail)) {
        text.en += ` (${f.detail > 0 ? '+' : ''}${f.detail} min)`;
        text.fr += ` (${f.detail > 0 ? '+' : ''}${f.detail} min)`;
      }
      return text;
    };
    const since = (r, limit) =>
      r.lastOkAt !== null
        ? {
            en: `; last data ${formatTime(r.lastOkAt, 'en')}${mono - r.lastOkMono > limit ? ', stale' : ''}, nothing published since`,
            fr: ` ; dernières données ${formatTime(r.lastOkAt, 'fr')}${mono - r.lastOkMono > limit ? ', périmées' : ''}, rien publié depuis`,
          }
        : { en: '; no data yet', fr: ' ; pas encore de données' };
    const names = this.stopNames();
    for (const watch of config.watches) {
      const name = {
        en: watchLabel(watch, 'en', names.get(watch.stop)),
        fr: watchLabel(watch, 'fr', names.get(watch.stop)),
      };
      const result = this.results.get(watch.slot);
      const dep = result?.dep ?? null;
      const alerts = result?.alerts ?? null;
      let depText;
      if (!dep) depText = { en: 'departures not read yet', fr: 'départs pas encore lus' };
      else if (dep.ok) {
        const stale = mono - dep.readMono > staleAfter;
        if (!stale) anyOk = true;
        const next = dep.next
          ? {
              en: `next in ${dep.next.minutes} min (${dep.next.label})`,
              fr: `prochain dans ${dep.next.minutes} min (${dep.next.label})`,
            }
          : { en: 'no predicted departure', fr: 'aucun départ prévu' };
        depText = {
          en: `${next.en}, ${dep.count} departure(s) within 60 min, read ${formatTime(dep.readAt, 'en')}${stale ? ' (stale)' : ''}`,
          fr: `${next.fr}, ${dep.count} départ(s) dans les 60 min, lu ${formatTime(dep.readAt, 'fr')}${stale ? ' (périmé)' : ''}`,
        };
      } else {
        const w = why(dep.failure);
        if (dep.failure.kind === 'route_missing') {
          const missing = this.routeInfo.get(routesKey(watch))?.missing ?? [];
          w.en += ` (${missing.join(', ')})`;
          w.fr += ` (${missing.join(', ')})`;
        }
        const s = since(dep, staleAfter);
        depText = { en: `departures: ${w.en}${s.en}`, fr: `départs : ${w.fr}${s.fr}` };
      }
      let alertsText;
      if (!alerts) alertsText = { en: 'alerts not read yet', fr: 'alertes pas encore lues' };
      else if (alerts.ok) {
        const stale = mono - alerts.readMono > alertsStale;
        alertsText = {
          en: `${alerts.count} alert(s), read ${formatTime(alerts.readAt, 'en')}${stale ? ' (stale)' : ''}`,
          fr: `${alerts.count} alerte(s), lu ${formatTime(alerts.readAt, 'fr')}${stale ? ' (périmé)' : ''}`,
        };
      } else {
        const w = why(alerts.failure);
        const s = since(alerts, alertsStale);
        alertsText = { en: `alerts: ${w.en}${s.en}`, fr: `alertes : ${w.fr}${s.fr}` };
      }
      push(
        `${name.en}: ${depText.en}; ${alertsText.en}.`,
        `${name.fr} : ${depText.fr} ; ${alertsText.fr}.`,
      );
    }
    // Devices of stops no longer watched (a slot given another stop): never
    // updated again, their last values stay in Gladys until deleted there.
    const current = new Set(config.watches.map((w) => watchIds(this.gladys, w).device));
    const prefix = watchPrefix(this.gladys);
    const old = (this.gladys.devices ?? []).filter(
      (d) =>
        typeof d?.external_id === 'string' &&
        d.external_id.startsWith(prefix) &&
        !current.has(d.external_id),
    );
    if (old.length > 0) {
      const names = old.map((d) => d.name).join(', ');
      push(
        `Not updated any more (stop no longer in the configuration), delete in Gladys: ${names}.`,
        `Plus mis à jour (arrêt retiré de la configuration), à supprimer dans Gladys : ${names}.`,
      );
    }
    if (this.checkFailure) {
      const w = why(this.checkFailure);
      push(
        `Stop check: ${w.en}; tried again later (departures read meanwhile).`,
        `Vérification des arrêts : ${w.fr} ; nouvel essai plus tard (départs lus en attendant).`,
      );
    }
    if (this.nextDueMono !== null) {
      push(
        `Next read ${formatTime(toWall(this.nextDueMono), 'en')}.`,
        `Prochaine lecture ${formatTime(toWall(this.nextDueMono), 'fr')}.`,
      );
    }
    if (config.errors.length > 0) {
      const errors = configErrors(config.errors);
      push(`Configuration: ${errors.en}.`, `Configuration : ${errors.fr}.`);
    }
    if (this.dataTells === false && this.lastAttemptMono === null) {
      push(
        '/data does not tell when the MBTA was last read: the first read waits 30 s after the start.',
        '/data ne dit pas quand le MBTA a été lu : la première lecture attend 30 s après le démarrage.',
      );
    }
    if (this.saveFailed) {
      push(
        'The time of the last read could not be written in /data: a restart may read sooner than the interval.',
        "L'heure de la dernière lecture n'a pas pu être écrite dans /data : un redémarrage peut lire plus tôt que l'intervalle.",
      );
    }
    if (this.storeStatus === 'unreadable') {
      push(
        'The state file of /data is unreadable: left untouched, the integration runs from memory.',
        "Le fichier d'état de /data est illisible : laissé tel quel, l'intégration tourne en mémoire.",
      );
    }
    const message = {};
    for (const lang of LANGS)
      message[lang] = [...lines[lang].join(' ')].slice(0, STATUS_MAX).join('');
    return { connected: anyOk, message };
  }

  async updateStatus(gen) {
    const { connected, message } = this.composeStatus();
    await this.setStatus(connected, message, gen);
  }

  async setStatus(connected, message, gen) {
    if (gen !== this.gen) return;
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    try {
      await this.bounded(() => this.gladys.setConnectionStatus(connected, message));
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not published (${err?.name ?? 'Error'})`);
    }
  }
}

/** The flat data of the scene trigger (≤ 30 keys, texts bounded). */
export function sceneData(device, alert) {
  const text = (value) => [...String(value ?? '')].slice(0, SCENE_TEXT_MAX).join('');
  return {
    device,
    alert_id: text(alert.id),
    effect: effectOf(alert),
    severity_band: bandOf(alert),
    severity: alert.severity,
    header: text(alert.header),
    description: text(alert.description),
    cause: text(alert.cause),
    lifecycle: text(alert.lifecycle),
    timeframe: text(alert.timeframe),
    url: text(alert.url),
  };
}
