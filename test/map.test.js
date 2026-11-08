import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { drawBasemap, tileZoom } from '../public/basemap.js';
import { destination, makeView, ringPoints, worldPixel } from '../public/mercator.js';
import { bearingDeg, distanceKm } from '../public/geo.js';

const CPH = { lat: 55.6761, lon: 12.5683 };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('world pixels: the standard Web Mercator tile grid', () => {
  assert.deepEqual(worldPixel(0, 0, 256), { x: 128, y: 128 });
  assert.ok(near(worldPixel(85.0511, 0, 256).y, 0, 0.01)); // top edge of the map
  // Copenhagen is in tile 547/320 at zoom 10 (OpenStreetMap/Esri tile numbering).
  const p = worldPixel(CPH.lat, CPH.lon, 256 * 2 ** 10);
  assert.deepEqual([Math.floor(p.x / 256), Math.floor(p.y / 256)], [547, 320]);
});

test('destination agrees with distance and bearing', () => {
  for (const [b, d] of [[0, 25], [90, 50], [200, 120], [315, 400]]) {
    const p = destination(CPH.lat, CPH.lon, b, d);
    assert.ok(near(distanceKm(CPH.lat, CPH.lon, p.lat, p.lon), d, 1e-6), `${b}° ${d} km`);
    assert.ok(near(bearingDeg(CPH.lat, CPH.lon, p.lat, p.lon), b, 1e-6), `${b}° ${d} km`);
  }
});

test('view: centred, north up, range spans the radius', () => {
  const view = makeView(CPH, 50, 200, 600, 500);
  const c = view.toScreen(CPH.lat, CPH.lon);
  assert.ok(near(c.x, 300, 1e-6) && near(c.y, 250, 1e-6));
  const east = destination(CPH.lat, CPH.lon, 90, 25);
  const north = destination(CPH.lat, CPH.lon, 0, 25);
  const e = view.toScreen(east.lat, east.lon);
  const n = view.toScreen(north.lat, north.lon);
  // Within 1%: Mercator stretches slightly away from the centre latitude.
  assert.ok(near(e.x, 400, 1) && near(e.y, 250, 1), JSON.stringify(e));
  assert.ok(near(n.x, 300, 1e-6) && near(n.y, 150, 1), JSON.stringify(n));
});

test('rings are true distance circles, close to round at radar ranges', () => {
  const view = makeView(CPH, 50, 200, 600, 500);
  const ring = ringPoints(view, 50);
  assert.equal(ring.length, 120);
  for (const p of ring) {
    const r = Math.hypot(p.x - 300, p.y - 250);
    assert.ok(near(r, 200, 200 * 0.012), `radius ${r}`);
  }
});

test('the antimeridian: a point just across it is drawn next to the centre', () => {
  const view = makeView({ lat: 0, lon: 179.95 }, 50, 200, 600, 500);
  const p = view.toScreen(0, -179.95);
  // 0.1° of longitude at the equator is 11.1 km: 44.5 px at 200 px per 50 km.
  assert.ok(near(p.x, 344.5, 0.5), `x ${p.x}`);
});

// --- tiles -----------------------------------------------------------------

const realImage = globalThis.Image;
afterEach(() => { globalThis.Image = realImage; });

function fakeImages() {
  const made = [];
  globalThis.Image = class {
    constructor() { made.push(this); this.complete = true; this.naturalWidth = 256; }
  };
  return made;
}

function fakeContext() {
  const drawn = [];
  return {
    drawn,
    save() {}, restore() {},
    drawImage(img, x, y, w, h) { drawn.push({ src: img.src, x, y, w, h, alpha: this.globalAlpha }); },
    fills: [],
    fillRect(x, y, w, h) { this.fills.push({ x, y, w, h, alpha: this.globalAlpha, color: this.fillStyle }); },
    globalAlpha: 1,
  };
}

test('tile zoom follows the view, sharper on high-density screens', () => {
  const view = makeView(CPH, 50, 400, 900, 900);
  assert.ok(view.zoom > 9 && view.zoom < 10, `zoom ${view.zoom}`);
  assert.equal(tileZoom(view, 1), Math.round(view.zoom));
  assert.equal(tileZoom(view, 2), Math.round(view.zoom + 1));
  assert.equal(tileZoom(makeView(CPH, 0.01, 400, 900, 900), 2), 19);
});

