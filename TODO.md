# TODO

## Before announcing

- [ ] Install it on a real Gladys 5.1+ and add a stop: device creation, the minutes and the summary in the
      dashboard, the scene trigger in the scene editor.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store (after the first release: the store
      validator needs the GHCR image).
- [ ] Store metadata kept out of the manifest (no `keywords` / `countries` fields): countries US; keywords
      MBTA, Boston, subway, bus, commuter rail, transit, departures, T.

## To confirm over time on the live API

- [ ] A daytime capture (Red Line, buses, commuter rail): the fixtures were captured at 02:00 ET, when only the
      Green Line ran; the synthetic predictions of the tests follow the same shape.
- [ ] Whether the MBTA ever answers 304 to `If-Modified-Since`: on 2026-10-30 its `Last-Modified` moved every few
      seconds, even for an empty list, so every conditional request got a 200.
- [ ] `Last-Modified` through the night (03:00-05:00 ET): if the MBTA data stops moving when no vehicle runs, the
      status says "frozen feed" and nothing is published until it moves again (the safe side).
- [ ] The full text of the MassDOT Developers License Agreement: mass.gov answered an HTML page instead of the PDF
      to a non-browser client on 2026-10-30 (no attempt to get around it).

## Decisions

- **Version 0.1.0** set by hand in package.json, package-lock.json, the manifest and its `docker_image`
  (`ghcr.io/lm1lc3n7/gladys-mbta:0.1.0`).
- **SDK `^0.16.0`**, the latest published (checked on the npm registry on 2026-10-30): no change needed for a
  read-only device integration.
- **No API key** in 0.1.0: one predictions request per interval for every stop plus the alerts every 5 minutes
  stays far under the 20 requests per minute of the keyless API; no secret to keep.
- **No `location: true`**: the stops are typed (the id is at the end of the stop page on mbta.com).
- **One device per watched stop, id = the slot** (`watch:1..5`): changing the stop of a slot keeps the device;
  the scene trigger starts a new baseline for a changed stop (salted fingerprint in `/data`).
- **`Accept: application/vnd.api+json`** on every request (the API answers 406 to `text/html`, checked live).
- **Freshness**: an answer is used only with a believable `Date` (within 24 h of the local clock) and a
  `Last-Modified` at most 10 minutes before it (and at most 1 minute after). On the live API it moves every few
  seconds, for every endpoint. A 304 reuses the previous answer with its own `Last-Modified`.
- **Minutes** = whole minutes until the `departure_time`, counted against the `Date` of the answer, rounded down;
  a departure up to 1 minute in the past is 0 ("leaving now"); no `departure_time` (last stop of the trip),
  `CANCELLED` and `SKIPPED` are not departures; a time more than 24 h ahead is ignored.
- **No departure predicted**: the counter is 0 and the summary says it; the two minute values are not published
  (no invented value such as 999). The summary starts with its read time so an old one shows its age.
- **"No departure" needs a confirmed stop**: until `/stops` (and `/routes` for a route filter) confirmed the stop,
  an empty answer publishes nothing and no alert is read; departures that are there are published (the stop
  exists). A stop the MBTA does not know, or a route not calling at it, is refused in the status; checked again
  after 30 minutes. A failed check: retried after 1 minute, doubled, 30 minutes at most; it never holds the
  departures (a 429 pauses every read, as everywhere).
- **A station** (`location_type` 1, or a stop not checked yet) sees the predictions of its platforms through
  their `parent_station` in the `included` stops; a prediction whose platform is not described makes the answer
  "incomplete" for it (nothing published) rather than fewer departures.
- **One unreadable prediction or alert refuses the whole answer** (it could be the next departure, or an alert
  missing from the count).
- **Pauses**: a 429 anywhere pauses every read (2 min doubled, or until `x-ratelimit-reset` / `Retry-After` when
  later); a 5xx or another unexpected status of the departures pauses every read (1 min doubled); 6 h at most,
  kept in /data; a refusal arriving after a config save or a reconnection still pauses. A failure of the alerts
  (any but 429) is spaced out for that stop only (5 min, doubled, 1 h at most); a network error or a timeout never
  pauses. When `x-ratelimit-remaining` is 2 or less, the next request waits for `x-ratelimit-reset` (65 s at most).
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
- **Mutation** (120 mutants of the guards, in a temporary copy): all killed but 3 equivalent ones, guards kept:
  the 1-minute floor of a pause (every first pause is 1 minute or more), the explicit `null` test of
  `Last-Modified` (a null compares as stale anyway), and the explicit "no departure time" skip (a null time falls
  in the "already left" test).
