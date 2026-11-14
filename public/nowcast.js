// Rain heading for home, read from the radar images (a "nowcast"): find how
// the rain moved between two images 20 min apart, move the newest image on the
// same way, and see when rain reaches home. Good for about an hour; showers
// that form or fade on the way aren't foreseen.
//
// The images are turned into a grid around home (see rain.js, rainGridAt):
// each cell holds the share of its radar pixels showing rain or snow. Cell
// (i, j) is column i (east) and row j (south); home sits at the grid's middle.

export const CELL_PX = 4; // a cell: 4 × 4 radar pixels at zoom 7 (about 1.4 km at Copenhagen)
export const HALF_KM = 100; // the grid reaches this far from home
export const PAIR_MIN = 20; // the movement is measured between images this far apart
export const SEARCH_KM = 40; // the furthest rain is looked for having moved in that time (120 km/h)
export const HOME_KM = 3; // rain within this distance of home counts as at home…
export const AT_HOME = 0.25; // …once it covers this share of that circle
export const AHEAD_MIN = 75; // how far past the newest image to look
export const MIN_SCORE = 0.4; // how well the moved image must match the newer one (correlation)
export const MIN_RAIN = 0.002; // share of the matched area with rain needed to measure movement
export const MIN_SPEED_KMH = 5; // slower counts as standing still

// Rain or snow in RainViewer's colours (checked on real tiles, 2026-11-14):
// rain is opaque blue, then yellow, orange, red and magenta; snow a paler,
// fully saturated blue that fades out translucent; very light echoes
// (drizzle, often not reaching the ground) are a translucent tan-grey,
// left out here.
export function isPrecip(r, g, b, a) {
  if (a < 200) return false;
  const tan = r >= g && g >= b && b >= 80 && r - b < 100;
  return !tan;
}

// A grid from RGBA pixels `w` × `h` (ImageData's layout): the share of
// precipitation pixels in each `cellPx` × `cellPx` block.
export function gridFromPixels(data, w, h, cellPx, kmPerPx) {
  const n = Math.floor(Math.min(w, h) / cellPx);
  const cells = new Float32Array(n * n);
  const per = 1 / (cellPx * cellPx);
  for (let y = 0; y < n * cellPx; y++) {
    const row = Math.floor(y / cellPx) * n;
    for (let x = 0; x < n * cellPx; x++) {
      const k = (y * w + x) * 4;
      if (isPrecip(data[k], data[k + 1], data[k + 2], data[k + 3])) cells[row + Math.floor(x / cellPx)] += per;
    }
  }
  return { n, cells, kmPerCell: kmPerPx * cellPx };
}

// Averages f × f blocks: a coarser grid for a quick first search.
function coarsen(grid, f) {
  const n = Math.floor(grid.n / f);
  const cells = new Float32Array(n * n);
  for (let j = 0; j < n * f; j++) {
    for (let i = 0; i < n * f; i++) cells[Math.floor(j / f) * n + Math.floor(i / f)] += grid.cells[j * grid.n + i] / (f * f);
  }
  return { n, cells, kmPerCell: grid.kmPerCell * f };
}

// Correlation between the newer grid's middle (out to `inner` cells from the
// centre) and the older grid moved by (dx, dy) cells: 1 = the same pattern.
function match(older, newer, dx, dy, inner) {
  const { n } = newer;
  const lo = Math.max(0, Math.floor(n / 2 - inner));
  const hi = Math.min(n, Math.ceil(n / 2 + inner));
  let k = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let j = lo; j < hi; j++) {
    const jo = j - dy;
    if (jo < 0 || jo >= n) continue;
    for (let i = lo; i < hi; i++) {
      const io = i - dx;
      if (io < 0 || io >= n) continue;
      const a = older.cells[jo * n + io];
      const b = newer.cells[j * n + i];
      k++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  if (!k) return -1;
  const va = saa - (sa * sa) / k;
  const vb = sbb - (sb * sb) / k;
  return va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / k) / Math.sqrt(va * vb) : -1;
}

// The best shift within ±range around (cx, cy).
function bestShift(older, newer, cx, cy, range, limit, inner) {
  let best = { dx: 0, dy: 0, score: -Infinity };
  for (let dy = Math.max(-limit, cy - range); dy <= Math.min(limit, cy + range); dy++) {
    for (let dx = Math.max(-limit, cx - range); dx <= Math.min(limit, cx + range); dx++) {
      const score = match(older, newer, dx, dy, inner);
      if (score > best.score) best = { dx, dy, score };
    }
  }
  return best;
}

// Share of the newer grid's middle with rain in it.
function rainShare(grid, inner) {
  const { n } = grid;
  const lo = Math.max(0, Math.floor(n / 2 - inner));
  const hi = Math.min(n, Math.ceil(n / 2 + inner));
  let wet = 0;
  for (let j = lo; j < hi; j++) for (let i = lo; i < hi; i++) if (grid.cells[j * n + i] > 0) wet++;
  return wet / ((hi - lo) * (hi - lo));
}

