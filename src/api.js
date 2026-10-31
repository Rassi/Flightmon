// GET /api/aircraft?lat=&lon=&radius= (radius in km). The browser can't call
// the feeds itself because they send no CORS headers, so the Worker does.

import { normalize } from './aircraft.js';

const USER_AGENT = 'Flightmon (+https://github.com/rassi/flightmon)';
const TIMEOUT_MS = 8000;
// Both feeds cap the query radius at 250 nm.
export const MAX_RADIUS_KM = 463;

export const PROVIDERS = [
  {
    name: 'adsb.lol',
    url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  },
  {
    name: 'adsb.fi',
    url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  },
];

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function parseQuery(params) {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  const radiusKm = Number(params.get('radius') ?? 50);
  if (!params.has('lat') || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: 'lat must be a number between -90 and 90' };
  }
  if (!params.has('lon') || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { error: 'lon must be a number between -180 and 180' };
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > MAX_RADIUS_KM) {
    return { error: `radius must be between 1 and ${MAX_RADIUS_KM} km` };
  }
  const round4 = (v) => Math.round(v * 1e4) / 1e4;
  return { lat: round4(lat), lon: round4(lon), radiusKm };
}

export async function getAircraft(url) {
  const query = parseQuery(url.searchParams);
  if (query.error) return json({ error: query.error }, 400);

  const nm = Math.ceil(query.radiusKm / 1.852);
  const failures = [];
  for (const provider of PROVIDERS) {
    try {
      const res = await fetch(provider.url(query.lat, query.lon, nm), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = normalize(await res.json(), query);
      return json({ source: provider.name, center: query, ...data });
    } catch (err) {
      failures.push(`${provider.name}: ${err.message}`);
    }
  }
  return json({ error: 'No flight feed answered', failures }, 502);
}
