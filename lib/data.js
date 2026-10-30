'use strict';

// Turns what the providers send into the small shape the browser draws from.
// Kept apart from server.js so it can be tested without a network.

const EMERGENCY_SQUAWKS = { 7500: 'hijack', 7600: 'radio failure', 7700: 'emergency' };

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// readsb "v2" APIs answer { ac: [...] }; a local receiver's aircraft.json is
// { aircraft: [...] }. Same fields inside either way.
function normalizeAircraft(raw) {
  const list = (raw && (raw.ac || raw.aircraft)) || [];
  const out = [];
  for (const a of list) {
    const lat = num(a.lat);
    const lon = num(a.lon);
    if (lat === null || lon === null || !a.hex) continue;
    // Positions older than a minute are where the plane was, not where it is.
    const seen = num(a.seen_pos) !== null ? a.seen_pos : num(a.seen) || 0;
    if (seen > 60) continue;
    const ground = a.alt_baro === 'ground';
    const squawk = text(a.squawk);
    const emergency = text(a.emergency) && a.emergency !== 'none'
      ? a.emergency
      : (squawk && EMERGENCY_SQUAWKS[squawk]) || null;
    out.push({
      hex: String(a.hex).toLowerCase().replace(/^~/, ''),
      callsign: text(a.flight),
      reg: text(a.r),
      type: text(a.t),
      desc: text(a.desc),
      owner: text(a.ownOp),
      lat,
      lon,
      alt: ground ? 0 : num(a.alt_baro) !== null ? a.alt_baro : num(a.alt_geom),
      ground,
      gs: num(a.gs),
      track: num(a.track) !== null ? a.track : num(a.true_heading),
      vrate: num(a.baro_rate) !== null ? a.baro_rate : num(a.geom_rate),
      squawk,
      emergency,
      military: Boolean((a.dbFlags || 0) & 1),
      category: text(a.category),
      seen,
    });
  }
  return out;
}

function airport(a) {
  if (!a) return null;
  return {
    iata: text(a.iata),
    icao: text(a.icao),
    name: text(a.name),
    city: text(a.location),
    country: text(a.countryiso2),
    lat: num(a.lat),
    lon: num(a.lon),
  };
}

// adsb.lol's routeset answers with one entry per plane asked about.
// Routes come from a crowd-sourced database, so "plausible" matters: an
// implausible route is usually last season's flight number.
function parseRoute(raw) {
  const entry = Array.isArray(raw) ? raw[0] : null;
  if (!entry || !entry.airport_codes || entry.airport_codes === 'unknown') return null;
  const airports = Array.isArray(entry._airports) ? entry._airports.map(airport) : [];
  if (airports.length < 2) return null;
  return {
    callsign: text(entry.callsign),
    airline: text(entry.airline_code),
    from: airports[0],
    to: airports[airports.length - 1],
    via: airports.slice(1, -1),
    plausible: Boolean(entry.plausible),
  };
}

function parsePhoto(raw) {
  const p = raw && Array.isArray(raw.photos) ? raw.photos[0] : null;
  if (!p) return null;
  const image = p.thumbnail_large || p.thumbnail;
  if (!image || !image.src) return null;
  return { src: image.src, link: text(p.link), photographer: text(p.photographer) };
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { normalizeAircraft, parseRoute, parsePhoto, distanceNm };
