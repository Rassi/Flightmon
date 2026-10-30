#!/usr/bin/env node
// Flightmon server: serves public/ and proxies the flight data the browser
// can't fetch itself (no CORS, or the provider wants a proper User-Agent).
// Zero dependencies — Node 18+ for the global fetch.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { normalizeAircraft, parseRoute, parsePhoto, distanceNm } = require('./lib/data');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const USER_AGENT = 'Flightmon/0.1 (+https://github.com/Rassi/flightmon)';

// Defaults handed to a browser that has no settings yet, so a fresh iPad
// shows the right place without anyone typing coordinates on it.
const DEFAULTS = {
  lat: numberOr(process.env.LAT, null),
  lon: numberOr(process.env.LON, null),
  radius: numberOr(process.env.RADIUS, 25),
  units: process.env.UNITS || null,
};

// Tried in order until one answers. All three speak the readsb "v2" format.
const PROVIDERS = {
  adsblol: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  airplaneslive: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
  adsbfi: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
};
const PROVIDER_ORDER = (process.env.PROVIDERS || 'adsblol,airplaneslive,adsbfi')
  .split(',').map((s) => s.trim()).filter((s) => PROVIDERS[s]);

// A local dump1090/readsb receiver, e.g. http://raspberrypi.local/tar1090/data/aircraft.json.
// When set it is used instead of the online providers.
const READSB_URL = process.env.READSB_URL || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function numberOr(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

// --- tiny TTL cache, shared by every screen pointed at this server ---------

const cache = new Map();
const inflight = new Map();

function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);
  const p = load().then((value) => {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
}, 60_000).unref();

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 8000),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

// --- data endpoints --------------------------------------------------------

async function loadAircraft(lat, lon, nm) {
  if (READSB_URL) {
    const raw = await fetchJson(READSB_URL, { timeout: 4000 });
    const all = normalizeAircraft(raw);
    return {
      source: 'local receiver',
      aircraft: all.filter((a) => distanceNm(lat, lon, a.lat, a.lon) <= nm),
    };
  }
  const errors = [];
  for (const name of PROVIDER_ORDER) {
    try {
      const raw = await fetchJson(PROVIDERS[name](lat, lon, nm));
      return { source: name, aircraft: normalizeAircraft(raw) };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`no provider answered (${errors.join('; ')})`);
}

async function aircraftHandler(query) {
  // numberOr, not Number: Number(null) is 0, and 0,0 is a real place.
  const lat = numberOr(query.get('lat') ?? undefined, null);
  const lon = numberOr(query.get('lon') ?? undefined, null);
  const nm = Math.min(250, Math.max(1, Number(query.get('dist')) || 25));
  if (lat === null || lon === null) return [400, { error: 'lat and lon are required' }];
  // Round so screens a few metres apart share one upstream request.
  const key = `ac:${lat.toFixed(2)}:${lon.toFixed(2)}:${Math.round(nm)}`;
  const data = await cached(key, 2500, () => loadAircraft(lat, lon, Math.round(nm)));
  return [200, { now: Date.now(), source: data.source, aircraft: data.aircraft }];
}

async function routeHandler(query) {
  const callsign = (query.get('callsign') || '').trim().toUpperCase();
  const lat = Number(query.get('lat'));
  const lon = Number(query.get('lon'));
  if (!callsign) return [400, { error: 'callsign is required' }];
  const route = await cached(`route:${callsign}`, 60 * 60_000, async () => {
    const raw = await fetchJson('https://api.adsb.lol/api/0/routeset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: [{ callsign, lat: lat || 0, lng: lon || 0 }] }),
    });
    return parseRoute(raw);
  });
  return [200, { route }];
}

async function photoHandler(query) {
  const hex = (query.get('hex') || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!hex) return [400, { error: 'hex is required' }];
  const photo = await cached(`photo:${hex}`, 24 * 60 * 60_000, async () =>
    parsePhoto(await fetchJson(`https://api.planespotters.net/pub/photos/hex/${hex}`)));
  return [200, { photo }];
}

const API = {
  '/api/config': async () => [200, { defaults: DEFAULTS, receiver: Boolean(READSB_URL) }],
  '/api/aircraft': aircraftHandler,
  '/api/route': routeHandler,
  '/api/photo': photoHandler,
};

// --- http ------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // Short, so a screen that runs for weeks still picks up a new version.
      'Cache-Control': 'max-age=300',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = API[url.pathname];
  if (!handler) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    return serveStatic(pathname, res);
  }
  try {
    const [status, body] = await handler(url.searchParams);
    sendJson(res, status, body);
  } catch (err) {
    console.warn(`${url.pathname}: ${err.message}`);
    sendJson(res, 502, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const where = READSB_URL ? `local receiver ${READSB_URL}` : PROVIDER_ORDER.join(' → ');
    console.log(`Flightmon on http://localhost:${PORT} (data: ${where})`);
  });
}

module.exports = { server };
