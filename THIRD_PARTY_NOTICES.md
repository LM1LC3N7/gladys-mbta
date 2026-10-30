# Third-party notices

## MBTA data (Massachusetts Bay Transportation Authority)

The integration reads, at run time, the MBTA V3 API (https://api-v3.mbta.com/). The use of MBTA data is governed
by the MassDOT Developers License Agreement
(https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf), as stated on
https://www.mbta.com/developers. Each user of the integration reads the API from their own Gladys.

The test fixtures in `test/fixtures/` are trimmed copies of answers of that API captured on 2026-10-30 (stop,
route and prediction resources; the alert texts were replaced by synthetic texts). They serve the tests only and
are not shipped in the Docker image.

No code of the MBTA is used: the client is written from the API documentation
(https://api-v3.mbta.com/docs/swagger) and the observed answers. The integration is not endorsed by the MBTA nor
by MassDOT, and uses neither their names as a brand nor their logos.

## gladys-testkit

`test/kit/clock.mjs` is copied from gladys-testkit (Apache-2.0, same author as this repository).

## npm dependencies

The only runtime dependency is `@gladysassistant/integration-sdk` (Apache-2.0); its license ships in
`node_modules/@gladysassistant/integration-sdk/LICENSE` of the image.
