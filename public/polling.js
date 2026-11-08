// When to ask for aircraft again, so moving the map around can't flood the
// feeds, and a refusal for asking too often makes the page wait longer.

export const MIN_GAP_S = 5; // never two requests closer than this
export const MAX_BACKOFF_S = 120;

// Refused for asking too often: a 429, or the Worker's 502 when every feed answered 429.
export function isRateLimited(status, body) {
  if (status === 429) return true;
  const failures = body?.failures;
  return status === 502 && Array.isArray(failures) && failures.length > 0 &&
    failures.every((f) => /HTTP 429/.test(f));
}

// The wait after a refusal: twice the refresh interval at first, then twice the
// previous wait, at most 2 minutes.
export function nextBackoffS(prevS, refreshS) {
  return Math.min(MAX_BACKOFF_S, prevS ? prevS * 2 : refreshS * 2);
}

// Milliseconds until the next request. `wanted`: one is due as soon as allowed
// (the map moved, ↻, …); otherwise the next refresh. Never within MIN_GAP_S of
// the last request (`lastAt`), and not before a back-off is over.
export function delayMs({ now, lastAt, wanted, refreshS, backoffS = 0 }) {
  const after = (s) => lastAt + s * 1000 - now;
  let d = wanted ? after(MIN_GAP_S) : after(Math.max(MIN_GAP_S, refreshS));
  if (backoffS) d = Math.max(d, after(backoffS));
  return Math.max(0, d);
}
