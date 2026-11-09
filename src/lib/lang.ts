// The app's language. The English text doubles as the key, so screens stay
// readable: t('Find a barber') shows "Cari barber" in Bahasa Melayu.
// Malay text lives in strings-ms.ts.

import { ms } from './strings-ms.ts';

export type Lang = 'en' | 'ms';

export const LANGUAGES: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'ms', name: 'Bahasa Melayu' },
];

function deviceLang(): Lang {
  try {
    return /^ms\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'ms' : 'en';
  } catch {
    return 'en';
  }
}

let current: Lang = deviceLang();

export function getLang(): Lang {
  return current;
}

/** Use LanguageProvider's setLang in the app, so screens re-render. */
export function setCurrentLang(lang: Lang) {
  current = lang;
}

/** Locale for dates and times: "Tue, 6 Oct, 10:30 am" or "Sel, 6 Okt, 10:30 PG". */
export function dateLocale(): string {
  return current === 'ms' ? 'ms-MY' : 'en-MY';
}

/** Translates UI text, filling `{name}` placeholders from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const template = current === 'ms' ? (ms[text] ?? text) : text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}
