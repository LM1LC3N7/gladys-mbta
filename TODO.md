# TODO

## Before announcing

- [ ] Install it on a real Gladys 5.1+ and add a stop: device creation, the departure texts and the summary in the
      dashboard, the scene trigger in the scene editor.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store (after the first release: the store
      validator needs the GHCR image).
- [ ] Store metadata kept out of the manifest (no `keywords` / `countries` fields): countries US; keywords
      MBTA, Boston, subway, bus, commuter rail, transit, departures, T.

## To confirm over time on the live API

- [ ] A daytime capture in the fixtures: the reviewer parsed a rush-hour answer (434 and 656 predictions, all read,
      07:00 ET on 2026-10-30); the fixtures stay the 02:00 ET capture plus synthetic predictions of the same shape.
- [ ] `MAX_ITEMS` (2000, the whole answer refused beyond): 656 predictions and 609 included resources for 5 big
      stations at rush hour (review r1, m8): a margin of 3.
- [ ] Whether the MBTA ever answers 304 to `If-Modified-Since`: on 2026-10-30 its `Last-Modified` moved every few
      seconds, even for an empty list, so every conditional request got a 200.
- [ ] `Last-Modified` through the night: seen moving every few seconds from 02:57 to 04:00 ET (review r1, 68 samples);
      if it ever stops when no vehicle runs, the status says "frozen feed" and nothing is published (the safe side).
