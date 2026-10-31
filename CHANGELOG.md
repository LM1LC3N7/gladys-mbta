# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-31

### Added

- Up to five watched MBTA stops (station, platform or bus stop; optional route filter and direction), each one a
  Gladys device: next and following departure (texts with the minutes and the time), predicted departures within 60 minutes, a departures
  summary, the alerts in effect and the text of the most severe one, from the public MBTA V3 API (no account, no
  key).
- Scene triggers "MBTA departure approaching" (1 to 15 minutes) and "New MBTA alert at a stop" (effect,
  severity), each for a chosen stop.
- A button that shows the last read of each stop and the next one.
- Courtesy toward the MBTA: one request at a time, 3 s apart, a hold when its rate limit runs low; pauses after a
  429 or a 5xx, kept across restarts; no read sooner than the interval after a restart.
- Nothing published from a failed, unreadable or stale answer, nor from an answer dated more than 5 minutes away
  from the local clock, nor "no departure" for a stop the MBTA has not confirmed.

[Unreleased]: https://github.com/LM1LC3N7/gladys-mbta/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-mbta/releases/tag/v0.1.1
