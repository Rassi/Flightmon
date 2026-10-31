import { GROUND_COLOR, STOPS, altitudeColor, legendGradient } from './altitude.js';
import { ATTRIBUTION, drawBasemap } from './basemap.js';
import { lookup, renderDetails } from './details.js';
import { RAIN_CREDIT, drawRain, fetchFrame } from './rain.js';
import { WEATHER_CREDIT, clockParts, fetchWeather, weatherLines } from './weather.js';
import { drawRadar, hitTest } from './radar.js';
import { TrailRecorder, mergeTrail } from './trails.js';
import {
  climbArrow, displayName, formatAltitude, formatDirection, formatDistance, formatSpeed,
} from './format.js';

const REFRESH_MS = 5000;
const STALE_MS = 20000;
const DEFAULT_RANGE_KM = 50;
const MAX_RANGE_KM = 463;
const STORAGE_KEY = 'flightmon.location';
const RAIN_KEY = 'flightmon.rain';
const WEATHER_REFRESH_MS = 15 * 60 * 1000; // Open-Meteo's current values change every 15 min
const RAIN_REFRESH_MS = 5 * 60 * 1000; // a new radar image every 10 min
const RAIN_STALE_S = 30 * 60;

const $ = (id) => document.getElementById(id);
const els = {
  form: $('location-form'),
  lat: $('lat'),
  lon: $('lon'),
  range: $('range'),
  locate: $('locate'),
  canvas: $('radar'),
  attribution: $('attribution'),
  clockTime: $('clock-time'),
  clockZone: $('clock-zone'),
  clockUtc: $('clock-utc'),
  weather: $('weather'),
  rainToggle: $('rain-toggle'),
  rainStatus: $('rain-status'),
  legend: $('legend'),
  details: $('details'),
  status: $('status'),
  rows: document.querySelector('#aircraft tbody'),
  empty: $('empty'),
};

const state = {
  location: null, // { lat, lon, rangeKm }
  data: null, // last good /api/aircraft response
  lastOk: 0,
  error: null,
  highlight: null, // hex of the aircraft under the pointer in the list
  selected: null, // the clicked aircraft, as last seen; its details are shown
  info: undefined, // adsbdb lookup for the selected aircraft (undefined while loading)
  track: undefined, // its path from OpenSky: { path } or { error } (undefined while loading)
  weather: null, // Open-Meteo's current weather at the location (see weather.js)
  weatherError: null,
  weatherAt: 0, // when it was last asked for
  rainOn: true,
  rainFrame: null, // the latest radar image: { host, path, time }
  rainError: null,
  rainAt: 0,
};

const trails = new TrailRecorder(); // every aircraft's positions since the page opened

let lastView = null; // the radar's projection as last drawn, for clicks

// --- location ---------------------------------------------------------------

function parseLocation(lat, lon, range) {
  const loc = { lat: Number(lat), lon: Number(lon), rangeKm: Number(range) };
  if (!Number.isFinite(loc.lat) || loc.lat < -90 || loc.lat > 90) return null;
  if (!Number.isFinite(loc.lon) || loc.lon < -180 || loc.lon > 180) return null;
  if (!Number.isFinite(loc.rangeKm) || loc.rangeKm < 1 || loc.rangeKm > MAX_RANGE_KM) return null;
  return loc;
}

function initialLocation() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('lat') && params.has('lon')) {
    return parseLocation(params.get('lat'), params.get('lon'), params.get('range') ?? DEFAULT_RANGE_KM);
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return parseLocation(saved.lat, saved.lon, saved.rangeKm);
  } catch {
    // No storage (private window, blocked site data): just ask again.
  }
  return null;
}

function fillForm(loc) {
  els.lat.value = loc ? loc.lat : '';
  els.lon.value = loc ? loc.lon : '';
  els.range.value = loc ? loc.rangeKm : DEFAULT_RANGE_KM;
}

