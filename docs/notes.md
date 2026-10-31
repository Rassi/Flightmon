# Flightmon notes

What we've decided, what we've found out, and what could come next. Read
this at the start of a session; add to it whenever something is learned or
decided (with the date), in the same commit as the change it belongs to:

- **Decisions**: what the user chose, and choices made on their behalf
  (including things deliberately left out, and why).
- **Findings**: how a service or data source actually behaved when tried.
- **Gotchas**: things that cost time or nearly went wrong, so they don't again.
- **Backlog**: feature ideas, and their status.
- **History**: one line per change of note.

## Decisions

| Date | Decision |
| --- | --- |
| 2026-10-30 | Target: a browser on a laptop. Old iPads out of scope for now. Start minimal: location, aircraft every few seconds, radar (rings + planes), list sorted by distance. Routes, photos, weather etc. later, only if wanted. |
| 2026-10-30 | Rule: don't build anything that can't be verified. When a service refuses, report why; don't work around it (no browser-spoofing User-Agents etc.). |
| 2026-10-30 | FlightScnr / FlightScnr_Pi (CC BY-NC-SA): take ideas only, no code or images. |
| 2026-10-30 | "No server" isn't possible (feeds lack CORS, see below). User has a Cloudflare account → a Cloudflare Worker serves the page and `/api/aircraft`. |
| 2026-10-31 | The original sketch (Node proxy + ES5 page for iPads) was replaced entirely. Modern JS, no build step. |
| 2026-10-31 | Units: metric (m, km, km/h). Default range 50 km, refresh 5 s. |
| 2026-10-31 | Commit straight to `main`; no branches or PRs unless asked. |
| 2026-10-31 | Develop against local `wrangler dev`; the user decides when to deploy to Cloudflare. |
| 2026-10-31 | Deploying, when it comes: either Cloudflare's GitHub integration (deploys every push to `main`) or `npx wrangler login` + `npm run deploy`. Not chosen yet. The `workers.dev` address will be public; Cloudflare Access can restrict it. |
| 2026-10-31 | The Worker only proxies `/api/aircraft` (validated lat/lon, radius ≤ 463 km), with an honest User-Agent; not a general proxy. No response cache: with one screen polling every 5 s it would never hit. |
| 2026-10-31 | Aircraft on the ground: drawn grey and unlabelled (they pile up at airports), still in the list. Ground stations/vehicles, positions older than 60 s: dropped. |
| 2026-10-31 | Dark UI kept; dark *map* not required. Map shown at full opacity (`--map-opacity` in `style.css`). |
| 2026-10-31 | Prefer dependencies that are free and need no API key. Map: Esri World Street Map, full opacity. |
| 2026-10-31 | FlightScnr / FlightScnr_Pi are not a starting point for the code: different platforms (Python/pygame on a Pi; C++ on an ESP32) and licence conditions (attribution, non-commercial, share-alike). Used as a feature catalogue. |
| 2026-10-31 | Notes live in this file, in the repo, so every new session has them. |
| 2026-10-31 | Colour by altitude: our own scale (hue by altitude: orange 0 m → yellow 1.5 km → green 3 km → cyan 6 km → blue 9 km → magenta 12 km), always on, with a legend and a swatch per list row. Ground grey, unknown altitude light grey, emergencies red. The highlighted aircraft is white with a ring (yellow is now an altitude colour); list rows keep a yellow highlight. |
| 2026-10-31 | Click for details: click a plane (radar or list) → a card above the list with the adsbdb route and airframe plus live data; ✕ / empty click / Esc closes. The browser calls adsbdb directly (CORS allowed), only on click; answers kept in memory for the page only (route data may not be copied or stored). Credit shown on the card. Routes that don't fit the aircraft's position are shown with a warning, not hidden. No route line on the radar (not asked for). |
| 2026-10-31 | Destination line on the radar: started, then dropped. The user meant the path already flown, not a line to the destination. |
| 2026-10-31 | Path flown (user chose "option 3"): for the **selected** aircraft only (like ADS-B Exchange's default), a line in altitude colours. Our own recording of every aircraft's positions since the page opened (kept 2 h), plus OpenSky's track for the earlier part of the flight, fetched via the Worker (`/api/track`) on click and cached for the page. If OpenSky fails, the card says so and shows the recorded part. **The OpenSky part is committed but unverified**: the user chose to keep it and test it on the laptop (card says "(OpenSky)" if it works); if it doesn't work there, remove it. Times shown on a 24-hour clock regardless of browser language. |
| 2026-10-31 | Aircraft icons: our own canvas silhouettes (not FlightScnr_Pi's images), chosen from the ADS-B emitter category plus short lists of turboprop, helicopter and wide-body type codes. Not animated: the user didn't want moving parts (FlightScnr_Pi spins helicopter rotors). No category and no listed type: a plain arrow rather than a guess. |

## Data sources: what we found

Checked from Claude's cloud container (2026-10-30/31) with curl and with
`fetch()` from headless Chromium on a `localhost` page.

| Service | Reachable | Browser (CORS) | Notes |
| --- | --- | --- | --- |
| `api.adsb.lol/v2/point/{lat}/{lon}/{nm}` | ✅ 200 | ❌ no `Access-Control-Allow-Origin`; preflight 405 | **Primary feed.** readsb format, `ac` array, `now` in ms. Max radius 250 nm. |
| `opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` | ✅ 200 | ❌ same | **Fallback feed.** Same format, `aircraft` array, `now` in seconds. FlightScnr uses a `/api/v3/lat/…` endpoint (not tried). |
| `api.airplanes.live` | ❌ 403 | ❌ | "Please contact us at contact@airplanes.live": needs permission first. |
| `api.planespotters.net/pub/photos/hex/{hex}` | ❌ 403 | API sends `ACAO: *` | Rejects generic User-Agents (wants app name + contact URL). Headless Chromium got a 403 HTML page. **Untested from a real browser.** |
| `api.open-meteo.com` | ✅ (then 429) | ✅ `ACAO: *` | 429 "daily limit" came from the container's shared IP; a laptop shouldn't hit it. Free, no key, non-commercial. |
| Map: CARTO (`basemaps.cartocdn.com`) | 200 | `ACAO: *` | ⚠️ Every tile is an **"API KEY REQUIRED"** placeholder. Free key: carto.com/basemaps/apikey. |
| Map: `tile.openstreetmap.org` | 200 | `ACAO: *` | ⚠️ Every tile is an **"Access blocked"** placeholder (OSM tile usage policy). |
| Map: Esri `server.arcgisonline.com/.../World_Street_Map` (and `World_Imagery`) | ✅ real tiles | ✅ `ACAO: *` | **In use.** No key. Esri Master License Agreement; attribution required (in `public/basemap.js`). "Mature support", **retires December 2029**; its replacement needs a key. Esri staff (2025): legacy basemaps work without a key; commercial use depends on the licence. URL order is `{z}/{y}/{x}`. |
| `api.adsbdb.com/v0/aircraft/{hex}`, `/v0/callsign/{callsign}` | ✅ 200 | ✅ `ACAO: *` | **In use** for details. Free, no key; MIT code. ~512 requests/min per IP (from its source). 404 = unknown aircraft/callsign, 400 = invalid callsign. Route data © David J Taylor & Jim Mason: "may not be copied, published, or incorporated into other databases without explicit permission". Aircraft data: PlaneBase; photos: airport-data.com (attribution if shown; not used). The combined `/aircraft/{hex}?callsign=` endpoint 404s if *either* is unknown, so we make two requests. **Routes can be stale:** EZY86HP climbing out of Copenhagen westbound came back as LGW → FAO. |
| OpenSky `opensky-network.org/api/tracks/all?icao24={hex}&time=0` | ✅ with curl; ❌ from Node `fetch` and `wrangler dev` (503 "upstream connect error or disconnect/reset before headers" after 15 s, with or without our User-Agent) | ❌ `ACAO` is opensky-network.org only → via the Worker | Returns the whole current flight: `path` = [time s, lat, lon, baro alt m, track, on ground]. "Purely experimental… can be out of order at any time". Anonymous: 400 credits/day per IP, a live track costs 4 (≈100 clicks/day); free account (OAuth2 client credentials) 4000/day. API docs: "research and non-commercial purposes", cite The OpenSky Network; the terms page returned 403. 404 = no track. Why Node/workerd fail while curl works is unknown; varying headers to find out was blocked (a curl-like User-Agent counts as bot-check circumvention). |
| adsb.lol / adsb.fi trace files (`globe.adsb.lol/data/traces/…`, `globe.adsb.fi/…`) | ❌ 403 bot verification pages | | The files their map sites use; protected, so not usable. adsb.lol's documented API has no history endpoint. |
| Natural Earth GeoJSON (`raw.githubusercontent.com/nvkelso/natural-earth-vector`) | ✅ | n/a | Public domain coastlines (10 MB), lakes, borders, airports. A keyless fallback for an outline map. |
| Cloudflare `*.workers.dev` | ❓ | | The container's proxy refused a made-up subdomain; may or may not reach a real one. |

**Lesson:** a tile server can answer 200 with a placeholder image. Look at a tile, not just the status.

**Still unknown until the first deploy:** whether adsb.lol / adsb.fi accept requests from Cloudflare's network.

## Data quirks (readsb format)

- Airport ground stations and vehicles transmit too: type `TWR`, or emitter category `C*`. Filtered out.
- `alt_baro` is `"ground"` on the ground, and pressure altitude otherwise, so it can be slightly negative near the ground on high-pressure days.
- `track` is missing on the ground; fall back to `true_heading`, then `mag_heading`.
- `flight` (callsign) is space-padded and uses `@` for undecoded characters.
- `seen_pos` can be tens of seconds old; positions older than 60 s are dropped.
- `dst`/`dir` (readsb's distance and bearing from the query point) differ from a spherical great circle by up to 0.22%; bearings agree within 0.05°.

## Gotchas

**Code**
- Workers treat every named export of the main module (`src/worker.js`) as an entrypoint and refuse constants: keep it to a default export. Unit tests in Node didn't catch this; only `wrangler dev` did.
- Map tiles are Web Mercator; the radar draws aircraft, rings and tiles all in that projection so they line up. Drawing aircraft by distance/bearing instead would be ~3 px off at 50 km and kilometres off at long ranges.
- Drawing tiles translucent shows bright seams where they overlap by a pixel; draw opaque and dim with one overlay instead.
- Map tiles must load with `crossOrigin = 'anonymous'` (Esri sends CORS headers), or the canvas becomes unreadable and the browser check's pixel reads fail.
- An HTML `required` field blocks the form's submit event before any JS runs: the "paste lat, lon into one field" feature only worked once the split happened on `input`.
- A CSS grid item won't shrink below its content (a wide table) unless it has `min-width: 0`: that caused horizontal scroll on phones.
- "Use my location" (geolocation) only works on https or `localhost`.
- Icons are several canvas paths each; outline all parts, then fill each separately. One combined path would cut holes where mirrored parts overlap (fill winding rules).
- On a phone the radar fills its square, so nothing can sit in its corners: the legend and attribution go underneath below 800 px.
- Selected aircraft path: the browser check rebuilds the recorded path from the `/api/aircraft` responses and checks segment midpoints; it needs a moving aircraft and ~8 distinct positions (~40 s), and must skip ~22 px around each aircraft (icon + 17 px selection ring) and its label.
- `toLocaleTimeString` without `hourCycle` gave "01:06 PM" in the container (en-US): set the clock format explicitly.
- adsbdb's 404 for unknown aircraft is logged by Chromium as a console "error" even though the page handles it; the browser check ignores exactly those.
- Icons overlap at airports: the browser check accepts the colour (or dark outline) of a neighbouring icon drawn on top.

**Verifying**
- Do the arithmetic in code, not in your head: two "failing" tests (a tile number, an antimeridian offset) were wrong expectations, not wrong code.
- Look at the screenshots. They caught what the checks didn't: `@@@@@@@@` callsigns, cluttered airport labels, overlapping layout, tile seams, placeholder tiles.
- When a test only runs under a condition (e.g. "if zoom is 10"), check the condition actually holds, or the test silently checks nothing.
- Races in the browser check: record responses synchronously (read bodies afterwards), use the aircraft's *current* position after waiting (a jet moves ~10 px between refreshes at 50 km), and wait for an actual refresh rather than a fixed time (refresh = 5 s after the previous fetch finished, plus feed latency). A failure that doesn't reproduce: add diagnostics before re-running, don't just re-run.
- Playwright reports no `response` for a request the browser blocked for CORS; read the real status over the DevTools protocol (`Network.responseReceivedExtraInfo`).

**The cloud container**
- `wrangler dev` works and uses the HTTPS proxy for the Worker's outgoing fetches. Headless Chromium needs the proxy too for anything on the internet (map tiles), with `localhost` bypassed.
- `pkill -f "wrangler dev"` matches and kills the shell running it (exit 144); use `pkill -f "[w]rangler dev"`.
- Sending a browser-like User-Agent to get past a 403 is blocked by Claude's safety checks (and against the rules here anyway).
- The git proxy refuses deleting remote branches (403); `curl` to github.com web pages gets 403, but `git clone` of public repos works (attach with `add_repo` first). The FlightScnr_Pi wiki clones as `…/FlightScnr_Pi.wiki.git`.
- The container shares its outgoing IP with other users, so rate limits (e.g. Open-Meteo's 429) can be hit here that a laptop wouldn't.

## Reference projects

**FlightScnr_Pi** ([repo](https://github.com/yashmulgaonkar/FlightScnr_Pi), CC BY-NC-SA 4.0):
a Raspberry Pi app for a 4″ round 720×720 touchscreen. Python, ~113k lines;
the radar is drawn with pygame; a Flask web portal handles settings and API keys
(it doesn't show the radar). Parts are based on c0wsaysmoo's code, used with
permission given to that project. Not a usable codebase for a browser page;
useful as a feature catalogue. Full feature list is in its wiki
(`git clone https://github.com/yashmulgaonkar/FlightScnr_Pi.wiki.git`, `Features.md`).
Keys it uses: FR24 (paid; routes, airline details, tracking), Tomorrow.io
(optional; Open-Meteo fallback), AirLabs / FlightAware / OpenSky (optional route
fallbacks), CARTO / Stadia (free map keys), aisstream.io (ships), NASA FIRMS
(wildfires outside the US). Its aircraft positions come from adsb.fi, no key.

**FlightScnr** ([repo](https://github.com/yashmulgaonkar/FlightScnr), CC BY-NC-SA 4.0):
the original: ESP32-S3 firmware in C++ (~75k lines) for 1.8″ round knob
displays (LilyGO T-Encoder Pro, Waveshare Knob Touch LCD 1.8). Dark radar
with sweep, dashed rings, compass, callsign/type/altitude tags coloured by
altitude; knob changes range, tap for flight details; clock and forecast
screens; settings page on the device. Routes via adsbdb (free) or keyed
APIs. Itself inspired by [ESP32-Plane-Radar](https://github.com/MatixYo/ESP32-Plane-Radar)
and [deskradar](https://github.com/arvis91/deskradar) (not looked at).

## Feature backlog

From FlightScnr_Pi's feature list, sorted by how well they fit Flightmon.

**Done**
- Live aircraft (adsb.lol, adsb.fi fallback), refresh every 5 s
- Radar with range rings, compass, north up; ground traffic grey and unlabelled; emergencies red
- Street map (Esri)
- List sorted by distance; hover a row to highlight the plane
- Location: typed, pasted "lat, lon", or the browser's; remembered and in the URL
- Colour by altitude, with legend
- Aircraft-type icons (own drawings, static)
- Click a plane for details, with route and airframe from adsbdb
- Path flown by the selected aircraft (recorded since page open; OpenSky history unverified)

**Candidates: fit a laptop browser, no key**
1. Military / twin-engine icon variants (need a type database, e.g. ICAO Doc 8643 descriptions; check licence)
2. Altitude / speed filters; zoom with mouse wheel or keys
3. Clock and weather (Open-Meteo, works directly from the browser); air quality (Open-Meteo)
4. Aircraft just outside the range shown on the rim
5. Tag options: flight number / callsign / registration; leader lines
6. Animated radar sweep (left out of the minimal start on purpose)
7. Airports and runways overlay (OurAirports open data)
8. Precipitation overlay (LibreWXR / RainViewer; check terms and CORS)
9. ISS on the radar and an ISS tracker (wheretheiss.at, no key)
10. Arrivals/departures board built from aircraft the radar sees (no schedule API)
11. Short trails behind every aircraft (the recording is already there); favourite locations; tracked-flight / follow view
12. Earthquakes (USGS, no key)
13. Other map styles: Esri satellite (no key), Natural Earth outlines (no key)
14. Route line on the radar towards the destination (adsbdb gives airport coordinates)

**Need a key, payment, or checking first**
- Aircraft photos: planespotters (refused generic requests from here; test in a real browser), Wikimedia Commons fallback
- Better routes: FR24 (paid), AirLabs, FlightAware (paid per call). adsbdb (free) is in use but can be stale
- CARTO / Stadia map styles (free keys)
- Ships (aisstream.io free key; Open Waters fallback without key), wildfires outside the US (NASA FIRMS free key)

**Not applicable (Pi / device only)**
- ATC audio, lo-fi music, chimes and voice alerts; Wi-Fi setup, power menu, firmware updates, boot disclaimer; touch gestures, facing calibration; email alerts

## History

| Date | Change |
| --- | --- |
| 2026-10-30 | Checked every feed and its CORS from the container: the feeds work but browsers can't call them directly. |
| 2026-10-31 | Rebuilt as a Cloudflare Worker + static page: radar with rings, list by distance, location form, 5 s refresh. Unit tests on recorded feed responses. |
| 2026-10-31 | Esri street map under the radar; everything drawn in Web Mercator. |
| 2026-10-31 | Map at full opacity. |
| 2026-10-31 | Notes (this file) and `scripts/browser-check.cjs` added to the repo. |
| 2026-10-31 | Colour by altitude (legend, list swatches) and aircraft-type icons. |
| 2026-10-31 | Click a plane for details: adsbdb route and airframe, live data, stale-route warning. `src/geo.js` moved to `public/geo.js` (shared by page and Worker). |
| 2026-10-31 | Path flown by the selected aircraft: recorded positions (verified) + OpenSky history via `/api/track` (unverified here). |

## Open questions

- Does OpenSky's track load from the laptop (`npm run dev`) and from Cloudflare? It fails from Claude's container (Node/workerd only). Kept for now; the user is testing it on the laptop. Not working there → remove it.
- OpenSky's terms of use page couldn't be read (403).

- Do adsb.lol / adsb.fi accept requests from Cloudflare? (Check at the first deploy.)
- Esri's terms summary page couldn't be loaded; the exact conditions for keyless use are unconfirmed.
- planespotters.net from a real browser: allowed or not?