// How the rain moved from `older` to `newer` (`minutes` apart): { dxPerMin,
// dyPerMin (cells, east and south), speedKmh, fromDeg (the compass direction
// it comes from), score }, or null when there's too little rain or no clear match.
export function estimateMotion(older, newer, minutes) {
  if (older.n !== newer.n) return null;
  const limit = Math.round(SEARCH_KM / newer.kmPerCell);
  const inner = newer.n / 2 - limit; // the older grid reaches every shifted cell
  if (inner < 4 || rainShare(newer, inner) < MIN_RAIN || rainShare(older, older.n / 2) < MIN_RAIN) return null;

  // First on cells 4 times coarser, then around that on the full grid.
  const F = 4;
  const co = coarsen(older, F);
  const cn = coarsen(newer, F);
  const cl = Math.ceil(limit / F);
  const rough = bestShift(co, cn, 0, 0, cl, cl, inner / F);
  const fine = bestShift(older, newer, rough.dx * F, rough.dy * F, F, limit, inner);
  if (fine.score < MIN_SCORE) return null;

  // Between whole cells: a parabola through the best match and its neighbours.
  const part = (minus, plus) => {
    const curve = minus - 2 * fine.score + plus;
    return curve < 0 ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curve))) : 0;
  };
  const dx = fine.dx + part(match(older, newer, fine.dx - 1, fine.dy, inner), match(older, newer, fine.dx + 1, fine.dy, inner));
  const dy = fine.dy + part(match(older, newer, fine.dx, fine.dy - 1, inner), match(older, newer, fine.dx, fine.dy + 1, inner));

  const east = (dx * newer.kmPerCell * 60) / minutes;
  const north = (-dy * newer.kmPerCell * 60) / minutes;
  const speedKmh = Math.hypot(east, north);
  const still = speedKmh < MIN_SPEED_KMH;
  return {
    dxPerMin: still ? 0 : dx / minutes,
    dyPerMin: still ? 0 : dy / minutes,
    speedKmh: still ? 0 : speedKmh,
    fromDeg: still ? null : ((Math.atan2(-east, -north) * 180) / Math.PI + 360) % 360,
    score: fine.score,
  };
}

// Share of the circle of HOME_KM around point (x, y) (in cells) covered by rain.
function coverAt(grid, x, y) {
  const r = HOME_KM / grid.kmPerCell;
  let sum = 0, k = 0;
  for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++) {
    for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
      if ((i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2 > r * r) continue;
      if (i < 0 || j < 0 || i >= grid.n || j >= grid.n) return null;
      sum += grid.cells[j * grid.n + i];
      k++;
    }
  }
  return k ? sum / k : null;
}

// Whether it rains at home in the newest image, and when the rain moved on
// with `motion` (null: unknown) reaches or leaves home: { rainNow, startsAt,
// endsAt (ms, or null), aheadMin (how far ahead it could look) }.
// `frameTime`: the newest image's time, ms.
export function forecastHome(grid, motion, frameTime) {
  const c = grid.n / 2;
  const wet = (t) => {
    // The rain over home t minutes on was this far upwind in the image.
    const cover = coverAt(grid, c - (motion?.dxPerMin ?? 0) * t, c - (motion?.dyPerMin ?? 0) * t);
    return cover === null ? null : cover >= AT_HOME;
  };
  const rainNow = wet(0) === true;
  const out = { rainNow, startsAt: null, endsAt: null, aheadMin: 0 };
  if (!motion || !motion.speedKmh) return out;
  for (let t = 1; t <= AHEAD_MIN; t++) {
    const w = wet(t);
    if (w === null) break; // past the grid's edge
    out.aheadMin = t;
    if (w !== rainNow) {
      out[rainNow ? 'endsAt' : 'startsAt'] = frameTime + t * 60000;
      break;
    }
  }
  return out;
}

const FIVE_MIN = 5 * 60000;
const round5 = (ms) => Math.round(ms / FIVE_MIN) * FIVE_MIN;

// The warning shown beside the radar time, '' when there's nothing to say.
// `clock(ms)` formats a time of day.
export function warningText(cast, now, clock) {
  if (!cast) return '';
  if (cast.rainNow) {
    if (!cast.endsAt) return 'Raining at home';
    return cast.endsAt > now ? `Raining at home, until ~${clock(round5(cast.endsAt))}` : '';
  }
  if (!cast.startsAt) return '';
  if (cast.startsAt <= now + FIVE_MIN / 2) return cast.startsAt > now - 4 * FIVE_MIN ? 'Rain at home about now' : '';
  return `Rain at home from ~${clock(round5(cast.startsAt))}`;
}