function useLocation(loc) {
  state.location = loc;
  state.data = null;
  state.error = null;
  state.highlight = null;
  state.selected = null;
  trails.clear();
  fillForm(loc);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
  } catch {
    // Not remembered; the address bar still has it.
  }
  const params = new URLSearchParams({ lat: loc.lat, lon: loc.lon, range: loc.rangeKm });
  history.replaceState(null, '', `?${params}`);
  render();
  poll();
  loadWeather();
}

// Accept "55.6761, 12.5683" (as copied from a map) in the latitude field.
els.lat.addEventListener('input', () => {
  const pair = els.lat.value.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (pair) [, els.lat.value, els.lon.value] = pair;
});

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const loc = parseLocation(els.lat.value, els.lon.value, els.range.value);
  if (!loc) {
    showStatus(`Latitude must be −90 to 90, longitude −180 to 180 and range 1 to ${MAX_RANGE_KM} km.`, true);
    return;
  }
  useLocation(loc);
});

els.locate.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showStatus('This browser has no location service. Type the coordinates instead.', true);
    return;
  }
  showStatus('Asking the browser for your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const round4 = (v) => Math.round(v * 1e4) / 1e4;
      const range = Number(els.range.value) || DEFAULT_RANGE_KM;
      useLocation(parseLocation(round4(pos.coords.latitude), round4(pos.coords.longitude), range));
    },
    (err) => showStatus(`Couldn't get your location: ${err.message}`, true),
    { timeout: 15000, maximumAge: 600000 },
  );
});

// --- polling ----------------------------------------------------------------

let timer = null;
let controller = null;

async function poll() {
  clearTimeout(timer);
  timer = null;
  controller?.abort();
  if (!state.location || document.hidden) return;

  const ctrl = (controller = new AbortController());
  const { lat, lon, rangeKm } = state.location;
  try {
    const res = await fetch(`/api/aircraft?lat=${lat}&lon=${lon}&radius=${rangeKm}`, { signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body.failures ? ` (${body.failures.join('; ')})` : '';
      throw new Error((body.error || `HTTP ${res.status}`) + detail);
    }
    state.data = body;
    trails.record(body);
    state.lastOk = Date.now();
    state.error = null;
  } catch (err) {
    if (ctrl.signal.aborted) return;
    state.error = err.message;
  }
  if (ctrl.signal.aborted) return; // superseded by a newer location
  controller = null;
  render();
  timer = setTimeout(poll, REFRESH_MS);
}

// Don't poll in a background tab; catch up as soon as it's visible again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  poll();
  refreshSlow();
});

// --- clock, weather and rain ------------------------------------------------

let weatherController = null;

async function loadWeather() {
  weatherController?.abort();
  if (!state.location) return;
  const ctrl = (weatherController = new AbortController());
  const { lat, lon } = state.location;
  state.weatherAt = Date.now();
  if (state.weather && (state.weather.lat !== lat || state.weather.lon !== lon)) state.weather = null;
  renderWeather();
  try {
    const w = await fetchWeather(lat, lon, (url, opts) => fetch(url, { ...opts, signal: AbortSignal.any([opts.signal, ctrl.signal]) }));
    if (ctrl.signal.aborted) return;
    state.weather = { ...w, lat, lon };
    state.weatherError = null;
  } catch (err) {
    if (ctrl.signal.aborted) return;
    state.weatherError = err.message;
  }
  renderWeather();
  renderClock();
  renderRain(); // its time is shown in the location's time zone
}

async function loadRain() {
  state.rainAt = Date.now();
  try {
    state.rainFrame = await fetchFrame();
    state.rainError = null;
  } catch (err) {
    state.rainError = err.message;
  }
  renderRain();
  drawCanvas();
}

// Weather and rain change slowly: refresh them when due, and not in a background tab.
function refreshSlow() {
  if (document.hidden) return;
  if (state.location && Date.now() - state.weatherAt > WEATHER_REFRESH_MS) loadWeather();
  if (state.rainOn && Date.now() - state.rainAt > RAIN_REFRESH_MS) loadRain();
}

