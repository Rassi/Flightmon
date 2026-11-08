// The page's pure modules (formatting, map geometry); drawing is checked in a
// real browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { climbArrow, compass, displayName, formatAltitude, formatDistance, formatSpeed } from '../public/format.js';
import { cornerRangeKm, mapView, maxRangeKm, onMap } from '../public/radar.js';
import { delayMs, isRateLimited, nextBackoffS } from '../public/polling.js';

test('compass points', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(11), 'N');
  assert.equal(compass(12), 'NNE');
  assert.equal(compass(195.6), 'SSW');
  assert.equal(compass(359), 'N');
});

test('distances, altitudes and speeds', () => {
  assert.equal(formatDistance(4.234), '4.2 km');
  assert.equal(formatDistance(28.81), '29 km');
  assert.equal(formatAltitude({ onGround: true, altM: null }), 'Ground');
  assert.equal(formatAltitude({ onGround: false, altM: null }), '–');
  assert.equal(formatAltitude({ onGround: false, altM: 754 }), '754 m');
  assert.match(formatAltitude({ onGround: false, altM: 10668 }), /^10\D?668 m$/);
  assert.equal(formatSpeed(362), '362 km/h');
  assert.equal(formatSpeed(null), '–');
});

test('climb arrows ignore level flight', () => {
  assert.equal(climbArrow(5.9), '↑');
  assert.equal(climbArrow(-5.9), '↓');
  assert.equal(climbArrow(0.5), '');
  assert.equal(climbArrow(null), '');
});

test('names: callsign, then registration, then the ICAO address', () => {
  assert.equal(displayName({ callsign: 'SAS500', reg: 'EI-SIC', hex: '4cacb6' }), 'SAS500');
  assert.equal(displayName({ callsign: null, reg: 'OY-CLZ', hex: '458d9a' }), 'OY-CLZ');
  assert.equal(displayName({ callsign: null, reg: null, hex: '458d9a' }), '458D9A');
});

test('the range reaches the nearest edge; aircraft are asked for out to the corners', () => {
  const center = { lat: 55.6761, lon: 12.5683 };
  const view = mapView(center, 50, 1000, 800);
  // 50 km north is at the top edge (800 / 2 px up), give or take Mercator's stretch over 50 km.
  const north = view.toScreen(center.lat + 50 / 111.2, center.lon);
  assert.ok(Math.abs(north.y) < 8, `north edge at y=${north.y}`);
  assert.equal(Math.round(cornerRangeKm(50, 1000, 800)), 80); // 50 × √(1000² + 800²) / 800
  assert.equal(cornerRangeKm(50, 800, 800), 50 * Math.SQRT2);
  assert.equal(cornerRangeKm(50, 0, 0), 50 * Math.SQRT2); // not laid out yet
});

test('on the map: inside the visible rectangle, corners included', () => {
  const center = { lat: 55.6761, lon: 12.5683 };
  const view = mapView(center, 50, 1000, 800);
  assert.ok(onMap(view, center));
  assert.ok(onMap(view, { lat: center.lat, lon: center.lon + 0.95 })); // ~60 km east: inside the wider side
  assert.ok(!onMap(view, { lat: center.lat + 0.5, lon: center.lon })); // ~56 km north: past the top
  assert.ok(!onMap(view, { lat: center.lat, lon: center.lon + 1.3 })); // ~81 km east: past the right
});

test('zoom-out cap: the feeds still reach the corners', () => {
  assert.equal(maxRangeKm(1000, 800), Math.floor(463 * 800 / Math.hypot(1000, 800))); // 289
  assert.ok(cornerRangeKm(maxRangeKm(1000, 800), 1000, 800) <= 463);
  assert.equal(maxRangeKm(800, 800), Math.floor(463 / Math.SQRT2)); // 327
  assert.equal(maxRangeKm(0, 0), 463); // not laid out yet
});

test('requests: at least 5 s apart, refreshes on time, longer waits after a 429', () => {
  const t = 1_000_000;
  // Moving the map right after a request waits out the 5 s.
  assert.equal(delayMs({ now: t + 1000, lastAt: t, wanted: true, refreshS: 30 }), 4000);
  assert.equal(delayMs({ now: t + 9000, lastAt: t, wanted: true, refreshS: 30 }), 0);
  // Otherwise the next refresh, counted from the last request.
  assert.equal(delayMs({ now: t + 2000, lastAt: t, wanted: false, refreshS: 30 }), 28000);
  // Backing off: nothing before it's over, even when wanted.
  assert.equal(delayMs({ now: t + 1000, lastAt: t, wanted: true, refreshS: 30, backoffS: 60 }), 59000);
  assert.equal(nextBackoffS(0, 30), 60);
  assert.equal(nextBackoffS(60, 30), 120);
  assert.equal(nextBackoffS(120, 30), 120);
  assert.equal(nextBackoffS(0, 5), 10);
  assert.equal(nextBackoffS(80, 5), 120);
});

test('rate-limited: a 429, or a 502 when every feed answered 429', () => {
  assert.ok(isRateLimited(429, {}));
  assert.ok(isRateLimited(502, { failures: ['adsb.lol: HTTP 429', 'adsb.fi: HTTP 429'] }));
  assert.ok(!isRateLimited(502, { failures: ['adsb.lol: HTTP 429', 'adsb.fi: HTTP 503'] }));
  assert.ok(!isRateLimited(502, { failures: [] }));
  assert.ok(!isRateLimited(500, null));
});
