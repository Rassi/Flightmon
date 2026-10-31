// Colour by altitude: orange near the ground, through yellow and green, to
// blue and magenta at cruise. Stops are [altitude in metres, hue in degrees].

export const STOPS = [
  [0, 25],
  [500, 38],
  [1500, 55],
  [3000, 100],
  [6000, 185],
  [9000, 230],
  [12000, 290],
];

const SATURATION = 0.85;
const LIGHTNESS = 0.52;

export const GROUND_COLOR = '#8a9a96';
export const UNKNOWN_COLOR = '#b9c4c1';

export function altitudeHue(m) {
  if (m <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [a1, h1] = STOPS[i];
    if (m <= a1) {
      const [a0, h0] = STOPS[i - 1];
      return h0 + ((m - a0) / (a1 - a0)) * (h1 - h0);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const hex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export const hueColor = (h) => hslToHex(h, SATURATION, LIGHTNESS);

export function altitudeColor(ac) {
  if (ac.onGround) return GROUND_COLOR;
  if (ac.altM === null || ac.altM === undefined) return UNKNOWN_COLOR;
  return hueColor(altitudeHue(ac.altM));
}

// The legend's gradient, built from the same stops.
export function legendGradient() {
  const top = STOPS[STOPS.length - 1][0];
  const parts = STOPS.map(([m, h]) => `${hueColor(h)} ${((m / top) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
