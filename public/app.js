import { GROUND_COLOR, STOPS, altitudeColor, legendGradient } from './altitude.js';
import { ATTRIBUTION, drawBasemap } from './basemap.js';
import { lookup, renderDetails } from './details.js';
import { RAIN_CREDIT, drawRain, fetchFrame } from './rain.js';
import { WEATHER_CREDIT, clockParts, fetchWeather, weatherLines } from './weather.js';
import { cornerRangeKm, drawMap, hitTest, mapView, maxRangeKm, onMap } from './radar.js';
import { delayMs, isRateLimited, nextBackoffS } from './polling.js';
import { TrailRecorder, mergeTrail } from './trails.js';
import { distanceKm } from './geo.js';
import {
  climbArrow, displayName, formatAltitude, formatDistance, formatSpeed,
} from './format.js';

const REFRESH_CHOICES_S = [5, 10, 30, 60, 120]; // the options in index.html
const DEFAULT_REFRESH_S = 30;
const REFRESH_KEY = 'flightmon.refresh';
// Home: Copenhagen. The dot on the map, the weather and the clock are for here;
// the Home button brings the map back to it at the default zoom.
const HOME = { lat: 55.6761, lon: 12.5683 };
const DEFAULT_RANGE_KM = 50; // from the map's middle to its nearest edge
const MAX_RANGE_KM = 463; // the feeds' limit
const VIEW_KEY = 'flightmon.view'; // where the map was left: { lat, lon, rangeKm }
const RAIN_KEY = 'flightmon.rain';
const WEATHER_REFRESH_MS = 15 * 60 * 1000; // Open-Meteo's current values change every 15 min
const RAIN_REFRESH_MS = 5 * 60 * 1000; // a new radar image every 10 min
const RAIN_STALE_S = 30 * 60;

const $ = (id) => document.getElementById(id);
const els = {
  home: $('home'),
  canvas: $('radar'),
  attribution: $('attribution'),
  clockTime: $('clock-time'),
  clockZone: $('clock-zone'),
  clockUtc: $('clock-utc'),
  weather: $('weather'),
  refresh: $('refresh'),
  refreshNow: $('refresh-now'),
  rainToggle: $('rain-toggle'),
  rainStatus: $('rain-status'),
  legend: $('legend'),
  details: $('details'),
  status: $('status'),
  rows: document.querySelector('#aircraft tbody'),
  empty: $('empty'),
};

const state = {
  view: { ...HOME, rangeKm: DEFAULT_RANGE_KM }, // the map's middle and zoom
  data: null, // last good /api/aircraft response
  lastOk: 0,
  refreshS: DEFAULT_REFRESH_S, // seconds between aircraft requests
  error: null,
  highlight: null, // hex of the aircraft under the pointer in the list
  selected: null, // the clicked aircraft, as last seen; its details are shown
  info: undefined, // adsbdb lookup for the selected aircraft (undefined while loading)
  track: undefined, // its path from OpenSky: { path } or { error } (undefined while loading)
  weather: null, // Open-Meteo's current weather at home (see weather.js)
  weatherError: null,
  weatherAt: 0, // when it was last asked for
  rainOn: true,
  rainFrame: null, // the latest radar image: { host, path, time }
  rainError: null,
  rainAt: 0,
};

const trails = new TrailRecorder(); // every aircraft's positions since the page opened

let lastView = null; // the radar's projection as last drawn, for clicks

// --- the map: home, wheel to zoom, drag to move ---------------------------------

// Where the map was left last time, or home.
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (v && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180 && v.rangeKm >= 1 && v.rangeKm <= MAX_RANGE_KM) {
      return { lat: v.lat, lon: v.lon, rangeKm: v.rangeKm };
    }
  } catch {
    // No storage (private window, blocked site data): start at home.
  }
  return { ...HOME, rangeKm: DEFAULT_RANGE_KM };
}

// A smaller window (or a saved map from a bigger one) can't show as far out.
function clampZoom() {
  const maxKm = maxRangeKm(els.canvas.clientWidth, els.canvas.clientHeight, MAX_RANGE_KM);
  if (state.view.rangeKm > maxKm) state.view = { ...state.view, rangeKm: maxKm };
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(state.view));
  } catch {
    // Not remembered.
  }
}

// The scale is set at home's latitude, so dragging north or south keeps it.
function currentView(rangeKm = state.view.rangeKm) {
  return mapView(state.view, rangeKm, els.canvas.clientWidth, els.canvas.clientHeight, HOME.lat);
}

// Once the map stops moving: remember it and fetch aircraft for what is shown.
let settleTimer = null;
function settle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    saveView();
    requestPoll();
  }, 400);
}

els.home.addEventListener('click', () => {
  state.view = { ...HOME, rangeKm: DEFAULT_RANGE_KM };
  zoomTarget = null;
  saveView();
  render();
  requestPoll();
});

