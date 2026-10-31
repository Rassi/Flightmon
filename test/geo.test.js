import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bearingDeg, distanceKm } from '../src/geo.js';

const CPH = { lat: 55.6761, lon: 12.5683 };
const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

test('known distance: Copenhagen to Malmö is about 28 km', () => {
  const km = distanceKm(55.6761, 12.5683, 55.605, 13.0038);
  assert.ok(Math.abs(km - 28.3) < 0.5, `got ${km}`);
});

test('bearings point the right way', () => {
  assert.ok(Math.abs(bearingDeg(55, 12, 56, 12) - 0) < 1e-9);
  assert.ok(Math.abs(bearingDeg(55, 12, 54, 12) - 180) < 1e-9);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 1e-9);
  assert.ok(Math.abs(bearingDeg(0, 1, 0, 0) - 270) < 1e-9);
});

// Both feeds report each aircraft's distance (nm) and direction from the query
// point, computed by readsb. Ours must agree. readsb's distances differ from a
// spherical great circle by up to 0.22% depending on direction (it uses a
// different approximation), i.e. under 60 m at 30 km: well below a pixel.
for (const file of ['adsblol-cph.json', 'adsbfi-cph.json']) {
  test(`distance and bearing agree with readsb's dst/dir in ${file}`, () => {
    const body = fixture(file);
    const list = body.ac ?? body.aircraft;
    assert.ok(list.length > 5);
    for (const a of list) {
      const km = distanceKm(CPH.lat, CPH.lon, a.lat, a.lon);
      const deg = bearingDeg(CPH.lat, CPH.lon, a.lat, a.lon);
      const expected = a.dst * 1.852;
      assert.ok(Math.abs(km - expected) / expected < 0.003, `${a.hex}: ${km} km vs dst ${a.dst} nm`);
      const diff = Math.abs(((deg - a.dir + 540) % 360) - 180);
      assert.ok(diff < 0.2, `${a.hex}: ${deg}° vs dir ${a.dir}°`);
    }
  });
}
