// The page's pure modules (formatting, map geometry); drawing is checked in a
// real browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { climbArrow, compass, displayName, formatAltitude, formatDirection, formatDistance, formatSpeed } from '../public/format.js';
import { cornerRangeKm, mapView, onMap } from '../public/radar.js';

test('compass points', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(11), 'N');
  assert.equal(compass(12), 'NNE');
  assert.equal(compass(195.6), 'SSW');
  assert.equal(compass(359), 'N');
  assert.equal(formatDirection(359.7), 'N 0°');
  assert.equal(formatDirection(195.6), 'SSW 196°');
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
