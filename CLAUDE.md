# Flightmon

Read `docs/notes.md` first: decisions, what we've found out about each data
source, gotchas, reference projects, the feature backlog, history and open
questions. Keep it up to date in the same commit as each change: add
decisions the user makes (and things deliberately left out), findings about
services, gotchas that cost time, new feature ideas, and a history line.
Date each entry.

## Git

- Commit and push directly to `main`, even when a session is assigned its
  own branch. No feature branches or pull requests unless asked for.
- Run `npm test` before pushing. For page changes, also run the browser
  check against `npm run dev` and look at its screenshots:
  `NODE_PATH=$(npm root -g) node scripts/browser-check.cjs <dir>`.

## Deploying

Not deployed yet. Develop and verify against the local Worker
(`npm run dev`, i.e. `wrangler dev`) until the user is satisfied; the user
decides when to deploy to Cloudflare. Don't deploy or set up Cloudflare
until asked.

## Rules

- Don't build anything that can't be verified. If a feed or service can't be
  reached, say why rather than working around it.
- Inspired by FlightScnr_Pi (CC BY-NC-SA): take ideas only, no code or images.
- Target is a browser on a laptop. Keep it minimal; routes, photos, weather
  etc. only when asked for.
- Prefer free dependencies that need no API key.
- Units are metric (m, km, km/h).

## Gotchas when changing code

- Workers treat every named export of `src/worker.js` as an entrypoint and
  refuse anything that isn't a handler, so keep that file to a default export.
- A tile server can answer 200 with a placeholder image: look at a tile, not
  just the status.