function setRain(on) {
  state.rainOn = on;
  try {
    localStorage.setItem(RAIN_KEY, on ? 'on' : 'off');
  } catch {
    // Not remembered.
  }
  renderRain();
  drawCanvas();
  refreshSlow();
}

els.rainToggle.addEventListener('click', () => setRain(!state.rainOn));

// The time at the radar's location (once the weather has told us its time
// zone; the browser's until then), and UTC as aviation uses it.
function renderClock() {
  const { time, zone, utc } = clockParts(new Date(), state.weather?.timeZone);
  els.clockTime.textContent = time;
  els.clockZone.textContent = zone;
  // Only when it differs (not in London in winter, nor when the zone is UTC).
  els.clockUtc.textContent = time.startsWith(utc) ? '' : `· ${utc} UTC`;
}

function renderWeather() {
  if (!state.location) {
    els.weather.replaceChildren();
    els.weather.title = '';
    return;
  }
  if (!state.weather) {
    els.weather.textContent = state.weatherError ? `Weather unavailable: ${state.weatherError}` : 'Loading weather…';
    els.weather.title = '';
    return;
  }
  const [sky, rest] = weatherLines(state.weather);
  const first = document.createElement('span');
  first.className = 'sky';
  first.textContent = sky;
  els.weather.replaceChildren(first, document.createElement('br'), rest);
  els.weather.title = `Open-Meteo, for ${state.weather.time?.replace('T', ' ')} local time` +
    (state.weatherError ? ` (last update failed: ${state.weatherError})` : '');
}

function renderRain() {
  els.rainToggle.setAttribute('aria-pressed', String(state.rainOn));
  els.rainToggle.title = state.rainOn ? 'Hide the rain radar' : 'Show the rain radar';
  let text = '';
  let problem = false;
  if (state.rainOn) {
    if (state.rainFrame) {
      const { time } = clockParts(new Date(state.rainFrame.time * 1000), state.weather?.timeZone);
      text = `Radar ${time.slice(0, 5)}`;
      problem = Date.now() / 1000 - state.rainFrame.time > RAIN_STALE_S;
      if (state.rainError) text += ` (update failed: ${state.rainError})`;
    } else if (state.rainError) {
      text = `Unavailable: ${state.rainError}`;
      problem = true;
    } else {
      text = 'Loading…';
    }
  }
  els.rainStatus.textContent = text;
  els.rainStatus.classList.toggle('error', problem);
  renderAttribution();
}

function renderAttribution() {
  const credits = [WEATHER_CREDIT];
  if (state.rainOn) credits.push(RAIN_CREDIT);
  const parts = [ATTRIBUTION];
  for (const { label, text, href } of credits) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    parts.push(`. ${label}: `, a);
  }
  els.attribution.replaceChildren(...parts);
}

// --- rendering --------------------------------------------------------------

function cssColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  return {
    ring: get('--ring'),
    ringStrong: get('--ring-strong'),
    muted: get('--muted'),
    alert: get('--alert'),
    highlight: get('--highlight'),
    halo: get('--bg'),
    mapOpacity: Number(get('--map-opacity')) || 1,
    rainOpacity: Number(get('--rain-opacity')) || 0.7,
  };
}

// Tiles arrive one by one; redraw at most once per frame.
let drawQueued = false;
function queueDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    drawCanvas();
  });
}

function aircraftInRange() {
  if (!state.data || !state.location) return [];
  return state.data.aircraft.filter((ac) => ac.distKm <= state.location.rangeKm);
}

