// The radar: range rings around the chosen location, north up, and each
// aircraft at its distance and bearing, pointing along its track.

import { displayName } from './format.js';

// Ring spacing of roughly a quarter of the range, rounded to 1, 2 or 5 × 10ⁿ km.
export function ringStep(rangeKm) {
  const rough = rangeKm / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= rough * 0.75) * magnitude;
  return step;
}

// Screen offset from the centre, in pixels; y grows downwards.
export function project(distKm, bearingDeg, rangeKm, radiusPx) {
  const r = (distKm / rangeKm) * radiusPx;
  const θ = (bearingDeg * Math.PI) / 180;
  return { x: r * Math.sin(θ), y: -r * Math.cos(θ) };
}

const MARGIN = 28;

export function drawRadar(ctx, { width, height, aircraft, rangeKm, highlight, colors }) {
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(10, Math.min(width, height) / 2 - MARGIN);

  drawRings(ctx, cx, cy, radius, rangeKm, colors);

  // Ground traffic underneath, then airborne from low to high, highlight last.
  const order = [...aircraft].sort((a, b) =>
    (a.hex === highlight) - (b.hex === highlight) ||
    (b.onGround - a.onGround) ||
    ((a.altM ?? 0) - (b.altM ?? 0)));

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const ac of order) {
    if (ac.distKm > rangeKm) continue;
    const p = project(ac.distKm, ac.bearingDeg, rangeKm, radius);
    const color = ac.hex === highlight ? colors.highlight
      : ac.emergency ? colors.alert
      : ac.onGround ? colors.ground
      : colors.plane;
    drawPlane(ctx, cx + p.x, cy + p.y, ac.trackDeg, color, ac.hex === highlight);
    // Aircraft parked at an airport pile up; label them only when highlighted.
    if (!ac.onGround || ac.hex === highlight) {
      ctx.fillStyle = color;
      ctx.fillText(displayName(ac), cx + p.x + 10, cy + p.y);
    }
  }
}

function drawRings(ctx, cx, cy, radius, rangeKm, colors) {
  const step = ringStep(rangeKm);
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, sans-serif';

  ctx.strokeStyle = colors.ring;
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  const rings = [];
  for (let d = step; d < rangeKm - step * 0.25; d += step) rings.push(d);
  rings.push(rangeKm);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const d of rings) {
    const r = (d / rangeKm) * radius;
    ctx.strokeStyle = d === rangeKm ? colors.ringStrong : colors.ring;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Label each ring just right of north, at 20°.
    ctx.fillStyle = colors.muted;
    ctx.fillText(`${Number(d.toFixed(1))} km`, cx + r * Math.sin(0.35) + 3, cy - r * Math.cos(0.35));
  }

  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 12px system-ui, sans-serif';
  const o = radius + 14;
  ctx.fillText('N', cx, cy - o);
  ctx.fillText('E', cx + o, cy);
  ctx.fillText('S', cx, cy + o);
  ctx.fillText('W', cx - o, cy);
  ctx.textAlign = 'left';

  ctx.fillStyle = colors.ringStrong;
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlane(ctx, x, y, trackDeg, color, emphasised) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (emphasised) {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (trackDeg === null) {
    ctx.beginPath();
    ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.rotate((trackDeg * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
