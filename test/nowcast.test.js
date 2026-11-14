import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AHEAD_MIN, PAIR_MIN, estimateMotion, forecastHome, gridFromPixels, isPrecip, warningText,
} from '../public/nowcast.js';

const KM = 1.38; // a cell at Copenhagen
const N = 146; // 100 km each way

// A grid with rain in circles: { east, north, r } in km from home (the middle).
function grid(blobs) {
  const cells = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const east = (i + 0.5 - N / 2) * KM;
      const north = -(j + 0.5 - N / 2) * KM;
      if (blobs.some((b) => (east - b.east) ** 2 + (north - b.north) ** 2 <= b.r ** 2)) cells[j * N + i] = 1;
    }
  }
  return { n: N, cells, kmPerCell: KM };
}

// A ragged band of showers, moved by (east, north) km.
const showers = (east, north) => [
  { east: -40 + east, north: 10 + north, r: 12 },
  { east: -25 + east, north: -15 + north, r: 8 },
  { east: -55 + east, north: -5 + north, r: 6 },
  { east: -30 + east, north: 30 + north, r: 5 },
];

const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('colours: rain and snow count, drizzle tan and empty pixels don\'t', () => {
  for (const c of [[0, 145, 202, 255], [136, 221, 238, 255], [255, 210, 0, 255], [93, 0, 0, 255], [255, 119, 255, 255], [120, 184, 255, 255], [194, 255, 255, 204]]) {
    assert.equal(isPrecip(...c), true, c.join());
  }
  for (const c of [[222, 208, 151, 190], [222, 208, 151, 255], [99, 97, 89, 20], [0, 0, 0, 0], [200, 255, 255, 102]]) {
    assert.equal(isPrecip(...c), false, c.join());
  }
});

test('grid from pixels: the share of rain pixels in each cell', () => {
  const w = 8, h = 8;
  const data = new Uint8ClampedArray(w * h * 4);
  const paint = (x, y) => data.set([0, 145, 202, 255], (y * w + x) * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) paint(x, y); // top left full
  for (let x = 4; x < 8; x++) paint(x, 7); // one row of the bottom right
  const g = gridFromPixels(data, w, h, 4, 0.35);
  assert.equal(g.n, 2);
  assert.deepEqual([...g.cells], [1, 0, 0, 0.25]);
  assert.equal(g.kmPerCell, 1.4);
});

test('movement: showers moving east at 60 km/h come from the west', () => {
  const m = estimateMotion(grid(showers(0, 0)), grid(showers(20, 0)), PAIR_MIN);
  assert.ok(Math.abs(m.speedKmh - 60) < 3, m.speedKmh);
  assert.ok(angle(m.fromDeg, 270) < 4, m.fromDeg);
  assert.ok(m.score > 0.9);
});

test('movement: from the south-west at 45 km/h', () => {
  const d = (45 * PAIR_MIN) / 60 / Math.SQRT2; // km east and north
  const m = estimateMotion(grid(showers(0, 0)), grid(showers(d, d)), PAIR_MIN);
  assert.ok(Math.abs(m.speedKmh - 45) < 3, m.speedKmh);
  assert.ok(angle(m.fromDeg, 225) < 5, m.fromDeg);
});

test('movement: fast (110 km/h from the north), within the search', () => {
  const m = estimateMotion(grid(showers(0, 30)), grid(showers(0, 30 - (110 * PAIR_MIN) / 60)), PAIR_MIN);
  assert.ok(Math.abs(m.speedKmh - 110) < 4, m.speedKmh);
  assert.ok(angle(m.fromDeg, 0) < 4, m.fromDeg);
});

test('movement: standing still, or not measurable with (almost) no rain', () => {
  const still = estimateMotion(grid(showers(0, 0)), grid(showers(0.5, 0)), PAIR_MIN);
  assert.equal(still.speedKmh, 0);
  assert.equal(still.fromDeg, null);
  assert.equal(estimateMotion(grid([]), grid([]), PAIR_MIN), null);
  assert.equal(estimateMotion(grid([{ east: 0, north: 0, r: 1 }]), grid([{ east: 1, north: 0, r: 1 }]), PAIR_MIN), null);
});

const T0 = Date.UTC(2026, 10, 14, 13, 50);
const at = (ms) => (ms - T0) / 60000; // minutes after the newest image

test('forecast: rain 35 km west moving east at 60 km/h reaches home in about 35 min', () => {
  const newer = grid([{ east: -50, north: 0, r: 15 }]);
  const m = estimateMotion(grid([{ east: -70, north: 0, r: 15 }]), newer, PAIR_MIN);
  const f = forecastHome(newer, m, T0);
  assert.equal(f.rainNow, false);
  assert.ok(at(f.startsAt) >= 32 && at(f.startsAt) <= 36, at(f.startsAt));
  assert.equal(f.endsAt, null);
});

test('forecast: raining at home now, until the back edge passes', () => {
  const newer = grid([{ east: 0, north: 0, r: 20 }, { east: -60, north: 20, r: 10 }]);
  const m = estimateMotion(grid([{ east: -20, north: 0, r: 20 }, { east: -80, north: 20, r: 10 }]), newer, PAIR_MIN);
  const f = forecastHome(newer, m, T0);
  assert.equal(f.rainNow, true);
  assert.ok(at(f.endsAt) >= 18 && at(f.endsAt) <= 23, at(f.endsAt));
});

test('forecast: rain moving away, standing still, or with unknown movement', () => {
  const away = forecastHome(grid([{ east: 30, north: 0, r: 10 }]), { dxPerMin: 1 / KM, dyPerMin: 0, speedKmh: 60, fromDeg: 270 }, T0);
  assert.deepEqual(away, { rainNow: false, startsAt: null, endsAt: null, aheadMin: AHEAD_MIN });
  const still = forecastHome(grid([{ east: 0, north: 0, r: 10 }]), { dxPerMin: 0, dyPerMin: 0, speedKmh: 0, fromDeg: null }, T0);
  assert.deepEqual(still, { rainNow: true, startsAt: null, endsAt: null, aheadMin: 0 });
  assert.equal(forecastHome(grid([]), null, T0).rainNow, false);
});

test('forecast: stops at the grid\'s edge when the rain is fast', () => {
  // 120 km/h: the rain over home 50 min on is 100 km away, off the grid.
  const f = forecastHome(grid([]), { dxPerMin: 2 / KM, dyPerMin: 0, speedKmh: 120, fromDeg: 270 }, T0);
  assert.ok(f.aheadMin >= 45 && f.aheadMin < 50, f.aheadMin);
});

test('warning text', () => {
  const clock = (ms) => new Date(ms).toISOString().slice(11, 16);
  const now = T0 + 12 * 60000; // 14:02
  const min = (m) => T0 + m * 60000;
  assert.equal(warningText(null, now, clock), '');
  assert.equal(warningText({ rainNow: false, startsAt: null }, now, clock), '');
  assert.equal(warningText({ rainNow: false, startsAt: min(34) }, now, clock), 'Rain at home from ~14:25'); // 14:24, to 5 min
  assert.equal(warningText({ rainNow: false, startsAt: min(13) }, now, clock), 'Rain at home about now');
  assert.equal(warningText({ rainNow: false, startsAt: min(2) }, now, clock), 'Rain at home about now');
  assert.equal(warningText({ rainNow: true, endsAt: null }, now, clock), 'Raining at home');
  assert.equal(warningText({ rainNow: true, endsAt: min(41) }, now, clock), 'Raining at home, until ~14:30');
  assert.equal(warningText({ rainNow: true, endsAt: min(10) }, now, clock), '');
});