function drawCanvas() {
  const canvas = els.canvas;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!state.location) {
    ctx.clearRect(0, 0, width, height);
    return;
  }
  const colors = cssColors();
  lastView = drawRadar(ctx, {
    width,
    height,
    center: state.location,
    aircraft: aircraftInRange(),
    rangeKm: state.location.rangeKm,
    highlight: new Set([state.highlight, state.selected?.hex].filter(Boolean)),
    trail: selectedTrail(),
    colors,
    background: (c, view) => {
      drawBasemap(c, view, { dpr, opacity: colors.mapOpacity, dimColor: colors.halo, onLoad: queueDraw });
      if (state.rainOn && state.rainFrame) {
        drawRain(c, view, state.rainFrame, { dpr, opacity: colors.rainOpacity, onLoad: queueDraw });
      }
    },
  });
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

// Altitude with a swatch in the aircraft's radar colour.
function altitudeCell(ac) {
  const td = cell(`${formatAltitude(ac)} ${climbArrow(ac.vrateMs)}`.trim(), 'num');
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.backgroundColor = ac.emergency ? cssColors().alert : altitudeColor(ac);
  td.prepend(swatch);
  return td;
}

function renderLegend() {
  const bar = document.createElement('span');
  bar.className = 'legend-bar';
  bar.style.backgroundImage = legendGradient();
  const top = STOPS[STOPS.length - 1][0];
  const ticks = document.createElement('span');
  ticks.className = 'legend-ticks';
  for (const km of [0, 3, 6, 9, 12]) {
    const t = document.createElement('span');
    t.textContent = km === 12 ? '12 km' : String(km);
    t.style.left = `${((km * 1000) / top) * 100}%`;
    ticks.append(t);
  }
  const ground = document.createElement('span');
  ground.className = 'legend-ground';
  const dot = document.createElement('span');
  dot.className = 'swatch';
  dot.style.backgroundColor = GROUND_COLOR;
  ground.append(dot, 'Ground');
  const scale = document.createElement('span');
  scale.className = 'legend-scale';
  scale.append(bar, ticks);
  els.legend.replaceChildren(scale, ground);
}

function renderList() {
  const list = aircraftInRange();
  const rows = list.map((ac) => {
    const tr = document.createElement('tr');
    tr.dataset.hex = ac.hex;
    if (ac.onGround) tr.classList.add('ground');
    if (ac.emergency) tr.classList.add('emergency');
    if (ac.hex === state.highlight) tr.classList.add('highlight');
    if (ac.hex === state.selected?.hex) tr.classList.add('selected');

    const name = cell(displayName(ac), 'name');
    if (ac.callsign && ac.reg) {
      const reg = document.createElement('span');
      reg.className = 'reg';
      reg.textContent = ac.reg;
      name.append(reg);
    }
    tr.append(
      name,
      cell(ac.type ?? '–'),
      altitudeCell(ac),
      cell(formatSpeed(ac.speedKmh), 'num'),
      cell(formatDistance(ac.distKm), 'num'),
      cell(formatDirection(ac.bearingDeg)),
    );
    return tr;
  });
  els.rows.replaceChildren(...rows);
  els.empty.hidden = !state.data || list.length > 0;
  if (state.data && state.location) {
    els.empty.textContent = `No aircraft within ${state.location.rangeKm} km right now.`;
  }
}

function showStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function renderStatus() {
  if (!state.location) {
    showStatus('Enter a location above, or use your browser’s.');
    return;
  }
  if (!state.data) {
    showStatus(state.error ? `Couldn't load aircraft: ${state.error}` : 'Loading aircraft…', Boolean(state.error));
    return;
  }
  const count = aircraftInRange().length;
  const ago = Math.max(0, Math.round((Date.now() - state.lastOk) / 1000));
  const stale = Date.now() - state.lastOk > STALE_MS;
  const parts = [
    `${count} aircraft within ${state.location.rangeKm} km`,
    `from ${state.data.source}`,
    `updated ${ago} s ago`,
  ];
  if (state.error) parts.push(`last attempt failed: ${state.error}`);
  showStatus(parts.join(' · '), stale || Boolean(state.error));
}

// --- details of the selected aircraft ---------------------------------------

