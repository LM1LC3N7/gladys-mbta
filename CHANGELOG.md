# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Up to five watched MBTA stops (station, platform or bus stop; optional route filter and direction), each one a
  Gladys device: next and following departure in minutes, predicted departures within 60 minutes, a departures
  summary, the alerts in effect and the text of the most severe one, from the public MBTA V3 API (no account, no
  key).
- Scene trigger "New MBTA alert at a stop", filtered by stop, effect and severity.
- A button that shows the last read of each stop and the next one.
- Courtesy toward the MBTA: one request at a time, 3 s apart, a hold when its rate limit runs low; pauses after a
  429 or a 5xx, kept across restarts; no read sooner than the interval after a restart.
- Nothing published from a failed, unreadable or stale answer, nor "no departure" for a stop the MBTA has not
  confirmed.
