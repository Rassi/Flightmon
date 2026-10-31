import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalize, toAircraft } from '../src/aircraft.js';

const CENTER = { lat: 55.6761, lon: 12.5683, radiusKm: 50 };
const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

test('adsb.lol: drops ground stations and vehicles, keeps aircraft, sorted by distance', () => {
  const { now, aircraft } = normalize(fixture('adsblol-cph.json'), CENTER);
  assert.equal(now, 1793435806000);
  const hexes = aircraft.map((a) => a.hex);
  // TWR stations (45fe49, 45fe4a, 45fe4b) and category C0 vehicles (45fc63, 45fc64) are gone.
  for (const hex of ['45fe49', '45fe4a', '45fe4b', '45fc63', '45fc64']) assert.ok(!hexes.includes(hex), hex);
  assert.equal(aircraft.length, 9);
  for (let i = 1; i < aircraft.length; i++) assert.ok(aircraft[i - 1].distKm <= aircraft[i].distKm);
});

test('adsb.fi: same format, `now` in seconds', () => {
  const { now, aircraft } = normalize(fixture('adsbfi-cph.json'), CENTER);
  assert.equal(now, 1793435806002);
  assert.ok(aircraft.length > 0);
  assert.ok(aircraft.every((a) => a.type !== 'TWR'));
});

test('converts to metric', () => {
  const { aircraft } = normalize(fixture('adsblol-cph.json'), CENTER);
  const mea = aircraft.find((a) => a.callsign === 'MEA225');
  assert.deepEqual(
    { reg: mea.reg, type: mea.type, altM: mea.altM, speedKmh: mea.speedKmh, trackDeg: mea.trackDeg, vrateMs: mea.vrateMs, squawk: mea.squawk },
    { reg: 'T7-FBA', type: 'A320', altM: 754, speedKmh: 362, trackDeg: 329.9, vrateMs: 0, squawk: '2227' },
  );
  // readsb: 15.554 nm at 195.6°
  assert.ok(Math.abs(mea.distKm - 15.554 * 1.852) < 0.1);
  assert.ok(Math.abs(mea.bearingDeg - 195.6) < 0.2);

  assert.equal(mea.category, 'A3');

  const sas = aircraft.find((a) => a.callsign === 'SAS500');
  assert.equal(sas.vrateMs, -5.9); // -1152 ft/min
});

test('aircraft on the ground have no altitude and fall back to heading for direction', () => {
  const base = { hex: 'abc123', lat: 55.6, lon: 12.6, seen_pos: 1 };
  const ground = toAircraft({ ...base, alt_baro: 'ground', true_heading: 90.04 }, CENTER);
  assert.equal(ground.onGround, true);
  assert.equal(ground.altM, null);
  assert.equal(ground.trackDeg, 90);
});

test('drops positionless and stale aircraft; trims callsigns; strips the ~ of non-ICAO addresses', () => {
  const base = { hex: '~2a0001', lat: 55.6, lon: 12.6, seen_pos: 1, flight: 'ABC123  ', alt_baro: 1000 };
  assert.equal(toAircraft({ ...base, lat: undefined }, CENTER), null);
  assert.equal(toAircraft({ ...base, seen_pos: 61 }, CENTER), null);
  const ac = toAircraft(base, CENTER);
  assert.equal(ac.callsign, 'ABC123');
  assert.equal(ac.hex, '2a0001');
  assert.equal(toAircraft({ ...base, flight: '   ' }, CENTER).callsign, null);
  // Seen live: undecoded characters come through as '@'.
  assert.equal(toAircraft({ ...base, flight: '@@@@@@@@' }, CENTER).callsign, null);
});

test('only aircraft inside the radius are kept (feeds are queried in whole nm)', () => {
  const { aircraft } = normalize(fixture('adsblol-cph.json'), { ...CENTER, radiusKm: 20 });
  assert.ok(aircraft.length > 0);
  assert.ok(aircraft.every((a) => a.distKm <= 20));
});

test('emergency is null when the feed says "none"', () => {
  const base = { hex: 'abc123', lat: 55.6, lon: 12.6, seen_pos: 1 };
  assert.equal(toAircraft({ ...base, emergency: 'none' }, CENTER).emergency, null);
  assert.equal(toAircraft({ ...base, emergency: 'general' }, CENTER).emergency, 'general');
});

test('rejects a response without an aircraft list', () => {
  assert.throws(() => normalize({ error: 'nope' }, CENTER), /no aircraft list/);
});
