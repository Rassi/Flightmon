// The clock and the weather at the radar's location. Weather comes from
// Open-Meteo: no key, CORS allowed, free for non-commercial use, CC BY 4.0
// (credit with a link). Its "current" values are model data at 15-minute
// steps, not station observations. It also tells us the location's time zone.

import { compass } from './format.js';

export const WEATHER_CREDIT = { label: 'Weather', text: 'Open-Meteo', href: 'https://open-meteo.com/' };

const API = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 8000;
const FIELDS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'cloud_cover',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl', 'visibility',
];

export function weatherUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: FIELDS.join(','),
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
  return `${API}?${params}`;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseWeather(body) {
  const c = body?.current;
  if (!c) throw new Error('Open-Meteo sent no current weather');
  return {
    timeZone: body.timezone || null,
    time: c.time ?? null, // local time at the location, ISO without zone
    tempC: num(c.temperature_2m),
    feelsC: num(c.apparent_temperature),
    humidity: num(c.relative_humidity_2m),
    code: num(c.weather_code),
    cloudPct: num(c.cloud_cover),
    windKmh: num(c.wind_speed_10m),
    windFromDeg: num(c.wind_direction_10m),
    gustKmh: num(c.wind_gusts_10m),
    pressureHpa: num(c.pressure_msl),
    visibilityM: num(c.visibility),
  };
}

export async function fetchWeather(lat, lon, fetchFn = fetch) {
  const res = await fetchFn(weatherUrl(lat, lon), { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err) => {
    throw err.name === 'TimeoutError' ? new Error(`Open-Meteo didn't answer within ${TIMEOUT_MS / 1000} s`) : err;
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason || `Open-Meteo answered HTTP ${res.status}`);
  return parseWeather(body);
}

// WMO weather interpretation codes, as Open-Meteo documents them.
const CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Light snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

export const describeWeather = (code) => CODES[code] ?? null;

export function formatWind(kmh, fromDeg, gustKmh) {
  if (kmh === null) return null;
  if (kmh < 1) return 'Wind calm';
  const from = fromDeg === null ? '' : ` from ${compass(fromDeg)}`;
  const gusts = gustKmh !== null && Math.round(gustKmh) > Math.round(kmh) ? `, gusts ${Math.round(gustKmh)}` : '';
  return `Wind ${Math.round(kmh)} km/h${from}${gusts}`;
}

export function formatVisibility(m) {
  if (m === null) return null;
  if (m < 1000) return `Visibility ${Math.round(m / 10) * 10} m`;
  return `Visibility ${m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}

const degrees = (c) => `${Math.round(c)} °C`;

// Two short lines: the sky and temperature, then wind, visibility, pressure.
export function weatherLines(w) {
  const first = [describeWeather(w.code), w.tempC === null ? null : degrees(w.tempC)].filter(Boolean).join(', ');
  const feels = w.feelsC !== null && w.tempC !== null && Math.round(w.feelsC) !== Math.round(w.tempC)
    ? ` (feels ${degrees(w.feelsC)})` : '';
  const second = [
    formatWind(w.windKmh, w.windFromDeg, w.gustKmh),
    formatVisibility(w.visibilityM),
    w.pressureHpa === null ? null : `${Math.round(w.pressureHpa)} hPa`,
  ].filter(Boolean).join(' · ');
  return [first + feels, second];
}

// The time in `timeZone` (an IANA name; the browser's own if not given or
// unknown), 24-hour, and UTC.
export function clockParts(date, timeZone) {
  const fmt = (options) => {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || undefined, ...options });
    } catch {
      return new Intl.DateTimeFormat('en-GB', options); // unknown zone: the browser's
    }
  };
  const time = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
  const zone = fmt({ timeZoneName: 'short' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const utc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return { time, zone, utc };
}
