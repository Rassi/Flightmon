# Flightmon

A live flight radar in the browser: the aircraft around a location on a simple
radar, and in a list sorted by distance. Updated every 5 seconds.

Inspired by [FlightScnr Pi](https://github.com/yashmulgaonkar/FlightScnr_Pi)
(ideas only; no code or images are taken from it).

- **Radar**: range rings, north up, each aircraft at its distance and
  direction, pointing along its track. Aircraft on the ground are grey and
  unlabelled. Emergencies (7500/7600/7700) are red.
- **List**: callsign and registration, type, altitude (with ↑/↓ when climbing
  or descending), ground speed, distance and direction. Hover a row to find the
  aircraft on the radar.
- **Units**: metric (m, km/h, km).

## How it works

The aircraft come from the free community feeds
[adsb.lol](https://api.adsb.lol/docs) and, if that fails,
[adsb.fi](https://github.com/adsbfi/opendata). Neither sends CORS headers, so a
web page can't call them directly. A small [Cloudflare Worker](https://developers.cloudflare.com/workers/)
does it instead: it serves the page from `public/` and answers
`/api/aircraft?lat=…&lon=…&radius=…` (radius in km, at most 463) with a trimmed,
metric list sorted by distance.

```
src/worker.js    Worker entry point (routing only)
src/api.js       /api/aircraft: parameters, feed fallback
src/aircraft.js  feed data → the list the page needs
src/geo.js       distance and bearing
public/          the page: index.html, app.js, radar.js, format.js, style.css
```

Altitudes are pressure altitudes, as the feeds report them, so a plane close to
the ground can show a few metres below zero on a high-pressure day. Airport
ground stations and vehicles, which also transmit, are left out, as are
aircraft whose last position is over a minute old.

## Running it locally

You need [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install
npm run dev
```

Open <http://localhost:8787>, then type a latitude and longitude (pasting
`55.6761, 12.5683` from a map into the latitude field also works) or press
*Use my location*. The location is remembered in the browser and put in the
address, so it can be bookmarked:
`http://localhost:8787/?lat=55.6761&lon=12.5683&range=50`.

## Putting it online

It runs on Cloudflare's free plan; one screen refreshing every 5 seconds is
about 17,000 requests a day, against a limit of 100,000.

- **From GitHub**: in the Cloudflare dashboard, create a Worker by importing
  this repository. Cloudflare then deploys every push to `main`.
- **From your computer**: `npx wrangler login`, then `npm run deploy`.

The Worker's `workers.dev` address is public. Your location isn't stored in
the code, only in your browser, but anyone with the address can use the radar.
Cloudflare Access can restrict it if needed.

## Tests

```sh
npm test
```

The tests use real responses from both feeds, saved in `test/fixtures/`, and
check distances and directions against the ones the feeds compute themselves.
