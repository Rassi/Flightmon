import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FRAMES_URL, drawRain, fetchFrame, latestFrame, rainTileUrl, rainZoom } from '../public/rain.js';
import { makeView, worldPixel } from '../public/mercator.js';

// RainViewer's list of radar images, 2026-10-31.
const body = JSON.parse(readFileSync(new URL('./fixtures/rainviewer-maps.json', import.meta.url)));
const CPH = { lat: 55.6761, lon: 12.5683 };

test('the newest radar image', () => {
  assert.deepEqual(latestFrame(body), { host: 'https://tilecache.rainviewer.com', path: '/v2/radar/0178a9fd0e4a', time: 1793458200 });
  assert.equal(latestFrame({ host: 'h', radar: { past: [] } }), null);
  assert.equal(latestFrame({}), null);
});

test('fetchFrame', async () => {
  let asked;
  const frame = await fetchFrame(async (url) => { asked = url; return new Response(JSON.stringify(body)); });
  assert.equal(asked, FRAMES_URL);
  assert.equal(frame.time, 1793458200);
  await assert.rejects(fetchFrame(async () => new Response('', { status: 429 })), /HTTP 429/);
  const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  await assert.rejects(fetchFrame(async () => { throw timeout; }), /RainViewer didn't answer within 8 s/);
  await assert.rejects(fetchFrame(async () => new Response('{"radar":{"past":[]}}')), /no radar images/);
});

test('tile address: 512 px, z/x/y, the one colour scheme, smoothed, with snow', () => {
  assert.equal(rainTileUrl(latestFrame(body))(7, 68, 40),
    'https://tilecache.rainviewer.com/v2/radar/0178a9fd0e4a/512/7/68/40/2/1_1.png');
});

test('zoom: a 512 px tile per 512 screen pixels, never above 7 (the free limit)', () => {
  const wide = makeView(CPH, 463, 400, 900, 900);
  assert.equal(rainZoom(wide, 1), Math.round(wide.zoom - 1));
  assert.ok(rainZoom(wide, 1) < 7);
  assert.equal(rainZoom(makeView(CPH, 50, 400, 900, 900), 2), 7);
  assert.equal(rainZoom(makeView(CPH, 1, 400, 900, 900), 2), 7);
});

function fakeImages() {
  const made = [];
  globalThis.Image = class {
    constructor() { made.push(this); this.complete = true; this.naturalWidth = 512; }
  };
  return made;
}

test('tiles go on a layer of their own, which is drawn over the map once, translucent', () => {
  const made = fakeImages();
  const layerDraws = [];
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      return {
        setTransform() {}, clearRect() {},
        drawImage: (img, x, y, w, h) => layerDraws.push({ src: img.src, x, y, w, h }),
      };
    }
  };
  const drawn = [];
  const ctx = {
    globalAlpha: 1, save() {}, restore() {},
    drawImage(img, x, y, w, h) { drawn.push({ img, x, y, w, h, alpha: this.globalAlpha }); },
  };
  const view = makeView(CPH, 50, 400, 900, 900);
  drawRain(ctx, view, latestFrame(body), { dpr: 2, opacity: 0.7, onLoad: () => {} });

  // Copenhagen's zoom-7 tile is 68/40; it's among those drawn, at the right place.
  const p = worldPixel(CPH.lat, CPH.lon, view.worldSize);
  const size = view.worldSize / 2 ** 7;
  assert.deepEqual([Math.floor(p.x / size), Math.floor(p.y / size)], [68, 40]);
  const cph = layerDraws.find((d) => d.src.endsWith('/512/7/68/40/2/1_1.png'));
  assert.ok(cph, layerDraws.map((d) => d.src).join('\n'));
  assert.ok(Math.abs(cph.x - (68 * size - view.originX)) <= 1 && Math.abs(cph.y - (40 * size - view.originY)) <= 1);
  assert.ok(made.every((img) => img.crossOrigin === 'anonymous'));
  // The tiles cover the view.
  assert.ok(Math.min(...layerDraws.map((d) => d.x)) <= 0 && Math.max(...layerDraws.map((d) => d.x + d.w)) >= 900);
  // One translucent draw of the whole layer onto the radar.
  assert.equal(drawn.length, 1);
  assert.deepEqual({ ...drawn[0], img: undefined }, { img: undefined, x: 0, y: 0, w: 900, h: 900, alpha: 0.7 });
  assert.equal(drawn[0].img.width, 1800);
});
