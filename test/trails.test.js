import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathText } from '../public/details.js';
import { TrailRecorder, mergeTrail } from '../public/trails.js';
import { normalizeTrack } from '../src/track.js';

const update = (nowMs, aircraft) => ({ now: nowMs, aircraft });
const ac = (hex, lat, lon, seenPosS = 0, extra = {}) => ({ hex, lat, lon, seenPosS, altM: 1000, onGround: false, ...extra });

test('recorder: one point per new position, timed by when it was seen', () => {
  const r = new TrailRecorder();
  r.record(update(1_000_000, [ac('a', 55, 12, 2), ac('b', 56, 13)]));
  r.record(update(1_005_000, [ac('a', 55, 12, 7)])); // same position again: skipped
  r.record(update(1_010_000, [ac('a', 55.01, 12.02, 1, { altM: 1200 })]));
  assert.deepEqual(r.get('a'), [
    { t: 998, lat: 55, lon: 12, altM: 1000, onGround: false },
    { t: 1009, lat: 55.01, lon: 12.02, altM: 1200, onGround: false },
  ]);
  assert.equal(r.get('b').length, 1);
  assert.deepEqual(r.get('nope'), []);
});

test('recorder: an older report than the last point is ignored', () => {
  const r = new TrailRecorder();
  r.record(update(1_000_000, [ac('a', 55, 12, 0)]));
  r.record(update(1_005_000, [ac('a', 55.1, 12.1, 30)])); // seen 30 s ago: before the last point
  assert.equal(r.get('a').length, 1);
});

test('recorder: points older than the keep time are dropped, and gone aircraft forgotten', () => {
  const r = new TrailRecorder(60);
  r.record(update(1_000_000, [ac('a', 55, 12), ac('b', 56, 13)]));
  r.record(update(1_050_000, [ac('a', 55.1, 12)]));
  r.record(update(1_070_000, [ac('a', 55.2, 12)]));
  assert.deepEqual(r.get('a').map((p) => p.t), [1050, 1070]);
  assert.deepEqual(r.get('b'), []);
  assert.equal(r.trails.has('b'), false);
});

test("merge: OpenSky's history before our recording, then ours", () => {
  const history = [10, 20, 30, 40].map((t) => ({ t }));
  const recorded = [35, 40, 45].map((t) => ({ t }));
  assert.deepEqual(mergeTrail(history, recorded).map((p) => p.t), [10, 20, 30, 35, 40, 45]);
  assert.deepEqual(mergeTrail(undefined, recorded), recorded);
  assert.deepEqual(mergeTrail([], recorded), recorded);
  assert.deepEqual(mergeTrail(history, []), history);
});

test('merge with a real OpenSky track keeps time order', () => {
  const { path } = normalizeTrack(JSON.parse(readFileSync(new URL('fixtures/opensky-track.json', import.meta.url))));
  const start = path.at(-10).t;
  const recorded = [0, 5, 10, 15].map((s) => ({ t: start + s, lat: 55.4, lon: 12.2 }));
  const merged = mergeTrail(path, recorded);
  assert.equal(merged.length, path.length - 10 + 4);
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i].t > merged[i - 1].t);
});

test('path wording on the card', () => {
  const trail = [{ t: 1_793_452_003 }, { t: 1_793_456_381 }];
  assert.equal(pathText(undefined, trail), 'loading…');
  assert.match(pathText({ path: [{}] }, trail), /^since \d\d[:.]\d\d \(OpenSky\)$/);
  assert.match(pathText({ error: 'x' }, trail), /^since \d\d[:.]\d\d \(recorded here\)$/);
  assert.equal(pathText({ error: 'x' }, [{ t: 1 }]), 'not enough positions yet');
});
