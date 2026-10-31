// Aircraft icons: simple silhouettes drawn on the canvas, nose up, chosen
// from the ADS-B emitter category and, where that isn't enough, the ICAO type
// designator. Not animated.

// Type designators the category can't tell apart. ICAO Doc 8643 codes.
const TURBOPROPS = new Set([
  'AT43', 'AT44', 'AT45', 'AT46', 'AT72', 'AT73', 'AT75', 'AT76',
  'DH8A', 'DH8B', 'DH8C', 'DH8D', 'DHC6', 'DHC7', 'SF34', 'SB20', 'D328',
  'F27', 'F50', 'E110', 'E120', 'B190', 'BE20', 'BE30', 'BE9L', 'BE99', 'B350',
  'JS31', 'JS32', 'JS41', 'L410', 'C212', 'CN35', 'C295', 'SW4', 'AN24', 'AN26',
  'AN32', 'Y12', 'P180', 'PC12', 'C208', 'TBM7', 'TBM8', 'TBM9', 'P68', 'C30J', 'C130',
]);
const HELICOPTERS = new Set([
  'EC20', 'EC30', 'EC35', 'EC45', 'EC55', 'EC75', 'EC25', 'H160', 'AS32', 'AS50',
  'AS55', 'AS65', 'A109', 'A119', 'A139', 'A169', 'A189', 'B06', 'B407', 'B412',
  'B429', 'BK17', 'R22', 'R44', 'R66', 'S76', 'S92', 'H60', 'NH90', 'EH10', 'MI8',
]);
const HEAVIES = new Set([
  'A306', 'A310', 'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
  'A359', 'A35K', 'A388', 'B744', 'B748', 'B762', 'B763', 'B764', 'B772', 'B773',
  'B77L', 'B77W', 'B778', 'B779', 'B788', 'B789', 'B78X', 'MD11', 'IL96', 'A400',
]);

export function iconKind(ac) {
  const { category: c, type: t } = ac;
  if (c === 'A7' || HELICOPTERS.has(t)) return 'helicopter';
  if (c === 'B1') return 'glider';
  if (c === 'B2') return 'balloon';
  if (c === 'B6') return 'drone';
  if (TURBOPROPS.has(t)) return 'turboprop';
  if (c === 'A5' || HEAVIES.has(t)) return 'heavy';
  if (c === 'A3' || c === 'A4') return 'jet';
  if (c === 'A2') return 'smalljet';
  if (c === 'A1' || c === 'B4') return 'light';
  if (c === 'A6') return 'fast';
  return 'generic';
}

// --- shapes ------------------------------------------------------------------
// Drawn in a 32-unit box centred on (0, 0), nose up at negative y. Each shape
// is a list of parts; `half` outlines are mirrored to make the left side.

const half = (points) => {
  const right = points.map(([x, y]) => `${x} ${y}`);
  const left = points.slice(1, -1).reverse().map(([x, y]) => `${-x} ${y}`);
  return `M${[...right, ...left].join(' L')} Z`;
};
const rect = (x0, y0, x1, y1) => `M${x0} ${y0} H${x1} V${y1} H${x0} Z`;
const pair = (x0, y0, x1, y1) => [rect(x0, y0, x1, y1), rect(-x1, y0, -x0, y1)];
const circle = (cx, cy, r) => `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
const ellipse = (cx, cy, rx, ry) => `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
// A bar of the given length and width through (0, 0) at `deg` from vertical.
function bar(deg, length, width) {
  const a = (deg * Math.PI) / 180;
  const [dx, dy] = [Math.sin(a) * length / 2, -Math.cos(a) * length / 2];
  const [nx, ny] = [Math.cos(a) * width / 2, Math.sin(a) * width / 2];
  const p = [[dx + nx, dy + ny], [dx - nx, dy - ny], [-dx - nx, -dy - ny], [-dx + nx, -dy + ny]];
  return `M${p.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L')} Z`;
}

