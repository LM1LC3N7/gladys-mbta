# MBTA Boston

The **next departures** (subway, light rail, bus, commuter rail, ferry) and
the **service alerts** at up to five stops of the MBTA (Boston area), in
Gladys.

This integration is unofficial: it is not affiliated with the MBTA nor
MassDOT, and it is **not an official source**. Check mbta.com or the stop
signs before you travel. It has never been tested on a real Gladys
installation by its author; it was checked against the live MBTA API.

## Get started in 3 steps

No account and no key: there is nothing to create.

1. **Find the id of your stop.** Open the stop on
   [mbta.com](https://www.mbta.com/stops): the id is the end of the address
   of its page. `mbta.com/stops/place-pktrm` is Park Street (a station: all
   its platforms), `mbta.com/stops/1` is a bus stop.
2. **Install the integration** from the catalog, open its configuration and
   type the id in **Stop 1 → Stop id**. Save.
3. Open the **Discover** tab and press **Add** on the stop. Its name is the
   MBTA name of the stop (e.g. "MBTA – Park Street") once the integration has
   checked it, or the name you typed.

The message at the top of the configuration page tells where each stop
stands, e.g. "MBTA – Park Street: next in 4 min (Red Line), 9 departure(s)
within 60 min, read Oct 30, 08:05 ET; 0 alert(s), read Oct 30, 08:05 ET."
The **Show the last read** button shows the same message; it never reads the
MBTA itself.

### Choosing what you see

| Field             | Example       | Meaning                                               |
| ----------------- | ------------- | ----------------------------------------------------- |
| Stop id           | `place-pktrm` | a station: every platform                             |
| Stop id           | `70075`       | one platform (here Park Street, Red Line southbound)  |
| Only these routes | `Red`         | the Red Line only                                     |
| Only these routes | `1, 47`       | buses 1 and 47 (route id or number shown on the bus)  |
| Direction         | `0` or `1`    | 0: outbound, south or west; 1: inbound, north or east |

Each route of the filter must call at the stop: the integration checks it
with the MBTA once, and a route that does not call there is refused (the
status names it), so that an unknown stop or route is not shown as "no
departure".

## What each device holds

- **Next departure** and **Following departure**: the minutes to wait, counted
  against the time of the MBTA server. 0 means "leaving now".
- **Predicted departures (60 min)**: how many departures the MBTA predicts at
  the stop within the next hour.
- **Departures**: a summary that starts with the time of the read, e.g.
  `08:05 · Red Line → Ashmont 4, 11 min · Red Line → Alewife 6 min`.
- **Alerts in effect**: how many MBTA alerts are in effect now for the stop
  (and its routes and direction when you filtered them).
- **Alert**: the text of the most severe one, e.g. "Shuttle buses replace Red
  Line service… (1 more alert)", or "No alert".

Stop names and alert texts come in English, the only language of the MBTA
API. The device names and the summary follow the language you choose.

## What the numbers are, and are not

- The departures are the **MBTA real-time predictions**. A trip the MBTA does
  not track yet is not counted: a bus that has not left its terminal, a
  commuter rail train far ahead. "No predicted departure" does not mean "no
  service"; at night it often means the service has ended.
- When no departure is predicted, the counter shows 0 and the summary says
  so; the two minute values are not published and keep their last value: the
  read time at the start of the summary tells how old they are.
- A stop is counted at 0 only when the MBTA has confirmed the stop (and the
  routes of the filter). Until then an empty answer publishes nothing.
- **Nothing is published** (no 0, no old value sent again) when a read fails,
  when the answer cannot be read, when it carries no usable server time, or
  when the MBTA data behind it is more than 10 minutes old (a frozen
  real-time feed). The configuration page then says so, with the time of the
  last good data.

## Scenes

**Trigger "New MBTA alert at a stop"**: an alert in effect appears at a
watched stop for the first time, and it was created, updated or started
within the last 2 hours. Filter on the stop, the effect (delay, shuttle,
suspension, detour, stop or station closed…) and the severity (severe 7 to
10, moderate 4 to 6, minor 0 to 3). The first read of a stop only learns the
alerts already there. The scene gets the alert text, its effect, severity,
cause, timeframe and link.

The device values work in the usual scenes of Gladys too, e.g. "when the next
departure of the bus stop goes under 6 minutes, turn the hall light on".

## Pace and courtesy toward the MBTA

The MBTA allows 20 requests per minute without a key. The integration sends
one request at a time, 3 seconds apart at least:

- the departures of **every** stop in one request, at the interval you choose
  (60 seconds by default, 30 to 600);
- the alerts every 5 minutes, one request per stop;
- the check of the stops (name, routes) once, then again 30 minutes later for
  a stop or a route the MBTA did not know (1 minute after a failed check,
  doubled each time, 30 minutes at most).

When the MBTA says its limit is near, the next request waits for the end of
the minute. A "429" (too many requests) pauses every read for 2 minutes,
doubled each time, or until the MBTA limit resets when that is later; a server
error on the departures pauses the reads too (1 minute, doubled each time).
A pause lasts 6 hours at most. The pause is kept across a
restart, and a restart waits for the interval after the last read (30 seconds
after the start when `/data` cannot tell when that was). A failure of the
alerts or of the stop check, other than a 429, never holds the departures.

## Troubleshooting

| Message                                            | What to do                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "the MBTA does not know this stop id"              | Check the id at the end of the stop page on mbta.com.                                        |
| "a route of the filter does not call at this stop" | Fix or remove the route named in the message (use the route id or the bus number).           |
| "the stop could not be checked yet"                | The MBTA was not reachable for the check; it is tried again, the departures are read anyway. |
| "frozen feed"                                      | The MBTA real-time data is not updated; nothing is published until it is.                    |
| "MBTA asked to slow down (429)"                    | Another program on your network may use the MBTA API too; the reads resume by themselves.    |
| A stop stays at "No predicted departure"           | Normal at night, or for a route whose next trip is not tracked yet.                          |

## Privacy, data and licences

- No account, no key, no location: only the stop ids you type are sent to
  the MBTA, in the address of the requests.
- MBTA data (`api-v3.mbta.com`), used under the
  [MassDOT Developers License Agreement](https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf).
- Integration code: Apache 2.0 licence.
