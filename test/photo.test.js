// Planespotters photos: parsing their answer, and one lookup per aircraft.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPhoto, parsePhoto } from '../public/photo.js';

// Their answer for 47c1c2 (LN-RKU), 2026-11-08.
const ANSWER = { photos: [{ id: '1973791',
  thumbnail: { src: 'https://t.plnspttrs.net/36579/1973791_2d626231f6_t.jpg', size: { width: 200, height: 112 } },
  thumbnail_large: { src: 'https://t.plnspttrs.net/36579/1973791_2d626231f6_280.jpg', size: { width: 498, height: 280 } },
  link: 'https://www.planespotters.net/photo/1973791/ln-rku-sas-scandinavian-airlines-airbus-a330-343?utm_source=api',
  photographer: 'Lauchlan' }] };

test('the large thumbnail, its link and the photographer, unchanged', () => {
  assert.deepEqual(parsePhoto(ANSWER), {
    src: 'https://t.plnspttrs.net/36579/1973791_2d626231f6_280.jpg',
    width: 498,
    height: 280,
    link: ANSWER.photos[0].link,
    photographer: 'Lauchlan',
  });
  assert.equal(parsePhoto({ photos: [] }), null);
  assert.equal(parsePhoto(null), null);
  // Only a small thumbnail: use that.
  const small = { photos: [{ ...ANSWER.photos[0], thumbnail_large: undefined }] };
  assert.equal(parsePhoto(small).src, ANSWER.photos[0].thumbnail.src);
});

test('asked once per aircraft; a failure is retried next time', async () => {
  const asked = [];
  const answer = (status, body) => async (url) => { asked.push(url); return { status, ok: status < 400, json: async () => body }; };
  const a = await fetchPhoto('aaaaaa', answer(200, ANSWER));
  await fetchPhoto('aaaaaa', answer(200, ANSWER));
  assert.equal(a.photographer, 'Lauchlan');
  assert.deepEqual(asked, ['https://api.planespotters.net/pub/photos/hex/aaaaaa']);

  assert.equal(await fetchPhoto('bbbbbb', answer(200, { photos: [] })), null);
  assert.deepEqual(await fetchPhoto('cccccc', answer(503, {})), { error: 'Planespotters answered HTTP 503' });
  const again = await fetchPhoto('cccccc', answer(200, ANSWER));
  assert.equal(again.photographer, 'Lauchlan');
  assert.equal(asked.filter((u) => u.endsWith('cccccc')).length, 2);
});

test('a blocked request says so plainly', async () => {
  const blocked = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await fetchPhoto('dddddd', blocked), { error: "couldn't reach Planespotters" });
});