// The range changes smoothly while scrolling (the exact value is kept here, the
// used one is rounded). The point under the mouse stays where it is.
let zoomTarget = null;
const roundRange = (km) => (km < 10 ? Math.round(km * 10) / 10 : Math.round(km));

// On the whole map section, so scrolling over the legend or credits zooms too.
els.canvas.parentElement.addEventListener('wheel', (event) => {
  event.preventDefault();
  // Pixels, lines or pages, depending on the device.
  const px = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 800 : 1);
  // Not further out than the feeds reach into the map's corners.
  const maxKm = maxRangeKm(els.canvas.clientWidth, els.canvas.clientHeight, MAX_RANGE_KM);
  zoomTarget ??= state.view.rangeKm;
  zoomTarget = Math.min(maxKm, Math.max(1, zoomTarget * Math.exp(px * 0.0015)));
  const rangeKm = Math.min(maxKm, roundRange(zoomTarget));
  if (rangeKm === state.view.rangeKm) return;
  const box = els.canvas.getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  const under = currentView().toLatLon(x, y);
  const after = currentView(rangeKm);
  const p = after.toScreen(under.lat, under.lon);
  state.view = { ...after.toLatLon(after.width / 2 + (p.x - x), after.height / 2 + (p.y - y)), rangeKm };
  render();
  settle();
}, { passive: false });

// Drag with the mouse button down. A press that moves less than 4 px is a click.
let drag = null; // { x, y, view, moved }
let dragged = false; // the click that ends a drag selects nothing
els.canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { x: event.clientX, y: event.clientY, view: currentView(), moved: false };
  els.canvas.setPointerCapture(event.pointerId);
});
els.canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  els.canvas.style.cursor = 'grabbing';
  const v = drag.view;
  state.view = { ...v.toLatLon(v.width / 2 - dx, v.height / 2 - dy), rangeKm: state.view.rangeKm };
  render();
});
function endDrag() {
  if (!drag) return;
  const { moved } = drag;
  drag = null;
  els.canvas.style.cursor = '';
  if (!moved) return;
  dragged = true;
  setTimeout(() => { dragged = false; }); // in case no click follows
  settle();
}
els.canvas.addEventListener('pointerup', endDrag);
els.canvas.addEventListener('pointercancel', endDrag);

// --- polling ----------------------------------------------------------------

let timer = null;
let inFlight = false;
let lastFetchAt = 0; // when the last request started
let wanted = false; // a request is due as soon as allowed (the map moved, ↻, …)
let backoffS = 0; // > 0 after the feeds refused for asking too often
let nextAt = 0; // when the next request is planned

// Plan the next request: the next refresh, or sooner when one is wanted, but
// never within 5 s of the last one and not before a back-off is over.
function schedule() {
  clearTimeout(timer);
  const now = Date.now();
  const d = delayMs({ now, lastAt: lastFetchAt, wanted, refreshS: state.refreshS, backoffS });
  nextAt = now + d;
  timer = setTimeout(poll, d);
}

// Ask for aircraft as soon as allowed (a request under way finishes first).
function requestPoll() {
  wanted = true;
  if (!inFlight) schedule();
}

