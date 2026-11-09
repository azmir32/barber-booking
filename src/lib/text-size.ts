// How big the app's text is: the phone's own text size, times the choice
// under Account (Normal, Large, Largest). Kept free of React Native imports
// so a plain node test can check the sums.
//
// On iOS and Android, React Native already grows every Text, and its line
// height, by the phone's setting (allowFontScaling). The choice here
// multiplies the app's own sizes on top. On the web, where the phone's
// setting never reaches the page, the choice is what makes text bigger.

export type TextSize = 'normal' | 'large' | 'largest';

export const TEXT_SIZES: { key: TextSize; name: string; scale: number }[] = [
  { key: 'normal', name: 'Normal', scale: 1 },
  { key: 'large', name: 'Large', scale: 1.25 },
  { key: 'largest', name: 'Largest', scale: 1.5 },
];

/** What AsyncStorage keeps it under, on this phone for whoever uses it. */
export const TEXT_SIZE_KEY = 'potongku.textSize';

/** A saved choice, or Normal for nothing saved or anything unknown. */
export function parseTextSize(saved: string | null | undefined): TextSize {
  return TEXT_SIZES.some((s) => s.key === saved) ? (saved as TextSize) : 'normal';
}

export function textScale(size: TextSize): number {
  return TEXT_SIZES.find((s) => s.key === size)?.scale ?? 1;
}

/**
 * How much to grow a piece of text by, given the choice in the app (`app`),
 * for a crowded place the most it may grow in all (`cap`), and the phone's
 * own setting (`phone`, which React Native applies by itself on iOS and
 * Android). `scale` multiplies our own sizes; `maxFontSizeMultiplier` is
 * for the Text, so the phone's part stops at the cap too; `total` is how big
 * it ends up, to lay things out around it.
 */
export function fitText(app: number, cap?: number, phone = 1) {
  if (cap === undefined) return { scale: app, maxFontSizeMultiplier: undefined, total: app * phone };
  const scale = Math.min(app, cap);
  // At least 1, as React Native reads anything below as "no limit".
  const maxFontSizeMultiplier = Math.max(1, cap / scale);
  return { scale, maxFontSizeMultiplier, total: scale * Math.min(phone, maxFontSizeMultiplier) };
}

type Sized = { fontSize?: number; lineHeight?: number };

/**
 * A text style grown by `scale`: its font size and its line height, so lines
 * never overlap or clip. The same object back at 1, so Normal stays exactly
 * as it was.
 */
export function scaleText<S extends Sized>(style: S, scale: number): S {
  if (scale === 1) return style;
  const grown: S = { ...style };
  if (typeof style.fontSize === 'number') grown.fontSize = Math.round(style.fontSize * scale * 2) / 2;
  if (typeof style.lineHeight === 'number') grown.lineHeight = Math.round(style.lineHeight * scale);
  return grown;
}
