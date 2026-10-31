// Map tiles under the radar: Esri World Street Map, which needs no API key.
// It is in "mature support" and retires in December 2029; its terms require
// the attribution below. To use another tile source, change this file.

import { TileCache, drawTiles } from './tiles.js';

const MAX_ZOOM = 19;

const tileUrl = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;

export const ATTRIBUTION =
  'Map: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, ' +
  'Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, © OpenStreetMap contributors, ' +
  'and the GIS User Community';

const cache = new TileCache(400);

// Tile zoom for a view: sharp on high-density screens, within what Esri has.
export function tileZoom(view, dpr = 1) {
  return Math.max(0, Math.min(MAX_ZOOM, Math.round(view.zoom + Math.log2(dpr))));
}

// Draws the tiles covering the view, then dims them towards `dimColor` when
// `opacity` < 1. (Dimming afterwards, rather than drawing the tiles
// translucent, keeps their 1-pixel overlaps from showing as bright seams.)
export function drawBasemap(ctx, view, { dpr = 1, opacity = 1, dimColor = '#000', onLoad }) {
  ctx.save();
  drawTiles(ctx, view, tileZoom(view, dpr), tileUrl, cache, onLoad);
  if (opacity < 1) {
    ctx.globalAlpha = 1 - opacity;
    ctx.fillStyle = dimColor;
    ctx.fillRect(0, 0, view.width, view.height);
  }
  ctx.restore();
}