async function poll() {
  clearTimeout(timer);
  timer = null;
  if (document.hidden) return; // resumes when the tab is shown again
  wanted = false;
  inFlight = true;
  lastFetchAt = Date.now();
  const { rangeKm } = state.view;
  const lat = state.view.lat.toFixed(4);
  const lon = state.view.lon.toFixed(4);
  // Out to the map's corners, within what the feeds allow.
  const radius = Math.min(MAX_RANGE_KM, Math.ceil(cornerRangeKm(rangeKm, els.canvas.clientWidth, els.canvas.clientHeight)));
  try {
    const res = await fetch(`/api/aircraft?lat=${lat}&lon=${lon}&radius=${radius}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body.failures ? ` (${body.failures.join('; ')})` : '';
      const err = new Error((body.error || `HTTP ${res.status}`) + detail);
      err.rateLimited = isRateLimited(res.status, body);
      throw err;
    }
    // Distances from home, wherever the map is; the list is sorted by them.
    state.data = fromHome(body);
    trails.record(body);
    state.lastOk = Date.now();
    state.error = null;
    backoffS = 0;
  } catch (err) {
    state.error = err.message;
    backoffS = err.rateLimited ? nextBackoffS(backoffS, state.refreshS) : 0;
  }
  inFlight = false;
  schedule(); // first, so the status can say when the next try is
  render();
}

function loadRefresh() {
  let saved = null;
  try {
    saved = Number(localStorage.getItem(REFRESH_KEY));
  } catch {
    // Default below.
  }
  state.refreshS = REFRESH_CHOICES_S.includes(saved) ? saved : DEFAULT_REFRESH_S;
  els.refresh.value = String(state.refreshS);
}

// Fetch now, or as soon as allowed (paths and the open details stay).
els.refreshNow.addEventListener('click', () => requestPoll());

// A new interval: fetch as soon as allowed, then keep to it.
els.refresh.addEventListener('change', () => {
  state.refreshS = Number(els.refresh.value);
  try {
    localStorage.setItem(REFRESH_KEY, String(state.refreshS));
  } catch {
    // Kept for this page only.
  }
  requestPoll();
});

// Don't poll in a background tab; catch up as soon as it's visible again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  requestPoll();
  refreshSlow();
});

// --- clock, weather and rain ------------------------------------------------

let weatherController = null;

async function loadWeather() {
  weatherController?.abort();
  const ctrl = (weatherController = new AbortController());
  const { lat, lon } = HOME;
  state.weatherAt = Date.now();
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
  renderRain(); // its time is shown in home's time zone
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
  if (Date.now() - state.weatherAt > WEATHER_REFRESH_MS) loadWeather();
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

// The time at home (once the weather has told us its time
// zone; the browser's until then), and UTC as aviation uses it.
function renderClock() {
  const { time, zone, utc } = clockParts(new Date(), state.weather?.timeZone);
  els.clockTime.textContent = time;
  els.clockZone.textContent = zone;
  // Only when it differs (not in London in winter, nor when the zone is UTC).
  els.clockUtc.textContent = time.startsWith(utc) ? '' : `· ${utc} UTC`;
}

function renderWeather() {
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
    accent: get('--accent'),
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

// The aircraft on the visible map (the list shows exactly these).
function aircraftOnMap() {
  if (!state.data) return [];
  const view = currentView();
  return state.data.aircraft.filter((ac) => onMap(view, ac));
}

// The feed's answer with distances from home, nearest first (rounded as the
// Worker rounds them; its own are from the map's middle).
function fromHome(body) {
  const aircraft = body.aircraft.map((ac) => ({
    ...ac,
    distKm: Number(distanceKm(HOME.lat, HOME.lon, ac.lat, ac.lon).toFixed(2)),
  }));
  aircraft.sort((a, b) => a.distKm - b.distKm);
  return { ...body, aircraft };
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
  const colors = cssColors();
  lastView = drawMap(ctx, {
    width,
    height,
    center: state.view,
    home: HOME,
    aircraft: aircraftOnMap(),
    rangeKm: state.view.rangeKm,
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
  const list = aircraftOnMap();
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
    );
    return tr;
  });
  els.rows.replaceChildren(...rows);
  els.empty.hidden = !state.data || list.length > 0;
  els.empty.textContent = 'No aircraft on the map right now.';
}

function showStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function renderStatus() {
  const busy = backoffS ? ` · feeds busy, next try in ${Math.max(0, Math.ceil((nextAt - Date.now()) / 1000))} s` : '';
  if (!state.data) {
    showStatus(state.error ? `Couldn't load aircraft: ${state.error}${busy}` : 'Loading aircraft…', Boolean(state.error));
    return;
  }
  const count = aircraftOnMap().length;
  const ago = Math.max(0, Math.round((Date.now() - state.lastOk) / 1000));
  // Stale when two refreshes have been missed (20 s at 5 s, 70 s at 30 s).
  const stale = Date.now() - state.lastOk > (2 * state.refreshS + 10) * 1000;
  const parts = [
    `${count} aircraft on the map`,
    `from ${state.data.source}`,
    `updated ${ago} s ago`,
  ];
  if (state.error) parts.push(`last attempt failed: ${state.error}`);
  showStatus(parts.join(' · ') + busy, stale || Boolean(state.error));
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
  const ac = hex && aircraftOnMap().find((a) => a.hex === hex);
  if (ac) select(ac);
});
els.rows.addEventListener('mouseleave', () => {
  state.highlight = null;
  for (const tr of els.rows.children) tr.classList.remove('highlight');
  drawCanvas();
});

// Click an aircraft on the map for its details; click elsewhere to close them.
function aircraftAt(event) {
  if (!lastView) return null;
  return hitTest(lastView, aircraftOnMap(), event.offsetX, event.offsetY);
}
els.canvas.addEventListener('click', (event) => {
  if (dragged) {
    dragged = false;
    return;
  }
  const ac = aircraftAt(event);
  if (ac) select(ac);
  else deselect();
});
els.canvas.addEventListener('mousemove', (event) => {
  if (drag?.moved) return;
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
loadRefresh();
renderRain();
renderLegend();
// A new size shows more or less of the map, so the list changes too.
new ResizeObserver(() => {
  clampZoom();
  render();
}).observe(els.canvas);
setInterval(renderStatus, 1000);
// Tick just after each whole second, so the clock doesn't lag behind.
(function tick() {
  renderClock();
  setTimeout(tick, 1005 - (Date.now() % 1000));
})();
setInterval(refreshSlow, 60 * 1000);
refreshSlow();

// --- start ------------------------------------------------------------------

// Old addresses carried ?lat=&lon=&range=; the map's position is in the browser now.
if (window.location.search) history.replaceState(null, '', window.location.pathname);
state.view = loadView();
clampZoom();
render();
requestPoll();
loadWeather();
