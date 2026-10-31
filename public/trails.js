// Where aircraft have flown. Every update's positions are recorded for every
// aircraft, so the selected one's path since the page opened is known. When it
// is clicked, OpenSky's track adds the part before that.

const KEEP_S = 2 * 60 * 60;

export class TrailRecorder {
  constructor(keepS = KEEP_S) {
    this.keepS = keepS;
    this.trails = new Map(); // hex → [{ t (s), lat, lon, altM, onGround }]
  }

  // `data`: an /api/aircraft response (`now` in ms, aircraft with `seenPosS`).
  record(data) {
    const nowS = data.now / 1000;
    for (const ac of data.aircraft) {
      const t = nowS - (ac.seenPosS ?? 0);
      const trail = this.trails.get(ac.hex) ?? [];
      const last = trail[trail.length - 1];
      // Skip repeats: the feed reports an unchanged position until a new one arrives.
      if (last && (t <= last.t || (last.lat === ac.lat && last.lon === ac.lon))) continue;
      trail.push({ t, lat: ac.lat, lon: ac.lon, altM: ac.altM, onGround: ac.onGround });
      this.trails.set(ac.hex, trail);
    }
    const cutoff = nowS - this.keepS;
    for (const [hex, trail] of this.trails) {
      while (trail.length && trail[0].t < cutoff) trail.shift();
      if (!trail.length) this.trails.delete(hex);
    }
  }

  get(hex) {
    return this.trails.get(hex) ?? [];
  }

  clear() {
    this.trails.clear();
  }
}

// OpenSky's history up to where our own recording starts, then ours (denser).
export function mergeTrail(history, recorded) {
  if (!history || !history.length) return recorded;
  if (!recorded.length) return history;
  const start = recorded[0].t;
  return [...history.filter((p) => p.t < start), ...recorded];
}
