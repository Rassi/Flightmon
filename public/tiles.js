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
}

// Draws the zoom-`z` tiles covering the view: `url(z, x, y)` gives each tile's
// address. Tiles still loading are skipped and `onLoad` is called as each
// arrives, so the caller can redraw.
export function drawTiles(ctx, view, z, url, cache, onLoad) {
  const n = 2 ** z;
  const size = view.worldSize / n; // a tile's size on screen, in CSS pixels
  const x0 = Math.floor(view.originX / size);
  const x1 = Math.floor((view.originX + view.width) / size);
  const y0 = Math.max(0, Math.floor(view.originY / size));
  const y1 = Math.min(n - 1, Math.floor((view.originY + view.height) / size));

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const img = cache.get(url(z, ((tx % n) + n) % n, ty), onLoad);
      if (!img.complete || img.naturalWidth === 0) continue;
      // Snap to whole pixels so neighbouring tiles don't show hairline gaps.
      const left = Math.floor(tx * size - view.originX);
      const top = Math.floor(ty * size - view.originY);
      const right = Math.ceil((tx + 1) * size - view.originX);
      const bottom = Math.ceil((ty + 1) * size - view.originY);
      ctx.drawImage(img, left, top, right - left, bottom - top);
    }
  }
}
