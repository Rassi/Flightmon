/* Flightmon — a flight radar for a spare screen.
 *
 * Plain ES5 on purpose: no build step, and it runs on the Safari of an
 * old iPad (iOS 9 and up). No let/const, arrows, template strings, fetch,
 * Object.assign, Number.isFinite or Math.log2 below this line.
 */
(function () {
  'use strict';

  // --- settings ------------------------------------------------------------

  var STORAGE_KEY = 'flightmon.settings';
  var DEFAULTS = {
    lat: null,
    lon: null,
    radius: 25,          // nautical miles; the APIs want nm
    units: 'aviation',
    basemap: 'dark',
    refresh: 5,          // seconds
    sweep: true,
    labels: true,
    trails: true,
    clock24: true,
    demo: false
  };

  var settings = extend({}, DEFAULTS);

  function extend(target, source) {
    for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = source[k];
    return target;
  }

  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function store() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) { /* private mode: settings last until the tab closes */ }
  }

  // ?lat=55.68&lon=12.57&radius=25&units=metric&demo=1 — easier than typing on a 2012 iPad.
  function readQuery() {
    var out = {};
    var q = window.location.search.replace(/^\?/, '');
    if (!q) return out;
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var key = decodeURIComponent(kv[0]);
      var value = kv.length > 1 ? decodeURIComponent(kv[1].replace(/\+/g, ' ')) : '1';
      if (!(key in DEFAULTS)) continue;
      out[key] = coerce(key, value);
    }
    return out;
  }

  function coerce(key, value) {
    if (typeof DEFAULTS[key] === 'boolean') return value === '1' || value === 'true' || value === 'on';
    if (key === 'lat' || key === 'lon' || key === 'radius' || key === 'refresh') {
      var n = parseFloat(value);
      return isFinite(n) ? n : DEFAULTS[key];
    }
    return value;
  }

  function hasLocation() {
    return typeof settings.lat === 'number' && typeof settings.lon === 'number' &&
      isFinite(settings.lat) && isFinite(settings.lon);
  }

  // --- units ---------------------------------------------------------------

  var UNITS = {
    aviation: { dist: 'nm', perNm: 1, speed: 'kt', perKt: 1, alt: 'ft', perFt: 1, vrate: 'fpm', perFpm: 1 },
    metric: { dist: 'km', perNm: 1.852, speed: 'km/h', perKt: 1.852, alt: 'm', perFt: 0.3048, vrate: 'm/s', perFpm: 0.00508 },
    imperial: { dist: 'mi', perNm: 1.15078, speed: 'mph', perKt: 1.15078, alt: 'ft', perFt: 1, vrate: 'fpm', perFpm: 1 }
  };

  function unit() { return UNITS[settings.units] || UNITS.aviation; }

  function thousands(n) {
    var s = String(Math.round(Math.abs(n)));
    var out = '';
    while (s.length > 3) {
      out = ',' + s.slice(-3) + out;
      s = s.slice(0, -3);
    }
    return (n < 0 ? '-' : '') + s + out;
  }

  function fmtAlt(a) {
    if (a.ground) return 'Ground';
    if (a.alt === null) return '–';
    var u = unit();
    var v = a.alt * u.perFt;
    return thousands(u.alt === 'm' ? Math.round(v / 10) * 10 : Math.round(v / 25) * 25) + ' ' + u.alt;
  }

  // Radar label: a datablock — hundreds of feet in aviation/imperial, metres otherwise.
  function shortAlt(a) {
    if (a.ground) return 'GND';
    if (a.alt === null) return '';
    if (unit().alt === 'm') return thousands(Math.round(a.alt * 0.3048 / 100) * 100) + 'm';
    var h = Math.round(a.alt / 100);
    return (h < 10 ? '00' : h < 100 ? '0' : '') + h;
  }

  function fmtSpeed(kt) {
    if (kt === null || kt === undefined) return '–';
    return Math.round(kt * unit().perKt) + ' ' + unit().speed;
  }

  function fmtDist(nm) {
    var v = nm * unit().perNm;
    return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + ' ' + unit().dist;
  }

  function fmtVrate(fpm) {
    if (fpm === null || fpm === undefined || Math.abs(fpm) < 100) return 'Level';
    var u = unit();
    var v = fpm * u.perFpm;
    var arrow = fpm > 0 ? '▲ ' : '▼ ';
    return arrow + (u.vrate === 'm/s' ? Math.abs(v).toFixed(1) : thousands(Math.abs(Math.round(v / 50) * 50))) + ' ' + u.vrate;
  }

  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compass(deg) { return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // --- geography -----------------------------------------------------------

  var RAD = Math.PI / 180;

  function distanceNm(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * RAD;
    var dLon = (lon2 - lon1) * RAD;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    var y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
    var x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
      Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // Short hops only (dead reckoning between polls), so flat-earth is plenty.
  function moveBy(lat, lon, trackDeg, nm) {
    return {
      lat: lat + nm * Math.cos(trackDeg * RAD) / 60,
      lon: lon + nm * Math.sin(trackDeg * RAD) / (60 * Math.cos(lat * RAD))
    };
  }

  // Web Mercator world pixels at zoom z, 256 px tiles.
  function worldX(lon, z) { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
  function worldY(lat, z) {
    var s = Math.sin(lat * RAD);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
  }

  // --- networking ----------------------------------------------------------

  function getJson(url, cb) {
    var done = false;
    var xhr = new XMLHttpRequest();
    function finish(err, data) {
      if (done) return;
      done = true;
      cb(err, data);
    }
    xhr.open('GET', url, true);
    xhr.timeout = 12000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        var data;
        try { data = JSON.parse(xhr.responseText); } catch (e) { return finish(e); }
        finish(null, data);
      } else {
        var msg = 'HTTP ' + xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) { /* not json */ }
        finish(new Error(xhr.status ? msg : 'no connection'));
      }
    };
    xhr.ontimeout = function () { finish(new Error('timed out')); };
    xhr.send();
  }

  function qs(params) {
    var parts = [];
    for (var k in params) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    return parts.join('&');
  }

  // --- aircraft state ------------------------------------------------------

  var tracks = {};          // hex -> { a, t0, trail, lastSeen }
  var selectedHex = null;
  var feed = { source: '', error: null, updated: 0, count: 0, loading: false };
  var serverAvailable = true;
  var pollTimer = null;

  function ingest(list, now) {
    var seenNow = {};
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      seenNow[a.hex] = true;
      var t = tracks[a.hex];
      if (!t) t = tracks[a.hex] = { trail: [] };
      t.a = a;
      t.t0 = now - (a.seen || 0) * 1000; // when the reported position was true
      t.lastSeen = now;
      var last = t.trail[t.trail.length - 1];
      if (!last || last.lat !== a.lat || last.lon !== a.lon) {
        t.trail.push({ lat: a.lat, lon: a.lon });
        if (t.trail.length > 60) t.trail.shift();
      }
    }
    // Keep a plane through one missed poll, so a flaky provider doesn't make it blink.
    for (var hex in tracks) {
      if (!seenNow[hex] && now - tracks[hex].lastSeen > settings.refresh * 2000 + 4000) {
        delete tracks[hex];
        if (hex === selectedHex) select(null);
      }
    }
  }

  // Where a plane is now, extrapolated from its last report.
  function position(t, now) {
    var a = t.a;
    if (a.ground || a.gs === null || a.track === null) return { lat: a.lat, lon: a.lon };
    var secs = Math.min(30, Math.max(0, (now - t.t0) / 1000));
    return moveBy(a.lat, a.lon, a.track, a.gs * secs / 3600);
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, settings.refresh * 1000);
    if (!hasLocation() || feed.loading) return;
    if (settings.demo || !serverAvailable) {
      ingest(demo.step(), Date.now());
      feed.source = serverAvailable ? 'demo traffic' : 'demo traffic (no server found)';
      feed.error = null;
      feed.updated = Date.now();
      afterPoll();
      return;
    }
    feed.loading = true;
    getJson('api/aircraft?' + qs({ lat: settings.lat.toFixed(4), lon: settings.lon.toFixed(4), dist: Math.ceil(settings.radius * 1.1) }), function (err, data) {
      feed.loading = false;
      if (err) {
        feed.error = err.message;
      } else {
        feed.error = null;
        feed.source = data.source;
        feed.updated = Date.now();
        ingest(data.aircraft || [], Date.now());
      }
      afterPoll();
    });
  }

  function afterPoll() {
    renderList();
    renderDetail();
    renderStatus();
  }

  // --- demo traffic ----------------------------------------------------------

  var demo = (function () {
    var planes = null;
    var CALLS = ['SAS', 'DLH', 'KLM', 'BAW', 'NAX', 'AFR', 'FIN', 'RYR', 'EZY', 'UAE', 'THY', 'ICE', 'LOT', 'AUA', 'SWR', 'WZZ'];
    var TYPES = [['A20N', 'AIRBUS A-320neo'], ['B738', 'BOEING 737-800'], ['A321', 'AIRBUS A-321'],
      ['E195', 'EMBRAER ERJ-195'], ['B77W', 'BOEING 777-300ER'], ['AT76', 'ATR 72-600'], ['CRJ9', 'BOMBARDIER CRJ-900'], ['A359', 'AIRBUS A-350-900']];
    var last = 0;

    function rand(a, b) { return a + Math.random() * (b - a); }

    function spawn(i, anywhere) {
      var r = settings.radius * (anywhere ? Math.sqrt(Math.random()) : 1);
      var b = rand(0, 360);
      var p = moveBy(settings.lat, settings.lon, b, r);
      var type = TYPES[i % TYPES.length];
      var climbing = Math.random();
      var alt = Math.round(rand(1500, 39000) / 100) * 100;
      return {
        hex: (0x4a0000 + i * 977 + Math.floor(rand(0, 900))).toString(16),
        callsign: CALLS[i % CALLS.length] + Math.floor(rand(10, 9999)),
        reg: 'OY-' + String.fromCharCode(65 + i % 26) + String.fromCharCode(65 + (i * 7) % 26) + String.fromCharCode(65 + (i * 3) % 26),
        type: type[0],
        desc: type[1],
        owner: null,
        lat: p.lat,
        lon: p.lon,
        alt: alt,
        ground: false,
        gs: Math.round(alt < 10000 ? rand(160, 280) : rand(380, 490)),
        // Arrivals from the edge head roughly inward.
        track: anywhere ? rand(0, 360) : (b + 180 + rand(-50, 50)) % 360,
        vrate: climbing < 0.25 ? Math.round(rand(800, 2500)) : climbing < 0.5 ? -Math.round(rand(800, 2000)) : 0,
        squawk: String(1000 + Math.floor(rand(0, 6000))),
        emergency: null,
        military: i === 9,
        category: 'A3',
        seen: 0
      };
    }

    return {
      reset: function () { planes = null; },
      step: function () {
        var now = Date.now();
        if (!planes) {
          planes = [];
          for (var i = 0; i < 18; i++) planes.push(spawn(i, true));
          last = now;
        }
        var dt = (now - last) / 1000;
        last = now;
        for (var j = 0; j < planes.length; j++) {
          var a = planes[j];
          var p = moveBy(a.lat, a.lon, a.track, a.gs * dt / 3600);
          a.lat = p.lat;
          a.lon = p.lon;
          a.alt = Math.max(500, Math.min(41000, a.alt + a.vrate * dt / 60));
          if (Math.random() < 0.05) a.track = (a.track + rand(-15, 15) + 360) % 360;
          if (distanceNm(settings.lat, settings.lon, a.lat, a.lon) > settings.radius * 1.1) planes[j] = spawn(j, false);
        }
        return planes.map(function (x) { return extend({}, x); });
      },
      route: function (a) {
        var ports = [['CPH', 'Copenhagen'], ['ARN', 'Stockholm'], ['OSL', 'Oslo'], ['LHR', 'London'], ['FRA', 'Frankfurt'],
          ['AMS', 'Amsterdam'], ['CDG', 'Paris'], ['HEL', 'Helsinki'], ['DXB', 'Dubai'], ['IST', 'Istanbul']];
        var n = parseInt(a.hex, 16);
        var from = ports[n % ports.length];
        var to = ports[(n + 3) % ports.length];
        return {
          airline: a.callsign.slice(0, 3),
          from: { iata: from[0], city: from[1] },
          to: { iata: to[0], city: to[1] },
          via: [],
          plausible: true
        };
      }
    };
  }());

  // --- radar drawing ---------------------------------------------------------

  var canvas = document.getElementById('radar');
  var ctx = canvas.getContext('2d');
  var base = document.createElement('canvas');   // map + rings, redrawn only when the view changes
  var baseCtx = base.getContext('2d');
  var view = null;
  var baseDirty = true;
  var tiles = {};
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  var TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png';
  var ATTRIBUTION = '© OpenStreetMap contributors © CARTO';

  function computeView() {
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return null;
    var r = Math.min(w, h) / 2 - 18;
    var mpp = settings.radius * 1852 / r;                       // metres per CSS pixel we want
    var ground = 156543.03392 * Math.cos(settings.lat * RAD);   // metres per pixel at zoom 0
    var z = Math.max(1, Math.min(18, Math.floor(Math.log(ground / mpp) / Math.LN2)));
    return {
      w: w, h: h, cx: w / 2, cy: h / 2, r: r, z: z,
      scale: ground / Math.pow(2, z) / mpp,                     // CSS px per world px at zoom z (1–2)
      wx: worldX(settings.lon, z),
      wy: worldY(settings.lat, z),
      pxPerNm: r / settings.radius
    };
  }

  function project(lat, lon) {
    return {
      x: view.cx + (worldX(lon, view.z) - view.wx) * view.scale,
      y: view.cy + (worldY(lat, view.z) - view.wy) * view.scale
    };
  }

  function resize() {
    canvas.width = Math.round(canvas.clientWidth * DPR);
    canvas.height = Math.round(canvas.clientHeight * DPR);
    base.width = canvas.width;
    base.height = canvas.height;
    view = hasLocation() ? computeView() : null;
    baseDirty = true;
  }

  function tile(z, x, y) {
    var n = Math.pow(2, z);
    var key = z + '/' + x + '/' + y;
    if (tiles[key]) return tiles[key];
    var img = new Image();
    img.onload = function () { img.ready = true; baseDirty = true; };
    img.onerror = function () { img.failed = true; };
    img.src = TILE_URL
      .replace('{s}', 'abcd'.charAt((x + y) % 4))
      .replace('{z}', z)
      .replace('{x}', ((x % n) + n) % n)
      .replace('{y}', y)
      .replace('{r}', DPR > 1 ? '@2x' : '');
    tiles[key] = img;
    return img;
  }

  function drawBase() {
    var c = baseCtx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.fillStyle = '#05080b';
    c.fillRect(0, 0, view.w, view.h);

    c.save();
    c.beginPath();
    c.arc(view.cx, view.cy, view.r, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#0a1016';
    c.fillRect(0, 0, view.w, view.h);

    if (settings.basemap !== 'none') {
      var size = 256 * view.scale;
      var left = view.wx - view.cx / view.scale;
      var top = view.wy - view.cy / view.scale;
      var x0 = Math.floor(left / 256);
      var y0 = Math.floor(top / 256);
      var x1 = Math.floor((left + view.w / view.scale) / 256);
      var y1 = Math.floor((top + view.h / view.scale) / 256);
      var max = Math.pow(2, view.z) - 1;
      for (var x = x0; x <= x1; x++) {
        for (var y = Math.max(0, y0); y <= Math.min(max, y1); y++) {
          var img = tile(view.z, x, y);
          if (!img.ready) continue;
          // +0.5 px overlap hides the hairline seams some browsers draw between tiles.
          c.drawImage(img, view.cx + (x * 256 - view.wx) * view.scale, view.cy + (y * 256 - view.wy) * view.scale, size + 0.5, size + 0.5);
        }
      }
      // Calm the map down so the traffic stands out.
      c.fillStyle = 'rgba(5, 10, 14, 0.35)';
      c.fillRect(0, 0, view.w, view.h);
    }
    c.restore();

    // Range rings at round numbers in the chosen unit.
    var u = unit();
    var rangeDisp = settings.radius * u.perNm;
    var step = niceStep(rangeDisp / 4);
    c.strokeStyle = 'rgba(78, 224, 138, 0.22)';
    c.fillStyle = 'rgba(78, 224, 138, 0.6)';
    c.lineWidth = 1;
    c.font = '11px -apple-system, Helvetica, Arial, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (var d = step; d < rangeDisp * 0.999; d += step) {
      var rr = d / u.perNm * view.pxPerNm;
      c.beginPath();
      c.arc(view.cx, view.cy, rr, 0, Math.PI * 2);
      c.stroke();
      c.fillText(trimNum(d) + ' ' + u.dist, view.cx + rr * 0.7071 + 4, view.cy - rr * 0.7071 - 4);
    }

    // Outer edge with degree ticks and the cardinal points.
    c.strokeStyle = 'rgba(78, 224, 138, 0.5)';
    c.beginPath();
    c.arc(view.cx, view.cy, view.r, 0, Math.PI * 2);
    c.stroke();
    for (var deg = 0; deg < 360; deg += 10) {
      var a = (deg - 90) * RAD;
      var len = deg % 90 === 0 ? 12 : deg % 30 === 0 ? 8 : 4;
      c.beginPath();
      c.moveTo(view.cx + Math.cos(a) * view.r, view.cy + Math.sin(a) * view.r);
      c.lineTo(view.cx + Math.cos(a) * (view.r - len), view.cy + Math.sin(a) * (view.r - len));
      c.stroke();
    }
    c.fillStyle = 'rgba(78, 224, 138, 0.85)';
    c.font = '600 13px -apple-system, Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    var labels = ['N', 'E', 'S', 'W'];
    for (var k = 0; k < 4; k++) {
      var ang = (k * 90 - 90) * RAD;
      c.fillText(labels[k], view.cx + Math.cos(ang) * (view.r - 24), view.cy + Math.sin(ang) * (view.r - 24));
    }

    // Home.
    c.strokeStyle = '#4ee08a';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(view.cx - 6, view.cy); c.lineTo(view.cx + 6, view.cy);
    c.moveTo(view.cx, view.cy - 6); c.lineTo(view.cx, view.cy + 6);
    c.stroke();
  }

  function niceStep(x) {
    var p = Math.pow(10, Math.floor(Math.log(x) / Math.LN10));
    var f = x / p;
    return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * p;
  }

  function trimNum(n) { return String(Math.round(n * 10) / 10); }

  // Altitude colour, ground → 40,000 ft: orange, yellow, green, cyan, blue, violet.
  function altColor(a, alpha) {
    if (a.emergency) return 'rgba(255, 77, 77, ' + alpha + ')';
    if (a.ground) return 'rgba(150, 160, 170, ' + alpha + ')';
    if (a.alt === null) return 'rgba(200, 200, 200, ' + alpha + ')';
    var f = Math.max(0, Math.min(1, a.alt / 40000));
    var hue = Math.round(25 + Math.pow(f, 0.8) * 265);
    return 'hsla(' + hue + ', 90%, 60%, ' + alpha + ')';
  }

  function drawPlane(c, x, y, track, size, color) {
    c.save();
    c.translate(x, y);
    c.rotate((track || 0) * RAD);
    c.scale(size / 20, size / 20);
    c.beginPath();
    // A plain airliner silhouette, nose up, 20 units tall.
    c.moveTo(0, -10);
    c.lineTo(1.6, -7); c.lineTo(1.6, -2.5); c.lineTo(9, 2); c.lineTo(9, 3.8); c.lineTo(1.6, 1.6);
    c.lineTo(1.4, 6.5); c.lineTo(4, 8.6); c.lineTo(4, 10); c.lineTo(0, 9);
    c.lineTo(-4, 10); c.lineTo(-4, 8.6); c.lineTo(-1.4, 6.5); c.lineTo(-1.6, 1.6);
    c.lineTo(-9, 3.8); c.lineTo(-9, 2); c.lineTo(-1.6, -2.5); c.lineTo(-1.6, -7);
    c.closePath();
    c.fillStyle = color;
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    c.stroke();
    c.restore();
  }

  var SWEEP_MS = 4000;
  var lastFrame = 0;
  var hitList = [];

  function frame(ts) {
    requestFrame(frame);
    var minGap = settings.sweep ? 33 : 250;
    if (ts - lastFrame < minGap) return;
    lastFrame = ts;
    if (!view) return;
    if (baseDirty) {
      baseDirty = false;
      drawBase();
    }

    var now = Date.now();
    var c = ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(base, 0, 0);
    c.setTransform(DPR, 0, 0, DPR, 0, 0);

    c.save();
    c.beginPath();
    c.arc(view.cx, view.cy, view.r, 0, Math.PI * 2);
    c.clip();

    var sweepAngle = (now % SWEEP_MS) / SWEEP_MS * 360;  // compass degrees
    if (settings.sweep) drawSweep(c, sweepAngle);

    var size = Math.max(14, Math.min(26, view.r / 18));
    var selectedPos = null;
    hitList = [];

    for (var hex in tracks) {
      var t = tracks[hex];
      var a = t.a;
      var p = position(t, now);
      var s = project(p.lat, p.lon);
      var selected = hex === selectedHex;

      if (settings.trails || selected) drawTrail(c, t, s, a, selected);

      // A blip brightens as the sweep passes over it, then fades.
      var glow = 0;
      if (settings.sweep) {
        var behind = (sweepAngle - bearing(settings.lat, settings.lon, p.lat, p.lon) + 360) % 360;
        glow = Math.max(0, 1 - behind / 120);
      }
      if (glow > 0) {
        c.beginPath();
        c.arc(s.x, s.y, size * (0.7 + glow * 0.3), 0, Math.PI * 2);
        c.fillStyle = altColor(a, 0.18 * glow);
        c.fill();
      }
      if (a.emergency && Math.floor(now / 500) % 2) {
        c.beginPath();
        c.arc(s.x, s.y, size * 1.1, 0, Math.PI * 2);
        c.strokeStyle = 'rgba(255, 77, 77, 0.9)';
        c.lineWidth = 2;
        c.stroke();
      }

      drawPlane(c, s.x, s.y, a.track, size, altColor(a, 1));
      if (selected) selectedPos = s;

      if (settings.labels || selected) {
        c.font = '600 12px -apple-system, Helvetica, Arial, sans-serif';
        c.textAlign = 'left';
        c.textBaseline = 'alphabetic';
        c.fillStyle = selected ? '#ffffff' : 'rgba(216, 227, 234, 0.9)';
        c.fillText(a.callsign || a.reg || a.hex.toUpperCase(), s.x + size * 0.7, s.y - 2);
        c.font = '11px -apple-system, Helvetica, Arial, sans-serif';
        c.fillStyle = 'rgba(125, 141, 153, 0.95)';
        var arrow = a.vrate > 300 ? '↑' : a.vrate < -300 ? '↓' : '';
        c.fillText(shortAlt(a) + arrow, s.x + size * 0.7, s.y + 11);
      }
      hitList.push({ hex: hex, x: s.x, y: s.y });
    }

    if (selectedPos) {
      c.beginPath();
      c.arc(selectedPos.x, selectedPos.y, size * 1.05, 0, Math.PI * 2);
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.5;
      c.stroke();
      drawDestination(c, selectedPos);
    }
    c.restore();
  }

  function drawSweep(c, angle) {
    var steps = 24;
    var spread = 60;
    for (var i = 0; i < steps; i++) {
      var a0 = (angle - spread * (i + 1) / steps - 90) * RAD;
      var a1 = (angle - spread * i / steps - 90) * RAD;
      c.beginPath();
      c.moveTo(view.cx, view.cy);
      c.arc(view.cx, view.cy, view.r, a0, a1 + 0.01);
      c.closePath();
      c.fillStyle = 'rgba(78, 224, 138, ' + (0.13 * Math.pow(1 - i / steps, 2)) + ')';
      c.fill();
    }
    var lead = (angle - 90) * RAD;
    c.beginPath();
    c.moveTo(view.cx, view.cy);
    c.lineTo(view.cx + Math.cos(lead) * view.r, view.cy + Math.sin(lead) * view.r);
    c.strokeStyle = 'rgba(78, 224, 138, 0.55)';
    c.lineWidth = 1.5;
    c.stroke();
  }

  function drawTrail(c, t, s, a, selected) {
    if (t.trail.length < 1) return;
    c.beginPath();
    var first = project(t.trail[0].lat, t.trail[0].lon);
    c.moveTo(first.x, first.y);
    for (var i = 1; i < t.trail.length; i++) {
      var q = project(t.trail[i].lat, t.trail[i].lon);
      c.lineTo(q.x, q.y);
    }
    c.lineTo(s.x, s.y);
    c.strokeStyle = altColor(a, selected ? 0.8 : 0.35);
    c.lineWidth = selected ? 2 : 1.5;
    c.stroke();
  }

  function drawDestination(c, from) {
    var r = routes[routeKey(selectedTrack())];
    if (!r || !r.to || typeof r.to.lat !== 'number') return;
    var to = project(r.to.lat, r.to.lon);
    if (c.setLineDash) c.setLineDash([4, 6]);
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(to.x, to.y);
    c.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    c.lineWidth = 1.5;
    c.stroke();
    if (c.setLineDash) c.setLineDash([]);
  }

  var requestFrame = window.requestAnimationFrame || window.webkitRequestAnimationFrame ||
    function (fn) { return setTimeout(function () { fn(Date.now()); }, 33); };

  // --- side panel ------------------------------------------------------------

  var listEl = document.getElementById('list');
  var detailEl = document.getElementById('detail');
  var statusEl = document.getElementById('status');

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined && txt !== null) e.textContent = txt;
    return e;
  }

  function sortedTracks() {
    var now = Date.now();
    var out = [];
    for (var hex in tracks) {
      var t = tracks[hex];
      var p = position(t, now);
      out.push({ t: t, dist: distanceNm(settings.lat, settings.lon, p.lat, p.lon), brg: bearing(settings.lat, settings.lon, p.lat, p.lon) });
    }
    out.sort(function (x, y) { return x.dist - y.dist; });
    return out;
  }

  function renderList() {
    var rows = sortedTracks();
    document.getElementById('nearby-count').textContent = rows.length ? String(rows.length) : '';
    listEl.innerHTML = '';
    if (!rows.length) {
      var empty = el('li', 'empty', hasLocation() ? (feed.error ? 'No data right now.' : 'Nothing in range.') : 'Set your location in Settings.');
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < Math.min(rows.length, 40); i++) {
      var row = rows[i];
      var a = row.t.a;
      var li = el('li', (a.hex === selectedHex ? 'selected' : '') + (a.emergency ? ' alert' : ''));
      li.setAttribute('data-hex', a.hex);
      var sw = el('span', 'swatch');
      sw.style.background = altColor(a, 1);
      li.appendChild(sw);
      var main = el('div', 'main');
      main.appendChild(el('div', 'callsign', a.callsign || a.reg || a.hex.toUpperCase()));
      var r = routes[routeKey(row.t)];
      var sub = r && r.from && r.to ? (r.from.iata || r.from.icao) + ' → ' + (r.to.iata || r.to.icao) + ' · ' : '';
      main.appendChild(el('div', 'sub', sub + (a.type || '') + (a.reg ? ' · ' + a.reg : '') + (a.emergency ? ' · ' + a.emergency.toUpperCase() : '')));
      li.appendChild(main);
      var nums = el('div', 'nums');
      var b = el('b', null, fmtAlt(a));
      nums.appendChild(b);
      nums.appendChild(el('div', null, fmtDist(row.dist) + ' ' + compass(row.brg)));
      li.appendChild(nums);
      listEl.appendChild(li);
    }
  }

  listEl.addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== listEl && !node.getAttribute('data-hex')) node = node.parentNode;
    if (node && node !== listEl) select(node.getAttribute('data-hex'));
  });

  // Routes and photos are looked up once per flight and kept.
  var routes = {};
  var photos = {};

  function routeKey(t) { return t && t.a.callsign ? t.a.callsign : null; }
  function selectedTrack() { return selectedHex ? tracks[selectedHex] : null; }

  function select(hex) {
    selectedHex = hex && tracks[hex] ? hex : null;
    var t = selectedTrack();
    if (t) lookup(t);
    renderDetail();
    renderList();
  }

  function lookup(t) {
    var a = t.a;
    var key = routeKey(t);
    if (key && !(key in routes)) {
      routes[key] = null;
      if (settings.demo || !serverAvailable) {
        routes[key] = demo.route(a);
      } else {
        getJson('api/route?' + qs({ callsign: key, lat: a.lat.toFixed(3), lon: a.lon.toFixed(3) }), function (err, data) {
          if (err) { delete routes[key]; return; }
          routes[key] = data.route;
          renderDetail();
          renderList();
        });
      }
    }
    if (!(a.hex in photos) && !settings.demo && serverAvailable) {
      photos[a.hex] = null;
      getJson('api/photo?' + qs({ hex: a.hex }), function (err, data) {
        if (err) { delete photos[a.hex]; return; }
        photos[a.hex] = data.photo;
        renderDetail();
      });
    }
  }

  function fact(parent, k, v) {
    var f = el('div', 'fact');
    f.appendChild(el('div', 'k', k));
    f.appendChild(el('div', 'v', v));
    parent.appendChild(f);
  }

  function renderDetail() {
    var t = selectedTrack();
    if (!t) {
      detailEl.className = 'is-hidden';
      detailEl.innerHTML = '';
      return;
    }
    var a = t.a;
    var now = Date.now();
    var p = position(t, now);
    var r = routes[routeKey(t)];
    var photo = photos[a.hex];
    detailEl.className = '';
    detailEl.innerHTML = '';

    if (photo) {
      var ph = el('div', 'photo');
      ph.style.backgroundImage = 'url("' + photo.src.replace(/"/g, '%22') + '")';
      if (photo.photographer) ph.appendChild(el('div', 'credit', '© ' + photo.photographer + ' / planespotters.net'));
      detailEl.appendChild(ph);
    }

    var close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.onclick = function () { select(null); };
    detailEl.appendChild(close);

    detailEl.appendChild(el('div', 'title' + (a.emergency ? ' alert' : ''), a.callsign || a.reg || a.hex.toUpperCase()));

    if (r && r.from && r.to) {
      var route = el('div', 'route');
      route.appendChild(el('span', null, r.from.iata || r.from.icao));
      route.appendChild(el('span', 'arrow', '→'));
      route.appendChild(el('span', null, r.to.iata || r.to.icao));
      detailEl.appendChild(route);
      var cities = (r.from.city || r.from.name || '') + ' to ' + (r.to.city || r.to.name || '');
      if (!r.plausible) cities += ' (route may be out of date)';
      detailEl.appendChild(el('div', 'route-cities', cities));
    }

    var what = [a.desc || a.type, a.reg, a.owner].filter(function (x) { return x; }).join(' · ');
    if (what) detailEl.appendChild(el('div', 'muted', what));
    if (a.emergency) detailEl.appendChild(el('div', 'title alert', 'Squawking ' + a.squawk + ' — ' + a.emergency));

    var facts = el('div', 'facts');
    fact(facts, 'Altitude', fmtAlt(a));
    fact(facts, 'Speed', fmtSpeed(a.gs));
    fact(facts, 'Vertical', fmtVrate(a.vrate));
    fact(facts, 'Distance', fmtDist(distanceNm(settings.lat, settings.lon, p.lat, p.lon)));
    fact(facts, 'Bearing', Math.round(bearing(settings.lat, settings.lon, p.lat, p.lon)) + '° ' + compass(bearing(settings.lat, settings.lon, p.lat, p.lon)));
    fact(facts, 'Heading', a.track === null ? '–' : Math.round(a.track) + '°');
    fact(facts, 'Squawk', a.squawk || '–');
    fact(facts, 'Hex', a.hex.toUpperCase());
    fact(facts, 'Type', a.type || '–');
    detailEl.appendChild(facts);
  }

  function renderStatus() {
    statusEl.innerHTML = '';
    if (!hasLocation()) {
      statusEl.appendChild(el('div', null, 'No location set'));
      return;
    }
    var n = 0;
    for (var k in tracks) n++;
    statusEl.appendChild(el('div', null, n + ' aircraft · ' + fmtDist(settings.radius) + ' range'));
    if (feed.error) {
      statusEl.appendChild(el('div', 'error', 'Feed: ' + feed.error));
    } else if (feed.source) {
      var ago = Math.round((Date.now() - feed.updated) / 1000);
      statusEl.appendChild(el('div', null, feed.source + (ago > settings.refresh * 3 ? ' · ' + ago + ' s ago' : '')));
    }
  }

  function renderLegend() {
    var legend = document.getElementById('legend');
    legend.innerHTML = '';
    var stops = [];
    for (var i = 0; i <= 8; i++) stops.push(altColor({ alt: i * 5000, ground: false }, 1));
    var bar = el('span', 'bar');
    bar.style.background = '-webkit-linear-gradient(left, ' + stops.join(', ') + ')';
    bar.style.background = 'linear-gradient(to right, ' + stops.join(', ') + ')';
    legend.appendChild(el('span', null, '0'));
    legend.appendChild(bar);
    legend.appendChild(el('span', null, unit().alt === 'm' ? '12,000 m' : '40,000 ft'));
    document.getElementById('attribution').textContent = settings.basemap === 'none' ? '' : ATTRIBUTION;
  }

  // --- clock & weather -------------------------------------------------------

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function tickClock() {
    var d = new Date();
    var h = d.getHours();
    var suffix = '';
    if (!settings.clock24) {
      suffix = h < 12 ? ' am' : ' pm';
      h = h % 12 || 12;
    }
    document.getElementById('clock-time').textContent = (settings.clock24 ? pad2(h) : h) + ':' + pad2(d.getMinutes());
    document.getElementById('clock-sec').textContent = pad2(d.getSeconds()) + suffix;
    document.getElementById('clock-date').textContent = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (d.getSeconds() % 5 === 0) renderStatus();
  }

  var WMO = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail'
  };

  var weatherTimer = null;

  // Open-Meteo allows browser requests and needs no key, so this skips the server.
  function loadWeather() {
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(loadWeather, 15 * 60 * 1000);
    var box = document.getElementById('weather');
    if (!hasLocation()) { box.innerHTML = ''; box.className = 'is-hidden'; return; }
    var u = settings.units;
    var url = 'https://api.open-meteo.com/v1/forecast?' + qs({
      latitude: settings.lat.toFixed(3),
      longitude: settings.lon.toFixed(3),
      current: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover',
      daily: 'sunrise,sunset',
      timezone: 'auto',
      forecast_days: 1,
      temperature_unit: u === 'imperial' ? 'fahrenheit' : 'celsius',
      wind_speed_unit: u === 'aviation' ? 'kn' : u === 'imperial' ? 'mph' : 'kmh'
    });
    getJson(url, function (err, data) {
      if (err || !data.current) {
        if (!box.firstChild) box.className = 'is-hidden';
        return;
      }
      var c = data.current;
      box.className = 'muted';
      var wind = u === 'aviation' ? 'kt' : u === 'imperial' ? 'mph' : 'km/h';
      box.innerHTML = '';
      box.appendChild(el('div', 'temp', Math.round(c.temperature_2m) + '°'));
      var lines = el('div', 'lines');
      lines.appendChild(el('div', null, (WMO[c.weather_code] || '') + ' · ' + c.cloud_cover + '% cloud'));
      lines.appendChild(el('div', null, 'Wind ' + pad3(Math.round(c.wind_direction_10m / 10) * 10) + '° ' +
        Math.round(c.wind_speed_10m) + (c.wind_gusts_10m > c.wind_speed_10m + 8 ? ' gusting ' + Math.round(c.wind_gusts_10m) : '') + ' ' + wind));
      if (data.daily && data.daily.sunrise) {
        lines.appendChild(el('div', null, 'Sun ' + hhmm(data.daily.sunrise[0]) + ' – ' + hhmm(data.daily.sunset[0])));
      }
      box.appendChild(lines);
    });
  }

  function pad3(n) { n = n % 360 || 360; return n < 100 ? '0' + pad2(n) : String(n); }
  function hhmm(iso) { var m = /T(\d\d:\d\d)/.exec(iso || ''); return m ? m[1] : ''; }

  // --- settings dialog -------------------------------------------------------

  var overlay = document.getElementById('settings');
  var form = document.getElementById('settings-form');
  var RANGES = { nm: [5, 10, 15, 25, 40, 60, 100, 150], km: [10, 20, 30, 50, 75, 100, 150, 250], mi: [5, 10, 20, 30, 50, 75, 100, 150] };

  function fillRanges(units, currentNm) {
    var u = UNITS[units] || UNITS.aviation;
    var sel = form.radius;
    sel.innerHTML = '';
    var best = null;
    var list = RANGES[u.dist];
    for (var i = 0; i < list.length; i++) {
      var nm = list[i] / u.perNm;
      var opt = el('option', null, list[i] + ' ' + u.dist);
      opt.value = String(nm);
      sel.appendChild(opt);
      if (best === null || Math.abs(nm - currentNm) < Math.abs(best - currentNm)) best = nm;
    }
    sel.value = String(best);
  }

  function openSettings() {
    form.lat.value = hasLocation() ? settings.lat : '';
    form.lon.value = hasLocation() ? settings.lon : '';
    form.units.value = settings.units;
    form.basemap.value = settings.basemap;
    form.refresh.value = String(settings.refresh);
    form.sweep.checked = settings.sweep;
    form.labels.checked = settings.labels;
    form.trails.checked = settings.trails;
    form.clock24.checked = settings.clock24;
    form.demo.checked = settings.demo;
    fillRanges(settings.units, settings.radius);
    document.getElementById('locate-msg').textContent = '';
    overlay.className = 'overlay';
  }

  function closeSettings() { overlay.className = 'overlay is-hidden'; }

  form.units.addEventListener('change', function () {
    fillRanges(form.units.value, parseFloat(form.radius.value));
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var lat = parseFloat(String(form.lat.value).replace(',', '.'));
    var lon = parseFloat(String(form.lon.value).replace(',', '.'));
    var moved = lat !== settings.lat || lon !== settings.lon;
    var wasDemo = settings.demo;
    settings.lat = isFinite(lat) && Math.abs(lat) <= 85 ? lat : null;
    settings.lon = isFinite(lon) && Math.abs(lon) <= 180 ? lon : null;
    settings.radius = parseFloat(form.radius.value) || DEFAULTS.radius;
    settings.units = form.units.value;
    settings.basemap = form.basemap.value;
    settings.refresh = parseFloat(form.refresh.value) || DEFAULTS.refresh;
    settings.sweep = form.sweep.checked;
    settings.labels = form.labels.checked;
    settings.trails = form.trails.checked;
    settings.clock24 = form.clock24.checked;
    settings.demo = form.demo.checked;
    store();
    closeSettings();
    if (moved || wasDemo !== settings.demo) {
      tracks = {};
      selectedHex = null;
      demo.reset();
    }
    applySettings();
  });

  document.getElementById('btn-cancel').onclick = closeSettings;
  document.getElementById('btn-settings').onclick = openSettings;

  document.getElementById('btn-locate').onclick = function () {
    var msg = document.getElementById('locate-msg');
    if (!navigator.geolocation) { msg.textContent = 'This browser has no location service.'; return; }
    msg.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      form.lat.value = pos.coords.latitude.toFixed(4);
      form.lon.value = pos.coords.longitude.toFixed(4);
      msg.textContent = '';
    }, function (err) {
      // Browsers only share location with https pages or localhost.
      msg.textContent = window.location.protocol === 'http:' && window.location.hostname !== 'localhost'
        ? 'Location needs https or localhost — type the coordinates instead.'
        : 'Could not get location (' + (err.message || err.code) + ').';
    }, { timeout: 15000 });
  };

  function stepRange(dir) {
    var list = RANGES[unit().dist];
    var cur = settings.radius * unit().perNm;
    var idx = 0;
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - cur) < Math.abs(list[idx] - cur)) idx = i;
    idx = Math.max(0, Math.min(list.length - 1, idx + dir));
    settings.radius = list[idx] / unit().perNm;
    store();
    demo.reset();
    applySettings();
  }

  document.getElementById('btn-zoom-in').onclick = function () { stepRange(-1); };
  document.getElementById('btn-zoom-out').onclick = function () { stepRange(1); };

  document.addEventListener('keydown', function (e) {
    if (overlay.className.indexOf('is-hidden') < 0) {
      if (e.keyCode === 27) closeSettings();
      return;
    }
    if (e.key === '+' || e.key === '=' || e.keyCode === 187) stepRange(-1);
    else if (e.key === '-' || e.keyCode === 189) stepRange(1);
    else if (e.key === 'Escape' || e.keyCode === 27) select(null);
    else if (e.key === 's' || e.key === ',') openSettings();
    else if (e.key === 'f') toggleFullscreen();
  });

  // --- fullscreen & staying awake -------------------------------------------

  var docEl = document.documentElement;
  var canFullscreen = docEl.requestFullscreen || docEl.webkitRequestFullscreen;

  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (canFullscreen) {
      canFullscreen.call(docEl);
    }
  }

  if (canFullscreen) document.getElementById('btn-fullscreen').onclick = toggleFullscreen;
  else document.getElementById('btn-fullscreen').className = 'is-hidden';

  // Where the browser offers it, keep the screen on. Old iPads don't: set
  // Auto-Lock to Never there instead.
  var wakeLock = null;
  function keepAwake() {
    if (!navigator.wakeLock || wakeLock || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }, function () { /* refused, e.g. battery saver */ });
  }
  document.addEventListener('visibilitychange', function () {
    keepAwake();
    if (!document.hidden) poll();
  });

  // --- radar taps ------------------------------------------------------------

  canvas.addEventListener('click', function (e) {
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var best = null;
    var bestD = 32 * 32;
    for (var i = 0; i < hitList.length; i++) {
      var dx = hitList[i].x - x;
      var dy = hitList[i].y - y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = hitList[i].hex; }
    }
    select(best);
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 100);
  });

  // --- start -----------------------------------------------------------------

  function applySettings() {
    resize();
    renderLegend();
    tickClock();
    loadWeather();
    afterPoll();
    poll();
  }

  function start(serverDefaults) {
    var fromServer = {};
    for (var k in serverDefaults || {}) {
      if (serverDefaults[k] !== null && serverDefaults[k] !== undefined && k in DEFAULTS) fromServer[k] = serverDefaults[k];
    }
    // Least to most specific: built-in, the server's, this device's, the address bar's.
    settings = extend(extend(extend(extend({}, DEFAULTS), fromServer), readStored()), readQuery());
    if (!UNITS[settings.units]) settings.units = DEFAULTS.units;
    applySettings();
    setInterval(tickClock, 1000);
    requestFrame(frame);
    keepAwake();
    if (!hasLocation()) openSettings();
  }

  // A screen left on for weeks slowly gathers cruft (and old Safari leaks).
  // Reload once a night, at a quiet hour.
  setInterval(function () {
    var d = new Date();
    if (d.getHours() === 4 && d.getMinutes() === 0 && overlay.className.indexOf('is-hidden') >= 0) window.location.reload();
  }, 60 * 1000);

  getJson('api/config', function (err, data) {
    // No server behind this page (opened as a file, or on static hosting):
    // the radar still runs, on demo traffic.
    serverAvailable = !err;
    start(data && data.defaults);
  });
}());
