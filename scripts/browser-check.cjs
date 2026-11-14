// Browser check: drives the page in headless Chromium against the local
// Worker and live data, and compares what is drawn with what the API returned.
//
//   npm run dev                                   # in another terminal
//   NODE_PATH=$(npm root -g) node scripts/browser-check.cjs [screenshot-dir] [--only=group,group]
//
// Every run loads the page and checks the list and radar against the API (steps
// 1–3). The rest are groups; --only runs just those (the full run asks the
// flight feeds for a lot, and they answer 429 when asked too often):
//   map (3b), weather (3c), rain (3d), refresh (4), hover (5), details (5b),
//   home (6–10: the map remembered after a reload and in a new tab, the Home button, feed failure, back-off after a 429, Set home)
// The main pages run with a 5 s refresh (set in their browser storage) so the
// timing checks don't take minutes; `refresh` checks the 30 s default in a fresh profile.
// Laptop browser only: phone widths aren't checked (user's choice, 2026-11-08).
// A 502 from /api/aircraft because every feed answered 429 is a warning, not a
// failure: the feeds refused, the page is fine (step 9 checks it copes).
//
// Needs Playwright with Chromium (pre-installed in Claude's cloud container;
// elsewhere `npm i -g playwright && npx playwright install chromium`).
// Checks: list = API response, each aircraft drawn at its expected pixel
// (Web Mercator computed independently of public/mercator.js), map tiles load,
// distances from Copenhagen, zoom at the pointer, drag, refresh, hover
// highlight, the map remembered in the browser, Home, feed failure, back-off
// after a 429, zoom-out cap, never two aircraft requests within 5 s, no console
// errors; clock in Copenhagen's time zone, weather as Open-Meteo answered, rain radar tiles (z ≤ 7) placed
// exactly (checked with a synthetic tile), the rain on/off switch and the last hour played as a loop. Screenshots go to the
// given directory (default: the system temp dir); look at them too: a tile
// server can answer 200 with a placeholder image.

