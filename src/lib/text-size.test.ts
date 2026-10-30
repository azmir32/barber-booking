/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fitText, parseTextSize, scaleText, TEXT_SIZES, textScale } from './text-size.ts';

test('the three text sizes grow in order, starting from the app as it is', () => {
  assert.deepEqual(
    TEXT_SIZES.map((s) => [s.key, s.scale]),
    [
      ['normal', 1],
      ['large', 1.25],
      ['largest', 1.5],
    ],
  );
  assert.equal(textScale('normal'), 1);
  assert.equal(textScale('largest'), 1.5);
});

test('a saved text size is read back, and anything else is Normal', () => {
  assert.equal(parseTextSize('large'), 'large');
  assert.equal(parseTextSize('largest'), 'largest');
  assert.equal(parseTextSize(null), 'normal');
  assert.equal(parseTextSize(undefined), 'normal');
  assert.equal(parseTextSize('huge'), 'normal');
  assert.equal(parseTextSize('1.5'), 'normal');
});

test('Normal leaves a style exactly as it was', () => {
  const body = { fontSize: 16, lineHeight: 22, fontWeight: '600' as const };
  assert.equal(scaleText(body, 1), body);
});

test('bigger text grows its line height with it, so lines never overlap', () => {
  const body = { fontSize: 16, lineHeight: 22, fontWeight: '600' as const, color: '#000' };
  assert.deepEqual(scaleText(body, 1.5), { fontSize: 24, lineHeight: 33, fontWeight: '600', color: '#000' });
  assert.deepEqual(scaleText({ fontSize: 13, lineHeight: 18 }, 1.25), { fontSize: 16.5, lineHeight: 23 });
  // The original is untouched, as StyleSheet styles are shared.
  assert.equal(body.fontSize, 16);
  // Without a line height of its own, the text's natural one already grows with it.
  assert.deepEqual(scaleText({ fontSize: 12 }, 1.5), { fontSize: 18 });
  for (const { scale } of TEXT_SIZES) {
    const { fontSize, lineHeight } = scaleText({ fontSize: 28, lineHeight: 34 }, scale);
    assert.ok(lineHeight! >= fontSize! * 1.2, `title at ${scale}: ${fontSize}/${lineHeight}`);
  }
});

test('the app’s choice comes on top of the phone’s own text size', () => {
  // Nothing in the way: the app's part is ours to apply, the phone's React Native's.
  assert.deepEqual(fitText(1.5, undefined, 1.3), { scale: 1.5, maxFontSizeMultiplier: undefined, total: 1.5 * 1.3 });
  assert.deepEqual(fitText(1, undefined, 2), { scale: 1, maxFontSizeMultiplier: undefined, total: 2 });
});

test('a crowded place grows no further than its cap, however the two are set', () => {
  // Largest in the app is cut back to the cap, and the phone may add nothing.
  assert.deepEqual(fitText(1.5, 1.25, 2), { scale: 1.25, maxFontSizeMultiplier: 1, total: 1.25 });
  // Normal in the app leaves the phone room up to the cap.
  assert.deepEqual(fitText(1, 1.25, 2), { scale: 1, maxFontSizeMultiplier: 1.25, total: 1.25 });
  assert.deepEqual(fitText(1, 1.25, 1.1), { scale: 1, maxFontSizeMultiplier: 1.25, total: 1.1 });
  // In between, the two share it.
  const large = fitText(1.25, 1.5, 2);
  assert.equal(large.scale, 1.25);
  assert.equal(large.maxFontSizeMultiplier, 1.2);
  assert.equal(large.total, 1.5);
  // A cap of 1 keeps the text its own size: a picture made of a letter.
  assert.deepEqual(fitText(1.5, 1, 3), { scale: 1, maxFontSizeMultiplier: 1, total: 1 });
  for (const app of [1, 1.25, 1.5]) {
    for (const phone of [0.85, 1, 1.3, 2, 3.1]) {
      const { scale, maxFontSizeMultiplier, total } = fitText(app, 1.3, phone);
      assert.ok(total <= 1.3 + 1e-9, `app ${app}, phone ${phone}: ${total}`);
      // React Native reads a multiplier under 1 as no limit at all.
      assert.ok(maxFontSizeMultiplier! >= 1);
      assert.ok(scale <= app);
    }
  }
});