test('basemap covers the whole view with Esri tiles in z/y/x order, without gaps', () => {
  const made = fakeImages();
  const ctx = fakeContext();
  const view = makeView(CPH, 50, 400, 900, 900);
  drawBasemap(ctx, view, { dpr: 2, onLoad: () => {} });

  const z = tileZoom(view, 2);
  assert.equal(z, 10);
  for (const img of made) {
    assert.match(img.src, new RegExp(`^https://server\\.arcgisonline\\.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/\\d+/\\d+$`));
    assert.equal(img.crossOrigin, 'anonymous');
  }
  // The tile under the centre is Copenhagen's: 547/320 at zoom 10, i.e. .../10/320/547.
  assert.ok(made.some((img) => img.src.endsWith('/10/320/547')));

  // Drawn tiles cover every pixel of the view.
  const minX = Math.min(...ctx.drawn.map((d) => d.x));
  const minY = Math.min(...ctx.drawn.map((d) => d.y));
  const maxX = Math.max(...ctx.drawn.map((d) => d.x + d.w));
  const maxY = Math.max(...ctx.drawn.map((d) => d.y + d.h));
  assert.ok(minX <= 0 && minY <= 0 && maxX >= 900 && maxY >= 900, JSON.stringify({ minX, minY, maxX, maxY }));
  const xs = [...new Set(ctx.drawn.map((d) => d.x))].sort((a, b) => a - b);
  const width = Object.fromEntries(ctx.drawn.map((d) => [d.x, d.w]));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i - 1] + width[xs[i - 1]] >= xs[i], 'no gap between columns');
});

test('tiles are fetched once and reused on redraw', () => {
  const made = fakeImages();
  const view = makeView({ lat: 40, lon: -3 }, 30, 300, 700, 700);
  drawBasemap(fakeContext(), view, { onLoad: () => {} });
  const first = made.length;
  drawBasemap(fakeContext(), view, { onLoad: () => {} });
  assert.ok(first > 0);
  assert.equal(made.length, first);
});

test('dimming: tiles drawn opaque, then one overlay over the whole view', () => {
  fakeImages();
  const ctx = fakeContext();
  const view = makeView(CPH, 50, 400, 900, 900);
  drawBasemap(ctx, view, { opacity: 0.45, dimColor: '#0b1416', onLoad: () => {} });
  assert.ok(ctx.drawn.length > 0 && ctx.drawn.every((d) => d.alpha === 1));
  assert.equal(ctx.fills.length, 1);
  assert.deepEqual(ctx.fills[0], { x: 0, y: 0, w: 900, h: 900, alpha: 0.55, color: '#0b1416' });
});

test('toLatLon undoes toScreen; the scale follows scaleLat, not the centre', () => {
  const home = { lat: 55.6761, lon: 12.5683 };
  const view = makeView({ lat: 56.2, lon: 13.1 }, 50, 400, 1000, 800, home.lat);
  for (const [lat, lon] of [[55.6761, 12.5683], [56.9, 11.2], [55.1, 14.0]]) {
    const p = view.toScreen(lat, lon);
    const back = view.toLatLon(p.x, p.y);
    assert.ok(Math.abs(back.lat - lat) < 1e-9 && Math.abs(back.lon - lon) < 1e-9, `${lat},${lon} → ${back.lat},${back.lon}`);
  }
  const atHome = makeView(home, 50, 400, 1000, 800);
  assert.equal(view.worldSize, atHome.worldSize);
});

test('a tile still loading is stood in for by loaded coarser and sharper tiles', async () => {
  const { drawTiles } = await import('../public/tiles.js');
  const url = (z, x, y) => `${z}/${x}/${y}`;
  const img = (src) => ({ src, complete: true, naturalWidth: 256 });
  // Loaded: the parent of tile 4/8/5 (3/4/2) and one of its children (5/16/10). 4/8/5 itself isn't.
  const have = new Map([['3/4/2', img('3/4/2')], ['5/16/10', img('5/16/10')]]);
  const cache = {
    get: (u) => have.get(u) ?? { src: u, complete: false, naturalWidth: 0 },
    loaded: (u) => have.get(u) ?? null,
  };
  const drawn = [];
  const ctx = { drawImage: (...a) => drawn.push({ src: a[0].src, args: a.slice(1) }) };
  // A view exactly one zoom-4 tile (256 px) big, showing tile 4/8/5.
  const view = { worldSize: 256 * 16, originX: 8 * 256, originY: 5 * 256, width: 255, height: 255 };
  drawTiles(ctx, view, 4, url, cache, () => {});

  // First the parent: its bottom-left quarter (4/8/5 is x even, y odd), scaled to the whole tile.
  assert.equal(drawn[0].src, '3/4/2');
  assert.deepEqual(drawn[0].args, [0, 128, 128, 128, 0, 0, 256, 256]);
  // Then the sharper one on top, in its quarter.
  assert.equal(drawn[1].src, '5/16/10');
  assert.deepEqual(drawn[1].args, [0, 0, 128, 128]);
  assert.equal(drawn.length, 2);
});
