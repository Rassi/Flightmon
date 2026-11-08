// The map: the street map filling the canvas, centred on the chosen location,
// north up, and each aircraft at its position, pointing along its track.
// `rangeKm` is the distance from the centre to the nearest edge, measured at
// `scaleLat` (the location's latitude, so dragging keeps the scale). Everything is
// drawn in Web Mercator (see mercator.js) so it lines up with the map tiles.

import { altitudeColor } from './altitude.js';
import { displayName } from './format.js';
import { drawIcon, iconKind } from './icons.js';
import { makeView } from './mercator.js';

export function mapView(center, rangeKm, width, height, scaleLat = center.lat) {
  const toEdge = Math.max(10, Math.min(width, height) / 2);
  return makeView(center, rangeKm, toEdge, width, height, scaleLat);
}

// How far out to ask for aircraft so the corners of the map are covered too.
export function cornerRangeKm(rangeKm, width, height) {
  if (!(width > 0 && height > 0)) return rangeKm * Math.SQRT2;
  return (rangeKm * Math.hypot(width, height)) / Math.min(width, height);
}

// Whether an aircraft is on the visible map.
export function onMap(view, ac) {
  const p = view.toScreen(ac.lat, ac.lon);
  return p.x >= 0 && p.x <= view.width && p.y >= 0 && p.y <= view.height;
}

// The aircraft nearest to screen point (x, y), within `maxPx`; null if none.
export function hitTest(view, aircraft, x, y, maxPx = 18) {
  let best = null;
  let bestD = maxPx;
  for (const ac of aircraft) {
    if (!onMap(view, ac)) continue;
    const p = view.toScreen(ac.lat, ac.lon);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD) {
      best = ac;
      bestD = d;
    }
  }
  return best;
}

// `center`: the middle of the map; `home`: the chosen location (a dot).
// `background(ctx, view)` draws the map tiles (and rain).
// `highlight`: a Set of hex codes to draw white with a ring.
// `trail`: points [{ lat, lon, altM, onGround }] flown by the selected aircraft.
export function drawMap(ctx, { width, height, center, home = center, aircraft, rangeKm, highlight = new Set(), trail, colors, background }) {
  ctx.clearRect(0, 0, width, height);
  const view = mapView(center, rangeKm, width, height, home.lat);

  if (background) background(ctx, view);
  if (trail && trail.length > 1) drawTrail(ctx, view, trail, colors.halo);

  // The chosen location: a small dot.
  const c = view.toScreen(home.lat, home.lon);
  ctx.beginPath();
  ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.strokeStyle = colors.halo;
  ctx.stroke();
  ctx.fill();

  // Ground traffic underneath, then airborne from low to high, highlight last.
  const order = aircraft.filter((ac) => onMap(view, ac)).sort((a, b) =>
    highlight.has(a.hex) - highlight.has(b.hex) ||
    (b.onGround - a.onGround) ||
    ((a.altM ?? 0) - (b.altM ?? 0)));

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const ac of order) {
    const p = view.toScreen(ac.lat, ac.lon);
    const highlighted = highlight.has(ac.hex);
    const color = highlighted ? colors.highlight
      : ac.emergency ? colors.alert
      : altitudeColor(ac);
    if (highlighted) drawRing(ctx, p.x, p.y, 17, colors.highlight, colors.halo);
    const size = drawIcon(ctx, iconKind(ac), p.x, p.y, ac.trackDeg, color, colors.halo);
    // Aircraft parked at an airport pile up; label them only when highlighted.
    if (!ac.onGround || highlighted) {
      haloText(ctx, displayName(ac), p.x + size / 2 + 2, p.y, color, colors.halo);
    }
  }
  return view;
}

// Text with an outline in the background colour, readable over the map.
function haloText(ctx, text, x, y, color, halo) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawRing(ctx, x, y, r, color, halo) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = halo;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
}

// The path flown, each segment coloured by the altitude at its start, over a
// dark outline so it reads on the map.
function drawTrail(ctx, view, trail, halo) {
  const pts = trail.map((p) => view.toScreen(p.lat, p.lon));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.lineWidth = 5;
  ctx.strokeStyle = halo;
  ctx.stroke();
  ctx.lineWidth = 2.5;
  for (let i = 1; i < pts.length; i++) {
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = altitudeColor(trail[i - 1]);
    ctx.stroke();
  }
}
