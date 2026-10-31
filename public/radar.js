// The radar: range rings around the chosen location, north up, and each
// aircraft at its position, pointing along its track. Everything is drawn in
// Web Mercator (see mercator.js) so it lines up with the map underneath.

import { altitudeColor } from './altitude.js';
import { displayName } from './format.js';
import { drawIcon, iconKind } from './icons.js';
import { makeView, ringPoints } from './mercator.js';

// Ring spacing of roughly a quarter of the range, rounded to 1, 2 or 5 × 10ⁿ km.
export function ringStep(rangeKm) {
  const rough = rangeKm / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= rough * 0.75) * magnitude;
  return step;
}

const MARGIN = 28;

export function radarView(center, rangeKm, width, height) {
  const radius = Math.max(10, Math.min(width, height) / 2 - MARGIN);
  return makeView(center, rangeKm, radius, width, height);
}

// The aircraft nearest to screen point (x, y), within `maxPx`; null if none.
export function hitTest(view, aircraft, x, y, maxPx = 18) {
  let best = null;
  let bestD = maxPx;
  for (const ac of aircraft) {
    if (ac.distKm > view.rangeKm) continue;
    const p = view.toScreen(ac.lat, ac.lon);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD) {
      best = ac;
      bestD = d;
    }
  }
  return best;
}

// `background(ctx, view)` draws the map; it is clipped to the outer ring.
// `highlight`: a Set of hex codes to draw white with a ring.
// `trail`: points [{ lat, lon, altM, onGround }] flown by the selected aircraft.
export function drawRadar(ctx, { width, height, center, aircraft, rangeKm, highlight = new Set(), trail, colors, background }) {
  ctx.clearRect(0, 0, width, height);
  const view = radarView(center, rangeKm, width, height);
  const outer = ringPoints(view, rangeKm);

  if (background) {
    ctx.save();
    pathThrough(ctx, outer);
    ctx.clip();
    background(ctx, view);
    ctx.restore();
  }

  drawRings(ctx, view, outer, colors);
  if (trail && trail.length > 1) {
    ctx.save();
    pathThrough(ctx, outer);
    ctx.clip();
    drawTrail(ctx, view, trail, colors.halo);
    ctx.restore();
  }

  // Ground traffic underneath, then airborne from low to high, highlight last.
  const order = [...aircraft].sort((a, b) =>
    highlight.has(a.hex) - highlight.has(b.hex) ||
    (b.onGround - a.onGround) ||
    ((a.altM ?? 0) - (b.altM ?? 0)));

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const ac of order) {
    if (ac.distKm > rangeKm) continue;
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

function pathThrough(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

// Text with an outline in the background colour, readable over the map.
function haloText(ctx, text, x, y, color, halo) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawRings(ctx, view, outer, colors) {
  const { rangeKm } = view;
  const step = ringStep(rangeKm);
  const c = view.toScreen(view.center.lat, view.center.lon);
  const north = outer[0];
  const east = outer[outer.length / 4];
  const south = outer[outer.length / 2];
  const west = outer[(outer.length * 3) / 4];

  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.ring;
  ctx.beginPath();
  ctx.moveTo(west.x, west.y); ctx.lineTo(east.x, east.y);
  ctx.moveTo(north.x, north.y); ctx.lineTo(south.x, south.y);
  ctx.stroke();

  const rings = [];
  for (let d = step; d < rangeKm - step * 0.25; d += step) rings.push(d);
  rings.push(rangeKm);

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  for (const d of rings) {
    // 120 points: index 7 is at 21°, just right of north, for the label.
    const points = d === rangeKm ? outer : ringPoints(view, d);
    ctx.lineWidth = 1;
    ctx.strokeStyle = d === rangeKm ? colors.ringStrong : colors.ring;
    pathThrough(ctx, points);
    ctx.stroke();
    haloText(ctx, `${Number(d.toFixed(1))} km`, points[7].x + 3, points[7].y, colors.muted, colors.halo);
  }

  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colors.muted;
  ctx.fillText('N', north.x, north.y - 14);
  ctx.fillText('E', east.x + 14, east.y);
  ctx.fillText('S', south.x, south.y + 14);
  ctx.fillText('W', west.x - 14, west.y);
  ctx.textAlign = 'left';

  ctx.fillStyle = colors.ringStrong;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
  ctx.fill();
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
