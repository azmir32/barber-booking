/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Colors } from '../constants/colors.ts';

// WCAG contrast: text needs 4.5:1 against what is behind it, and the edges
// of buttons and fields need 3:1, in both light and dark mode.

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
    ];
    for (const [what, fg, bg] of text) {
      assert.ok(contrast(fg, bg) >= 4.5, `${what}: ${contrast(fg, bg).toFixed(2)}:1`);
    }
    const edges: [string, string, string][] = [
      ['field border on card', c.inputBorder, c.card],
      ['field border on page', c.inputBorder, c.background],
    ];
    for (const [what, fg, bg] of edges) {
      assert.ok(contrast(fg, bg) >= 3, `${what}: ${contrast(fg, bg).toFixed(2)}:1`);
    }
  });
}
