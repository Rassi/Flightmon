// Details for one aircraft: its route and airframe from adsbdb.com, looked up
// when it is clicked. adsbdb sends CORS headers, so the browser asks it
// directly. Answers are kept in memory for this page only: adsbdb's route
// data may not be copied, published or put into other databases.

import { formatAltitude, formatDirection, formatDistance, formatSpeed, displayName } from './format.js';
import { distanceKm } from './geo.js';

const API = 'https://api.adsbdb.com/v0';
const TIMEOUT_MS = 8000;

export const CREDIT =
  'Route and aircraft data: adsbdb.com. Routes by David J Taylor (Edinburgh) and Jim Mason; ' +
  'aircraft data from PlaneBase.';

// adsbdb's `response` field, or null when it doesn't know the aircraft or callsign.
async function get(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404 || res.status === 400) return null; // unknown / invalid
  if (!res.ok) throw new Error(`adsbdb answered HTTP ${res.status}`);
  return (await res.json()).response;
}

export function parseAircraft(a) {
  if (!a) return null;
  return {
    manufacturer: a.manufacturer || null,
    model: a.type || null,
    icaoType: a.icao_type || null,
    registration: a.registration || null,
    owner: a.registered_owner || null,
    ownerCountry: a.registered_owner_country_name || null,
  };
}

const airport = (p) => p && {
  code: p.iata_code || p.icao_code,
  icao: p.icao_code,
  name: p.name,
  city: p.municipality || null,
  country: p.country_name || null,
  lat: p.latitude,
  lon: p.longitude,
};

export function parseRoute(r) {
  if (!r || !r.origin || !r.destination) return null;
  return {
    flightNumber: r.callsign_iata || null,
    airline: r.airline ? r.airline.name : null,
    origin: airport(r.origin),
    destination: airport(r.destination),
  };
}

// In-memory caches for this page; failed lookups are forgotten, so they're retried.
const aircraftCache = new Map();
const routeCache = new Map();

function cached(cache, key, load) {
  if (!cache.has(key)) {
    const p = load();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}

// Both lookups run in parallel; either can fail without losing the other.
export async function lookup(hex, callsign, fetchFn = fetch) {
  const [aircraft, route] = await Promise.allSettled([
    cached(aircraftCache, hex, () => get(`${API}/aircraft/${encodeURIComponent(hex)}`, fetchFn).then((r) => parseAircraft(r?.aircraft))),
    callsign
      ? cached(routeCache, callsign, () => get(`${API}/callsign/${encodeURIComponent(callsign)}`, fetchFn).then((r) => parseRoute(r?.flightroute)))
      : Promise.resolve(null),
  ]);
  const errors = [aircraft, route].filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  return {
    aircraft: aircraft.status === 'fulfilled' ? aircraft.value : null,
    route: route.status === 'fulfilled' ? route.value : null,
    errors,
  };
}

export function clearCaches() {
  aircraftCache.clear();
  routeCache.clear();
}

// A callsign's route can be out of date. It fits when the aircraft is roughly
// on the way: origin → aircraft → destination is at most 10% + 100 km longer
// than flying direct.
export function routeFits(ac, route) {
  const { origin: o, destination: d } = route;
  const direct = distanceKm(o.lat, o.lon, d.lat, d.lon);
  const via = distanceKm(o.lat, o.lon, ac.lat, ac.lon) + distanceKm(ac.lat, ac.lon, d.lat, d.lon);
  return via <= direct * 1.1 + 100;
}

// --- the card ----------------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function climb(vrateMs) {
  if (vrateMs === null) return '';
  if (vrateMs > 1) return `, climbing ${vrateMs.toFixed(1)} m/s`;
  if (vrateMs < -1) return `, descending ${(-vrateMs).toFixed(1)} m/s`;
  return ', level';
}

function airportBlock(p) {
  const div = el('div', 'airport');
  div.append(el('span', 'code', p.code));
  div.append(el('span', 'place', p.name));
  const where = [p.city, p.country].filter(Boolean).join(', ');
  if (where) div.append(el('span', 'where', where));
  return div;
}

// `info`: undefined while loading, else lookup()'s result. `seen`: whether
// the aircraft was in the latest update.
export function renderDetails(container, { ac, info, seen, onClose }) {
  const head = el('div', 'details-head');
  const title = el('div');
  title.append(el('h2', null, displayName(ac)));
  const route = info?.route;
  const sub = [route?.airline, route?.flightNumber].filter(Boolean).join(' · ');
  if (sub) title.append(el('p', 'sub', sub));
  const close = el('button', 'close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close details');
  close.addEventListener('click', onClose);
  head.append(title, close);

  const parts = [head];
  if (!ac.callsign) {
    parts.push(el('p', 'note', 'No callsign, so no route to look up.'));
  } else if (info === undefined) {
    parts.push(el('p', 'note', 'Looking up the route…'));
  } else if (route) {
    const r = el('div', 'route');
    r.append(airportBlock(route.origin), el('span', 'arrow', '→'), airportBlock(route.destination));
    parts.push(r);
    if (!routeFits(ac, route)) {
      parts.push(el('p', 'note warn', `This is the usual route for ${ac.callsign}, but the aircraft's position doesn't fit it. It may be out of date.`));
    }
  } else if (!info.errors.length) {
    parts.push(el('p', 'note', `No route known for ${ac.callsign}.`));
  }
  if (info?.errors.length) parts.push(el('p', 'note warn', `Couldn't look up details: ${info.errors.join('; ')}`));
  if (!seen) parts.push(el('p', 'note warn', 'Not in the latest update; showing the last position.'));

  const a = info?.aircraft;
  const facts = [
    ['Aircraft', a ? [a.manufacturer, a.model].filter(Boolean).join(' ') + (a.icaoType ? ` (${a.icaoType})` : '') : ac.type],
    ['Registration', a?.registration ?? ac.reg],
    ['Owner', a?.owner ? [a.owner, a.ownerCountry].filter(Boolean).join(', ') : null],
    ['Altitude', ac.onGround || ac.altM === null ? formatAltitude(ac) : formatAltitude(ac) + climb(ac.vrateMs)],
    ['Speed', formatSpeed(ac.speedKmh)],
    ['Heading', ac.trackDeg === null ? null : `${Math.round(ac.trackDeg) % 360}°`],
    ['Position', `${formatDistance(ac.distKm)} ${formatDirection(ac.bearingDeg)}`],
    ['Squawk', ac.squawk],
    ['ICAO address', ac.hex.toUpperCase()],
  ];
  const dl = el('dl', 'facts');
  for (const [k, v] of facts) {
    if (v === null || v === undefined || v === '') continue;
    dl.append(el('dt', null, k), el('dd', null, v));
  }
  parts.push(dl);
  if (info && (info.aircraft || info.route)) parts.push(el('p', 'credit', CREDIT));
  container.replaceChildren(...parts);
}
