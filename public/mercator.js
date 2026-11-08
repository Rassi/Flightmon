// Web Mercator, the projection map tiles use. The map draws everything in
// it (tiles, aircraft) so they line up exactly, centred on a location
// and scaled so that `rangeKm` spans `radiusPx` at latitude `scaleLat` (the
// centre's unless given: the map keeps its scale while it is dragged).

const MERCATOR_RADIUS_KM = 6378.137; // the sphere Web Mercator is defined on
const EARTH_RADIUS_KM = 6371.0088; // mean radius, for distances (as geo.js)
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

// Position in pixels on a square world map `worldSize` pixels wide.
export function worldPixel(lat, lon, worldSize) {
  const sin = Math.sin(toRad(lat));
  return {
    x: ((lon + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize,
  };
}

export function makeView({ lat, lon }, rangeKm, radiusPx, width, height, scaleLat = lat) {
  const pxPerKm = radiusPx / rangeKm;
  const worldSize = pxPerKm * 2 * Math.PI * MERCATOR_RADIUS_KM * Math.cos(toRad(scaleLat));
  const c = worldPixel(lat, lon, worldSize);
  const originX = c.x - width / 2;
  const originY = c.y - height / 2;
  return {
    center: { lat, lon },
    rangeKm,
    radiusPx,
    width,
    height,
    worldSize,
    // Fractional tile zoom level: 256-pixel tiles, 2^zoom of them across.
    zoom: Math.log2(worldSize / 256),
    originX,
    originY,
    toScreen(lat2, lon2) {
      const p = worldPixel(lat2, lon2, worldSize);
      // Take the shorter way round across the antimeridian.
      let dx = p.x - c.x;
      if (dx > worldSize / 2) dx -= worldSize;
      if (dx < -worldSize / 2) dx += worldSize;
      return { x: width / 2 + dx, y: p.y - originY };
    },
    // The inverse: the position under screen point (x, y).
    toLatLon(x, y) {
      const wx = c.x + (x - width / 2);
      const wy = originY + y;
      const lon2 = ((((wx / worldSize) * 360 - 180) + 540) % 360) - 180;
      const lat2 = toDeg(Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / worldSize))));
      return { lat: lat2, lon: lon2 };
    },
  };
}

// The point `distKm` away from (lat, lon) in direction `bearingDeg`.
export function destination(lat, lon, bearingDeg, distKm) {
  const δ = distKm / EARTH_RADIUS_KM;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  );
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

// A distance ring as screen points: every point is `distKm` from the centre.
export function ringPoints(view, distKm, steps = 120) {
  const points = [];
  for (let i = 0; i < steps; i++) {
    const p = destination(view.center.lat, view.center.lon, (i * 360) / steps, distKm);
    points.push(view.toScreen(p.lat, p.lon));
  }
  return points;
}
