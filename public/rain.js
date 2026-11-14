// Rain radar over the map, from RainViewer's public API: no key, CORS allowed,
// for personal and educational use, with a credit and link to RainViewer.
// weather-maps.json lists the radar images of the last two hours, one every
// 10 minutes; the latest is drawn, and the last hour can be played as a loop
// to show where the rain is heading. Since January 2026 the free tiles go up to
// zoom 7 only (higher zooms answer 200 with a "Zoom Level Not Supported"
// image) and come in one colour scheme; 512 px tiles at zoom 7 cover the same
// area as 256 px ones, twice as sharp.

import { TileCache, drawTiles, tilesReady } from './tiles.js';
import { CELL_PX, HALF_KM, gridFromPixels } from './nowcast.js';
import { worldPixel } from './mercator.js';

export const FRAMES_URL = 'https://api.rainviewer.com/public/weather-maps.json';
export const RAIN_CREDIT = { label: 'Rain', text: 'RainViewer', href: 'https://www.rainviewer.com/' };

const MAX_ZOOM = 7;
const TILE_PX = 512;
const TIMEOUT_MS = 8000;

export const PLAY_MINUTES = 60; // how far back the loop goes

// The radar images of the last `minutes` before the newest, oldest first:
// [{ host, path, time (s) }]; empty if there are none.
export function recentFrames(body, minutes = PLAY_MINUTES) {
  const past = body?.radar?.past;
  if (!body?.host || !Array.isArray(past) || !past.length) return [];
  const newest = past[past.length - 1].time;
  return past
    .filter((f) => f.time >= newest - minutes * 60)
    .map(({ path, time }) => ({ host: body.host, path, time }));
}

// The newest radar image, or null if there's none.
export const latestFrame = (body) => recentFrames(body, 0)[0] ?? null;

export async function fetchFrames(fetchFn = fetch) {
  const res = await fetchFn(FRAMES_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err) => {
    throw err.name === 'TimeoutError' ? new Error(`RainViewer didn't answer within ${TIMEOUT_MS / 1000} s`) : err;
  });
  if (!res.ok) throw new Error(`RainViewer answered HTTP ${res.status}`);
  const frames = recentFrames(await res.json());
  if (!frames.length) throw new Error('RainViewer listed no radar images');
  return frames;
}

// …/{size}/{z}/{x}/{y}/{colour scheme}/{smooth}_{snow}.png
export const rainTileUrl = (frame) => (z, x, y) =>
  `${frame.host}${frame.path}/${TILE_PX}/${z}/${x}/${y}/2/1_1.png`;

// A 512 px tile matches the screen's pixels one zoom level below the map's.
export function rainZoom(view, dpr = 1) {
  return Math.max(0, Math.min(MAX_ZOOM, Math.round(view.zoom + Math.log2(dpr) - 1)));
}

// Room for every image of the loop (7 × the few tiles a view needs) and stand-ins.
const cache = new TileCache(200);
let layer = null; // offscreen canvas the tiles are drawn onto

// The tiles are drawn opaque onto a layer of their own, which then goes over
// the map at `opacity`: drawing each tile translucent would darken the
// 1-pixel overlaps between tiles into visible seams.
export function drawRain(ctx, view, frame, { dpr = 1, opacity = 0.7, onLoad }) {
  const w = Math.round(view.width * dpr);
  const h = Math.round(view.height * dpr);
  if (!layer) layer = new OffscreenCanvas(w, h);
  if (layer.width !== w || layer.height !== h) {
    layer.width = w;
    layer.height = h;
  }
  const lc = layer.getContext('2d');
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.clearRect(0, 0, w, h);
  lc.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTiles(lc, view, rainZoom(view, dpr), rainTileUrl(frame), cache, onLoad);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.drawImage(layer, 0, 0, view.width, view.height);
  ctx.restore();
}

// Starts loading a radar image's tiles for the view; true once they're all in,
// so the loop can wait for an image instead of showing it half drawn.
export function rainReady(view, frame, { dpr = 1, onLoad }) {
  return tilesReady(view, rainZoom(view, dpr), rainTileUrl(frame), cache, onLoad);
}

const MERCATOR_RADIUS_KM = 6378.137;

// One radar image as a grid around home for the nowcast (nowcast.js): its
// zoom-7 tiles (the sharpest there are, about 350 m a pixel at Copenhagen)
// pieced together on a canvas HALF_KM each way from home, and read back.
export async function rainGridAt(frame, home) {
  const world = 2 ** MAX_ZOOM * TILE_PX;
  const kmPerPx = (2 * Math.PI * MERCATOR_RADIUS_KM * Math.cos((home.lat * Math.PI) / 180)) / world;
  const half = CELL_PX * Math.round(HALF_KM / kmPerPx / CELL_PX); // whole cells each way
  const size = 2 * half;
  const c = worldPixel(home.lat, home.lon, world);
  const x0 = Math.round(c.x) - half;
  const y0 = Math.round(c.y) - half;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const n = 2 ** MAX_ZOOM;
  const jobs = [];
  for (let ty = Math.max(0, Math.floor(y0 / TILE_PX)); ty <= Math.min(n - 1, Math.floor((y0 + size - 1) / TILE_PX)); ty++) {
    for (let tx = Math.floor(x0 / TILE_PX); tx <= Math.floor((x0 + size - 1) / TILE_PX); tx++) {
      const url = rainTileUrl(frame)(MAX_ZOOM, ((tx % n) + n) % n, ty);
      jobs.push(loadImage(url).then((img) => ctx.drawImage(img, tx * TILE_PX - x0, ty * TILE_PX - y0)));
    }
  }
  await Promise.all(jobs);
  return gridFromPixels(ctx.getImageData(0, 0, size, size).data, size, size, CELL_PX, kmPerPx);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // readable pixels (RainViewer sends CORS headers)
    const timer = setTimeout(() => reject(new Error(`a radar tile didn't load within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('a radar tile failed to load')); };
    img.src = url;
  });
}
