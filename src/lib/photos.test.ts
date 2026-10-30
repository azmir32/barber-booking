/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  base64Bytes,
  firstPlace,
  gridLayout,
  inShownOrder,
  photoCaption,
  photoCounts,
  photoLabel,
  photoPaths,
  resizeTarget,
  stripTileSize,
  thumbTarget,
  uploadProblem,
} from './photos.ts';

test('a picked photo is saved at most 1600 px on its long side, in its own shape, and never made bigger', () => {
  assert.deepEqual(resizeTarget({ width: 4032, height: 3024 }), { width: 1600, height: 1200 });
  assert.deepEqual(resizeTarget({ width: 3024, height: 4032 }), { width: 1200, height: 1600 });
  assert.deepEqual(resizeTarget({ width: 3000, height: 3000 }), { width: 1600, height: 1600 });
  // A panorama keeps its shape, and a thin side never rounds to nothing.
  assert.deepEqual(resizeTarget({ width: 12000, height: 2 }), { width: 1600, height: 1 });
  assert.deepEqual(resizeTarget({ width: 1080, height: 1350 }), { width: 1080, height: 1350 });
  // A phone that doesn't say the size: worked out after loading it.
  assert.equal(resizeTarget({ width: 0, height: 1200 }), null);
  assert.equal(resizeTarget({ width: Number.NaN, height: 1200 }), null);
});

test('a thumbnail is about 400 px on its short side, so its square crop stays sharp', () => {
  assert.deepEqual(thumbTarget({ width: 1200, height: 1600 }), { width: 400, height: 533 });
  assert.deepEqual(thumbTarget({ width: 1600, height: 1200 }), { width: 533, height: 400 });
  assert.deepEqual(thumbTarget({ width: 1600, height: 1600 }), { width: 400, height: 400 });
  assert.deepEqual(thumbTarget({ width: 300, height: 200 }), { width: 300, height: 200 });
  assert.equal(thumbTarget({ width: 0, height: 0 }), null);
});

test('the photo grid has 3 or 4 square tiles a row, filling the width', () => {
  // My shop's card at 360 wide: the screen's and the card's padding leave 294.
  assert.deepEqual(gridLayout(294), { columns: 3, size: 92 });
  assert.deepEqual(gridLayout(320), { columns: 3, size: 101 });
  assert.deepEqual(gridLayout(400), { columns: 4, size: 94 });
  assert.deepEqual(gridLayout(700), { columns: 4, size: 169 });
  // Even squeezed, still three across rather than one long column.
  assert.deepEqual(gridLayout(200), { columns: 3, size: 61 });
  for (const width of [200, 294, 328, 400, 560, 700]) {
    const { columns, size } = gridLayout(width);
    assert.ok(columns * size + (columns - 1) * 8 <= width, `fits ${width}`);
  }
});

test('the strip shows about two and a half tiles, so the half one says there is more', () => {
  assert.equal(stripTileSize(328), 125);
  assert.equal(stripTileSize(360), 138);
  // Wide screens stop at 160; narrow ones keep tiles big enough to tap and see.
  assert.equal(stripTileSize(560), 160);
  assert.equal(stripTileSize(200), 96);
});

test('Move to first puts a photo before all the others, and photos show in order', () => {
  assert.equal(firstPlace([{ sort_order: 3 }, { sort_order: 0 }, { sort_order: 7 }]), -1);
  assert.equal(firstPlace([{ sort_order: -4 }]), -5);
  assert.equal(firstPlace([]), 0);
  const photos = [
    { id: 'a', sort_order: 2 },
    { id: 'b', sort_order: -1 },
    { id: 'c', sort_order: 0 },
  ];
  assert.deepEqual(inShownOrder(photos).map((p) => p.id), ['b', 'c', 'a']);
  assert.deepEqual(photos.map((p) => p.id), ['a', 'b', 'c'], 'leaves the list as it was');
});

test('each barber’s photos are counted, and untagged ones are nobody’s', () => {
  const counts = photoCounts([{ barber_id: 'ali' }, { barber_id: 'danial' }, { barber_id: 'ali' }, { barber_id: null }]);
  assert.deepEqual([...counts], [['ali', 2], ['danial', 1]]);
});

test('a caption is one tidy line of up to 60 characters, and blank is none', () => {
  assert.equal(photoCaption('  Skin fade,\n  hard   part '), 'Skin fade, hard part');
  assert.equal(photoCaption(' \t\n '), null);
  assert.equal(photoCaption('x'.repeat(70)), 'x'.repeat(60));
  assert.equal(photoCaption(`${'a'.repeat(59)} b`), 'a'.repeat(59));
});

test('every photo has a label: its caption and barber, or where it is in the list', () => {
  setCurrentLang('en');
  assert.equal(photoLabel('Skin fade with a hard part', 'Ali', 0, 8), 'Skin fade with a hard part, cut by Ali');
  assert.equal(photoLabel(null, 'Danial', 2, 8), 'Photo 3 of 8, cut by Danial');
  assert.equal(photoLabel(null, null, 2, 8), 'Photo 3 of 8');
  assert.equal(photoLabel('Quiff', undefined, 0, 1), 'Quiff');
  setCurrentLang('ms');
  assert.equal(photoLabel(null, 'Ali', 0, 3), 'Foto 1 daripada 3, dipotong oleh Ali');
  setCurrentLang('en');
});

test('new files get random names in the shop’s own folder, the thumbnail beside the photo', () => {
  const { path, thumb_path } = photoPaths('shop-1', () => 0.5);
  assert.match(path, /^shop-1\/[a-z0-9]+-i{12}\.jpg$/);
  assert.equal(thumb_path, path.replace(/\.jpg$/, '-thumb.jpg'));
  assert.notEqual(photoPaths('shop-1').path, photoPaths('shop-1').path);
});

test('the resizer’s base64 becomes the bytes Storage takes', () => {
  assert.deepEqual([...base64Bytes('/9j/4A==')], [0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual([...base64Bytes('data:image/jpeg;base64,/9j/\n4A==')], [0xff, 0xd8, 0xff, 0xe0]);
});

test('a file Storage turns down says why in plain words', () => {
  setCurrentLang('en');
  assert.match(uploadProblem({ statusCode: '413' })!, /too big/);
  assert.match(uploadProblem({ statusCode: '415' })!, /JPEG/);
  assert.match(uploadProblem({ statusCode: '403' })!, /owner/);
  assert.equal(uploadProblem({ statusCode: '500' }), null);
  assert.equal(uploadProblem(null), null);
});
