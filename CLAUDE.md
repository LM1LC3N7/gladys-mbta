# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        MbtaApp: rounds, pace (3 s gap, rate hold, pauses), freshness, status, scene trigger
src/mbta.js                       one bounded GET of the MBTA V3 API (JSON:API Accept), strict reading of the resources
src/watch.js                      what a stop sees: its departures (platforms, routes, direction), minutes, texts
src/config.js                     strict reading of the configuration (manifest `config_schema`)
src/devices.js                    one read-only device per watched stop (id = slot)
src/i18n.js                       every text, English and French
src/store.js                      /data state (last attempt, pause, alerts seen), never overwritten if unreadable
gladys-assistant-integration.json manifest: name, config_schema, actions, scene trigger, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys of the SDK, virtual clock (test/kit), captured fixtures
scripts/cover.mjs                 generates cover.png (800x534), plain Node
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

MBTA rules kept by the code: the `Accept: application/vnd.api+json` header (the API answers 406 otherwise); one
request at a time, 3 s between two starts, a hold when `x-ratelimit-remaining` runs low; never sooner than the
interval (restart, reconnection, unchanged configuration, Discovery, test button; a restart whose /data cannot
tell the last attempt waits 30 s); 429 and 5xx pauses kept in
/data; minutes counted against the `Date` of the answer, which must be within 5 minutes of the local clock; next and
following departure are texts (Gladys cannot clear a number); device id = slot and stop; nothing published for a failed, unreadable or stale
answer (`Last-Modified` more than 10 minutes before `Date`), nor "no departure" for an unconfirmed stop.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set by hand once, see TODO.md). `test/manifest.test.js`
  checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
