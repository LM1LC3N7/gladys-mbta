# gladys-mbta

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the **MBTA** (Boston area): the next
departures (subway, light rail, bus, commuter rail, ferry) and the service alerts at your stops, read from the
public [MBTA V3 API](https://www.mbta.com/developers/v3-api). No account, no API key.

> This integration is not an official source and is not affiliated with the MBTA or MassDOT. Before you travel,
> check [mbta.com](https://www.mbta.com/) or the stop signs.

MBTA data is used under the MassDOT Developers License Agreement.

- Up to five watched stops (a station, a platform or a bus stop, optionally limited to some routes and one
  direction), one Gladys device each: next and following departure (minutes), predicted departures within 60
  minutes, alerts in effect (counters), a departures summary and the most severe alert (texts).
- A scene trigger "New MBTA alert at a stop" (filters: stop, effect, severity).
- One predictions request for every stop per interval (30 to 600 s), the alerts every 5 minutes, one request at
  a time, 3 s apart, under the 20 requests per minute of the keyless API; pauses after a 429 or a 5xx, kept
  across restarts.
- Nothing is published from a failed, unreadable or stale answer (MBTA data more than 10 minutes old), never 0.
- Tested against the live MBTA API on 2026-10-30; not yet tested by a user in Boston.

User documentation: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm test               # node --test (virtual clock, scripted MBTA; one test on the real clock x20)
npm run lint
npm run format:check
node scripts/cover.mjs cover.png
```

Tests never reach the Internet: answers captured on the live API on 2026-10-30 (trimmed, alert texts replaced)
are in `test/fixtures/`, and the real-clock test serves answers from a local HTTP server.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
