// Map tiles under the radar: Esri World Street Map, which needs no API key.
// It is in "mature support" and retires in December 2029; its terms require
// the attribution below. To use another tile source, change this file.

const MAX_ZOOM = 19;
const MAX_CACHED = 400;

const tileUrl = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;

export const ATTRIBUTION =
  'Map: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, ' +
  'Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, © OpenStreetMap contributors, ' +
  'and the GIS User Community';

const cache = new Map(); // "z/x/y" → HTMLImageElement

function tile(z, x, y, onLoad) {
  const key = `${z}/${x}/${y}`;
  let img = cache.get(key);
  if (img) {
    // Refresh its place in the eviction order.
    cache.delete(key);
    cache.set(key, img);
    return img;
  }
  img = new Image();
  img.crossOrigin = 'anonymous'; // keeps the canvas readable (the tiles send CORS headers)
  img.onload = onLoad;
  img.src = tileUrl(z, x, y);
  cache.set(key, img);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return img;
}

// Tile zoom for a view: sharp on high-density screens, within what Esri has.
export function tileZoom(view, dpr = 1) {
  return Math.max(0, Math.min(MAX_ZOOM, Math.round(view.zoom + Math.log2(dpr))));
}

// Draws the tiles covering the view, then dims them towards `dimColor` when
// `opacity` < 1. (Dimming afterwards, rather than drawing the tiles
// translucent, keeps their 1-pixel overlaps from showing as bright seams.)
// Tiles still loading are skipped and `onLoad` is called as each arrives, so
// the caller can redraw.
export function drawBasemap(ctx, view, { dpr = 1, opacity = 1, dimColor = '#000', onLoad }) {
  const z = tileZoom(view, dpr);
  const n = 2 ** z;
  const size = view.worldSize / n; // a tile's size on screen, in CSS pixels
  const x0 = Math.floor(view.originX / size);
  const x1 = Math.floor((view.originX + view.width) / size);
  const y0 = Math.max(0, Math.floor(view.originY / size));
  const y1 = Math.min(n - 1, Math.floor((view.originY + view.height) / size));

  ctx.save();
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const img = tile(z, ((tx % n) + n) % n, ty, onLoad);
      if (!img.complete || img.naturalWidth === 0) continue;
      // Snap to whole pixels so neighbouring tiles don't show hairline gaps.
      const left = Math.floor(tx * size - view.originX);
      const top = Math.floor(ty * size - view.originY);
      const right = Math.ceil((tx + 1) * size - view.originX);
      const bottom = Math.ceil((ty + 1) * size - view.originY);
      ctx.drawImage(img, left, top, right - left, bottom - top);
    }
  }
  if (opacity < 1) {
    ctx.globalAlpha = 1 - opacity;
    ctx.fillStyle = dimColor;
    ctx.fillRect(0, 0, view.width, view.height);
  }
  ctx.restore();
}
