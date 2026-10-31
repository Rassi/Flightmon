// A flight's path so far, from the OpenSky Network's tracks endpoint
// (`path` entries: [time s, lat, lon, baro altitude m, track °, on ground]).

export function normalizeTrack(body) {
  if (!body || !Array.isArray(body.path)) throw new Error('Unexpected response: no path');
  const path = body.path
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))
    .map(([t, lat, lon, alt, , ground]) => ({
      t,
      lat,
      lon,
      altM: Number.isFinite(alt) ? Math.round(alt) : null,
      onGround: ground === true,
    }));
  return {
    hex: body.icao24,
    callsign: typeof body.callsign === 'string' && body.callsign.trim() ? body.callsign.trim() : null,
    path,
  };
}