// OpenSky tracks, per aircraft, for this page (each costs some of the daily allowance).
const trackCache = new Map();

function fetchTrack(hex) {
  if (!trackCache.has(hex)) {
    const p = fetch(`/api/track?hex=${hex}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return { path: body.path };
      })
      .catch((err) => {
        trackCache.delete(hex); // try again next time it's clicked
        return { error: err.message };
      });
    trackCache.set(hex, p);
  }
  return trackCache.get(hex);
}

// OpenSky's path (if any) followed by what we've recorded, ending where it is now.
function selectedTrail() {
  if (!state.selected) return null;
  return mergeTrail(state.track?.path, trails.get(state.selected.hex));
}

function select(ac) {
  if (state.selected?.hex === ac.hex) return;
  state.selected = ac;
  state.info = undefined;
  state.track = undefined;
  render();
  lookup(ac.hex, ac.callsign).then((info) => {
    if (state.selected?.hex !== ac.hex) return; // another aircraft was chosen meanwhile
    state.info = info;
    renderSelected();
  });
  fetchTrack(ac.hex).then((track) => {
    if (state.selected?.hex !== ac.hex) return;
    state.track = track;
    renderSelected();
    drawCanvas();
  });
}

function deselect() {
  if (!state.selected) return;
  state.selected = null;
  render();
}

function renderSelected() {
  if (!state.selected) {
    els.details.hidden = true;
    els.details.replaceChildren();
    return;
  }
  // Follow the aircraft with each update; keep its last position if it's gone.
  const current = state.data?.aircraft.find((ac) => ac.hex === state.selected.hex);
  if (current) state.selected = current;
  renderDetails(els.details, {
    ac: state.selected,
    info: state.info,
    track: state.track,
    trail: selectedTrail(),
    seen: Boolean(current),
    onClose: deselect,
  });
  els.details.hidden = false;
}

function render() {
  renderSelected();
  drawCanvas();
  renderList();
  renderStatus();
}

els.rows.addEventListener('mouseover', (event) => {
  const hex = event.target.closest('tr')?.dataset.hex ?? null;
  if (hex === state.highlight) return;
  state.highlight = hex;
  for (const tr of els.rows.children) tr.classList.toggle('highlight', tr.dataset.hex === hex);
  drawCanvas();
});
els.rows.addEventListener('click', (event) => {
  const hex = event.target.closest('tr')?.dataset.hex;
  const ac = hex && aircraftInRange().find((a) => a.hex === hex);
  if (ac) select(ac);
});
els.rows.addEventListener('mouseleave', () => {
  state.highlight = null;
  for (const tr of els.rows.children) tr.classList.remove('highlight');
  drawCanvas();
});

// Click an aircraft on the radar for its details; click elsewhere to close them.
function aircraftAt(event) {
  if (!lastView) return null;
  return hitTest(lastView, aircraftInRange(), event.offsetX, event.offsetY);
}
els.canvas.addEventListener('click', (event) => {
  const ac = aircraftAt(event);
  if (ac) select(ac);
  else deselect();
});
els.canvas.addEventListener('mousemove', (event) => {
  els.canvas.style.cursor = aircraftAt(event) ? 'pointer' : '';
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') deselect();
});

try {
  state.rainOn = localStorage.getItem(RAIN_KEY) !== 'off';
} catch {
  // On by default.
}
renderRain();
renderLegend();
new ResizeObserver(drawCanvas).observe(els.canvas);
setInterval(renderStatus, 1000);
// Tick just after each whole second, so the clock doesn't lag behind.
(function tick() {
  renderClock();
  setTimeout(tick, 1005 - (Date.now() % 1000));
})();
setInterval(refreshSlow, 60 * 1000);
refreshSlow();

// --- start ------------------------------------------------------------------

const start = initialLocation();
if (start) {
  useLocation(start);
} else {
  fillForm(null);
  render();
  els.lat.focus();
}
