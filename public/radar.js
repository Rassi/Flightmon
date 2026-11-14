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

// The furthest zoom-out (km from the middle to the nearest edge) at which the
// feeds, which answer up to `feedKm` around a point, still reach the corners.
export function maxRangeKm(width, height, feedKm = 463) {
  if (!(width > 0 && height > 0)) return feedKm;
  return Math.floor((feedKm * Math.min(width, height)) / Math.hypot(width, height));
}

// The range that keeps the map's scale when the latitude it's measured at
// moves from `fromLat` to `toLat` (e.g. when home moves north or south).
export function rangeAtLat(rangeKm, fromLat, toLat) {
  const rad = (d) => (d * Math.PI) / 180;
  return (rangeKm * Math.cos(rad(toLat))) / Math.cos(rad(fromLat));
}

// Home within this many pixels of the map's middle counts as "centred on home".
export const CENTRED_PX = 10;
export function centredOn(view, place) {
  const p = view.toScreen(place.lat, place.lon);
  return Math.hypot(p.x - view.width / 2, p.y - view.height / 2) < CENTRED_PX;
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

// `center`: the middle of the map (a grey crosshair when it isn't home);
// `home`: a green dot.
// `background(ctx, view)` draws the map tiles (and rain).
// `highlight`: a Set of hex codes to draw white with a ring.
// `trail`: points [{ lat, lon, altM, onGround }] flown by the selected aircraft.
// `rainArrow`: { fromDeg, speedKmh }, how the rain around home moves (nowcast.js).
export function drawMap(ctx, { width, height, center, home = center, aircraft, rangeKm, highlight = new Set(), trail, rainArrow, colors, background }) {
  ctx.clearRect(0, 0, width, height);
  const view = mapView(center, rangeKm, width, height, home.lat);

  if (background) background(ctx, view);
  if (trail && trail.length > 1) drawTrail(ctx, view, trail, colors.halo);

  // The map's middle, when away from home: where "Set home" would put it.
  if (!centredOn(view, home)) drawCross(ctx, width / 2, height / 2, colors.muted, colors.halo);

  // Home: a small dot, with the rain's movement as an arrow into it.
  const c = view.toScreen(home.lat, home.lon);
  if (rainArrow && onMap(view, home)) drawRainArrow(ctx, c, rainArrow, colors.rain, colors.halo);
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

// An arrow coming into home from where the rain comes from, the speed at its
// tail. A fixed size on screen, whatever the zoom: it shows a direction.
const ARROW_TAIL_PX = 70;
const ARROW_TIP_PX = 10;
export function drawRainArrow(ctx, home, { fromDeg, speedKmh }, color, halo) {
  const θ = (fromDeg * Math.PI) / 180;
  const ux = Math.sin(θ); // towards where the rain comes from, north up
  const uy = -Math.cos(θ);
  const at = (d) => [home.x + ux * d, home.y + uy * d];
  const [tx, ty] = at(ARROW_TAIL_PX);
  const [hx, hy] = at(ARROW_TIP_PX);
  const head = (side) => [hx + ux * 9 + uy * side * 6, hy + uy * 9 - ux * side * 6];
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.moveTo(...head(1));
    ctx.lineTo(hx, hy);
    ctx.lineTo(...head(-1));
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  path();
  ctx.lineWidth = 6;
  ctx.strokeStyle = halo;
  ctx.stroke();
  path();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Beyond the tail, clear of it whichever way the arrow points.
  const label = `${Math.round(speedKmh)} km/h`;
  const [lx, ly] = at(ARROW_TAIL_PX + 6 + Math.abs(ux) * ctx.measureText(label).width / 2 + Math.abs(uy) * 7);
  haloText(ctx, label, lx, ly, color, halo);
  ctx.restore();
}

function drawCross(ctx, x, y, color, halo) {
  ctx.beginPath();
  ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y);
  ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
  ctx.lineCap = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = halo;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
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
