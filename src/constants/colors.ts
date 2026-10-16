// The app's colours, kept free of React Native imports so a plain node test
// (src/lib/contrast.test.ts) can check every pair is readable.

export const Colors = {
  light: {
    text: '#15171C',
    textSecondary: '#5F6470',
    background: '#F7F6F3',
    card: '#FFFFFF',
    border: '#E3E1DC',
    /** Edges of things you type in or tap: dark enough to see (3:1). */
    inputBorder: '#8F8B83',
    /** Fill of primary buttons and selected chips, under white text. */
    accent: '#C8283C',
    accentText: '#FFFFFF',
    /** Brand red used as text or a line: links, tab icons, selected borders. */
    tint: '#C8283C',
    success: '#1E7F4F',
    warning: '#A15C00',
    danger: '#B42318',
    /** Background of destructive buttons, so Cancel never looks like Confirm. */
    dangerSoft: '#FDECEA',
    chip: '#EEECE7',
    /** Grey shapes standing in for content still loading; only there to be seen, not read. */
    skeleton: '#E4E1DA',
  },
  dark: {
    text: '#F3F2EF',
    textSecondary: '#A6AAB3',
    background: '#0F1115',
    card: '#191C22',
    border: '#2A2E36',
    inputBorder: '#6B7280',
    accent: '#C8283C',
    accentText: '#FFFFFF',
    tint: '#FF7A8A',
    success: '#4CC38A',
    warning: '#F0A44B',
    danger: '#F97066',
    dangerSoft: '#3A1D20',
    chip: '#323844',
    skeleton: '#373C48',
  },
} as const;

export type Palette = { [K in keyof typeof Colors.light]: string };

/** `top` laid over `bottom` at `amount` (0 to 1), as one solid colour: a soft fill for a booking. */
export function blend(top: string, bottom: string, amount: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  const mixed = [1, 3, 5].map((i) => Math.round(channel(top, i) * amount + channel(bottom, i) * (1 - amount)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * The fills of the barber's day as chairs (components/chairs.tsx): each
 * booking by where it is in its day, blocked time, and time off or on a
 * break. Kept here so the contrast test checks the words on each.
 */
export function chairFills(c: Palette) {
  return {
    upcoming: blend(c.tint, c.card, 0.12),
    now: blend(c.success, c.card, 0.2),
    toMark: blend(c.warning, c.card, 0.16),
    done: c.chip,
    noShow: c.dangerSoft,
    block: blend(c.textSecondary, c.card, 0.16),
    shade: blend(c.textSecondary, c.card, 0.1),
  };
}