const os = require('node:os');
const { chromium } = require('playwright');
const BASE = process.env.FLIGHTMON_URL || 'http://127.0.0.1:8787';
const args = process.argv.slice(2);
const OUT = args.find((a) => !a.startsWith('--')) || os.tmpdir();
const GROUPS = ['map', 'weather', 'rain', 'refresh', 'hover', 'details', 'home'];
const HOME = { lat: 55.6761, lon: 12.5683 }; // Copenhagen, the page's home
const AT_HOME = { center: HOME, range: 50 }; // the page's default map
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').filter(Boolean) : null;
if (only?.some((g) => !GROUPS.includes(g))) {
  console.error(`Unknown group in ${onlyArg}; groups: ${GROUPS.join(', ')}`);
  process.exit(2);
}
const want = (group) => !only || only.includes(group);
const skipped = (step, group) => console.log(`${step} (${group}): skipped`);
const warnings = [];
const warn = (msg) => { console.log('  !', msg); warnings.push(msg); };
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
let failures = 0;
// Expected screen position, Web Mercator (textbook asinh form, independent of public/mercator.js).
// Map width of the whole world in CSS px: the range reaches the nearest edge, at
// latitude scaleLat (the location's; the scale stays put when the map is dragged).
function worldPx(range, w, h, scaleLat) {
  const toEdge = Math.max(10, Math.min(w, h) / 2);
  return (toEdge / range) * 2 * Math.PI * 6378.137 * Math.cos(scaleLat * Math.PI / 180);
}
// Web Mercator on a world 1 wide, and back.
const merc = (lat, lon) => ({ x: (lon + 180) / 360, y: (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 });
const unmerc = (m) => ({ lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * m.y))) * 180 / Math.PI, lon: m.x * 360 - 180 });
function expectedXY(a, center, range, w, h, scaleLat = center.lat) {
  const W = worldPx(range, w, h, scaleLat);
  const p = merc(a.lat, a.lon), c = merc(center.lat, center.lon);
  return { x: w / 2 + (p.x - c.x) * W, y: h / 2 + (p.y - c.y) * W };
}
// Haversine, mean Earth radius.
function homeKm(home, a) {
  const r = (d) => d * Math.PI / 180;
  const h = Math.sin(r(a.lat - home.lat) / 2) ** 2 + Math.cos(r(home.lat)) * Math.cos(r(a.lat)) * Math.sin(r(a.lon - home.lon) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
// The hex codes in the list (the aircraft on the map).
const listed = (page) => page.$$eval('#aircraft tbody tr', (trs) => trs.map((tr) => tr.dataset.hex));
const check = (ok, msg) => { console.log(ok ? '  ✓' : '  ✗', msg); if (!ok) failures++; return ok; };

(async () => {
  const { altitudeColor } = await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '../public/altitude.js')));
  // Map tiles are fetched from the internet; use the proxy when there is one.
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  // 5 s refresh for this run unless a step chose another (the page's default is 30 s).
  await context.addInitScript(() => { if (!localStorage.getItem('flightmon.refresh')) localStorage.setItem('flightmon.refresh', '5'); });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // adsbdb answers 404/400 for aircraft and callsigns it doesn't know; the page
    // handles that, but Chromium still logs the status.
    if (/api\.adsbdb\.com/.test(m.location().url) && /status of 40[04]/.test(m.text())) return;
    // /api/track answers 404/429/502 when OpenSky has no track or fails; the card says so.
    if (/\/api\/track\?/.test(m.location().url) && /status of (404|429|502)/.test(m.text())) return;
    // Open-Meteo refusing (429, daily limit) or down (5xx): the page says "Weather
    // unavailable"; a warning, not a failure (the service, not the page).
    const meteo = /api\.open-meteo\.com/.test(m.location().url) && m.text().match(/status of (429|5\d\d)/);
    if (meteo) { warn(`the weather service answered ${meteo[1]}`); return; }
    // Planespotters' Cloudflare answers headless Chromium 403 (no CORS header), a
    // real browser gets the photo (checked 2026-11-08); not worked around.
    if (/api\.planespotters\.net/.test(m.text() + ' ' + m.location().url)) { warn('Planespotters refused the headless test browser (Cloudflare 403); a real browser gets the photo'); return; }
    // /api/aircraft's 502s are judged by their body below (feeds' 429 → warning).
    if (/\/api\/aircraft\?/.test(m.location().url) && /status of 502/.test(m.text())) return;
    errors.push(`${m.text()} (${m.location().url})`);
  });
  let injecting = false; // steps 8 and 9 fake feed failures
  const asked = [[]]; // times of /api/aircraft requests, one list per page load
  page.on('request', (r) => { if (r.url().includes('/api/aircraft')) asked.at(-1).push(Date.now()); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) asked.push([]); });
  page.on('response', async (r) => {
    if (!r.url().includes('/api/aircraft') || r.status() !== 502 || injecting) return;
    const body = await r.json().catch(() => null);
    const fails = body?.failures ?? [];
    if (fails.length && fails.every((f) => /HTTP 429/.test(f))) warn(`the feeds refused (rate limit): ${fails.join('; ')}`);
    else errors.push(`/api/aircraft answered 502: ${JSON.stringify(body)}`);
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  let lastApi = null; let apiCalls = 0;
  const apiHistory = []; // every /api/aircraft response, to rebuild what the page recorded
  const tiles = { ok: 0, bad: [] };
  page.on('response', (r) => { if (r.url().includes('arcgisonline.com')) { if (r.status() === 200 && /image\//.test(r.headers()['content-type'] || '')) tiles.ok++; else tiles.bad.push(r.status() + ' ' + r.url()); } });
  page.on('requestfailed', (r) => { if (r.url().includes('arcgisonline.com')) tiles.bad.push('failed ' + r.failure()?.errorText + ' ' + r.url()); });
  page.on('response', async (r) => { if (r.url().includes('/api/aircraft') && r.ok()) { apiCalls++; lastApi = await r.json(); apiHistory.push(lastApi); } });
  // Weather and rain: record responses as they arrive, read bodies later.
  const weatherResps = []; const rainLists = []; const rainTiles = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith('https://api.open-meteo.com/')) weatherResps.push({ status: r.status(), json: r.json().catch(() => null) });
    if (u.startsWith('https://api.rainviewer.com/')) rainLists.push({ status: r.status(), json: r.json().catch(() => null) });
    if (u.startsWith('https://tilecache.rainviewer.com/')) rainTiles.push({ url: u, status: r.status(), type: r.headers()['content-type'] });
  });

  console.log('1. First visit (from an old address with ?lat=&lon=&range=): Copenhagen at 50 km, nothing saved');
  await page.goto(BASE + '/?lat=10&lon=10&range=5');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('aircraft on the map'));
  check(apiCalls > 0, 'aircraft loaded');
  check(new URL(page.url()).search === '', 'old address parameters dropped: ' + page.url());
  check(await page.evaluate(() => localStorage.getItem('flightmon.view')) === null, 'nothing saved before the map is moved');
  check(Boolean(await page.$('#home')) && !(await page.$('#lat')) && !(await page.$('#locate')), 'Home button; no location form');
  check(await page.$eval('header', (h) => Boolean(h.querySelector('#rain-toggle'))), 'Rain button in the header');
  await page.screenshot({ path: OUT + '/00-first-visit.png' });

  // `view`: what the map should show, { center, range }.
  async function verifyAgainstApi(label, view = AT_HOME) {
    // Wait for the feed's answer for this map (an answer to a request made
    // before the map moved can still arrive after it), then for the page to draw it.
    const dims = await page.evaluate(() => { const c = document.getElementById('radar'); return { w: c.clientWidth, h: c.clientHeight }; });
    const radiusFor = Math.min(463, Math.ceil(view.range * Math.hypot(dims.w, dims.h) / Math.min(dims.w, dims.h)));
    const forView = () => {
      const c = lastApi?.center;
      return c && lastApi === apiHistory.at(-1) && c.radiusKm === radiusFor &&
        Math.abs(c.lat - view.center.lat) < 2e-4 && Math.abs(c.lon - view.center.lon) < 2e-4;
    };
    for (let t = 0; t < 48 && !forView(); t++) await page.waitForTimeout(250);
    await page.waitForTimeout(300);
    const api = lastApi;
    const rows = await page.$$eval('#aircraft tbody tr', (trs) => trs.map((tr) => ({ hex: tr.dataset.hex, cells: [...tr.cells].map((c) => c.textContent) })));
    const info = await page.evaluate(() => { const c = document.getElementById('radar'); return { w: c.clientWidth, h: c.clientHeight, dpr: devicePixelRatio }; });
    const { center, range } = view;
    const home = view.home ?? HOME;
    check(Math.abs(api.center.lat - center.lat) < 2e-4 && Math.abs(api.center.lon - center.lon) < 2e-4, `${label}: asked the feed around the map's middle (${api.center.lat}, ${api.center.lon}; expected ${center.lat.toFixed(4)}, ${center.lon.toFixed(4)})`);
    const wantRadius = Math.min(463, Math.ceil(range * Math.hypot(info.w, info.h) / Math.min(info.w, info.h)));
    check(api.center.radiusKm === wantRadius, `${label}: asked the feed out to the map's corners (${api.center.radiusKm} km for ${range} km to the nearest edge)`);
    // On the map, nearest home first (the page measures from there, wherever the map is).
    // The page sorts by distance rounded to 10 m and keeps its earlier order for
    // ties (aircraft parked side by side), so ties may come in either order.
    const pos = new Map(rows.map((r, i) => [r.hex, i]));
    const km10 = (a) => Number(a.homeKm.toFixed(2));
    const visible = api.aircraft.filter((a) => { const p = expectedXY(a, center, range, info.w, info.h, home.lat); return p.x >= 0 && p.x <= info.w && p.y >= 0 && p.y <= info.h; })
      .map((a) => ({ ...a, homeKm: homeKm(home, a) }))
      .sort((a, b) => km10(a) - km10(b) || (pos.get(a.hex) ?? 1e9) - (pos.get(b.hex) ?? 1e9));
    const listOk = check(rows.map((r) => r.hex).join() === visible.map((a) => a.hex).join(), `${label}: list = the API's aircraft on the map (${rows.length} of ${api.aircraft.length}, same order)`);
    if (!listOk) {
      // Which differ, and was the answer the page drew newer than the one read here?
      const inList = new Set(rows.map((r) => r.hex)), inApi = new Set(visible.map((a) => a.hex));
      const edge = (hex) => { const a = api.aircraft.find((x) => x.hex === hex); if (!a) return 'not in the answer'; const p = expectedXY(a, center, range, info.w, info.h, home.lat); return `at ${p.x.toFixed(1)},${p.y.toFixed(1)} of ${info.w}×${info.h}`; };
      console.log('     only in the list:', [...inList].filter((h) => !inApi.has(h)).map((h) => `${h} (${edge(h)})`).join(', ') || 'none');
      console.log('     only in the answer:', [...inApi].filter((h) => !inList.has(h)).map((h) => `${h} (${edge(h)})`).join(', ') || 'none');
      const firstDiff = rows.findIndex((r, i) => r.hex !== visible[i]?.hex);
      if (firstDiff >= 0) console.log('     from position', firstDiff + 1, '— list:', rows.slice(firstDiff, firstDiff + 3).map((r) => `${r.hex} ${r.cells[4]}`).join(', '), '| expected:', visible.slice(firstDiff, firstDiff + 3).map((a) => `${a.hex} ${a.homeKm.toFixed(3)} km`).join(', '));
      console.log('     answers seen:', apiHistory.length, '| this one is the latest:', api === apiHistory.at(-1), '| order differs only:', inList.size === inApi.size && [...inList].every((h) => inApi.has(h)));
    }
    const dists = visible.map((a) => a.homeKm);
    check(!rows.some((r) => r.cells[0].includes('@')), `${label}: no undecoded '@' callsigns shown`);
    check(dists.every((d, i) => i === 0 || dists[i - 1] <= d), `${label}: sorted by distance`);
    const km = (d) => { const r = Number(d.toFixed(2)); return `${r < 10 ? r.toFixed(1) : Math.round(r)} km`; };
    const distBad = rows.filter((r, i) => visible[i] && r.cells[4] !== km(visible[i].homeKm));
    check(rows.every((r) => r.cells.length === 5) && distBad.length === 0, `${label}: Distance column = from Copenhagen, no Direction column` + (distBad.length ? ' — ' + distBad.slice(0, 3).map((r) => r.cells.join(' | ')).join('; ') : ''));
    // Pixel check: each aircraft is drawn at its projected position.
    const alert = hexToRgb(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--alert').trim()));
    const halo = hexToRgb(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()));
    const expectedColor = (a) => (a.emergency ? alert : hexToRgb(altitudeColor(a)));
    const pts = visible.map((a) => ({ a, ...expectedXY(a, center, range, info.w, info.h, home.lat) }));
    const pixels = await page.evaluate(({ pts, dpr }) => {
      const ctx = document.getElementById('radar').getContext('2d');
      // A 4×4 device-pixel patch (±1 CSS px) around each projected point.
      return pts.map((p) => { const d = ctx.getImageData(Math.round(p.x * dpr) - 2, Math.round(p.y * dpr) - 2, 4, 4).data; const out = []; for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); return out; });
    }, { pts, dpr: info.dpr });
    let ok = 0; const bad = [];
    pts.forEach((p, i) => {
      const px = pixels[i];
      const near = (c) => px.some((q) => c.every((v, k) => Math.abs(v - q[k]) < 40) && q[3] > 200);
      // Where icons overlap, the one on top (fill or dark outline) may be another aircraft's.
      const neighbours = pts.filter((q, j) => j !== i && Math.hypot(q.x - p.x, q.y - p.y) < 20);
      // Zoomed out, another aircraft's label (its colour, outlined in the background colour) can lie over it.
      const labels = pts.filter((q, j) => j !== i && p.x > q.x + 6 && p.x < q.x + 120 && Math.abs(p.y - q.y) < 9);
      if (near(expectedColor(p.a)) || neighbours.some((q) => near(expectedColor(q.a))) || (neighbours.length && near(halo)) ||
        labels.some((q) => near(expectedColor(q.a))) || (labels.length && near(halo))) ok++; else bad.push(`${p.a.hex} (${p.a.callsign}, ground=${p.a.onGround}, ${p.a.homeKm.toFixed(1)} km from home) at ${p.x.toFixed(0)},${p.y.toFixed(0)} rgba(${px[5]})`);
    });
    if (bad.length) { const box = await page.$eval('#radar', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; }); const p = pts.find((q) => bad[0].startsWith(q.a.hex)); await page.screenshot({ path: OUT + '/miss.png', clip: { x: box.x + p.x - 30, y: box.y + p.y - 30, width: 60, height: 60 } }); }
    check(bad.length === 0, `${label}: ${ok}/${pts.length} aircraft drawn at their projected pixel` + (bad.length ? ' — off: ' + bad.join('; ') : ''));
    return { api, rows, visible };
  }

  console.log('3. Live data vs page');
  const { api, rows } = await verifyAgainstApi('first load');
  console.log('   source:', api.source, '| first rows:'); rows.slice(0, 4).forEach((r) => console.log('    ', r.cells.join(' | ')));

  // The location's time zone, from Open-Meteo's answer (weather and rain need it).
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('#weather').textContent), null, { timeout: 15000 }).catch(() => {});
  const lastWeather = weatherResps.at(-1);
  const weatherJson = lastWeather ? await lastWeather.json : null;
  const liveTz = lastWeather?.status === 200 && weatherJson?.current ? weatherJson.timezone : null;

  if (!want('map')) skipped('3b', 'map'); else {
    console.log('3b. Map tiles');
    await page.waitForTimeout(1500);
    check(tiles.ok > 0 && tiles.bad.length === 0, `${tiles.ok} Esri tiles loaded, ${tiles.bad.length} failed` + (tiles.bad.length ? ': ' + tiles.bad.slice(0, 3).join('; ') : ''));
    const mapStats = await page.evaluate(() => {
      const c = document.getElementById('radar'); const ctx = c.getContext('2d');
      // A ring of samples a third of the way out: the map should vary, not be one flat colour.
      const vals = []; const cx = c.width / 2, cy = c.height / 2, r = Math.min(c.width, c.height) / 6;
      for (let i = 0; i < 360; i += 3) { const d = ctx.getImageData(Math.round(cx + r * Math.sin(i * Math.PI / 180)), Math.round(cy - r * Math.cos(i * Math.PI / 180)), 1, 1).data; vals.push(d[0] + d[1] + d[2]); }
      const mean = vals.reduce((a, b) => a + b) / vals.length; const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      return { mean: Math.round(mean), sd: Math.round(sd), distinct: new Set(vals).size };
    });
    check(mapStats.distinct > 10 && mapStats.sd > 5, `map drawn under the radar (brightness mean ${mapStats.mean}, sd ${mapStats.sd}, ${mapStats.distinct} distinct values)`);
    check((await page.textContent('#attribution')).startsWith('Map: Esri'), 'Esri attribution shown');
    const legend = await page.$eval('#legend', (e) => ({ text: e.textContent, bg: e.querySelector('.legend-bar').style.backgroundImage }));
    check(legend.bg.startsWith('linear-gradient') && legend.text.includes('12 km') && legend.text.includes('Ground'), 'altitude legend shown: ' + legend.text);
    const swatches = await page.$$eval('#aircraft tbody tr', (trs) => trs.map((tr) => [tr.dataset.hex, getComputedStyle(tr.querySelector('.swatch')).backgroundColor]));
    const rgb = (h) => `rgb(${hexToRgb(h).join(', ')})`;
    const swatchBad = swatches.filter(([hex, c]) => { const a = lastApi.aircraft.find((x) => x.hex === hex); return a && !a.emergency && c !== rgb(altitudeColor(a)); });
    check(swatches.length > 0 && swatchBad.length === 0, `list swatches match the radar colours (${swatches.length})`);

    // Map colour: tiles keep 30% of their colour (--map-saturation). Measured on a
    // page of its own whose tiles are all pure orange, with no aircraft and no rain.
    {
      const mc = await browser.newContext({ viewport: { width: 1000, height: 700 } });
      await mc.addInitScript(() => localStorage.setItem('flightmon.rain', 'off'));
      const mp = await mc.newPage();
      const orange = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); x.fillStyle = '#ff8000'; x.fillRect(0, 0, 256, 256); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
      await mp.route('**/server.arcgisonline.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: orange }));
      await mp.route('**/api/aircraft*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ now: Date.now(), source: 'test', center: { ...HOME, radiusKm: 73 }, aircraft: [] }) }));
      await mp.route('https://api.open-meteo.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: require('node:fs').readFileSync(require('node:path').join(__dirname, '../test/fixtures/openmeteo-cph.json')) }));
      await mp.goto(BASE + '/');
      await mp.waitForTimeout(1500);
      const px = await mp.evaluate(() => { const c = document.getElementById('radar'); return Array.from(c.getContext('2d').getImageData(Math.round(c.width / 4), Math.round(c.height / 4), 1, 1).data); });
      const chroma = Math.max(px[0], px[1], px[2]) - Math.min(px[0], px[1], px[2]);
      check(px[3] === 255 && chroma >= 50 && chroma <= 105, `map at about 30% colour: pure orange (255,128,0) drawn as rgb(${px.slice(0, 3)}), colourfulness ${chroma} of 255`);
      await mc.close();
    }

    // Mouse wheel: up zooms in, down zooms out, keeping the point under the pointer in place.
    const rect = await page.$eval('#radar', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: c.clientWidth, h: c.clientHeight }; });
    const home = HOME;
    let view = AT_HOME; // what the page should show
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('flightmon.view')));
    const savedIs = (v, s) => s && s.rangeKm === v.range && Math.abs(s.lat - v.center.lat) < 2e-4 && Math.abs(s.lon - v.center.lon) < 2e-4;
    const ptr = { x: rect.w / 3, y: rect.h / 3 };
    await page.mouse.move(rect.x + ptr.x, rect.y + ptr.y);
    // The page gets the delta in CSS pixels (Chromium divides Playwright's by the device pixel ratio).
    await page.evaluate(() => addEventListener('wheel', (e) => { window.lastWheelDy = e.deltaY; }, { capture: true }));
    let target = 50;
    const zoomTo = async (dy) => {
      const n = apiCalls;
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(50);
      const got = await page.evaluate(() => window.lastWheelDy);
      target *= Math.exp(got * 0.0015); // the page's rate
      const km = target < 10 ? Math.round(target * 10) / 10 : Math.round(target);
      // The point under the pointer stays put: work out the new middle.
      const W0 = worldPx(view.range, rect.w, rect.h, home.lat), W1 = worldPx(km, rect.w, rect.h, home.lat);
      const c0 = merc(view.center.lat, view.center.lon);
      const under = { x: c0.x + (ptr.x - rect.w / 2) / W0, y: c0.y + (ptr.y - rect.h / 2) / W0 };
      view = { center: unmerc({ x: under.x - (ptr.x - rect.w / 2) / W1, y: under.y - (ptr.y - rect.h / 2) / W1 }), range: km };
      for (let t = 0; t < 32 && apiCalls === n; t++) await page.waitForTimeout(250);
      const sv = await saved();
      check(savedIs(view, sv), `wheel ${dy > 0 ? 'down' : 'up'} (deltaY ${got}): map saved once scrolling stops: ${JSON.stringify(sv)} (expected ${km} km around ${view.center.lat.toFixed(4)}, ${view.center.lon.toFixed(4)})`);
      await verifyAgainstApi(`zoomed to ${km} km at the pointer`, view);
    };
    await zoomTo(-300); // in
    await zoomTo(300); // and back to 50
    check(view.range === 50, 'back at 50 km');

    // Drag: the map follows the mouse; distances stay from Copenhagen.
    {
      const n = apiCalls;
      const from = { x: rect.w / 2 + 40, y: rect.h / 2 + 60 };
      await page.mouse.move(rect.x + from.x, rect.y + from.y);
      await page.mouse.down();
      await page.mouse.move(rect.x + from.x + 180, rect.y + from.y + 90, { steps: 6 });
      await page.mouse.up();
      const W = worldPx(50, rect.w, rect.h, home.lat);
      const c = merc(view.center.lat, view.center.lon);
      view = { center: unmerc({ x: c.x - 180 / W, y: c.y - 90 / W }), range: 50 };
      check(await page.$eval('#details', (e) => e.hidden), 'a drag selects nothing');
      for (let t = 0; t < 32 && apiCalls === n; t++) await page.waitForTimeout(250);
      await verifyAgainstApi('dragged 180, 90 px', view);
      check(savedIs(view, await saved()), 'dragged map saved');
      check(new URL(page.url()).search === '', 'nothing in the address: ' + page.url());
      await page.screenshot({ path: OUT + '/dragged.png' });

      // Zoomed out as far as it goes: the feeds' 463 km still reach the corners.
      const n3 = apiCalls;
      await page.mouse.wheel(0, 8000);
      for (let t = 0; t < 32 && apiCalls === n3; t++) await page.waitForTimeout(250);
      const cap = Math.floor(463 * Math.min(rect.w, rect.h) / Math.hypot(rect.w, rect.h));
      const out = await saved();
      check(out.rangeKm === cap, `zoom-out stops at ${out.rangeKm} km to the nearest edge (expected ${cap} for a ${rect.w}×${rect.h} map)`);
      const far = await verifyAgainstApi('zoomed out fully', { center: { lat: out.lat, lon: out.lon }, range: out.rangeKm });
      check(far.api.center.radiusKm <= 463, `asked within the feeds' limit (${far.api.center.radiusKm} km)`);
      await page.screenshot({ path: OUT + '/zoomed-out.png' });

      const n2 = apiCalls;
      await page.click('#home');
      for (let t = 0; t < 32 && apiCalls === n2; t++) await page.waitForTimeout(250);
      check(savedIs(AT_HOME, await saved()), 'Home: Copenhagen at 50 km, saved');
      await verifyAgainstApi('after Home');
    }

    // Zooming out one tile level while the new tiles are held back: what was on
    // screen stays drawn from the tiles already loaded (no background showing).
    {
      const rect = await page.$eval('#radar', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: c.clientWidth, h: c.clientHeight }; });
      await page.route('**/server.arcgisonline.com/**', (route) => setTimeout(() => route.continue().catch(() => {}), 2500));
      await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
      await page.mouse.wheel(0, 2 * Math.log(2) / 0.0015); // × 2 out (Chromium halves the delta at DPR 2)
      await page.waitForTimeout(300);
      const empty = await page.evaluate(() => {
        const c = document.getElementById('radar'); const ctx = c.getContext('2d');
        const count = (x0, y0, x1, y1) => { let n = 0, all = 0; for (let y = y0; y < y1; y += 6) for (let x = x0; x < x1; x += 6) { all++; if (ctx.getImageData(x, y, 1, 1).data[3] === 0) n++; } return { n, all }; };
        const w = c.width, h = c.height;
        return { inner: count(Math.round(w * 0.28), Math.round(h * 0.28), Math.round(w * 0.72), Math.round(h * 0.72)), whole: count(0, 0, w, h) };
      });
      const sv = await page.evaluate(() => JSON.parse(localStorage.getItem('flightmon.view')));
      await page.screenshot({ path: OUT + '/zoom-out-loading.png' });
      check(empty.inner.n === 0, `zoomed out to ${sv?.rangeKm ?? '?'} km with new tiles still loading: the old view stays drawn (${empty.inner.n}/${empty.inner.all} empty samples in the middle; ${empty.whole.n}/${empty.whole.all} over the whole map)`);
      await page.waitForTimeout(2600);
      await page.unroute('**/server.arcgisonline.com/**');
      const n = apiCalls;
      await page.click('#home');
      for (let t = 0; t < 32 && apiCalls === n; t++) await page.waitForTimeout(250);
    }

    // + and −: double or halve the range around the map's middle (it stays put).
    {
      const rect = await page.$eval('#radar', (c) => ({ w: c.clientWidth, h: c.clientHeight }));
      const cap = Math.floor(463 * Math.min(rect.w, rect.h) / Math.hypot(rect.w, rect.h));
      const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('flightmon.view')));
      const pos = await page.evaluate(() => { const z = document.getElementById('zoom-out').getBoundingClientRect(); const a = document.getElementById('attribution').getBoundingClientRect(); const m = document.getElementById('radar').getBoundingClientRect(); return { z: [z.left - m.left, z.bottom], a: [a.left - m.left, a.top], mapLeft: m.left }; });
      check(pos.z[0] < 20 && pos.z[1] <= pos.a[1] && pos.a[1] - pos.z[1] < 16, `+ and − bottom left, just above the credits (− at x ${pos.z[0].toFixed(0)}, ${(pos.a[1] - pos.z[1]).toFixed(0)} px above them)`);
      await page.click('#zoom-out');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('flightmon.view'))?.rangeKm === 100, null, { timeout: 5000 }).catch(() => {});
      const out = await saved();
      check(out?.rangeKm === 100 && Math.abs(out.lat - HOME.lat) < 1e-9 && Math.abs(out.lon - HOME.lon) < 1e-9, `− : 50 → ${out?.rangeKm} km, middle unchanged (${out?.lat}, ${out?.lon})`);
      await verifyAgainstApi('after −', { center: HOME, range: 100 });
      for (let i = 0; i < 6 && !(await page.$eval('#zoom-out', (b) => b.disabled)); i++) await page.click('#zoom-out');
      await page.waitForFunction((cap) => JSON.parse(localStorage.getItem('flightmon.view'))?.rangeKm === cap, cap, { timeout: 5000 }).catch(() => {});
      check((await saved())?.rangeKm === cap && await page.$eval('#zoom-out', (b) => b.disabled), `− stops at ${cap} km and is greyed out there`);
      await page.click('#zoom-in');
      await page.waitForFunction((r) => JSON.parse(localStorage.getItem('flightmon.view'))?.rangeKm === r, Math.round(cap / 2), { timeout: 5000 }).catch(() => {});
      const back = await saved();
      check(back?.rangeKm === Math.round(cap / 2) && Math.abs(back.lat - HOME.lat) < 1e-9 && !(await page.$eval('#zoom-out', (b) => b.disabled)), `+ : ${cap} → ${back?.rangeKm} km, middle unchanged`);
      await verifyAgainstApi('after +', { center: HOME, range: back.rangeKm });
      await page.screenshot({ path: OUT + '/zoom-buttons.png' });
      const n = apiCalls;
      await page.click('#home');
      for (let t = 0; t < 32 && apiCalls === n; t++) await page.waitForTimeout(250);
    }
    await page.mouse.move(5, 5);
  }

  if (!want('weather')) skipped('3c', 'weather'); else {
    console.log('3c. Clock and weather');
    const last = lastWeather;
    const w = weatherJson;
    const text = await page.textContent('#weather');
    if (liveTz) {
      const c = w.current;
      const want = [`${Math.round(c.temperature_2m)} °C`, `${Math.round(c.wind_speed_10m)} km/h`, `${Math.round(c.pressure_msl)} hPa`];
      check(want.every((t) => text.includes(t)), `live weather shown as Open-Meteo gave it: "${text}"`);
    } else {
      // Not worked around: the page says why. (Display checked below with a recorded answer.)
      check(text.startsWith('Weather unavailable') && (!w?.reason || text.includes(w.reason)), `Open-Meteo ${last ? 'answered ' + last.status : "didn't answer"}; page says: "${text}"`);
      console.log('   (live weather not verified this run)');
    }
    // The clock: the location's time once Open-Meteo has given its zone, else the browser's (UTC here).
    const tz = liveTz || 'UTC';
    const read = () => page.evaluate(() => ['clock-time', 'clock-zone', 'clock-utc'].map((id) => document.getElementById(id).textContent));
    const [t1, zone, utc] = await read();
    const expected = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
    const now = Date.now();
    check([now - 1500, now - 500, now].map(expected).includes(t1), `clock shows the time in ${tz}: ${t1} ${zone} ${utc} (expected ${expected(now)})`);
    const utcNow = [now, now - 1000].map((ms) => new Date(ms).toISOString().slice(11, 16));
    if (t1.startsWith(utcNow[0]) || t1.startsWith(utcNow[1])) check(utc === '', `local time is UTC: no second UTC time ("${utc}")`);
    else check(utcNow.some((u) => utc === `· ${u} UTC`), `UTC shown: ${utc}`);
    await page.waitForTimeout(1100);
    check((await read())[0] !== t1, 'clock ticks');
  }

  if (!want('rain')) skipped('3d', 'rain'); else {
    console.log('3d. Rain radar (RainViewer)');
    await page.waitForFunction(() => /Radar \d\d:\d\d/.test(document.querySelector('#rain-status').textContent), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const list = rainLists.length ? await rainLists[rainLists.length - 1].json : null;
    const frame = list?.radar?.past?.at(-1);
    check(Boolean(frame), `RainViewer listed ${list?.radar?.past?.length} radar images (${rainLists.map((r) => r.status).join(', ')})`);
    check(await page.getAttribute('#rain-toggle', 'aria-pressed') === 'true', 'rain is on by default');
    const status = await page.textContent('#rain-status');
    const tz = liveTz || 'UTC';
    const frameTime = frame && new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(frame.time * 1000));
    check(status.startsWith(`Radar ${frameTime}`), `status shows the image time: "${status}"`);
    const zooms = [...new Set(rainTiles.map((t) => Number(t.url.match(/\/512\/(\d+)\//)?.[1])))];
    const bad = rainTiles.filter((t) => t.status !== 200 || t.type !== 'image/png' || !t.url.includes(frame?.path));
    check(rainTiles.length > 0 && bad.length === 0 && zooms.every((z) => z <= 7), `${rainTiles.length} rain tiles of the latest image, 512 px at zoom ${zooms.join(',')} (≤ 7), all PNG` + (bad.length ? ' — bad: ' + bad.slice(0, 3).map((t) => `${t.status} ${t.url}`).join('; ') : ''));
    const links = await page.$$eval('#attribution a', (as) => as.map((a) => a.href));
    check(links.includes('https://open-meteo.com/') && links.includes('https://www.rainviewer.com/'), 'Open-Meteo and RainViewer credited with links');

    // Placement: a page whose rain tiles are replaced by one opaque magenta tile
    // (the one under the centre) and transparent ones, and no aircraft.
    const png = async (color) => Buffer.from(await page.evaluate((color) => {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      if (color) { const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 512, 512); }
      return c.toDataURL('image/png').split(',')[1];
    }, color), 'base64');
    const magenta = await png('#ff00ff'); const clear = await png(null);
    const center = { lat: 55.6761, lon: 12.5683 };
    const asked = [];
    const rp = await context.newPage();
    let mark = null; // [z, x, y] of the magenta tile
    // The loop's oldest image (an hour before the newest) gets no magenta, so
    // the loop can be seen drawing the image its time says.
    let rpList = null; const rpTiles = [];
    rp.on('response', (r) => { if (r.url().startsWith('https://api.rainviewer.com/')) rpList = r.json().catch(() => null); });
    const lastHour = (l) => { const past = l?.radar?.past ?? []; return past.filter((f) => f.time >= past.at(-1).time - 3600); };
    await rp.route('https://tilecache.rainviewer.com/**', async (route) => {
      const url = route.request().url();
      rpTiles.push(url);
      const [, z, x, y] = url.match(/\/512\/(\d+)\/(\d+)\/(\d+)\//).map(Number);
      const oldest = lastHour(rpList ? await rpList : null)[0]?.path;
      if (oldest && url.includes(oldest + '/')) {
        route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: clear });
        return;
      }
      asked.push([z, x, y]);
      const n = 2 ** z;
      const cx = Math.floor((center.lon + 180) / 360 * n);
      const cy = Math.floor((1 - Math.asinh(Math.tan(center.lat * Math.PI / 180)) / Math.PI) / 2 * n);
      if (x === cx && y === cy) mark = [z, x, y];
      route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: x === cx && y === cy ? magenta : clear });
    });
    const recordedWeather = require('node:fs').readFileSync(require('node:path').join(__dirname, '../test/fixtures/openmeteo-cph.json'));
    await rp.route('https://api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: recordedWeather }));
    await rp.route('**/api/aircraft*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ now: Date.now(), source: 'test', center: { ...center, radiusKm: 50 }, aircraft: [] }) }));
    await rp.goto(BASE + '/');
    await rp.waitForFunction(() => /Radar \d\d:\d\d/.test(document.querySelector('#rain-status').textContent), null, { timeout: 15000 });
    await rp.waitForTimeout(3000); // map and rain tiles
    {
      // Weather display and the location's clock, from the recorded Open-Meteo answer (Copenhagen, 12.3 °C, overcast).
      const text = await rp.textContent('#weather');
      check(text === 'Overcast, 12 °C (feels 11 °C)Wind 10 km/h from NNE, gusts 21 · Visibility 7.5 km · 1032 hPa', `recorded Open-Meteo answer shown: "${text}"`);
      const [t, zone, utc] = await rp.evaluate(() => ['clock-time', 'clock-zone', 'clock-utc'].map((id) => document.getElementById(id).textContent));
      const cph = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
      const now = Date.now();
      check([now - 1500, now - 500, now].map(cph).includes(t) && /^CES?T$/.test(zone), `clock switches to the location's zone: ${t} ${zone} (Copenhagen now ${cph(now)})`);
      check([now, now - 1000].some((ms) => utc === `· ${new Date(ms).toISOString().slice(11, 16)} UTC`), `and UTC beside it: "${utc}"`);
      const st = await rp.textContent('#rain-status');
      const rt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(frame.time * 1000));
      check(st.startsWith(`Radar ${rt}`), `radar time in the location's zone too: "${st}"`);
      await rp.screenshot({ path: OUT + '/weather.png', clip: { x: 0, y: 0, width: 1440, height: 70 } });
    }
    const dimsR = await rp.$eval('#radar', (c) => ({ w: c.clientWidth, h: c.clientHeight }));
    const R = Math.min(dimsR.w, dimsR.h) / 2; // centre to the nearest edge
    const W = (R / 50) * 2 * Math.PI * 6378.137 * Math.cos(center.lat * Math.PI / 180);
    const [z] = mark ?? [asked[0]?.[0]];
    const tilePx = W / 2 ** z;
    const cWorld = { x: (center.lon + 180) / 360 * W, y: (1 - Math.asinh(Math.tan(center.lat * Math.PI / 180)) / Math.PI) / 2 * W };
    // Sample points on a grid over the map, away from tile edges and the centre dot.
    const pts = [];
    for (let gx = -1; gx <= 1; gx += 0.08) for (let gy = -1; gy <= 1; gy += 0.08) {
      const dx = gx * R, dy = gy * R, d = Math.hypot(dx, dy);
      if (d < 8 || Math.abs(dx) > dimsR.w / 2 - 4 || Math.abs(dy) > dimsR.h / 2 - 4) continue; // centre dot, canvas edges
      const wx = cWorld.x + dx, wy = cWorld.y + dy;
      const fx = wx / tilePx, fy = wy / tilePx;
      if (Math.min(fx % 1, 1 - (fx % 1)) * tilePx < 4 || Math.min(fy % 1, 1 - (fy % 1)) * tilePx < 4) continue;
      pts.push({ x: dimsR.w / 2 + dx, y: dimsR.h / 2 + dy, inside: mark && Math.floor(fx) === mark[1] && Math.floor(fy) === mark[2] });
    }
    const sample = () => rp.evaluate((pts) => {
      const ctx = document.getElementById('radar').getContext('2d'); const dpr = devicePixelRatio;
      return pts.map((p) => Array.from(ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data.slice(0, 3)));
    }, pts);
    const on = await sample();
    await rp.click('#rain-toggle');
    await rp.waitForTimeout(300);
    const off = await sample();
    const inside = pts.filter((p) => p.inside).length;
    const misses = [];
    pts.forEach((p, i) => {
      const want = p.inside ? off[i].map((v, k) => v * 0.3 + [255, 0, 255][k] * 0.7) : off[i];
      if (want.some((v, k) => Math.abs(v - on[i][k]) > (p.inside ? 6 : 2))) misses.push(`${p.inside ? 'in' : 'out'} ${p.x.toFixed(0)},${p.y.toFixed(0)}: on ${on[i]} off ${off[i]}`);
    });
    check(Boolean(mark) && inside > 20 && pts.length - inside > 20 && misses.length === 0,
      `synthetic tile ${mark?.join('/')} drawn exactly where Web Mercator puts it, at 70% over the map: ${pts.length - misses.length}/${pts.length} points (${inside} inside)` + (misses.length ? ' — ' + misses.slice(0, 4).join('; ') : ''));
    check(await rp.getAttribute('#rain-toggle', 'aria-pressed') === 'false' && (await rp.textContent('#rain-status')) === '', 'switched off: button released, no radar time');
    check(!(await rp.$$eval('#attribution a', (as) => as.map((a) => a.textContent))).includes('RainViewer'), 'switched off: RainViewer credit gone');
    await rp.screenshot({ path: OUT + '/rain-synthetic-off.png' });
    await rp.reload();
    await rp.waitForTimeout(2500);
    check(await rp.getAttribute('#rain-toggle', 'aria-pressed') === 'false', 'off is remembered after a reload');
    const afterReload = await sample();
    check(afterReload.every((c, i) => c.every((v, k) => Math.abs(v - off[i][k]) <= 2)), 'after the reload no rain is drawn');
    await rp.click('#rain-toggle');
    await rp.waitForFunction(() => /Radar \d\d:\d\d/.test(document.querySelector('#rain-status').textContent), null, { timeout: 15000 });
    await rp.waitForTimeout(1500);
    const again = await sample();
    check(again.every((c, i) => c.every((v, k) => Math.abs(v - on[i][k]) <= 2)), 'switched on again: drawn as before');
    await rp.screenshot({ path: OUT + '/rain-synthetic.png' });

    // ▶ plays the last hour: oldest to newest, the time beside it, each image
    // drawn with its time; ■ goes back to the newest.
    const hour = lastHour(await rpList);
    check(await rp.isVisible('#rain-play') && (await rp.textContent('#rain-play')) === '▶', `▶ next to Rain (${hour.length} images in the last hour)`);
    const tilesBefore = rpTiles.length;
    const ins = pts.map((p, i) => (p.inside ? i : -1)).filter((i) => i >= 0).slice(0, 12);
    const near = (a, b) => a.every((c, j) => c.every((v, k) => Math.abs(v - b[j][k]) <= 2));
    await rp.click('#rain-play');
    const shots = [];
    for (let t = 0; t < 70; t++) {
      shots.push(await rp.evaluate((ps) => {
        const ctx = document.getElementById('radar').getContext('2d'); const dpr = devicePixelRatio;
        return { status: document.getElementById('rain-status').textContent,
          px: ps.map((p) => Array.from(ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data.slice(0, 3))) };
      }, ins.map((i) => pts[i])));
      if (t === 20) await rp.screenshot({ path: OUT + '/rain-playing.png', clip: { x: 0, y: 0, width: 1440, height: 70 } });
      await rp.waitForTimeout(100);
    }
    const ago = (st) => Number(st.match(/\(−(\d+) min\)/)?.[1] ?? 0);
    const seq = shots.map((s) => ago(s.status)).filter((m, i, a) => i === 0 || m !== a[i - 1]);
    while (seq[0] === 0) seq.shift(); // the newest, until the oldest's tiles are in
    const want = hour.map((f) => Math.round((hour.at(-1).time - f.time) / 60));
    check(want.length === 7 && want.every((m, i) => seq[i] === m) && seq[want.length] === want[0],
      `plays ${want.map((m) => '−' + m).join(', ')} then starts over: saw ${seq.map((m) => '−' + m).join(', ')}`);
    const wrong = shots.filter((s) => !near(s.px, ins.map((i) => (ago(s.status) === want[0] ? off : on)[i])));
    check(wrong.length === 0, `each image drawn with its time (no magenta only at −${want[0]} min): ${shots.length - wrong.length}/${shots.length} samples` + (wrong.length ? ` — e.g. "${wrong[0].status}"` : ''));
    const paths = new Set(rpTiles.slice(tilesBefore).map((u) => u.match(/\/v2\/radar\/[^/]+/)?.[0]));
    check(hour.slice(0, -1).every((f) => paths.has(f.path)), `tiles asked for the ${hour.length - 1} older images`);
    check(await rp.$eval('#rain-play', (b) => b.textContent === '■' && b.getAttribute('aria-pressed') === 'true'), 'playing: the button shows ■');
    await rp.click('#rain-play');
    const stopped = await rp.textContent('#rain-status');
    check(stopped === `Radar ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(hour.at(-1).time * 1000))}`
      && (await rp.textContent('#rain-play')) === '▶' && near(await sample(), on), `■ stops at the newest image: "${stopped}"`);
    await rp.click('#rain-play');
    await rp.waitForTimeout(1500);
    await rp.click('#rain-toggle');
    check(!(await rp.isVisible('#rain-play')) && (await rp.getAttribute('#rain-play', 'aria-pressed')) === 'false', 'Rain off while playing: loop stops, ▶ hidden');
    await rp.click('#rain-toggle');
    await rp.close();
    // Leave the setting as found for the rest of the run (on).
  }

  if (!want('refresh')) skipped('4', 'refresh'); else {
    console.log('4. Refresh every 5 s');
    const before = apiCalls; await page.waitForTimeout(11000);
    check(apiCalls - before >= 2 && apiCalls - before <= 3, `${apiCalls - before} refreshes in 11 s`);
    await verifyAgainstApi('after refresh');
    check(await page.inputValue('#refresh') === '5', 'refresh menu shows the stored 5 s');
    const n = apiCalls;
    await page.selectOption('#refresh', '10');
    for (let t = 0; t < 22 && apiCalls === n; t++) await page.waitForTimeout(300);
    check(apiCalls > n, 'a new interval fetches as soon as allowed (within 5 s of the last request)');
    check(await page.evaluate(() => localStorage.getItem('flightmon.refresh')) === '10', 'a new interval is remembered');
    await page.selectOption('#refresh', '5');
    // The ↻ button: fetches now, keeps the selection.
    await page.click(`#aircraft tbody tr[data-hex="${(await listed(page))[0]}"]`);
    await page.waitForSelector('#details:not([hidden]) h2');
    const sel = await page.textContent('#details h2');
    await page.waitForTimeout(500);
    const n2 = apiCalls;
    await page.click('#refresh-now');
    for (let t = 0; t < 22 && apiCalls === n2; t++) await page.waitForTimeout(300);
    check(apiCalls > n2, '↻ fetches as soon as allowed (within 5 s of the last request)');
    check(!(await page.$eval('#details', (e) => e.hidden)) && (await page.textContent('#details h2')) === sel, `↻ keeps the open details (${sel})`);
    await page.keyboard.press('Escape');
    // A fresh browser profile (no stored choice): the default.
    const fresh = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await fresh.goto(BASE + '/');
    check(await fresh.inputValue('#refresh') === '30', 'refresh is 30 s by default');
    await fresh.close();
  }
  await page.screenshot({ path: OUT + '/radar-1440.png' });

  if (!want('hover')) skipped('5', 'hover'); else {
    console.log('5. Hover a list row highlights its plane');
    const inList = await listed(page);
    const firstAir = lastApi.aircraft.find((a) => inList.includes(a.hex) && !a.onGround) || lastApi.aircraft.find((a) => inList.includes(a.hex));
    await page.hover(`#aircraft tbody tr[data-hex="${firstAir.hex}"]`);
    const dims = await page.$eval('#radar', (c) => ({ w: c.clientWidth, h: c.clientHeight }));
    const hxy = expectedXY(firstAir, { lat: 55.6761, lon: 12.5683 }, 50, dims.w, dims.h);
    const hl = await page.evaluate(({ x, y }) => {
      const c = document.getElementById('radar'); const dpr = devicePixelRatio;
      return Array.from(c.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data);
    }, hxy);
    check(hl[0] > 230 && hl[1] > 230 && hl[2] > 230, `${firstAir.callsign || firstAir.hex} drawn in the highlight colour (white): rgba(${hl})`);
    check(await page.$eval(`#aircraft tbody tr[data-hex="${firstAir.hex}"]`, (tr) => tr.classList.contains('highlight')), 'row highlighted');
    await page.screenshot({ path: OUT + '/radar-hover.png' });
    await page.mouse.move(5, 5);
  }

  if (!want('details')) skipped('5b', 'details'); else {
    console.log('5b. Click a plane for details (route from adsbdb)');
    const adsbdb = [];
    // Record responses as they arrive (bodies are read later, so none is missed).
    const tracks = [];
    const photos = [];
    const onResp = (r) => {
      if (r.url().startsWith('https://api.planespotters.net/')) photos.push({ url: r.url(), status: r.status(), json: r.json().catch(() => null) });
      if (r.url().includes('api.adsbdb.com')) adsbdb.push({ url: r.url(), status: r.status(), json: r.json().catch(() => null) });
      if (r.url().includes('/api/track?')) tracks.push({ url: r.url(), status: r.status(), json: r.json().catch(() => null) });
    };
    page.on('response', onResp);
    const dims2 = await page.$eval('#radar', (c) => { const b = c.getBoundingClientRect(); return { w: c.clientWidth, h: c.clientHeight, x: b.x, y: b.y }; });
    const center = { lat: 55.6761, lon: 12.5683 };
    const placed = lastApi.aircraft.map((a) => ({ a, ...expectedXY(a, center, 50, dims2.w, dims2.h) }));
    // An airborne aircraft with a callsign and no other aircraft within 30 px, so the click is unambiguous.
    // Prefer a fast one, so its recorded path grows quickly enough to check.
    const onScreen = (p) => p.x > 10 && p.x < dims2.w - 10 && p.y > 10 && p.y < dims2.h - 10;
    const separate = placed.filter((p) => p.a.callsign && !p.a.onGround && onScreen(p) && placed.every((q) => q === p || Math.hypot(q.x - p.x, q.y - p.y) > 30));
    const target = separate.find((p) => p.a.speedKmh > 350) ?? separate[0];
    if (!target) {
      check(false, 'no clearly separate airborne aircraft with a callsign to click');
    } else {
      const cs = target.a.callsign;
      await page.mouse.click(dims2.x + target.x, dims2.y + target.y);
      await page.waitForSelector('#details:not([hidden]) h2');
      check((await page.textContent('#details h2')) === cs, `clicked ${cs}: details open`);
      await page.waitForFunction(() => !document.querySelector('#details').textContent.includes('Looking up'), null, { timeout: 15000 });
      for (const r of adsbdb) r.body = await r.json;
      const routeResp = adsbdb.find((r) => r.url.endsWith('/callsign/' + encodeURIComponent(cs)));
      const acResp = adsbdb.find((r) => r.url.endsWith('/aircraft/' + target.a.hex));
      const asked = check(Boolean(routeResp && acResp), `asked adsbdb for /callsign/${cs} (${routeResp?.status}) and /aircraft/${target.a.hex} (${acResp?.status})`);
      if (!asked) console.log('     adsbdb responses seen:', adsbdb.map((r) => `${r.status} ${r.url}`).join(', ') || 'none', '\n     card:', await page.textContent('#details'));
      const text = await page.textContent('#details');
      const fr = routeResp?.body?.response?.flightroute;
      if (fr) {
        const o = fr.origin.iata_code || fr.origin.icao_code, d = fr.destination.iata_code || fr.destination.icao_code;
        const codes = await page.$$eval('#details .airport .code', (els) => els.map((e) => e.textContent));
        check(codes.join('→') === `${o}→${d}`, `route shown as adsbdb gave it: ${codes.join(' → ')} (${fr.origin.municipality} → ${fr.destination.municipality})`);
        check(text.includes('adsbdb.com') && text.includes('David J Taylor'), 'adsbdb and route data credited');
      } else {
        check(text.includes(`No route known for ${cs}`), `no route known for ${cs} (adsbdb: ${routeResp?.status} ${JSON.stringify(routeResp?.body?.response)})`);
      }
      // The photo: as Planespotters gave it, linked to its page, photographer credited.
      await page.waitForFunction(() => document.querySelector('#details .photo img')?.complete || document.querySelector('#details')?.dataset.photo === 'none', null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      const ps = photos.find((p) => p.url.endsWith('/hex/' + target.a.hex));
      const psBody = ps && await ps.json;
      const want = psBody?.photos?.[0];
      const shown = await page.evaluate(() => { const f = document.querySelector('#details .photo'); if (!f) return null; const a = f.querySelector('a'), i = f.querySelector('img'); return { href: a.href, rel: a.rel, src: i.src, w: i.naturalWidth, caption: f.querySelector('figcaption').textContent }; });
      if (want) {
        check(Boolean(shown) && shown.src === want.thumbnail_large.src && shown.href === want.link && !/nofollow/.test(shown.rel) && shown.w > 0 && shown.caption.includes(want.photographer),
          `photo from Planespotters shown, linked to its page and credited ("${shown?.caption}", ${shown?.w} px wide)`);
      } else if (ps) {
        check(!shown, `no photo when Planespotters has none (${ps.status} ${JSON.stringify(psBody).slice(0, 80)})`);
      } else {
        // Refused (headless): the card says so instead of staying blank.
        const note = await page.textContent('#details');
        check(!shown && note.includes("No photo: couldn't reach Planespotters"), 'Planespotters refused: the card says "No photo: couldn\'t reach Planespotters"');
      }
      const reg = acResp?.body?.response?.aircraft?.registration;
      if (reg) check(text.includes(reg), `aircraft details from adsbdb shown (registration ${reg})`);
      check(await page.$eval(`#aircraft tbody tr[data-hex="${target.a.hex}"]`, (tr) => tr.classList.contains('selected')), 'its list row is marked selected');
      // Where it is now: the page may have refreshed since the click.
      const now = expectedXY(lastApi.aircraft.find((a) => a.hex === target.a.hex) ?? target.a, center, 50, dims2.w, dims2.h);
      const sel = await page.evaluate(({ x, y }) => Array.from(document.getElementById('radar').getContext('2d').getImageData(Math.round(x * devicePixelRatio), Math.round(y * devicePixelRatio), 1, 1).data), now);
      check(sel[0] > 230 && sel[1] > 230 && sel[2] > 230, `selected aircraft drawn white on the radar: rgba(${sel})`);

      // The path flown: OpenSky's part (before the page opened) drawn in altitude colours.
      await page.waitForFunction(() => !/loading/.test(document.querySelector('#details')?.textContent.split('Path flown')[1] ?? 'loading'), null, { timeout: 15000 });
      const tr = tracks.find((t) => t.url.endsWith('hex=' + target.a.hex));
      const trBody = tr && await tr.json;
      const pathFact = await page.evaluate(() => { const dts = [...document.querySelectorAll('#details dt')]; const dt = dts.find((d) => d.textContent === 'Path flown'); return dt ? dt.nextElementSibling.textContent : null; });
      if (tr && tr.status === 200 && trBody.path.length > 1) {
        check(/^since \d\d[:.]\d\d \(OpenSky\)$/.test(pathFact) && (await page.textContent('#details')).includes('The OpenSky Network'), `track from OpenSky: ${trBody.path.length} points, card says "${pathFact}", credited`);
        await page.waitForTimeout(300);
        const pageOpened = Date.now() / 1000 - 60;
        const nowList = lastApi.aircraft.map((a) => expectedXY(a, center, 50, dims2.w, dims2.h));
        const free = (m) => m.x > 4 && m.x < dims2.w - 4 && m.y > 4 && m.y < dims2.h - 4
          && nowList.every((q) => Math.hypot(q.x - m.x, q.y - m.y) > 22 && !(m.x > q.x - 5 && m.x < q.x + 110 && Math.abs(m.y - q.y) < 12));
        const mids = [];
        for (let i = 1; i < trBody.path.length; i++) {
          const a = trBody.path[i - 1], b = trBody.path[i];
          if (b.t >= pageOpened) break;
          const pa = expectedXY(a, center, 50, dims2.w, dims2.h), pb = expectedXY(b, center, 50, dims2.w, dims2.h);
          const m = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, seg: a };
          if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 6 && free(m)) mids.push(m);
        }
        if (mids.length < 3) {
          console.log(`   (only ${mids.length} checkable path segments inside the radar; colours not checked this run)`);
        } else {
          const got = await page.evaluate(({ mids }) => {
            const ctx = document.getElementById('radar').getContext('2d'); const dpr = devicePixelRatio;
            return mids.map((m) => { const d = ctx.getImageData(Math.round(m.x * dpr) - 2, Math.round(m.y * dpr) - 2, 4, 4).data; const out = []; for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]); return out; });
          }, { mids });
          const bad = mids.filter((m, i) => !got[i].some((q) => hexToRgb(altitudeColor(m.seg)).every((v, k) => Math.abs(v - q[k]) < 40)));
          check(bad.length === 0, `path drawn where OpenSky says, in altitude colours: ${mids.length - bad.length}/${mids.length} segment midpoints` + (bad.length ? ' — off at ' + bad.map((m) => `${m.x.toFixed(0)},${m.y.toFixed(0)}`).join('; ') : ''));
        }
      } else {
        const note = await page.textContent('#details');
        check(note.includes('Earlier path unavailable') && /recorded here|not enough positions/.test(pathFact), `OpenSky gave no track (${tr?.status} ${trBody?.error}); card says so: "${pathFact}"`);
        console.log('   (OpenSky part not verified this run)');
      }

      // The part recorded since the page opened: rebuild it from the responses the page got.
      const positions = () => {
        const seen = [];
        for (const r of apiHistory) {
          const a = r.aircraft.find((x) => x.hex === target.a.hex);
          if (!a) continue;
          const last = seen[seen.length - 1];
          if (!last || last.lat !== a.lat || last.lon !== a.lon) seen.push(a);
        }
        return seen;
      };
      // Wait for 8 distinct positions (about 40 s), or up to 70 s.
      for (let t = 0; t < 70 && positions().length < 8; t++) await page.waitForTimeout(1000);
      await page.waitForTimeout(400);
      {
        const seen = positions();
        const nowList = lastApi.aircraft.map((a) => expectedXY(a, center, 50, dims2.w, dims2.h));
        const segs = [];
        for (let i = 1; i < seen.length; i++) {
          const pa = expectedXY(seen[i - 1], center, 50, dims2.w, dims2.h), pb = expectedXY(seen[i], center, 50, dims2.w, dims2.h);
          const m = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, seg: seen[i - 1] };
          // Skip what icons, the selection ring (17 px + outline) and labels cover.
          const clear = nowList.every((q) => Math.hypot(q.x - m.x, q.y - m.y) > 22 && !(m.x > q.x + 8 && m.x < q.x + 110 && Math.abs(m.y - q.y) < 10));
          if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 4 && clear) segs.push(m);
        }
        const got = await page.evaluate(({ segs }) => {
          const ctx = document.getElementById('radar').getContext('2d'); const dpr = devicePixelRatio;
          return segs.map((m) => { const d = ctx.getImageData(Math.round(m.x * dpr) - 2, Math.round(m.y * dpr) - 2, 4, 4).data; const out = []; for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]); return out; });
        }, { segs });
        const bad = segs.filter((m, i) => !got[i].some((q) => hexToRgb(altitudeColor(m.seg)).every((v, k) => Math.abs(v - q[k]) < 40)));
        await page.screenshot({ path: OUT + '/trail.png' });
        // A slow or turning aircraft's recent path can lie under its own icon, ring and label.
        if (segs.length < 2) console.log(`   (only ${segs.length} checkable recorded segments behind ${cs}, ${seen.length} positions; not checked this run)`);
        else check(bad.length === 0, `recorded path drawn behind ${cs}: ${segs.length - bad.length}/${segs.length} segments (${seen.length} positions)` + (bad.length ? ' — off at ' + bad.map((m) => `${m.x.toFixed(0)},${m.y.toFixed(0)}`).join('; ') : ''));
      }
      await page.screenshot({ path: OUT + '/details.png' });

      // Wait for an actual refresh (5 s after the previous one finished, plus the feed's response time).
      const n = apiCalls;
      for (let t = 0; t < 24 && apiCalls === n; t++) await page.waitForTimeout(500);
      await page.waitForTimeout(300);
      const h2 = await page.textContent('#details h2');
      check(apiCalls > n && h2 === cs, `after a refresh the details still follow ${cs} (${apiCalls - n} refreshes; card shows ${h2})`);
      const before = adsbdb.length;
      // Click a list row: details for that aircraft (a second click on the same is cached: no new requests).
      await page.click(`#aircraft tbody tr[data-hex="${target.a.hex}"]`);
      check(adsbdb.length === before, 'same aircraft again: no new adsbdb requests');

      // Click an empty spot on the radar: details close.
      const empty = [[0.5, 0.15], [0.2, 0.5], [0.8, 0.5], [0.5, 0.85]].map(([fx, fy]) => ({ x: dims2.w * fx, y: dims2.h * fy }))
        .find((pt) => placed.every((q) => Math.hypot(q.x - pt.x, q.y - pt.y) > 40));
      await page.mouse.click(dims2.x + empty.x, dims2.y + empty.y);
      check(await page.$eval('#details', (e) => e.hidden), 'click on empty radar closes the details');

      const inList = await listed(page);
      const other = lastApi.aircraft.find((a) => a.hex !== target.a.hex && inList.includes(a.hex)) || target.a;
      await page.click(`#aircraft tbody tr[data-hex="${other.hex}"]`);
      await page.waitForSelector('#details:not([hidden]) h2');
      check((await page.textContent('#details h2')) === (other.callsign ?? other.reg ?? other.hex.toUpperCase()), `click a list row: details for ${other.callsign ?? other.reg ?? other.hex}`);
      await page.keyboard.press('Escape');
      check(await page.$eval('#details', (e) => e.hidden), 'Esc closes the details');

      // The photo as the card shows it, from Planespotters' recorded answer for
      // LN-RKU and a stand-in image (the real API refuses this headless browser).
      {
        const recorded = { photos: [{ id: '1973791',
          thumbnail: { src: 'https://t.plnspttrs.net/36579/1973791_2d626231f6_t.jpg', size: { width: 200, height: 112 } },
          thumbnail_large: { src: 'https://t.plnspttrs.net/36579/1973791_2d626231f6_280.jpg', size: { width: 498, height: 280 } },
          link: 'https://www.planespotters.net/photo/1973791/ln-rku-sas-scandinavian-airlines-airbus-a330-343?utm_source=api',
          photographer: 'Lauchlan' }] };
        const standIn = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 498; c.height = 280; const x = c.getContext('2d'); x.fillStyle = '#3a6b63'; x.fillRect(0, 0, 498, 280); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
        let asked = 0;
        await page.route('https://api.planespotters.net/**', (r) => { asked++; r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(recorded) }); });
        await page.route('https://t.plnspttrs.net/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: standIn }));
        await page.click(`#aircraft tbody tr[data-hex="${other.hex}"]`);
        await page.waitForFunction(() => document.querySelector('#details .photo img')?.naturalWidth > 0, null, { timeout: 8000 }).catch(() => {});
        const f = await page.evaluate(() => { const fig = document.querySelector('#details .photo'); if (!fig) return null; const a = fig.querySelector('a'), i = fig.querySelector('img'); return { href: a.href, target: a.target, rel: a.rel, src: i.src, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt, caption: fig.querySelector('figcaption').textContent, top: fig.getBoundingClientRect().top, head: document.querySelector('#details .details-head').getBoundingClientRect().bottom }; });
        const p = recorded.photos[0];
        check(Boolean(f) && f.src === p.thumbnail_large.src && f.w === 498 && f.h === 280, `photo: the large thumbnail, loaded from the URL Planespotters gave (${f?.src})`);
        check(Boolean(f) && f.href === p.link && f.target === '_blank' && !/nofollow/.test(f.rel), `photo links to its page on Planespotters, a plain link (rel="${f?.rel}")`);
        check(Boolean(f) && f.caption === 'Photo: Lauchlan / Planespotters.net' && f.top >= f.head, `photographer credited under it: "${f?.caption}", below the card's title`);
        await page.screenshot({ path: OUT + '/details-photo.png' });
        await page.keyboard.press('Escape');
        await page.unroute('https://api.planespotters.net/**');
        await page.unroute('https://t.plnspttrs.net/**');
        check(asked === 1, `one lookup for the aircraft (${asked})`);
      }
    }
    page.off('response', onResp);
  }

  if (!want('home')) skipped('6–10', 'home'); else {
    console.log('6. The map is remembered: after a reload and in a new tab');
    const rect = await page.$eval('#radar', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: c.clientWidth, h: c.clientHeight }; });
    const savedBefore = await page.evaluate(() => localStorage.getItem('flightmon.view'));
    await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.w / 2 - 150, rect.y + rect.h / 2, { steps: 5 });
    await page.mouse.up();
    // Saved once the map stops moving (0.4 s); a refresh can answer before that.
    await page.waitForFunction((before) => localStorage.getItem('flightmon.view') !== before, savedBefore, { timeout: 5000 });
    const sv = await page.evaluate(() => JSON.parse(localStorage.getItem('flightmon.view')));
    const moved = { center: { lat: sv.lat, lon: sv.lon }, range: sv.rangeKm };
    check(sv.lon > HOME.lon && Math.abs(sv.lat - HOME.lat) < 1e-6, `dragged east of Copenhagen and saved: ${JSON.stringify(sv)}`);
    const n2 = apiCalls;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('aircraft on the map'));
    for (let t = 0; t < 32 && apiCalls === n2; t++) await page.waitForTimeout(250);
    const r2 = await verifyAgainstApi('after a reload', moved);
    const p2 = await context.newPage();
    const req = p2.waitForRequest((r) => r.url().includes('/api/aircraft'));
    await p2.goto(BASE + '/');
    const q2 = new URL((await req).url()).searchParams;
    check(q2.get('lat') === sv.lat.toFixed(4) && q2.get('lon') === sv.lon.toFixed(4), `a new tab opens the same map (asked around ${q2.get('lat')}, ${q2.get('lon')})`);
    await p2.close();

    console.log('7. Home: back to Copenhagen at 50 km');
    const n3 = apiCalls;
    await page.click('#home');
    for (let t = 0; t < 32 && apiCalls === n3; t++) await page.waitForTimeout(250);
    await verifyAgainstApi('after Home');

    console.log('8. API failure keeps the last data and says so');
    const errorsBefore = errors.length;
    injecting = true;
    await page.route('**/api/aircraft*', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'No flight feed answered', failures: ['adsb.lol: HTTP 503', 'adsb.fi: HTTP 503'] }) }));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('failed'), null, { timeout: 12000 });
    check(await page.$eval('#status', (e) => e.classList.contains('error')), 'status: ' + await page.textContent('#status'));
    check((await page.$$('#aircraft tbody tr')).length > 0 || r2.api.aircraft.length === 0, 'list still shows the last good data');
    await page.unroute('**/api/aircraft*');

    console.log('9. Refused for asking too often (429): the next try waits twice the refresh interval');
    let refusedAt = 0;
    await page.route('**/api/aircraft*', (route) => {
      refusedAt = Date.now();
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'No flight feed answered', failures: ['adsb.lol: HTTP 429', 'adsb.fi: HTTP 429'] }) });
    });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('feeds busy'), null, { timeout: 15000 });
    const busyText = await page.textContent('#status');
    check(/feeds busy, next try in \d+ s/.test(busyText), 'status says so: ' + busyText);
    await page.unroute('**/api/aircraft*');
    const before = asked.at(-1).length;
    for (let t = 0; t < 60 && asked.at(-1).length === before; t++) await page.waitForTimeout(250);
    const waited = (asked.at(-1).at(-1) - refusedAt) / 1000;
    check(asked.at(-1).length > before && waited >= 9.9, `next request ${waited.toFixed(1)} s after the refusal (refresh 5 s → at least 10 s)`);
    await page.waitForFunction(() => !document.querySelector('#status').textContent.includes('feeds busy'), null, { timeout: 10000 }).catch(() => {});
    check(!(await page.textContent('#status')).includes('failed'), 'a good answer clears it: ' + await page.textContent('#status'));
    errors.splice(errorsBefore); // the 502s injected above are expected
    injecting = false;

    console.log('10. Set home: the map\'s middle (and zoom) becomes home');
    {
      const rect = await page.$eval('#radar', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: c.clientWidth, h: c.clientHeight }; });
      check(await page.$eval('#set-home', (b) => b.disabled), 'Set home greyed out while the map shows home');
      const n = apiCalls;
      await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.w / 2 - 200, rect.y + rect.h / 2, { steps: 5 });
      await page.mouse.up();
      for (let t = 0; t < 32 && apiCalls === n; t++) await page.waitForTimeout(250);
      const muted = hexToRgb(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()));
      const mid = await page.evaluate(() => { const c = document.getElementById('radar'); const d = c.getContext('2d').getImageData(Math.round(c.width / 2) - 3, Math.round(c.height / 2) - 3, 6, 6).data; const out = []; for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]); return out; });
      check(mid.some((q) => q.every((v, k) => Math.abs(v - muted[k]) < 25)), 'grey crosshair at the map\'s middle once it\'s away from home');
      check(!(await page.$eval('#set-home', (b) => b.disabled)), 'Set home available');
      const weatherAsked = page.waitForRequest((r) => r.url().startsWith('https://api.open-meteo.com/'), { timeout: 5000 }).catch(() => null);
      await page.click('#set-home');
      const home = await page.evaluate(() => JSON.parse(localStorage.getItem('flightmon.home')));
      check(home && home.lon > HOME.lon && Math.abs(home.lat - HOME.lat) < 1e-4 && home.rangeKm === 50, `saved as home: ${JSON.stringify(home)}`);
      check(await page.$eval('#set-home', (b) => b.disabled), 'Set home greyed out again (the map shows the new home)');
      const w = await weatherAsked;
      const wq = w && new URL(w.url()).searchParams;
      check(Boolean(wq) && Math.abs(Number(wq.get('latitude')) - home.lat) < 1e-3 && Math.abs(Number(wq.get('longitude')) - home.lon) < 1e-3, `weather asked for the new home (${wq?.get('latitude')}, ${wq?.get('longitude')})`);
      const atHome = { center: { lat: home.lat, lon: home.lon }, range: home.rangeKm, home };
      await verifyAgainstApi('distances from the new home', atHome);
      await page.screenshot({ path: OUT + '/new-home.png' });
      // Away and back: Home now means the new home.
      const n2 = apiCalls;
      await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.w / 2 + 120, rect.y + rect.h / 2 + 80, { steps: 5 });
      await page.mouse.up();
      for (let t = 0; t < 32 && apiCalls === n2; t++) await page.waitForTimeout(250);
      const n3 = apiCalls;
      await page.click('#home');
      for (let t = 0; t < 32 && apiCalls === n3; t++) await page.waitForTimeout(250);
      await verifyAgainstApi('Home goes to the new home', atHome);
    }
  }

  {
    const gaps = asked.flatMap((ts) => ts.slice(1).map((t, i) => t - ts[i]));
    const min = gaps.length ? Math.min(...gaps) : null;
    check(min === null || min >= 4900, `never two aircraft requests within 5 s (${gaps.length + asked.filter((ts) => ts.length).length} requests, closest ${min === null ? '–' : (min / 1000).toFixed(1) + ' s'} apart)`);
  }
  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  const warned = warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''}: ${[...new Set(warnings)].join(' | ')})` : '';
  const ran = only ? ` [core + ${only.join(', ')}]` : '';
  console.log((failures ? `\n${failures} FAILED` : '\nALL PASSED') + ran + warned);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
