/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QUIET_ZONE, qrMatrix, qrRuns, qrSvg } from './qr.ts';

const LINK = 'https://potongku.my/shop/kemas-barber-kajang';

test('qrMatrix makes a square code small enough for a phone screen', () => {
  const m = qrMatrix(LINK);
  // Version 4 (33 modules a side) holds a typical booking link at medium error correction.
  assert.equal(m.length, 33);
  assert.ok(m.every((row) => row.length === 33));
  // The same link always gives the same code.
  assert.deepEqual(qrMatrix(LINK), m);
});

test('qrMatrix has the three finder patterns scanners look for', () => {
  const m = qrMatrix(LINK);
  const n = m.length;
  // Top-left, top-right and bottom-left: a dark 7x7 ring, a light ring, a dark 3x3 centre.
  for (const [top, left] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ]) {
    const at = (r: number, c: number) => m[top + r][left + c];
    for (const [r, c] of [
      [0, 0],
      [0, 6],
      [6, 0],
      [6, 6],
    ]) {
      assert.equal(at(r, c), true, `corner ${r},${c} of the finder at ${top},${left}`);
    }
    assert.equal(at(1, 1), false);
    assert.equal(at(3, 3), true);
  }
});

test('qrRuns joins each row into runs that cover every dark module once', () => {
  assert.deepEqual(
    qrRuns([
      [true, true, false, true],
      [false, false, false, false],
      [false, true, true, true],
    ]),
    [
      { row: 0, col: 0, length: 2 },
      { row: 0, col: 3, length: 1 },
      { row: 2, col: 1, length: 3 },
    ],
  );

  const m = qrMatrix(LINK);
  const drawn = m.map((row) => row.map(() => false));
  const runs = qrRuns(m);
  for (const { row, col, length } of runs) {
    for (let c = col; c < col + length; c += 1) {
      assert.equal(drawn[row][c], false, 'drawn twice');
      drawn[row][c] = true;
    }
  }
  assert.deepEqual(drawn, m);
  // Far fewer boxes than modules, which is the point.
  assert.ok(runs.length < m.flat().filter(Boolean).length * 0.6);
});

test('qrSvg scales to fit and keeps the quiet zone', () => {
  const m = qrMatrix(LINK);
  const svg = qrSvg(m);
  const side = m.length + QUIET_ZONE * 2;
  assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes(`viewBox="0 0 ${side} ${side}"`));
  // No fixed size, so the poster decides how big it prints.
  assert.doesNotMatch(svg, /<svg[^>]* (width|height)=/);
  // The top-left finder starts inside the white border.
  assert.ok(svg.includes(`M${QUIET_ZONE} ${QUIET_ZONE}h7v1h-7z`));
});
