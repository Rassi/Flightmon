// Display formatting. Values arrive metric from the Worker (m, km, km/h, m/s).

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

export const formatDirection = (deg) => `${compass(deg)} ${Math.round(deg) % 360}°`;

export const formatDistance = (km) => `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;

export const formatSpeed = (kmh) => (kmh === null ? '–' : `${whole.format(kmh)} km/h`);

export function formatAltitude(ac) {
  if (ac.onGround) return 'Ground';
  if (ac.altM === null) return '–';
  return `${whole.format(ac.altM)} m`;
}

// Above 1 m/s (about 200 ft/min) counts as climbing or descending.
export function climbArrow(vrateMs) {
  if (vrateMs === null) return '';
  if (vrateMs > 1) return '↑';
  if (vrateMs < -1) return '↓';
  return '';
}

export const displayName = (ac) => ac.callsign ?? ac.reg ?? ac.hex.toUpperCase();
