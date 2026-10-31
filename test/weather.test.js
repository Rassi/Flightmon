import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  clockParts, describeWeather, fetchWeather, formatVisibility, formatWind, parseWeather, weatherLines, weatherUrl,
} from '../public/weather.js';

// Open-Meteo's answer for Copenhagen, 2026-10-31 15:45 local time.
const body = JSON.parse(readFileSync(new URL('./fixtures/openmeteo-cph.json', import.meta.url)));

test('the request asks for current weather in km/h and the local time zone', () => {
  const url = new URL(weatherUrl(55.6761, 12.5683));
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '55.6761');
  assert.equal(url.searchParams.get('longitude'), '12.5683');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
  for (const f of ['temperature_2m', 'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'visibility', 'pressure_msl']) {
    assert.ok(url.searchParams.get('current').split(',').includes(f), f);
  }
});

test('parses a real answer', () => {
  assert.deepEqual(parseWeather(body), {
    timeZone: 'Europe/Copenhagen',
    time: '2026-10-31T15:45',
    tempC: 12.3,
    feelsC: 10.5,
    humidity: 81,
    code: 3,
    cloudPct: 92,
    windKmh: 10.4,
    windFromDeg: 13,
    gustKmh: 20.9,
    pressureHpa: 1032.1,
    visibilityM: 7540,
  });
  assert.throws(() => parseWeather({ error: true, reason: 'x' }), /no current weather/);
});

test('missing values stay null', () => {
  const w = parseWeather({ current: { temperature_2m: null, weather_code: 61 } });
  assert.equal(w.tempC, null);
  assert.equal(w.windKmh, null);
  assert.equal(w.timeZone, null);
  assert.deepEqual(weatherLines(w), ['Light rain', '']);
});

test('two lines for the header', () => {
  assert.deepEqual(weatherLines(parseWeather(body)), [
    'Overcast, 12 °C (feels 11 °C)',
    'Wind 10 km/h from NNE, gusts 21 · Visibility 7.5 km · 1032 hPa',
  ]);
});

test('WMO weather codes', () => {
  assert.equal(describeWeather(0), 'Clear sky');
  assert.equal(describeWeather(45), 'Fog');
  assert.equal(describeWeather(65), 'Heavy rain');
  assert.equal(describeWeather(95), 'Thunderstorm');
  // Every code Open-Meteo documents has a description.
  for (const c of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
    assert.ok(describeWeather(c), String(c));
  }
  assert.equal(describeWeather(4), null);
});

test('wind: where it comes from, gusts only when stronger', () => {
  assert.equal(formatWind(10.4, 13, 20.9), 'Wind 10 km/h from NNE, gusts 21'); // 13° is nearer NNE (22.5°)
  assert.equal(formatWind(25, 225, 25.2), 'Wind 25 km/h from SW');
  assert.equal(formatWind(18, 350, null), 'Wind 18 km/h from N');
  assert.equal(formatWind(0.4, 90, 3), 'Wind calm');
  assert.equal(formatWind(null, null, null), null);
});

test('visibility in m below 1 km, else km', () => {
  assert.equal(formatVisibility(240), 'Visibility 240 m');
  assert.equal(formatVisibility(7540), 'Visibility 7.5 km');
  assert.equal(formatVisibility(24140), 'Visibility 24 km');
  assert.equal(formatVisibility(null), null);
});

test('clock: 24-hour time in the given zone, and UTC', () => {
  const t = new Date('2026-10-31T14:47:05Z');
  assert.deepEqual(clockParts(t, 'Europe/Copenhagen'), { time: '15:47:05', zone: 'CET', utc: '14:47' });
  assert.deepEqual(clockParts(new Date('2026-07-01T23:05:00Z'), 'Europe/Copenhagen'), { time: '01:05:00', zone: 'CEST', utc: '23:05' });
  assert.equal(clockParts(t, 'America/New_York').time, '10:47:05');
  assert.equal(clockParts(t, 'UTC').time, '14:47:05');
  // Unknown or no zone: the browser's own, no error.
  const own = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(t);
  assert.equal(clockParts(t, 'Not/AZone').time, own);
  assert.equal(clockParts(t, null).time, own);
});

test('fetchWeather: errors say what Open-Meteo said', async () => {
  const ok = await fetchWeather(55.6761, 12.5683, async () => new Response(JSON.stringify(body)));
  assert.equal(ok.tempC, 12.3);
  await assert.rejects(
    fetchWeather(0, 0, async () => new Response(JSON.stringify({ error: true, reason: 'Daily API request limit exceeded' }), { status: 429 })),
    /Daily API request limit exceeded/,
  );
  await assert.rejects(fetchWeather(0, 0, async () => new Response('down', { status: 503 })), /HTTP 503/);
  const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  await assert.rejects(fetchWeather(0, 0, async () => { throw timeout; }), /Open-Meteo didn't answer within 8 s/);
});
