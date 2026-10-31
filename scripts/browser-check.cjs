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
// input, feed failure, phone width, no console errors. Screenshots go to the
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
    errors.push(`${m.text()} (${m.location().url})`);
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  let lastApi = null; let apiCalls = 0;
  const apiHistory = []; // every /api/aircraft response, to rebuild what the page recorded
  const tiles = { ok: 0, bad: [] };
  page.on('response', (r) => { if (r.url().includes('arcgisonline.com')) { if (r.status() === 200 && /image\//.test(r.headers()['content-type'] || '')) tiles.ok++; else tiles.bad.push(r.status() + ' ' + r.url()); } });
  page.on('requestfailed', (r) => { if (r.url().includes('arcgisonline.com')) tiles.bad.push('failed ' + r.failure()?.errorText + ' ' + r.url()); });
  page.on('response', async (r) => { if (r.url().includes('/api/aircraft') && r.ok()) { apiCalls++; lastApi = await r.json(); apiHistory.push(lastApi); } });

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
