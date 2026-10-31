// Browser check: drives the page in headless Chromium against the local
// Worker and live data, and compares what is drawn with what the API returned.
//
//   npm run dev                                   # in another terminal
//   NODE_PATH=$(npm root -g) node scripts/browser-check.cjs [screenshot-dir]
//
// Needs Playwright with Chromium (pre-installed in Claude's cloud container;
// elsewhere `npm i -g playwright && npx playwright install chromium`).
// Checks: list = API response, each aircraft drawn at its expected pixel
// (Web Mercator computed independently of public/mercator.js), map tiles load,
// refresh, hover highlight, "use my location", reload/localStorage, invalid
// input, feed failure, phone width, no console errors; clock in the location's
// time zone, weather as Open-Meteo answered, rain radar tiles (z ≤ 7) placed
// exactly (checked with a synthetic tile) and the rain on/off switch. Screenshots go to the
// given directory (default: the system temp dir); look at them too: a tile
// server can answer 200 with a placeholder image.

const os = require('node:os');
const { chromium } = require('playwright');
const BASE = process.env.FLIGHTMON_URL || 'http://127.0.0.1:8787';
const OUT = process.argv[2] || os.tmpdir();
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
let failures = 0;
// Expected screen position, Web Mercator (textbook asinh form, independent of public/mercator.js).
function expectedXY(a, center, range, w, h) {
  const radius = Math.max(10, Math.min(w, h) / 2 - 28);
  const W = (radius / range) * 2 * Math.PI * 6378.137 * Math.cos(center.lat * Math.PI / 180);
  const merc = (lat, lon) => ({ x: (lon + 180) / 360 * W, y: (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * W });
  const p = merc(a.lat, a.lon), c = merc(center.lat, center.lon);
  return { x: w / 2 + p.x - c.x, y: h / 2 + p.y - c.y };
}
const check = (ok, msg) => { console.log(ok ? '  ✓' : '  ✗', msg); if (!ok) failures++; return ok; };

(async () => {
  const { altitudeColor } = await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '../public/altitude.js')));
  // Map tiles are fetched from the internet; use the proxy when there is one.
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    geolocation: { latitude: 55.618, longitude: 12.656 }, permissions: ['geolocation'] });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // adsbdb answers 404/400 for aircraft and callsigns it doesn't know; the page
    // handles that, but Chromium still logs the status.
    if (/api\.adsbdb\.com/.test(m.location().url) && /status of 40[04]/.test(m.text())) return;
    // /api/track answers 404/429/502 when OpenSky has no track or fails; the card says so.
    if (/\/api\/track\?/.test(m.location().url) && /status of (404|429|502)/.test(m.text())) return;
    // Open-Meteo's 429 (daily limit; this container shares its IP) is shown on the page.
    if (/api\.open-meteo\.com/.test(m.location().url) && /status of 429/.test(m.text())) return;
    errors.push(`${m.text()} (${m.location().url})`);
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

  console.log('1. First visit, no location');
  await page.goto(BASE + '/');
  check((await page.textContent('#status')).includes('Enter a location'), 'asks for a location');
  check(apiCalls === 0, 'no API call without a location');

  console.log('2. Paste "55.6761, 12.5683" into latitude, submit');
  await page.fill('#lat', '55.6761, 12.5683');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('aircraft within'));
  check(page.url().includes('lat=55.6761&lon=12.5683&range=50'), 'URL updated: ' + page.url());
  check(await page.inputValue('#lon') === '12.5683', 'longitude split from the pasted pair');
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('flightmon.location')).lat) === 55.6761, 'remembered in localStorage');

  async function verifyAgainstApi(label) {
    await page.waitForTimeout(300);
    const api = lastApi;
    const rows = await page.$$eval('#aircraft tbody tr', (trs) => trs.map((tr) => ({ hex: tr.dataset.hex, cells: [...tr.cells].map((c) => c.textContent) })));
    check(rows.map((r) => r.hex).join() === api.aircraft.map((a) => a.hex).join(), `${label}: list = API response (${rows.length} aircraft, same order)`);
    const dists = api.aircraft.map((a) => a.distKm);
    check(!rows.some((r) => r.cells[0].includes('@')), `${label}: no undecoded '@' callsigns shown`);
    check(dists.every((d, i) => i === 0 || dists[i - 1] <= d), `${label}: sorted by distance`);
    // Pixel check: each aircraft is drawn at its projected position.
    const info = await page.evaluate(() => { const c = document.getElementById('radar'); return { w: c.clientWidth, h: c.clientHeight, dpr: devicePixelRatio }; });
    const alert = hexToRgb(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--alert').trim()));
    const halo = hexToRgb(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()));
    const expectedColor = (a) => (a.emergency ? alert : hexToRgb(altitudeColor(a)));
    const q = new URL(page.url()).searchParams;
    const range = Number(q.get('range'));
    const center = { lat: Number(q.get('lat')), lon: Number(q.get('lon')) };
    const pts = api.aircraft.map((a) => ({ a, ...expectedXY(a, center, range, info.w, info.h) }));
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
      if (near(expectedColor(p.a)) || neighbours.some((q) => near(expectedColor(q.a))) || (neighbours.length && near(halo))) ok++; else bad.push(`${p.a.hex} (${p.a.callsign}, ground=${p.a.onGround}, ${p.a.distKm} km ${p.a.bearingDeg}°) at ${p.x.toFixed(0)},${p.y.toFixed(0)} rgba(${px[5]})`);
    });
    if (bad.length) { const box = await page.$eval('#radar', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; }); const p = pts.find((q) => bad[0].startsWith(q.a.hex)); await page.screenshot({ path: OUT + '/miss.png', clip: { x: box.x + p.x - 30, y: box.y + p.y - 30, width: 60, height: 60 } }); }
    check(bad.length === 0, `${label}: ${ok}/${pts.length} aircraft drawn at their projected pixel` + (bad.length ? ' — off: ' + bad.join('; ') : ''));
    return { api, rows };
  }

  console.log('3. Live data vs page');
  const { api, rows } = await verifyAgainstApi('first load');
  console.log('   source:', api.source, '| first rows:'); rows.slice(0, 4).forEach((r) => console.log('    ', r.cells.join(' | ')));

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

  console.log('3c. Clock and weather');
  let liveTz = null; // the time zone the page learnt from Open-Meteo, if it answered
  {
    await page.waitForFunction(() => !/Loading/.test(document.querySelector('#weather').textContent), null, { timeout: 15000 }).catch(() => {});
    const last = weatherResps.at(-1);
    const w = last ? await last.json : null;
    const text = await page.textContent('#weather');
    if (last?.status === 200 && w?.current) {
      liveTz = w.timezone;
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

  console.log('3d. Rain radar (RainViewer)');
  {
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
    await rp.route('https://tilecache.rainviewer.com/**', (route) => {
      const [, z, x, y] = route.request().url().match(/\/512\/(\d+)\/(\d+)\/(\d+)\//).map(Number);
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
    await rp.goto(BASE + '/?lat=55.6761&lon=12.5683&range=50');
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
    const R = Math.min(dimsR.w, dimsR.h) / 2 - 28;
    const W = (R / 50) * 2 * Math.PI * 6378.137 * Math.cos(center.lat * Math.PI / 180);
    const [z] = mark ?? [asked[0]?.[0]];
    const tilePx = W / 2 ** z;
    const cWorld = { x: (center.lon + 180) / 360 * W, y: (1 - Math.asinh(Math.tan(center.lat * Math.PI / 180)) / Math.PI) / 2 * W };
    // Sample points on a grid inside the radar, away from tile edges, the cross, rings and ring labels.
    const pts = [];
    for (let gx = -1; gx <= 1; gx += 0.08) for (let gy = -1; gy <= 1; gy += 0.08) {
      const dx = gx * R, dy = gy * R, d = Math.hypot(dx, dy);
      if (d > R - 6 || Math.abs(dx) < 5 || Math.abs(dy) < 5) continue;
      if ([1, 2, 3, 4, 5].some((k) => Math.abs(d - (k * R) / 5) < 6)) continue;
      if (dx > 0 && dy < 0 && Math.atan2(dx, -dy) < 50 * Math.PI / 180) continue; // labels sit at ~21°
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
    await rp.close();
    // Leave the setting as found for the rest of the run (on).
  }

  console.log('4. Refresh every 5 s');
  const before = apiCalls; await page.waitForTimeout(11000);
  check(apiCalls - before >= 2 && apiCalls - before <= 3, `${apiCalls - before} refreshes in 11 s`);
  await verifyAgainstApi('after refresh');
  await page.screenshot({ path: OUT + '/radar-1440.png' });

  console.log('5. Hover a list row highlights its plane');
  const firstAir = lastApi.aircraft.find((a) => !a.onGround) || lastApi.aircraft[0];
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

  console.log('5b. Click a plane for details (route from adsbdb)');
  {
    const adsbdb = [];
    // Record responses as they arrive (bodies are read later, so none is missed).
    const tracks = [];
    const onResp = (r) => {
      if (r.url().includes('api.adsbdb.com')) adsbdb.push({ url: r.url(), status: r.status(), json: r.json().catch(() => null) });
      if (r.url().includes('/api/track?')) tracks.push({ url: r.url(), status: r.status(), json: r.json().catch(() => null) });
    };
    page.on('response', onResp);
    const dims2 = await page.$eval('#radar', (c) => { const b = c.getBoundingClientRect(); return { w: c.clientWidth, h: c.clientHeight, x: b.x, y: b.y }; });
    const center = { lat: 55.6761, lon: 12.5683 };
    const placed = lastApi.aircraft.map((a) => ({ a, ...expectedXY(a, center, 50, dims2.w, dims2.h) }));
    // An airborne aircraft with a callsign and no other aircraft within 30 px, so the click is unambiguous.
    // Prefer a fast one, so its recorded path grows quickly enough to check.
    const separate = placed.filter((p) => p.a.callsign && !p.a.onGround && placed.every((q) => q === p || Math.hypot(q.x - p.x, q.y - p.y) > 30));
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
        const radius = Math.min(dims2.w, dims2.h) / 2 - 28;
        const nowList = lastApi.aircraft.map((a) => expectedXY(a, center, 50, dims2.w, dims2.h));
        const free = (m) => Math.hypot(m.x - dims2.w / 2, m.y - dims2.h / 2) < radius - 4
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
        check(segs.length >= 2 && bad.length === 0, `recorded path drawn behind ${cs}: ${segs.length - bad.length}/${segs.length} segments (${seen.length} positions)` + (bad.length ? ' — off at ' + bad.map((m) => `${m.x.toFixed(0)},${m.y.toFixed(0)}`).join('; ') : ''));
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

      const other = lastApi.aircraft.find((a) => a.hex !== target.a.hex) || target.a;
      await page.click(`#aircraft tbody tr[data-hex="${other.hex}"]`);
      await page.waitForSelector('#details:not([hidden]) h2');
      check((await page.textContent('#details h2')) === (other.callsign ?? other.reg ?? other.hex.toUpperCase()), `click a list row: details for ${other.callsign ?? other.reg ?? other.hex}`);
      await page.keyboard.press('Escape');
      check(await page.$eval('#details', (e) => e.hidden), 'Esc closes the details');
    }
    page.off('response', onResp);
  }

  console.log('6. Use my location (geolocation mocked to CPH airport 55.618, 12.656)');
  await page.fill('#range', '20');
  await page.click('#locate');
  await page.waitForFunction(() => location.search.includes('lat=55.618'));
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('within 20 km'));
  check(page.url().includes('lat=55.618&lon=12.656&range=20'), 'URL: ' + page.url());
  const r2 = await verifyAgainstApi('airport, 20 km');
  check(r2.api.center.radiusKm === 20 && r2.api.aircraft.every((a) => a.distKm <= 20), 'all within 20 km');

  console.log('7. Reload: location comes back from the URL; new tab without params: from localStorage');
  await page.reload(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('within 20 km'));
  check(true, 'reload keeps location');
  const p2 = await context.newPage(); await p2.goto(BASE + '/');
  await p2.waitForFunction(() => document.querySelector('#status').textContent.includes('aircraft within'));
  check(await p2.inputValue('#lat') === '55.618', 'new tab restored from localStorage');
  await p2.close();

  console.log('8. Invalid input');
  await page.fill('#lat', '123'); await page.click('button[type=submit]');
  check((await page.textContent('#status')).includes('Latitude must be'), 'error shown: ' + await page.textContent('#status'));
  check(page.url().includes('lat=55.618'), 'location unchanged');

  console.log('9. API failure keeps the last data and says so');
  const errorsBefore = errors.length;
  await page.route('**/api/aircraft*', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'No flight feed answered', failures: ['adsb.lol: HTTP 503', 'adsb.fi: HTTP 503'] }) }));
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('failed'), null, { timeout: 12000 });
  check(await page.$eval('#status', (e) => e.classList.contains('error')), 'status: ' + await page.textContent('#status'));
  check((await page.$$('#aircraft tbody tr')).length > 0 || r2.api.aircraft.length === 0, 'list still shows the last good data');
  await page.unroute('**/api/aircraft*');
  errors.splice(errorsBefore); // the 502s injected above are expected

  console.log('10. Phone width (390 px)');
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.goto(BASE + '/?lat=55.6761&lon=12.5683&range=50');
  await phone.waitForFunction(() => document.querySelector('#status').textContent.includes('aircraft within'));
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `no horizontal page scroll (overflow ${overflow}px)`);
  const gap = await phone.evaluate(() => document.getElementById('status').getBoundingClientRect().top - document.getElementById('radar').getBoundingClientRect().bottom);
  check(gap >= 0, `status line starts below the radar (gap ${gap}px)`);
  const overlaps = await phone.evaluate(() => {
    const r = document.getElementById('radar').getBoundingClientRect();
    return ['legend', 'attribution'].filter((id) => document.getElementById(id).getBoundingClientRect().top < r.bottom - 1);
  });
  check(overlaps.length === 0, 'legend and attribution below the radar' + (overlaps.length ? ': overlapping ' + overlaps.join(', ') : ''));
  const sq = await phone.$eval('#radar', (c) => [c.clientWidth, c.clientHeight]);
  check(sq[0] === sq[1], `radar is square on a phone: ${sq.join('×')}`);
  await phone.screenshot({ path: OUT + '/radar-390.png', fullPage: true });

  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
