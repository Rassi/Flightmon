'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAircraft, parseRoute, parsePhoto, distanceNm } = require('../lib/data');

test('normalizes a readsb v2 answer', () => {
  const [a] = normalizeAircraft({
    ac: [{
      hex: '4ACA8B', flight: 'SAS1420 ', r: 'SE-ROM', t: 'A20N', desc: 'AIRBUS A-320neo',
      lat: 55.7, lon: 12.6, alt_baro: 34000, gs: 452.1, track: 61.2, baro_rate: -64,
      squawk: '2271', dbFlags: 0, seen_pos: 1.2,
    }],
  });
  assert.equal(a.hex, '4aca8b');
  assert.equal(a.callsign, 'SAS1420');
  assert.equal(a.alt, 34000);
  assert.equal(a.ground, false);
  assert.equal(a.emergency, null);
  assert.equal(a.military, false);
  assert.equal(a.seen, 1.2);
});

test('reads a local aircraft.json and its quirks', () => {
  const list = normalizeAircraft({
    aircraft: [
      { hex: '~2a1b3c', lat: 55, lon: 12, alt_baro: 'ground', gs: 12 },        // TIS-B, on the ground
      { hex: '4ac000', lat: 55, lon: 12, alt_geom: 5000, true_heading: 90 },   // no baro altitude, no track
      { hex: '4ac001' },                                                        // no position
      { hex: '4ac002', lat: 55, lon: 12, seen_pos: 120 },                       // stale position
    ],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].hex, '2a1b3c');
  assert.equal(list[0].ground, true);
  assert.equal(list[0].alt, 0);
  assert.equal(list[1].alt, 5000);
  assert.equal(list[1].track, 90);
});

test('flags emergencies from the squawk or the emergency field', () => {
  const list = normalizeAircraft({
    ac: [
      { hex: 'a', lat: 1, lon: 1, squawk: '7700' },
      { hex: 'b', lat: 1, lon: 1, squawk: '1200', emergency: 'none' },
      { hex: 'c', lat: 1, lon: 1, emergency: 'lifeguard' },
      { hex: 'd', lat: 1, lon: 1, dbFlags: 1 },
    ],
  });
  assert.deepEqual(list.map((a) => a.emergency), ['emergency', null, 'lifeguard', null]);
  assert.equal(list[3].military, true);
});

test('parses an adsb.lol route', () => {
  const route = parseRoute([{
    callsign: 'SAS1420', airline_code: 'SAS', airport_codes: 'EKCH-ESSA', plausible: 1,
    _airports: [
      { iata: 'CPH', icao: 'EKCH', name: 'Copenhagen Kastrup Airport', location: 'Copenhagen', countryiso2: 'DK', lat: 55.618, lon: 12.656 },
      { iata: 'ARN', icao: 'ESSA', name: 'Stockholm-Arlanda Airport', location: 'Stockholm', countryiso2: 'SE', lat: 59.652, lon: 17.919 },
    ],
  }]);
  assert.equal(route.from.iata, 'CPH');
  assert.equal(route.to.city, 'Stockholm');
  assert.equal(route.to.lat, 59.652);
  assert.equal(route.airline, 'SAS');
  assert.equal(route.plausible, true);
  assert.deepEqual(route.via, []);
});

test('an unknown route is null', () => {
  assert.equal(parseRoute([{ callsign: 'XYZ1', airport_codes: 'unknown', _airports: [] }]), null);
  assert.equal(parseRoute([]), null);
  assert.equal(parseRoute(null), null);
});

test('parses a planespotters photo', () => {
  const photo = parsePhoto({
    photos: [{
      thumbnail: { src: 'https://t.plnspttrs.net/small.jpg' },
      thumbnail_large: { src: 'https://t.plnspttrs.net/large.jpg' },
      link: 'https://www.planespotters.net/photo/1', photographer: 'A. Spotter',
    }],
  });
  assert.deepEqual(photo, { src: 'https://t.plnspttrs.net/large.jpg', link: 'https://www.planespotters.net/photo/1', photographer: 'A. Spotter' });
  assert.equal(parsePhoto({ photos: [] }), null);
});

test('distance in nautical miles', () => {
  // Copenhagen to Stockholm Arlanda is about 300 nm.
  const d = distanceNm(55.618, 12.656, 59.652, 17.919);
  assert.ok(d > 290 && d < 310, String(d));
  assert.equal(distanceNm(55, 12, 55, 12), 0);
});
