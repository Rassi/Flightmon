# Flightmon

## Git

- Commit and push directly to `main`, even when a session is assigned its
  own branch. No feature branches or pull requests unless asked for.
- `main` is meant to deploy to Cloudflare on every push, so run `npm test`
  before pushing, and for page changes also check the page in the
  pre-installed headless Chromium against `npm run dev`.

## Rules

- Don't build anything that can't be verified. If a feed or service can't be
  reached, say why rather than working around it.
- Inspired by FlightScnr_Pi (CC BY-NC-SA): take ideas only, no code or images.
- Target is a browser on a laptop. Keep it minimal; routes, photos, weather
  etc. only when asked for.
- Units are metric (m, km, km/h).

## Things learned

- adsb.lol and adsb.fi send no CORS headers, hence the Worker in `src/`.
  airplanes.live requires contacting them first; planespotters.net rejects
  generic User-Agents.
- Workers treat every named export of `src/worker.js` as an entrypoint and
  refuse anything that isn't a handler, so keep that file to a default export.
