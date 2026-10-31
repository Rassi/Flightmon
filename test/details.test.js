import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { clearCaches, lookup, parseAircraft, parseRoute, routeFits } from '../public/details.js';
import { makeView } from '../public/mercator.js';
import { hitTest } from '../public/radar.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const route = JSON.parse(fixture('adsbdb-callsign-SAS500.json')).response.flightroute;
const airframe = JSON.parse(fixture('adsbdb-aircraft-4cacb6.json')).response.aircraft;

test('parses a recorded adsbdb route and aircraft', () => {
  const r = parseRoute(route);
  assert.equal(r.flightNumber, 'SK500');
  assert.equal(r.airline, 'Scandinavian Airlines System');
  assert.deepEqual(
    [r.origin.code, r.origin.name, r.origin.city, r.origin.country],
    ['LHR', 'London Heathrow Airport', 'London', 'United Kingdom'],
  );
  assert.deepEqual([r.destination.code, r.destination.lat, r.destination.lon], ['CPH', 55.6179, 12.656]);
  assert.deepEqual(parseAircraft(airframe), {
    manufacturer: 'Airbus', model: 'A320 251NSL', icaoType: 'A20N', registration: 'EI-SIC',
    owner: 'Scandinavian Airlines Connect', ownerCountry: 'Ireland',
  });
  assert.equal(parseRoute(null), null);
  assert.equal(parseAircraft(null), null);
});

test('route check: on the way fits, far off does not', () => {
  const r = parseRoute(route); // London Heathrow → Copenhagen
  assert.ok(routeFits({ lat: 55.510797, lon: 12.475319 }, r)); // SAS500 as recorded, approaching CPH
  assert.ok(routeFits({ lat: 53.5, lon: 5.0 }, r)); // over the North Sea, on the way
  assert.ok(routeFits({ lat: 51.48, lon: -0.3 }, r)); // just departed LHR
  assert.ok(!routeFits({ lat: 59.65, lon: 17.9 }, r)); // Stockholm: not on the way
  assert.ok(!routeFits({ lat: 48.0, lon: 11.0 }, r)); // Munich
});

// fetch stub: answers from a { url-suffix: [status, body] } table and records calls.
function stub(table) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const hit = Object.entries(table).find(([suffix]) => url.endsWith(suffix));
    if (!hit) throw new TypeError('fetch failed');
    const [status, body] = hit[1];
    return new Response(body, { status });
  };
  return { calls, fetchFn };
}

beforeEach(() => clearCaches());

test('lookup asks adsbdb for the aircraft and the callsign, in parallel', async () => {
  const { calls, fetchFn } = stub({
    '/aircraft/4cacb6': [200, fixture('adsbdb-aircraft-4cacb6.json')],
    '/callsign/SAS500': [200, fixture('adsbdb-callsign-SAS500.json')],
  });
  const info = await lookup('4cacb6', 'SAS500', fetchFn);
  assert.deepEqual(calls.sort(), ['https://api.adsbdb.com/v0/aircraft/4cacb6', 'https://api.adsbdb.com/v0/callsign/SAS500']);
  assert.equal(info.aircraft.registration, 'EI-SIC');
  assert.equal(info.route.destination.code, 'CPH');
  assert.deepEqual(info.errors, []);
});

test('unknown aircraft or callsign (404, 400) is "not known", not an error', async () => {
  const { fetchFn } = stub({
    '/aircraft/478de3': [404, fixture('adsbdb-unknown-aircraft.json')],
    '/callsign/DOC05': [400, '{"response":"invalid callsign: DOC05"}'],
  });
  assert.deepEqual(await lookup('478de3', 'DOC05', fetchFn), { aircraft: null, route: null, errors: [] });
});

test('no callsign: only the aircraft is looked up', async () => {
  const { calls, fetchFn } = stub({ '/aircraft/4cacb6': [200, fixture('adsbdb-aircraft-4cacb6.json')] });
  const info = await lookup('4cacb6', null, fetchFn);
  assert.equal(calls.length, 1);
  assert.equal(info.route, null);
});

test('one lookup failing keeps the other; failures are retried, answers are cached', async () => {
  const { calls, fetchFn } = stub({
    '/aircraft/4cacb6': [429, '{"response":"rate limited"}'],
    '/callsign/SAS500': [200, fixture('adsbdb-callsign-SAS500.json')],
  });
  const info = await lookup('4cacb6', 'SAS500', fetchFn);
  assert.equal(info.aircraft, null);
  assert.equal(info.route.origin.code, 'LHR');
  assert.deepEqual(info.errors, ['adsbdb answered HTTP 429']);
  await lookup('4cacb6', 'SAS500', fetchFn);
  // The route came from the cache; the failed aircraft lookup was tried again.
  assert.deepEqual(calls.filter((u) => u.includes('/callsign/')).length, 1);
  assert.deepEqual(calls.filter((u) => u.includes('/aircraft/')).length, 2);
});

test('network failure is reported', async () => {
  const { fetchFn } = stub({});
  const info = await lookup('4cacb6', 'SAS500', fetchFn);
  assert.deepEqual(info.errors, ['fetch failed', 'fetch failed']);
});

test('clicking: the nearest aircraft within reach, or none', () => {
  const view = makeView({ lat: 55.6761, lon: 12.5683 }, 50, 400, 900, 900);
  const a = { hex: 'a', lat: 55.7, lon: 12.6, distKm: 3 };
  const b = { hex: 'b', lat: 55.71, lon: 12.6, distKm: 4 };
  const pa = view.toScreen(a.lat, a.lon);
  const pb = view.toScreen(b.lat, b.lon);
  assert.equal(hitTest(view, [a, b], pa.x + 3, pa.y)?.hex, 'a');
  assert.equal(hitTest(view, [a, b], pb.x, pb.y - 2)?.hex, 'b');
  assert.equal(hitTest(view, [a, b], pa.x + 60, pa.y), null);
  assert.equal(hitTest(view, [{ ...a, distKm: 60 }], pa.x, pa.y), null); // outside the range: not drawn
});
