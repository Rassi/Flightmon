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
| 2026-10-30 | Rule: don't build anything that can't be verified (retired 2026-10-31, see below). When a service refuses, report why; don't work around it (no browser-spoofing User-Agents etc.). |
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
| 2026-10-31 | Path flown (user chose "option 3"): for the **selected** aircraft only (like ADS-B Exchange's default), a line in altitude colours. Our own recording of every aircraft's positions since the page opened (kept 2 h), plus OpenSky's track for the earlier part of the flight, fetched via the Worker (`/api/track`) on click and cached for the page. If OpenSky fails, the card says so and shows the recorded part. The OpenSky part works from the user's Windows machine (checked 2026-11-08), so it stays. Times shown on a 24-hour clock regardless of browser language. |
| 2026-10-31 | Aircraft icons: our own canvas silhouettes (not FlightScnr_Pi's images), chosen from the ADS-B emitter category plus short lists of turboprop, helicopter and wide-body type codes. Not animated: the user didn't want moving parts (FlightScnr_Pi spins helicopter rotors). No category and no listed type: a plain arrow rather than a guess. |
| 2026-10-31 | Retired the "don't build anything that can't be verified" rule: it was for the first iterations, before we knew where things would run. Still test and check what can be checked; the "don't work around refusals" rule stays. |
| 2026-10-31 | Ways to run it without starting a server (explored, nothing chosen; "leave it for now"): (1) deploy to Cloudflare and use the browser's "Install as app" (own window, also on a phone; needs a manifest + icon); (2) a Chrome/Edge extension, whose pages may fetch the feeds directly when listed in its host permissions (all local, no Cloudflare; loaded unpacked; untested); (3) Electron/Tauri desktop app (overkill: size, signing, per-OS builds); (4) a one-click launcher for `wrangler dev` (still a server). Opening `index.html` from disk can't work: the feeds send no CORS headers. |
| 2026-10-31 | Clock and weather in the header, rain radar on the map with an on/off button (user asked for all three). Clock: the time at the radar's location (zone from Open-Meteo; the browser's until it answers), with seconds, plus UTC when different. Weather: Open-Meteo "current" (sky, temperature, feels-like, wind from/gusts, visibility, pressure), refreshed every 15 min. Rain: RainViewer's latest radar image at 70% (`--rain-opacity`), on by default, the choice remembered in the browser; image list refreshed every 5 min; the image time is shown under the button. Credits with links under the radar (RainViewer only while rain is shown). No rain animation or forecast (not asked for). |
| 2026-11-08 | No circular radar: the user didn't like the circle and the range lines. The street map fills the whole left section; no rings, cross, distance labels or compass letters, just a small dot at the location. "Range" is now the distance from the centre to the nearest edge; aircraft are asked for out to the corners (range × diagonal / shorter side, max 463 km), and the list shows exactly the aircraft on the map (status: "N aircraft on the map (50 km to the nearest edge)"). Rain button, legend and credits sit on the map in translucent panels. |
| 2026-11-08 | Mouse wheel / trackpad zooms (user asked), around the location, which stays in the centre (no panning). Range × e^(deltaY × 0.0015): about ×1.16 per mouse notch (deltaY 100); 1 to 463 km, shown to 0.1 km below 10 km. Once scrolling stops (400 ms) the range goes into the URL/storage (not for the default location) and aircraft are fetched; paths and the open details stay. The Range field takes decimals (step 0.1). |
| 2026-11-08 | Zoom around the mouse pointer (the point under it stays put) and drag the map with the mouse button down (user asked for both). The location (lat/lon fields, the dot, weather, clock) stays put; the map's middle moves. Distances and directions in the list and details are still from the location, recomputed in the page when the map is off it, and the list is sorted by them. Aircraft are fetched around the map's middle once it stops moving. A press that moves less than 4 px is a click (selects a plane). "Centre on location" appears on the map once it has moved; Show, Use my location and a reload also centre it. The map's middle isn't saved (only the range is). The scale comes from the location's latitude, so dragging north or south doesn't change it. |
| 2026-11-08 | No location form (user: "I don't think we need all the location stuff"): Latitude, Longitude, Range, Show, Use my location and "Centre on location" are gone, and nothing goes in the address (old `?lat=&lon=&range=` links are cleaned up). Home is fixed at Copenhagen (55.6761, 12.5683): the dot, the weather and the clock are for there, and a **Home** button brings the map back to it at 50 km. Moving the map is drag and wheel only; where it was left (middle and zoom) is remembered in the browser (`flightmon.view`), saved once it stops moving, not before the first move. The Rain button and its image time moved to the header. The Direction column and the details card's Position line are gone; the user first wanted distances gone too, then kept the **Distance** column because the list is sorted by it: distance from Copenhagen, nearest first, wherever the map is. |
| 2026-11-08 | Limits on asking the feeds (user asked whether roaming zoomed-out, e.g. to Lisbon, strains them; chose all three): (1) never two /api/aircraft requests within 5 s: moving the map, ↻, a new interval and returning to the tab ask for one "as soon as allowed", and one under way finishes first; (2) after a 429 (or the Worker's 502 when every feed answered 429) the next try waits 2 × the refresh interval, doubling up to 2 min, shown as "feeds busy, next try in N s"; a good answer resets it; (3) zoom-out stops where the feeds' 463 km still reach the map's corners (463 × shorter side / diagonal, 317 km on an 832×784 map), clamped again on resize. Panning anywhere stays allowed. Measured: 463 km around CPH = 185 aircraft, 50 KB, < 0.1 s; 73 km = 22 aircraft, 6 KB. Rules in `public/polling.js`. |
| 2026-11-08 | No black while tiles load (user saw it flash when zooming out): a missing tile is drawn from what's already loaded for that spot, the nearest coarser tile up to 4 levels out (cropped, scaled up, blurry) and then sharper ones up to 2 levels in on top (e.g. the view before zooming out), like Leaflet / Google Maps. Only ground never loaded at any level stays empty until it arrives. Same for the rain layer (same code). Labels piling up when zoomed far out: user: fine as is for now. |
| 2026-11-08 | Street map at 30% colour (`--map-saturation: 0.3`, a canvas `saturate()` filter on the tiles only): its orange/yellow roads clashed with the altitude colours. The user compared screenshots of three options (greyscale + dimmed, washed out, Esri Dark Gray + labels) and chose washed out. Not chosen: greyscale (`grayscale(1) brightness(0.75)`) and Esri's `Canvas/World_Dark_Gray_Base` + `World_Dark_Gray_Reference` labels (both checked keyless with CORS, real tiles, max zoom 16). |
| 2026-11-08 | Home can be moved: a **Set home** button (plain, no confirmation, user's choice) makes the map's middle and zoom home, saved in the browser (`flightmon.home`, rounded to 4 decimals); greyed out while the map already shows home at its zoom. A grey crosshair marks the map's middle whenever it's more than 10 px from home (green dot). The dot, weather, clock (time zone) and Distance column follow home. Copenhagen is only the default; there's no "reset" (drag there and Set home). The range is converted when home moves north/south so the map keeps its scale (it's measured at home's latitude). Not chosen: right-click "Set home here" (hides the browser menu), double-click (means zoom on maps). |
| 2026-11-08 | **+ / −** buttons zoom around the map's middle (×½ / ×2 the range), so you can zoom in on a spot and back out before Set home without the wheel moving the middle (the wheel still zooms around the pointer). Greyed out at 1 km and at the zoom-out cap. Lower left of the map, stacked just above the credits box (user moved them there from top right). Not done (offered): Shift + wheel to zoom around the middle; the keyboard's + and − keys. |
| 2026-11-08 | Laptop browser only for now: don't spend effort on phone widths. The phone step was dropped from the browser check; the existing narrow-screen CSS stays but isn't checked. |
| 2026-11-08 | Refresh interval is a "Refresh" menu in the header (5 s, 10 s, 30 s, 1 min, 2 min), default **30 s** (was a fixed 5 s), remembered in the browser. Changing it fetches at once. "Stale" (status in red) after two missed refreshes: 2 × interval + 10 s. |
| 2026-11-08 | A ↻ button next to the Refresh menu fetches at once, keeping recorded paths and the open details (F5 or "Show" would clear them); the next automatic update comes a full interval later. |
| 2026-11-08 | Browser check: the user asked not to run every check every time, to avoid the feeds' 429s; feeds refusing with 429 is a warning (user's choice), any other failure still fails. |
| 2026-11-08 | First visit with no location shows Copenhagen at 50 km (user chose this over asking for the browser's location or a clearer message). The default isn't saved or put in the URL until the user picks a place. |

## Data sources: what we found

Checked from Claude's cloud container (2026-10-30/31) with curl and with
`fetch()` from headless Chromium on a `localhost` page. Rechecked 2026-11-08
from the user's Windows machine (curl + `wrangler dev`): adsb.lol, adsb.fi,
Open-Meteo, RainViewer, adsbdb, Esri tiles (real JPEG) and OpenSky via
`/api/track` all answered 200.

| Service | Reachable | Browser (CORS) | Notes |
| --- | --- | --- | --- |
| `api.adsb.lol/v2/point/{lat}/{lon}/{nm}` | ✅ 200 | ❌ no `Access-Control-Allow-Origin`; preflight 405 | **Primary feed.** readsb format, `ac` array, `now` in ms. Max radius 250 nm. |
| `opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` | ✅ 200 | ❌ same | **Fallback feed.** Same format, `aircraft` array, `now` in seconds. FlightScnr uses a `/api/v3/lat/…` endpoint (not tried). |
| `api.airplanes.live` | ❌ 403 | ❌ | "Please contact us at contact@airplanes.live": needs permission first. |
| `api.planespotters.net/pub/photos/hex/{hex}` | ❌ 403 from the container; ✅ 200 from the user's machine with `Flightmon (+https://github.com/rassi/flightmon)` (2026-11-08) | ✅ `ACAO: *`; ✅ from the page in the user's Chrome (2026-11-08) | Rejects generic User-Agents (wants app name + contact URL); browser requests need an Origin/Referer (a web page). Free, no key, one photo per hex or registration: `thumbnail` (200×112) and `thumbnail_large` (498×280) on `t.plnspttrs.net` (real JPEG, checked), `link`, `photographer`. **Terms** (photo/api page, read 2026-11-08 with our User-Agent; WebFetch got 403): photographer credited in visible text next to the image; the thumbnail is a plain link (no nofollow) to `link`; images fetched straight from their URLs by the browser showing them, not stored, re-hosted or proxied; URLs unchanged; JSON may be cached ≤ 24 h; reasonable volume; no AI training; no passing the data on. |
| `api.open-meteo.com/v1/forecast?current=…&timezone=auto` | ✅ once, then 429 from the container; ✅ from the user's machine (2026-11-08) | ✅ `ACAO: *` | **In use** for weather and the location's time zone. 429 `{"reason":"Daily API request limit exceeded. Please try again tomorrow."}` comes from the container's shared IP (seen 2026-10-30 and 10-31); a laptop has its own allowance (10,000 calls/day, non-commercial). Once it didn't answer within 8 s at all. Free, no key; CC BY 4.0, credit with a link. "Current" values are model data in 15-min steps, not observations. `wind_direction_10m` is where the wind comes from. |
| `api.rainviewer.com/public/weather-maps.json` + `tilecache.rainviewer.com` | ✅ | ✅ `ACAO: *` (list and tiles) | **In use** for the rain overlay. No key; "personal and educational use only", credit RainViewer with a link. The list has the last 2 h, one image per 10 min (`radar.past[]`, `nowcast` empty). Tiles: `{host}{path}/{256\|512}/{z}/{x}/{y}/{colour}/{smooth}_{snow}.png`. Since Jan 2026: **max zoom 7** (zoom 8+ answers 200 with a grey "Zoom Level Not Supported" image), one colour scheme (every colour number gives the same tile), no satellite/forecast. A 512 px tile at zoom 7 covers the same area as the 256 px one, twice as sharp. Only covers places with weather radars. |
| LibreWXR (`api.librewxr.net`) | ✅ (list) | not checked | A self-hostable RainViewer-compatible API (AGPL code, CC BY 4.0 data; MET Norway radar for the Nordics, DWD, US) restoring higher zooms and colour schemes. Its public instance is "for testing". A fallback if RainViewer's free tier goes. |
| Map: CARTO (`basemaps.cartocdn.com`) | 200 | `ACAO: *` | ⚠️ Every tile is an **"API KEY REQUIRED"** placeholder. Free key: carto.com/basemaps/apikey. |
| Map: `tile.openstreetmap.org` | 200 | `ACAO: *` | ⚠️ Every tile is an **"Access blocked"** placeholder (OSM tile usage policy). |
| Map: Esri `server.arcgisonline.com/.../World_Street_Map` (and `World_Imagery`; grey `Canvas/World_Dark_Gray_Base`, `World_Light_Gray_Base` and the label layer `World_Dark_Gray_Reference` also keyless, checked 2026-11-08) | ✅ real tiles | ✅ `ACAO: *` | **In use.** No key. Esri Master License Agreement; attribution required (in `public/basemap.js`). "Mature support", **retires December 2029**; its replacement needs a key. Esri staff (2025): legacy basemaps work without a key; commercial use depends on the licence. URL order is `{z}/{y}/{x}`. |
| `api.adsbdb.com/v0/aircraft/{hex}`, `/v0/callsign/{callsign}` | ✅ 200 | ✅ `ACAO: *` | **In use** for details. Free, no key; MIT code. ~512 requests/min per IP (from its source). 404 = unknown aircraft/callsign, 400 = invalid callsign. Route data © David J Taylor & Jim Mason: "may not be copied, published, or incorporated into other databases without explicit permission". Aircraft data: PlaneBase; photos: airport-data.com (attribution if shown; not used). The combined `/aircraft/{hex}?callsign=` endpoint 404s if *either* is unknown, so we make two requests. **Routes can be stale:** EZY86HP climbing out of Copenhagen westbound came back as LGW → FAO. |
| OpenSky `opensky-network.org/api/tracks/all?icao24={hex}&time=0` | ✅ with curl; from the container ❌ from Node `fetch` and `wrangler dev` (503 "upstream connect error or disconnect/reset before headers" after 15 s, with or without our User-Agent); ✅ via `wrangler dev` on the user's Windows machine (2026-11-08, 200 in ~0.15 s), so the failure was the container's network | ❌ `ACAO` is opensky-network.org only → via the Worker | Returns the whole current flight: `path` = [time s, lat, lon, baro alt m, track, on ground]. "Purely experimental… can be out of order at any time". Anonymous: 400 credits/day per IP, a live track costs 4 (≈100 clicks/day); free account (OAuth2 client credentials) 4000/day. API docs: "research and non-commercial purposes", cite The OpenSky Network; the terms page returned 403. 404 = no track. Why Node/workerd fail while curl works is unknown; varying headers to find out was blocked (a curl-like User-Agent counts as bot-check circumvention). |
| adsb.lol / adsb.fi trace files (`globe.adsb.lol/data/traces/…`, `globe.adsb.fi/…`) | ❌ 403 bot verification pages | | The files their map sites use; protected, so not usable. adsb.lol's documented API has no history endpoint. |
| Natural Earth GeoJSON (`raw.githubusercontent.com/nvkelso/natural-earth-vector`) | ✅ | n/a | Public domain coastlines (10 MB), lakes, borders, airports. A keyless fallback for an outline map. |
| Cloudflare `*.workers.dev` | ❓ | | The container's proxy refused a made-up subdomain; may or may not reach a real one. |

**Lesson:** a tile server can answer 200 with a placeholder image. Look at a tile, not just the status.

**Rate limits (2026-11-08, user's Windows machine):** after a full browser check (several pages polling every 5 s) plus a few curls, adsb.lol *and* adsb.fi both answered 429 to the same IP; the Worker then returns 502 "No flight feed answered" with both 429s listed. Neither publishes its limit (not looked up yet). The page copes (keeps the last data, says the update failed), but the browser check fails on the console error. Don't hammer the feeds when checking by hand. Seen again 2026-11-08 near the end of a run of six groups (one 429 from both, then they answered again). Since then the browser check reports a 502 whose failures are all 429s as a warning, and `--only=` runs just the groups a change touches.

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
- Map tiles are Web Mercator; the map draws aircraft and tiles all in that projection so they line up. Drawing aircraft by distance/bearing instead would be ~3 px off at 50 km and kilometres off at long ranges.
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

- Map colour: the browser check draws all tiles pure orange (255,128,0) on a page of its own and reads a pixel: rgb(179,140,102) at 30% saturation, which is exactly the CSS saturate() matrix in sRGB.
- Tile stand-ins: the browser check holds Esri's tiles back 2.5 s (`page.route` with a delay), zooms out one tile level at the centre and counts empty canvas pixels. Before the fix 98% were empty (that check failed on the old `tiles.js`, as it should); after, none.
- Rain radar: checked with Playwright replacing RainViewer's tiles by one opaque magenta tile (the one under the centre) and comparing the radar with rain on and off at a grid of points: inside the tile = 70% magenta over the map, outside unchanged. Independent of whether it's raining.
- The radar's rain layer is drawn opaque onto an offscreen canvas and then put over the map at 70% in one go; drawing each tile translucent would show seams where tiles overlap by a pixel (as with the map dimming).
- The aircraft pixel check after a refresh missed once by ~4 px (sampled the dark outline of a narrow fuselage): the known race between the response the check read and the one the page drew. Passed on the re-run; the crop (`miss.png`) showed the icon next to the point. Again 2026-11-08 in step 3, ~20 px (SAS44J, fast and low near CPH). Suspect: the `/api/aircraft` response listener reads bodies asynchronously, so `lastApi` can lag the response the page drew. Not fixed yet.
- Playwright's `mouse.wheel(0, 300)` reaches the page as `deltaY` 150 at device pixel ratio 2 (divided by the DPR); the browser check reads the delta the page got.
- The browser check works out where the map's middle should be after a zoom at the pointer or a drag with its own Mercator maths (`merc`/`unmerc`), not the page's, and measures list distances from the location with its own haversine.
- The recorded-path check can find nothing to test when the aircraft is slow or turning (the recent path lies under its icon, ring and label); it then says "not checked this run", like the OpenSky part.
- The browser check records when the main page asks for aircraft (per page load) and fails if two requests are under 4.9 s apart. Its waits for "a fetch after moving the map" are 8 s now (up to 5 s gap + 0.4 s settle).
- Zoomed out, other aircraft's labels lie over icons; the pixel check accepts a label's colour or outline when the point is in another aircraft's label box (6–120 px right, ±9 px).
- 2026-11-08, once, not reproduced: "after a reload: list = the API's aircraft on the map" failed (22 of 25). The check now prints which aircraft differ, whether they're at the edge, and whether the answer it compared with was the latest. Suspect the known async `lastApi` race.
- The browser check used to wait for "the next feed answer" after an action and compare with it; with a 5 s refresh that was often the answer to a request made *before* the action (old map position). It now waits for an answer whose centre is the expected map's middle. Same for the saved map position: wait for localStorage to change (the 0.4 s settle) rather than for any answer.
- The check's "answer for this map" also has to match the zoom (the radius asked for): + and − don't move the middle, so an answer for the old zoom matched on the centre alone.
- List order ties: the page sorts by distance rounded to 10 m and keeps its previous order for ties (aircraft parked side by side at the airport); the check accepts either order for those.
- Open-Meteo answered 503 once (2026-11-08, back within a minute). The check now warns for Open-Meteo 429/5xx instead of failing (the page shows "Weather unavailable").
- Save the browser check's output to a file (`> log 2>&1`) and grep it afterwards: filtering it live once hid which check failed and cost a re-run.
- The browser check sets a 5 s refresh in its own browser storage (`addInitScript`, only if unset), so its timing steps stay short; `refresh` opens a fresh profile to check the 30 s default.
- The browser check's groups share one page: the always-on steps 1–3 load Copenhagen at 50 km; `location` (6–9) moves it to the airport at 20 km, so it runs after the others. The location's time zone is read from Open-Meteo's answer in the always-on part, because both `weather` and `rain` need it.
- A page that looks fine in the browser check can look broken to a person: the check opened the first visit and only checked the hint text, while the user saw an empty dark page (the small hint at the top right went unnoticed). Look at the screenshot of the first visit too.

**The user's Windows machine**
- Long Node edit scripts as Bash heredocs broke once on quotes and backticks ("unexpected EOF while looking for matching"); write the script to a file in the scratchpad and run it instead.
- Editing files with a Node script: `s.replace(a, b)` treats `$$`, `$&`, `` $` `` and `$'` in `b` as patterns, so `page.$$eval` became `page.$eval`. Use `s.split(a).join(b)` (or a replacer function).
- Git Bash and PowerShell; `core.autocrlf=true`, so files are checked out with CRLF line endings: multi-line search-and-replace scripts must match CRLF.
- Playwright 1.65 installed globally with its Chromium (2026-11-08), so the browser check runs there. Claude in Chrome also works against `http://localhost:8787`. Chrome keeps `flightmon.location` in localStorage between visits: clear it to see a first visit.
- GitHub says the repo moved to `github.com/Rassi/Flightmon`; pushes to the old URL still work.

**The cloud container**
- `wrangler dev` works and uses the HTTPS proxy for the Worker's outgoing fetches. Headless Chromium needs the proxy too for anything on the internet (map tiles), with `localhost` bypassed.
- `pkill -f "wrangler dev"` matches and kills the shell running it (exit 144); use `pkill -f "[w]rangler dev"`, and not in the same command as `npx wrangler dev …` (that command line contains "wrangler dev" itself, so it's killed too): stop and start in separate commands.
- Sending a browser-like User-Agent to get past a 403 is blocked by Claude's safety checks (and against the rules here anyway).
- The git proxy refuses deleting remote branches (403); `curl` to github.com web pages gets 403, but `git clone` of public repos works (attach with `add_repo` first). The FlightScnr_Pi wiki clones as `…/FlightScnr_Pi.wiki.git`.
- The container shares its outgoing IP with other users, so rate limits (e.g. Open-Meteo's 429) can be hit here that a laptop wouldn't. The browser check then checks the page *says* so, and checks the weather display with the recorded answer (`test/fixtures/openmeteo-cph.json`) instead.

## Reference projects

**FlightScnr_Pi** ([repo](https://github.com/yashmulgaonkar/FlightScnr_Pi), CC BY-NC-SA 4.0):
a Raspberry Pi app for a 4″ round 720×720 touchscreen. Python, ~113k lines;
the radar is drawn with pygame; a Flask web portal handles settings and API keys
(it doesn't show the radar). Parts are based on c0wsaysmoo's code, used with
permission given to that project. Not a usable codebase for a browser page;
useful as a feature catalogue. Full feature list is in its wiki
(`git clone https://github.com/yashmulgaonkar/FlightScnr_Pi.wiki.git`, `Features.md`).
Its feature screenshots (`docs/images/features/*.jpg`, clone with
`--sparse` and `git sparse-checkout set docs/images/features`; looked at
2026-10-31, after our weather was built from the feature list alone): the
weather is a translucent curved "pill" on the radar's rim with a big clock,
temperature, a wind arrow and speed, and a weather icon (sun, cloud); the rain
overlay is strong and blocky over a dark map; green dashed rings, a sweep,
compass letters in green on the rim.
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
- Live aircraft (adsb.lol, adsb.fi fallback), refresh every 30 s by default (menu: 5 s to 2 min, remembered), and a ↻ button; never two requests within 5 s, longer waits after a 429, zoom-out capped where the feeds still cover the corners
- Mouse-wheel zoom around the pointer, + / − buttons around the middle, drag to move the map, Home, Set home (the map's middle and zoom; Copenhagen at 50 km by default); map and home remembered in the browser
- Map filling the left section, north up, a green dot at home and a grey crosshair at the middle when away from it (the circular radar with rings and compass was dropped 2026-11-08); ground traffic grey and unlabelled; emergencies red
- Street map (Esri), at 30% colour so it doesn't compete with the aircraft
- List of the aircraft on the map, sorted by distance from home (Distance column); hover a row to highlight the plane
- (Dropped 2026-11-08: typed/pasted/browser location, location in the URL, Direction column)
- Colour by altitude, with legend
- Aircraft-type icons (own drawings, static)
- Click a plane for details, with route and airframe from adsbdb
- Path flown by the selected aircraft (recorded since page open, plus OpenSky's history)
- Clock (home's time + UTC) and weather (Open-Meteo, at home) in the header
- Rain radar overlay (RainViewer), switchable from the header

**Candidates: fit a laptop browser, no key**
0. Fewer labels when zoomed out: fully zoomed out (2026-11-08) the labels around Copenhagen pile up unreadably; e.g. label only the selected/hovered aircraft, or skip labels that would overlap.
1. Military / twin-engine icon variants (need a type database, e.g. ICAO Doc 8643 descriptions; check licence)
2. Altitude / speed filters; zoom with mouse wheel or keys
3. Air quality (Open-Meteo); a short forecast; rain radar animation (the list has 2 h of images)
4. Aircraft just outside the range shown on the rim
5. Tag options: flight number / callsign / registration; leader lines
6. Animated radar sweep (left out of the minimal start on purpose)
7. Airports and runways overlay (OurAirports open data)
8. ~~Precipitation overlay~~ done (RainViewer); LibreWXR as a fallback
9. ISS on the radar and an ISS tracker (wheretheiss.at, no key)
10. Arrivals/departures board built from aircraft the radar sees (no schedule API)
11. Short trails behind every aircraft (the recording is already there); favourite locations; tracked-flight / follow view
12. Earthquakes (USGS, no key)
13. Other map styles: Esri satellite (no key), Natural Earth outlines (no key)
14. Route line on the radar towards the destination (adsbdb gives airport coordinates)

**Need a key, payment, or checking first**
- Aircraft photos: planespotters works from a browser page and with our User-Agent (2026-11-08); fits as a photo in the details card, loaded on click, credited and linked as their terms require. Wikimedia Commons as a fallback.
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
| 2026-10-31 | Clock, weather (Open-Meteo) and a switchable rain radar (RainViewer). Tile drawing shared in `public/tiles.js`. Live weather unverified from the container (429); display verified with a recorded answer. |
| 2026-11-08 | On the user's Windows machine: OpenSky's track via `wrangler dev` and live Open-Meteo weather both work. OpenSky track kept. |
| 2026-11-08 | First visit shows Copenhagen instead of an empty page (not saved until the user picks a place). Browser check updated; verified in Chrome. |
| 2026-11-08 | Playwright installed on the Windows machine. First full browser check there: all passed except "no console errors", from a real 502 when both feeds answered 429. |
| 2026-11-08 | Browser check: `--only=group,…` runs the always-on steps 1–3 plus the named groups; a 502 from both feeds answering 429 is a warning, not a failure. |
| 2026-11-08 | Refresh menu in the header, default 30 s. Checked with `--only=refresh,phone` (one pixel miss in step 3, the known race). |
| 2026-11-08 | Phone step removed from the browser check (laptop only). |
| 2026-11-08 | ↻ refresh-now button; checked with `--only=refresh`. |
| 2026-11-08 | Circular radar replaced by a full map (no rings); list = aircraft on the map; feed asked out to the corners. Browser check updated (list vs on-map aircraft, the radius asked for, rain sampled over the whole map); `--only=map,rain,hover,details,location` passed. |
| 2026-11-08 | Mouse-wheel zoom; checked with `--only=map` (zoom in, list and pixels at the new range, back out). |
| 2026-11-08 | Zoom at the pointer, drag to pan, "Centre on location" (replaced the same day by Home). `--only=map,details` passed except the recorded-path check finding 0 checkable segments (SAS954 turning onto final); that case is now "not checked". |
| 2026-11-08 | Home button instead of the location form; Rain button in the header; Direction column and Position line gone, Distance (from Copenhagen) kept for sorting; map position remembered in the browser. Browser check: first visit from an old address, `home` group (reload, new tab, Home, feed failure) instead of `location`. Ran all groups but `refresh`: passed except a too-tight tolerance in the check (saved position vs expected, the pointer sits on whole pixels; loosened to 2e-4°, not re-run). |
| 2026-11-08 | Request limits: 5 s minimum gap, back-off after a 429, zoom-out cap. Unit tests for the rules (`polling.js`, `maxRangeKm`). Browser check: gap over the whole run, the cap, a faked 429 (next try ≥ 10 s later at a 5 s refresh, status says so). `--only=map,refresh,home` then `map,home` passed after fixing the status (it drew before planning the next try: "next try in 0 s") and teaching the pixel check about labels. |
| 2026-11-08 | Tiles still loading are drawn from loaded coarser/sharper tiles instead of leaving the background (the black flash when zooming out). Unit test for the stand-ins; browser check `--only=map` failed on the old code (98% empty) and passed on the new (0%). |
| 2026-11-08 | Street map at 30% colour. Unit test for the filter; browser check `--only=map` measures it on a synthetic tile. |
| 2026-11-08 | Set home button and a grey crosshair at the map's middle. Unit tests for the scale conversion and "centred on home". Browser check step 10 (Set home); the check now waits for the answer for the expected map position (fixed several races), accepts tied distances in either order, and warns on Open-Meteo 503. `--only=map,home` then `home` and the always-on steps passed. |
| 2026-11-08 | + / − zoom buttons, lower left above the credits. Browser check (map group): position, ×2 out with the middle unchanged, stop and greyed out at the cap, ×½ in. `--only=map` passed. |
| 2026-11-08 | planespotters checked from the user's machine and Chrome: works; terms read and noted. |

## Open questions

- Does OpenSky's track load from Cloudflare? Works from the user's machine via `wrangler dev` (2026-11-08); check at the first deploy.
- OpenSky's terms of use page couldn't be read (403).

- Do adsb.lol / adsb.fi accept requests from Cloudflare? (Check at the first deploy.)
- Esri's terms summary page couldn't be loaded; the exact conditions for keyless use are unconfirmed.
