/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blend, chairEdges, chairFills, Colors } from '../constants/colors.ts';

// WCAG contrast (AA): text needs 4.5:1 against what is behind it, and the
// edges of buttons and fields, icons and the marks in charts need 3:1, in both
// light and dark mode.

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const [mode, c] of Object.entries(Colors)) {
  test(`${mode} mode colours are readable`, () => {
    const text: [string, string, string][] = [
      ['text on page', c.text, c.background],
      ['text on card', c.text, c.card],
      ['text on chip', c.text, c.chip],
      ['secondary text on page', c.textSecondary, c.background],
      ['secondary text on card', c.textSecondary, c.card],
      ['secondary text on chip', c.textSecondary, c.chip],
      ['button text on accent', c.accentText, c.accent],
      ['tint on page', c.tint, c.background],
      ['tint on card', c.tint, c.card],
      ['danger on card', c.danger, c.card],
      ['danger on its soft fill', c.danger, c.dangerSoft],
      ['success on card', c.success, c.card],
      ['warning on card', c.warning, c.card],
      // Badges and notes sit straight on the page too.
      ['danger on page', c.danger, c.background],
      ['success on page', c.success, c.background],
      ['warning on page', c.warning, c.background],
      // A chip's day under its name, in the brand colour on the one already in place.
      ['tint on chip', c.tint, c.chip],
    ];
    // The barber's day as chairs: names, services and times on each kind of fill.
    for (const [fill, bg] of Object.entries(chairFills(c))) {
      text.push([`text on the chairs’ ${fill} fill`, c.text, bg], [`secondary text on the chairs’ ${fill} fill`, c.textSecondary, bg]);
    }
    for (const [what, fg, bg] of text) {
      assert.ok(contrast(fg, bg) >= 4.5, `${what}: ${contrast(fg, bg).toFixed(2)}:1`);
    }
    const edges: [string, string, string][] = [
      ['field border on card', c.inputBorder, c.card],
      ['field border on page', c.inputBorder, c.background],
      ['focused field border on card', c.tint, c.card],
      ['field border with an error on card', c.danger, c.card],
      // Primary buttons and picked chips are told apart from the page by their fill.
      ['primary button on page', c.accent, c.background],
      ['primary button on card', c.accent, c.card],
      ['chevrons and quiet icons on card', c.textSecondary, c.card],
      ['tab icons on the tab bar', c.textSecondary, c.card],
      ['picked tab icon on the tab bar', c.tint, c.card],
      ['warning icon on card', c.warning, c.card],
      ['empty star and other hours’ bars on card', c.inputBorder, c.card],
      ['filled star on card', c.warning, c.card],
      ['busiest hour’s bar on card', c.tint, c.card],
      ['the chairs’ now line', c.tint, c.card],
    ];
    const fills = chairFills(c);
    for (const [kind, edge] of Object.entries(chairEdges(c))) {
      const fill = kind === 'noShow' ? fills.done : fills[kind as keyof typeof fills];
      edges.push([`edge of a ${kind} booking in the chairs`, edge, fill]);
    }
    for (const [what, fg, bg] of edges) {
      assert.ok(contrast(fg, bg) >= 3, `${what}: ${contrast(fg, bg).toFixed(2)}:1`);
    }
  });
}

test('blend lays one colour over another as a solid one', () => {
  assert.equal(blend('#FFFFFF', '#000000', 0), '#000000');
  assert.equal(blend('#FFFFFF', '#000000', 1), '#FFFFFF');
  assert.equal(blend('#C8283C', '#FFFFFF', 0.5), '#E4949E');
});
