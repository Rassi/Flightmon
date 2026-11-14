// Web Mercator map tiles drawn into the radar's view (see mercator.js). Used by
// the street map (basemap.js) and the rain overlay (rain.js).

// Images by URL, the most recently used kept; loading starts on first request.
export class TileCache {
  constructor(maxCached = 400) {
    this.maxCached = maxCached;
    this.images = new Map(); // url → HTMLImageElement
  }

  get(url, onLoad) {
    let img = this.images.get(url);
    if (img) {
      // Refresh its place in the eviction order.
      this.images.delete(url);
      this.images.set(url, img);
      return img;
    }
    img = new Image();
    img.crossOrigin = 'anonymous'; // keeps the canvas readable (the servers send CORS headers)
    img.onload = onLoad;
    img.src = url;
    this.images.set(url, img);
    if (this.images.size > this.maxCached) this.images.delete(this.images.keys().next().value);
    return img;
  }

  // The image for `url` if it has already loaded, else null; starts no download.
  loaded(url) {
    const img = this.images.get(url);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    this.images.delete(url);
    this.images.set(url, img);
    return img;
  }
}

const PARENT_LEVELS = 4; // how far out to look for a coarser stand-in
const CHILD_LEVELS = 2; // how far in to look for sharper ones (from before zooming out)

// Draws the zoom-`z` tiles covering the view: `url(z, x, y)` gives each tile's
// address. A tile still loading is stood in for by what's already loaded for
// that spot (a coarser tile scaled up, then any sharper ones on top), so moving
// or zooming doesn't flash the background; `onLoad` is called as each arrives,
// so the caller can redraw.
export function drawTiles(ctx, view, z, url, cache, onLoad) {
  const address = wrapped(url);
  for (const [tx, ty] of tilesInView(view, z)) {
    const img = cache.get(address(z, tx, ty), onLoad);
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, ...screenRect(view, z, tx, ty));
      continue;
    }
    drawCoarser(ctx, view, z, tx, ty, address, cache);
    drawSharper(ctx, view, z, tx, ty, address, cache);
  }
}

// Starts loading the zoom-`z` tiles covering the view; true once every one has
// finished (loaded or failed), so it can be shown without gaps.
export function tilesReady(view, z, url, cache, onLoad) {
  const address = wrapped(url);
  let ready = true;
  for (const [tx, ty] of tilesInView(view, z)) {
    if (!cache.get(address(z, tx, ty), onLoad).complete) ready = false;
  }
  return ready;
}

// [tx, ty] of the zoom-z tiles the view shows (tx may run past the date line).
function tilesInView(view, z) {
  const n = 2 ** z;
  const size = view.worldSize / n; // a tile's size on screen, in CSS pixels
  const x0 = Math.floor(view.originX / size);
  const x1 = Math.floor((view.originX + view.width) / size);
  const y0 = Math.max(0, Math.floor(view.originY / size));
  const y1 = Math.min(n - 1, Math.floor((view.originY + view.height) / size));
  const tiles = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) tiles.push([tx, ty]);
  return tiles;
}

const wrapped = (url) => (z, tx, ty) => url(z, ((tx % 2 ** z) + 2 ** z) % 2 ** z, ty);

// Where tile (tx, ty) of zoom z goes, snapped to whole pixels so neighbouring
// tiles don't show hairline gaps: [left, top, width, height].
function screenRect(view, z, tx, ty) {
  const size = view.worldSize / 2 ** z;
  const left = Math.floor(tx * size - view.originX);
  const top = Math.floor(ty * size - view.originY);
  return [left, top, Math.ceil((tx + 1) * size - view.originX) - left, Math.ceil((ty + 1) * size - view.originY) - top];
}

// The nearest loaded tile further out, cropped to this tile's part and scaled up.
function drawCoarser(ctx, view, z, tx, ty, address, cache) {
  for (let k = 1; k <= PARENT_LEVELS && z - k >= 0; k++) {
    const f = 2 ** k;
    const px = Math.floor(tx / f);
    const py = Math.floor(ty / f);
    const img = cache.loaded(address(z - k, px, py));
    if (!img) continue;
    const part = img.naturalWidth / f;
    ctx.drawImage(img, (tx - px * f) * part, (ty - py * f) * part, part, part, ...screenRect(view, z, tx, ty));
    return;
  }
}

// Loaded tiles further in that cover this one (e.g. what was shown before zooming out).
function drawSharper(ctx, view, z, tx, ty, address, cache) {
  for (let k = 1; k <= CHILD_LEVELS; k++) {
    const f = 2 ** k;
    for (let cy = ty * f; cy < (ty + 1) * f; cy++) {
      for (let cx = tx * f; cx < (tx + 1) * f; cx++) {
        const img = cache.loaded(address(z + k, cx, cy));
        if (img) ctx.drawImage(img, ...screenRect(view, z + k, cx, cy));
      }
    }
  }
}
