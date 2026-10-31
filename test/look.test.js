// Altitude colours and aircraft icons.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GROUND_COLOR, UNKNOWN_COLOR, altitudeColor, altitudeHue, hslToHex, legendGradient } from '../public/altitude.js';
import { SHAPES, iconKind } from '../public/icons.js';
import { normalize } from '../src/aircraft.js';

test('hsl to hex', () => {
  assert.equal(hslToHex(0, 1, 0.5), '#ff0000');
  assert.equal(hslToHex(120, 1, 0.5), '#00ff00');
  assert.equal(hslToHex(240, 1, 0.5), '#0000ff');
  assert.equal(hslToHex(0, 0, 0.5), '#808080');
});

test('altitude hue: orange low, through green and blue, magenta high; clamped', () => {
  assert.equal(altitudeHue(-50), 25);
  assert.equal(altitudeHue(0), 25);
  assert.equal(altitudeHue(1500), 55);
  assert.equal(altitudeHue(2250), 77.5); // halfway between the 1500 m and 3000 m stops
  assert.equal(altitudeHue(9000), 230);
  assert.equal(altitudeHue(15000), 290);
  for (let m = 0; m < 12000; m += 250) assert.ok(altitudeHue(m + 250) >= altitudeHue(m), `rises at ${m} m`);
});

test('ground and unknown altitude are grey; airborne gets a colour', () => {
  assert.equal(altitudeColor({ onGround: true, altM: null }), GROUND_COLOR);
  assert.equal(altitudeColor({ onGround: false, altM: null }), UNKNOWN_COLOR);
  assert.match(altitudeColor({ onGround: false, altM: 3000 }), /^#[0-9a-f]{6}$/);
  assert.notEqual(altitudeColor({ onGround: false, altM: 300 }), altitudeColor({ onGround: false, altM: 10000 }));
});

test('legend gradient spans 0 to 100%', () => {
  const g = legendGradient();
  assert.match(g, /^linear-gradient\(to right, #[0-9a-f]{6} 0\.0%, /);
  assert.match(g, / 100\.0%\)$/);
});

test('icons: from the emitter category, with type lists where it is not enough', () => {
  const kind = (category, type = null) => iconKind({ category, type });
  assert.equal(kind('A3', 'A320'), 'jet');
  assert.equal(kind('A3', 'B738'), 'jet');
  assert.equal(kind('A4', 'B752'), 'jet');
  assert.equal(kind('A5', 'B77W'), 'heavy');
  assert.equal(kind(null, 'A359'), 'heavy');
  assert.equal(kind('A2', 'CRJ2'), 'smalljet');
  assert.equal(kind('A2', 'AT76'), 'turboprop');
  assert.equal(kind('A3', 'DH8D'), 'turboprop');
  assert.equal(kind('A1', 'C172'), 'light');
  assert.equal(kind('B4', null), 'light');
  assert.equal(kind('A7', 'EC45'), 'helicopter');
  assert.equal(kind(null, 'EC35'), 'helicopter');
  assert.equal(kind('B1', 'DG80'), 'glider');
  assert.equal(kind('B2', null), 'balloon');
  assert.equal(kind('B6', null), 'drone');
  assert.equal(kind('A6', 'F16'), 'fast');
  assert.equal(kind(null, 'C172'), 'generic'); // no category: don't guess
  assert.equal(kind(null, null), 'generic');
  for (const k of ['jet', 'heavy', 'smalljet', 'turboprop', 'light', 'helicopter', 'glider', 'balloon', 'drone', 'fast', 'generic']) {
    assert.ok(SHAPES[k] && SHAPES[k].parts.length > 0, k);
  }
});

test('real traffic gets sensible icons (recorded adsb.lol response)', () => {
  const body = JSON.parse(readFileSync(new URL('fixtures/adsblol-cph.json', import.meta.url)));
  const { aircraft } = normalize(body, { lat: 55.6761, lon: 12.5683, radiusKm: 50 });
  const by = Object.fromEntries(aircraft.map((a) => [a.callsign ?? a.reg, iconKind(a)]));
  assert.equal(by.MEA225, 'jet'); // A320, A3
  assert.equal(by.SAS500, 'jet'); // A20N, A3
  assert.equal(by['OY-CLZ'], 'turboprop'); // AT75, A2
  assert.equal(by.DOC05, 'helicopter'); // EC45, A7
  assert.equal(by.SEVZR, 'light'); // EV97, A1
});
