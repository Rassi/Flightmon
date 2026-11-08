// A photo of the clicked aircraft from Planespotters.net. Their terms (photo
// API page, read 2026-11-08): the photographer is credited in text next to the
// photo, the photo is a plain link to its page there, and the browser loads the
// image straight from their URL, unchanged and not stored. The browser asks
// their API directly (it sends CORS headers and wants a web page's Origin).

const API = 'https://api.planespotters.net/pub/photos/hex/';
const TIMEOUT_MS = 8000;

// Planespotters' answer → { src, width, height, link, photographer }, or null
// when it has no photo of this aircraft.
export function parsePhoto(body) {
  const p = body?.photos?.[0];
  const t = p?.thumbnail_large?.src ? p.thumbnail_large : p?.thumbnail;
  if (!t?.src || !p.link) return null;
  return {
    src: t.src,
    width: t.size?.width ?? null,
    height: t.size?.height ?? null,
    link: p.link,
    photographer: p.photographer || 'unknown photographer',
  };
}

// One lookup per aircraft for this page (they allow caching answers for 24 h);
// a failed one is forgotten, so clicking again retries. Resolves to a photo,
// null (none), or { error }.
const cache = new Map();
export function fetchPhoto(hex, fetchFn = fetch) {
  if (!cache.has(hex)) {
    const p = fetchFn(API + hex, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Planespotters answered HTTP ${res.status}`);
        return parsePhoto(await res.json());
      })
      .catch((err) => {
        cache.delete(hex);
        // A refused or blocked request reaches the page only as "Failed to fetch".
        return { error: err instanceof TypeError ? "couldn't reach Planespotters" : err.message };
      });
    cache.set(hex, p);
  }
  return cache.get(hex);
}

// The photo, linked to its page, with the credit under it. The element is kept
// per image, so redrawing the details every update doesn't reload or flicker it.
const blocks = new Map();
export function photoBlock(photo) {
  if (blocks.has(photo.src)) return blocks.get(photo.src);
  const figure = document.createElement('figure');
  figure.className = 'photo';
  const a = document.createElement('a');
  a.href = photo.link;
  a.target = '_blank';
  a.rel = 'noopener'; // not nofollow: their terms want a plain link
  a.title = 'Open the photo on Planespotters.net';
  const img = document.createElement('img');
  img.src = photo.src;
  if (photo.width && photo.height) {
    img.width = photo.width;
    img.height = photo.height;
  }
  img.alt = `Photo of the aircraft by ${photo.photographer}`;
  a.append(img);
  const caption = document.createElement('figcaption');
  caption.textContent = `Photo: ${photo.photographer} / Planespotters.net`;
  figure.append(a, caption);
  if (blocks.size > 50) blocks.delete(blocks.keys().next().value);
  blocks.set(photo.src, figure);
  return figure;
}