export const SHAPES = {
  // Narrow-body airliner: swept wings, engines under them.
  jet: {
    size: 26,
    parts: [
      half([[0, -15], [1.2, -13.6], [1.7, -11], [1.7, -3], [13.5, 3.5], [13.5, 5.3], [1.7, 2.2], [1.7, 10],
        [5.8, 13.4], [5.8, 15], [0.8, 14.2], [0, 15.4]]),
      ...pair(4.6, -0.6, 6.8, 3.6),
    ],
  },
  // Wide-body: wider fuselage and span.
  heavy: {
    size: 32,
    parts: [
      half([[0, -15.6], [1.8, -13.8], [2.4, -11], [2.4, -3.5], [15.6, 4.2], [15.6, 6.2], [2.4, 2.6], [2.4, 10.4],
        [6.8, 13.6], [6.8, 15.3], [1, 14.4], [0, 15.8]]),
      ...pair(5.2, -1.2, 7.8, 4),
    ],
  },
  // Business / regional jet: shorter span, engines on the rear fuselage.
  smalljet: {
    size: 23,
    parts: [
      half([[0, -15], [1.1, -13.5], [1.5, -10.5], [1.5, -1.5], [11.5, 4], [11.5, 5.6], [1.5, 2.6], [1.3, 12.2],
        [5.6, 13.6], [5.6, 15], [0, 14.4]]),
      ...pair(1.6, 5, 3.8, 10.5),
    ],
  },
  // Turboprop: straight wings, nacelles and propellers ahead of them.
  turboprop: {
    size: 25,
    parts: [
      half([[0, -15], [1.3, -13.5], [1.6, -10.5], [1.6, -4.5], [14.5, -4], [14.5, -1.6], [1.6, -1], [1.3, 10.5],
        [5.8, 12.6], [5.8, 14.2], [0, 14.4]]),
      ...pair(4.4, -8.5, 6.6, 1),
      ...pair(2.6, -9.6, 8.4, -8.6),
    ],
  },
  // Light aircraft: high straight wing, propeller at the nose.
  light: {
    size: 20,
    parts: [
      half([[0, -13], [1.4, -11.8], [1.6, -7], [14, -6.5], [14, -3.5], [1.6, -3], [0.9, 9.5], [5.5, 10.5],
        [5.5, 12.6], [0, 12.6]]),
      rect(-4.5, -15, 4.5, -13.8),
    ],
  },
  // Glider: very long, thin wings.
  glider: {
    size: 26,
    parts: [
      half([[0, -12], [0.9, -10.5], [1, -4], [16, -3.4], [16, -1.6], [1, -1], [0.6, 11], [4.5, 11.5],
        [4.5, 13], [0, 13]]),
    ],
  },
  // Military jet / high performance: delta wing.
  fast: {
    size: 22,
    parts: [
      half([[0, -15.5], [1.3, -11.5], [1.8, -4], [11.5, 7], [11.5, 9.4], [2.2, 8.4], [2.2, 11],
        [5.6, 13.8], [5.6, 15.2], [0, 14.6]]),
    ],
  },
  // Helicopter: rotor blades (still), cabin, tail boom and tail rotor.
  helicopter: {
    size: 24,
    parts: [
      bar(45, 30, 1.6),
      bar(-45, 30, 1.6),
      ellipse(0, -1.5, 4, 6.5),
      rect(-0.9, 4, 0.9, 14),
      rect(-3.2, 12.6, 3.2, 14.2),
    ],
  },
  balloon: {
    size: 16,
    parts: [circle(0, -3, 10), rect(-3, 9, 3, 14)],
  },
  // Drone: four arms and rotors.
  drone: {
    size: 16,
    parts: [
      bar(45, 26, 2.2),
      bar(-45, 26, 2.2),
      circle(9, -9, 4.5), circle(-9, -9, 4.5), circle(9, 9, 4.5), circle(-9, 9, 4.5),
      rect(-3.5, -3.5, 3.5, 3.5),
    ],
  },
  // Unknown type: a plain arrowhead.
  generic: {
    size: 16,
    parts: [half([[0, -14], [11, 13], [0, 6]])],
  },
};

let paths = null; // Path2D objects, built on first use (browser only)

// Draws the icon at (x, y) rotated to `trackDeg` (null: as for north).
// Returns its size in pixels.
export function drawIcon(ctx, kind, x, y, trackDeg, color, halo) {
  paths ??= Object.fromEntries(
    Object.entries(SHAPES).map(([k, s]) => [k, s.parts.map((d) => new Path2D(d))]),
  );
  const shape = SHAPES[kind] ?? SHAPES.generic;
  const scale = shape.size / 32;
  ctx.save();
  ctx.translate(x, y);
  if (trackDeg !== null && trackDeg !== undefined) ctx.rotate((trackDeg * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 / scale;
  ctx.strokeStyle = halo;
  ctx.fillStyle = color;
  // Outline every part first, then fill, so one part's outline never covers another's fill.
  for (const p of paths[kind] ?? paths.generic) ctx.stroke(p);
  for (const p of paths[kind] ?? paths.generic) ctx.fill(p);
  ctx.restore();
  return shape.size;
}
