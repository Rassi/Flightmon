// The page's pure modules (formatting, radar geometry); drawing is checked in a
// real browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { climbArrow, compass, displayName, formatAltitude, formatDirection, formatDistance, formatSpeed } from '../public/format.js';
import { ringStep } from '../public/radar.js';

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

test('ring spacing is a round number, about a quarter of the range', () => {
  assert.equal(ringStep(50), 10);
  assert.equal(ringStep(25), 5);
  assert.equal(ringStep(100), 20);
  assert.equal(ringStep(463), 100);
  assert.equal(ringStep(10), 2);
});