- [x] The MassDOT Developers License Agreement, read by the reviewer from the MBTA's own link
      (https://cdn.mbta.com/sites/default/files/2023-08/mbta-massdot-develop-license-agreement.pdf): use, reproduction
      and redistribution allowed (§3.1), MassDOT acknowledged as the provider (§4.1: "Data: MassDOT / MBTA" in the
      intro, the docs, the README and the notices), revocable without notice (§5).
- **Version 0.1.0** set by hand in package.json, package-lock.json, the manifest and its `docker_image`
  (`ghcr.io/lm1lc3n7/gladys-mbta:0.1.0`).
- **SDK `^0.16.0`**, the latest published (checked on the npm registry on 2026-10-30): no change needed for a
  read-only device integration.
- **No API key** in 0.1.0: one predictions request per interval for every stop plus the alerts every 5 minutes
  stays far under the 20 requests per minute of the keyless API; no secret to keep.
- **No `location: true`**: the stops are typed (the id is at the end of the stop page on mbta.com).
- **One device per slot and stop** (`watch:<slot>-<stop id>`, review r1 I2): another stop in a slot is another
  device, never the old device with the values of the old stop. The device of the old stop is no longer updated:
  the status names it under "Not updated any more" (it can only be deleted in Gladys). The route filter and the
  direction keep the device (every read publishes every value again). The scene trigger starts a new baseline for
  a changed watch (salted fingerprint in `/data`).
- **`Accept: application/vnd.api+json`** on every request (the API answers 406 to `text/html`, checked live).
- **Freshness**: an answer is used only when its `Date` is within 5 minutes of the local clock (review r1 I1: a
  wrong clock, or an old copy served by a cache or replayed, consistent in itself, is never fresh; the status says
  "differs from the clock of this machine (+N min)") and its `Last-Modified` at most 10 minutes before `Date` (and
  at most 1 minute after). On the live API it moves every few seconds, for every endpoint. A 304 reuses the
  previous answer with its own `Last-Modified`. The read times of the status are the server's `Date`; the next
  read and the end of a pause come from the local clock (said in the docs).
- **Minutes** = whole minutes until the `departure_time`, counted against the `Date` of the answer, rounded down;
  a departure up to 1 minute in the past is 0 ("leaving now"); no `departure_time` (last stop of the trip),
  `CANCELLED` and `SKIPPED` are not departures; a time more than 24 h ahead is ignored.
- **Next and following departure are texts** (review r1 I2): Gladys cannot clear a number, so a numeric "minutes"
  value would stay on the dashboard after its departure is gone (no departure, or only one). The texts say the
  route, the destination, the minutes and the clock time of the departure, or "No predicted departure / No
  following departure (read hh:mm)"; every read publishes both. Never an invented number (999). The counter of
  departures within 60 minutes stays numeric, for the scenes, and the trigger "MBTA departure approaching"
  (1, 2, 3, 5, 10, 15 min) replaces the numeric comparisons: a departure crossing a threshold between two reads
  of the watch (a departure seen for the first time is only learnt; at most 10 events per read; the memory is per
  process and per watch, forgotten when the watch changes).
- **"No departure" and "no alert" need a confirmed stop**: until `/stops` (and `/routes` for a route filter)
  confirmed the stop, an empty answer publishes nothing; departures or alerts that are there are published (the
  stop exists). A failed check never holds the departures nor the alerts (review r1 m3); an unchecked empty
  alerts answer is read again at the next round. A stop the MBTA does not know, or a route not calling at it, is
  refused in the status; checked again after 30 minutes. A failed check: retried after 1 minute, doubled, 30
  minutes at most (a 429 pauses every read, as everywhere).
- **A station** (`location_type` 1, or a stop not checked yet) sees the predictions of its platforms through
  their `parent_station` in the `included` stops; a prediction whose platform is not described makes the answer
  "incomplete" for it (nothing published) rather than fewer departures.
- **One unreadable prediction or alert refuses the whole answer** (it could be the next departure, or an alert
  missing from the count).
- **Pauses**: a 429 anywhere pauses every read (2 min doubled, or until `x-ratelimit-reset` / `Retry-After` when
  later); a 5xx or another unexpected status (400, 403, 404, 406…) of the departures pauses every read (1 min
  doubled); 6 h at most, kept in /data; a shorter pause never replaces a longer one; a refusal arriving after a
  config save or a reconnection still pauses. `Retry-After` of any length, bounded to 6 h. A failure of the alerts
  (any but 429) is spaced out for that stop only (5 min, doubled, 1 h at most); a network error or a timeout never
  pauses. When `x-ratelimit-remaining` is 2 or less, the next request waits for `x-ratelimit-reset` (65 s at most).
- **Gladys calls bounded to 10 s** (review r1 m4), and the next round is armed at the start of a round: a Gladys
  that does not answer never holds the reads; a round still running when the next is due delays it, never two at
  once.
- **Alerts**: `filter[datetime]=NOW` (in effect now) with the stop, the resolved routes and the direction; read
  every 5 minutes per stop (a round within 5 s of it counts); a stop skipped (pause, not checked) stays due for
  the next round.
- **Scene trigger**: an alert new to the watch, created, updated or started within 2 h of the server time; the
  first read only learns; at most 10 events per stop and read; ids kept 7 days (500 at most) in /data.
- **/data that cannot tell the last attempt** (unreadable, date in the future, not writable): the first read waits
  30 s (the minimum interval) after the process start. /data saves are bounded to 2 s and never hold a round.
- **`connected`**: at least one stop whose last departures read succeeded within 3 intervals (5 minutes at least).
- **Test button = last read**: it never reads.
- **Checked live on 2026-10-30** (02:12 ET): five stops (Park Street, bus stop 1, South Station with
  `CR-Worcester`, Harvard with `red,1` and direction 1, an unknown id): 8 requests in the first round, the rate
  limit headers seen (20 per minute), names, departures, alerts, the route `1` refused at Harvard, the unknown id
  refused. Then installed in the sandbox Gladys (`gi install`, RUNNING) with two stops saved through its API
  (the empty fields arrive as `null`): Discovery (2 devices, 6 features each), status and test button OK; the
  sandbox integration was stopped afterwards so it does not keep polling the MBTA. Device creation from the
  Discovery tab was not tried there.
- **Mutation** (120 mutants of the guards at milestone 1; after review r1 the reviewer's 105 and 19 more on the
  new code, one at a time): all killed but equivalent ones, guards kept: the 1-minute floor of a pause (every
  first pause is 1 minute or more), the explicit `null` test of `Last-Modified` (a null compares as stale
  anyway), the explicit "no departure time" skip (a null time falls in the "already left" test), the explicit
  "departure not seen before" skip of the approaching trigger (`undefined > n` is false), the arming of the next
  round at its start and again at its end (each alone keeps the period, the Gladys calls being bounded), and the
  reviewer's P10, P12, P23, L2 and L14 (guards doubled).
