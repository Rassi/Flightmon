'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stand in for the upstream APIs: the first provider is down, the second answers.
const realFetch = global.fetch;
const calls = [];
global.fetch = async (url, options) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, options);
  calls.push(u);
  if (u.includes('adsb.lol/v2')) return new Response('busy', { status: 503 });
  if (u.includes('airplanes.live')) {
    return Response.json({ ac: [{ hex: 'abc123', flight: 'TEST1', lat: 55.7, lon: 12.6, alt_baro: 12000, gs: 300, track: 90 }] });
  }
  if (u.includes('planespotters')) return Response.json({ photos: [] });
  return new Response('nope', { status: 404 });
};

const { server } = require('../server');

test('server', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await t.test('falls through to the next provider', async () => {
    const res = await realFetch(`${base}/api/aircraft?lat=55.68&lon=12.57&dist=25`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'airplaneslive');
    assert.equal(body.aircraft[0].callsign, 'TEST1');
  });

  await t.test('shares one upstream request between screens', async () => {
    const before = calls.length;
    await realFetch(`${base}/api/aircraft?lat=55.6801&lon=12.5702&dist=25`);
    assert.equal(calls.length, before);
  });

  await t.test('rejects a request without a location', async () => {
    const res = await realFetch(`${base}/api/aircraft`);
    assert.equal(res.status, 400);
  });

  await t.test('serves the app', async () => {
    const res = await realFetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Flightmon/);
  });

  await t.test('does not serve files outside public/', async () => {
    const res = await realFetch(`${base}/..%2fserver.js`);
    assert.notEqual(res.status, 200);
  });

  await t.test('a missing photo is null, not an error', async () => {
    const body = await (await realFetch(`${base}/api/photo?hex=abc123`)).json();
    assert.equal(body.photo, null);
  });
});
