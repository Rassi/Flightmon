import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { parseQuery } from '../src/api.js';
import worker from '../src/worker.js';

const lol = readFileSync(new URL('fixtures/adsblol-cph.json', import.meta.url), 'utf8');
const fi = readFileSync(new URL('fixtures/adsbfi-cph.json', import.meta.url), 'utf8');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Replace fetch with a function of the requested URL; records each call.
function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url));
  };
  return calls;
}

const get = (path) => worker.fetch(new Request(`http://localhost${path}`));

test('uses adsb.lol, with the radius converted to whole nm and an identifying User-Agent', async () => {
  const calls = stubFetch(() => new Response(lol));
  const res = await get('/api/aircraft?lat=55.6761&lon=12.5683&radius=50');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.source, 'adsb.lol');
  assert.equal(body.aircraft.length, 9);
  assert.deepEqual(body.center, { lat: 55.6761, lon: 12.5683, radiusKm: 50 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.adsb.lol/v2/point/55.6761/12.5683/27');
  assert.match(calls[0].init.headers['User-Agent'], /^Flightmon \(\+https:/);
});

test('falls back to adsb.fi when adsb.lol fails', async () => {
  const calls = stubFetch((url) =>
    url.includes('adsb.lol') ? new Response('busy', { status: 503 }) : new Response(fi));
  const body = await (await get('/api/aircraft?lat=55.6761&lon=12.5683&radius=50')).json();
  assert.equal(body.source, 'adsb.fi');
  assert.equal(calls[1].url, 'https://opendata.adsb.fi/api/v2/lat/55.6761/lon/12.5683/dist/27');
});

test('falls back when adsb.lol answers with something that is not aircraft data', async () => {
  stubFetch((url) => (url.includes('adsb.lol') ? new Response('{"msg":"oops"}') : new Response(fi)));
  const body = await (await get('/api/aircraft?lat=55.6761&lon=12.5683')).json();
  assert.equal(body.source, 'adsb.fi');
});

test('502 with the reasons when every feed fails', async () => {
  stubFetch((url) => {
    if (url.includes('adsb.lol')) throw new TypeError('fetch failed');
    return new Response('nope', { status: 403 });
  });
  const res = await get('/api/aircraft?lat=55.6761&lon=12.5683');
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: 'No flight feed answered',
    failures: ['adsb.lol: fetch failed', 'adsb.fi: HTTP 403'],
  });
});

test('rejects bad parameters without calling any feed', async () => {
  const calls = stubFetch(() => new Response(lol));
  for (const q of ['', 'lat=55', 'lat=91&lon=12', 'lat=55&lon=181', 'lat=x&lon=12', 'lat=55&lon=12&radius=0', 'lat=55&lon=12&radius=500']) {
    const res = await get(`/api/aircraft?${q}`);
    assert.equal(res.status, 400, q);
  }
  assert.equal(calls.length, 0);
});

test('rounds coordinates to 4 decimals and defaults the radius to 50 km', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('lat=55.676123456&lon=12.56834999')), { lat: 55.6761, lon: 12.5683, radiusKm: 50 });
});

test('anything else is a 404, and only GET is allowed', async () => {
  stubFetch(() => new Response(lol));
  assert.equal((await get('/api/other')).status, 404);
  const post = await worker.fetch(new Request('http://localhost/api/aircraft?lat=1&lon=1', { method: 'POST' }));
  assert.equal(post.status, 405);
});

// --- /api/track ---------------------------------------------------------------

const track = readFileSync(new URL('fixtures/opensky-track.json', import.meta.url), 'utf8');

test('track: asks OpenSky for the live track and trims it', async () => {
  const calls = stubFetch(() => new Response(track, { headers: { 'x-rate-limit-remaining': '392' } }));
  const res = await get('/api/track?hex=4D224E');
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, 'https://opensky-network.org/api/tracks/all?icao24=4d224e&time=0');
  assert.match(calls[0].init.headers['User-Agent'], /^Flightmon \(\+https:/);
  const body = await res.json();
  assert.equal(body.source, 'OpenSky');
  assert.equal(body.hex, '4d224e');
  assert.equal(body.callsign, 'RYR19EA');
  assert.equal(body.remaining, 392);
  assert.equal(body.path.length, 106);
  // Recorded: departed London Stansted, last point approaching Copenhagen.
  assert.deepEqual(body.path[0], { t: 1793452003, lat: 51.9018, lon: 0.2599, altM: 0, onGround: false });
  assert.deepEqual(body.path.at(-1), { t: 1793456381, lat: 55.4327, lon: 12.1711, altM: 1524, onGround: false });
  for (let i = 1; i < body.path.length; i++) assert.ok(body.path[i].t > body.path[i - 1].t, 'in time order');
});

test('track: bad hex is refused without asking OpenSky', async () => {
  const calls = stubFetch(() => new Response(track));
  for (const q of ['', 'hex=', 'hex=12345', 'hex=zzzzzz', 'hex=4d224e1']) {
    assert.equal((await get(`/api/track?${q}`)).status, 400, q);
  }
  assert.equal(calls.length, 0);
});

test('track: OpenSky errors are passed on clearly', async () => {
  stubFetch(() => new Response('', { status: 404 }));
  let res = await get('/api/track?hex=000000');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'OpenSky has no track for this aircraft');

  stubFetch(() => new Response('', { status: 429, headers: { 'x-rate-limit-remaining': '0' } }));
  res = await get('/api/track?hex=4d224e');
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: "OpenSky's daily limit for this connection is used up", remaining: 0 });

  stubFetch(() => { throw new TypeError('fetch failed'); });
  res = await get('/api/track?hex=4d224e');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "OpenSky didn't answer: fetch failed");

  stubFetch(() => new Response('<html>', { status: 200 }));
  assert.equal((await get('/api/track?hex=4d224e')).status, 502);
});
