// Turns a readsb-style response (adsb.lol, adsb.fi) into the small, metric
// list the page needs, sorted by distance from the centre.

import { bearingDeg, distanceKm } from './geo.js';

const FT_TO_M = 0.3048;
const KT_TO_KMH = 1.852;
const FPM_TO_MS = 0.00508;

// Positions older than this are dropped rather than drawn in the wrong place.
export const MAX_POSITION_AGE_S = 60;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, digits) => (v === null ? null : Number(v.toFixed(digits)));

// Ground stations and airport vehicles also transmit ADS-B. readsb types the
// stations at airports as "TWR"; emitter category C* is surface vehicles and
// obstacles.
function isAircraft(a) {
  if (a.t === 'TWR') return false;
  if (typeof a.category === 'string' && a.category.startsWith('C')) return false;
  return true;
}

export function toAircraft(a, center) {
  const lat = num(a.lat);
  const lon = num(a.lon);
  if (lat === null || lon === null) return null;
  if ((num(a.seen_pos) ?? 0) > MAX_POSITION_AGE_S) return null;
  if (!isAircraft(a)) return null;

  const onGround = a.alt_baro === 'ground';
  const altFt = onGround ? null : (num(a.alt_baro) ?? num(a.alt_geom));
  const gs = num(a.gs);
  const rate = num(a.baro_rate) ?? num(a.geom_rate);
  const track = num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading);
  // readsb writes '@' for callsign characters it couldn't decode.
  const callsign = typeof a.flight === 'string' ? a.flight.replace(/@/g, '').trim() : '';

  return {
    hex: String(a.hex || '').replace(/^~/, ''),
    callsign: callsign || null,
    reg: a.r || null,
    type: a.t || null,
    lat,
    lon,
    onGround,
    altM: altFt === null ? null : Math.round(altFt * FT_TO_M),
    speedKmh: gs === null ? null : Math.round(gs * KT_TO_KMH),
    trackDeg: round(track, 1),
    vrateMs: rate === null ? null : round(rate * FPM_TO_MS, 1),
    squawk: a.squawk || null,
    emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
    seenPosS: round(num(a.seen_pos), 1),
    distKm: round(distanceKm(center.lat, center.lon, lat, lon), 2),
    bearingDeg: round(bearingDeg(center.lat, center.lon, lat, lon), 1),
  };
}

export function normalize(body, center) {
  const list = body && (body.ac ?? body.aircraft);
  if (!Array.isArray(list)) throw new Error('Unexpected response: no aircraft list');

  // adsb.lol sends `now` in milliseconds, adsb.fi in seconds.
  const now = num(body.now);
  const nowMs = now === null ? Date.now() : now > 1e12 ? now : Math.round(now * 1000);

  const aircraft = list
    .map((a) => toAircraft(a, center))
    .filter((a) => a && a.distKm <= center.radiusKm)
    .sort((a, b) => a.distKm - b.distKm);

  return { now: nowMs, aircraft };
}
