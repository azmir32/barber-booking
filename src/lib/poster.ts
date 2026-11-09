// The poster a barber prints for the counter, so walk-in customers can scan
// and book. Everyone reads the same poster, so its text is in English and
// Malay whatever language the app is in.

import { Colors } from '../constants/colors.ts';
import { qrMatrix, qrSvg } from './qr.ts';

/** The poster's own words: [English, Malay]. */
export const POSTER_TEXT = {
  headline: ['Book your cut online', 'Tempah potongan rambut dalam talian'],
  scan: ['Scan with your phone camera', 'Imbas dengan kamera telefon anda'],
} as const;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Long shop names get smaller type so the poster stays on one page. */
function nameSize(name: string): number {
  return name.length <= 20 ? 44 : name.length <= 40 ? 34 : 26;
}

/**
 * A complete one-page A4 HTML document: the shop's name, the QR code for its
 * booking link (as SVG, so it prints sharp at any size) and the link itself.
 * It is laid out for A4 at 96 px per inch, as browsers lay out A4 (see
 * print-html.ts).
 */
export function posterHtml({ shopName, link, area }: { shopName: string; link: string; area?: string | null }): string {
  const ink = Colors.light;
  const [headlineEn, headlineMs] = POSTER_TEXT.headline;
  const [scanEn, scanMs] = POSTER_TEXT.scan;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(shopName)}</title>
<style>
  /* No page margin, so browsers leave out their date and address headers. */
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; }
  body {
    color: ${ink.text};
    font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    text-align: center;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet { padding: 9% 8% 6%; }
  h1 { margin: 0; font-size: ${nameSize(shopName)}pt; line-height: 1.15; overflow-wrap: anywhere; }
  .area { margin: 6pt 0 0; font-size: 15pt; color: ${ink.textSecondary}; }
  .headline { margin: 26pt 0 0; font-size: 24pt; font-weight: 700; color: ${ink.tint}; }
  .ms { margin-top: 2pt; font-size: 17pt; font-weight: 600; }
  .qr { width: 72%; max-width: 130mm; margin: 18pt auto 0; }
  .qr svg { display: block; width: 100%; height: auto; }
  .scan { margin: 10pt 0 0; font-size: 18pt; font-weight: 600; }
  .scan span { display: block; font-size: 15pt; font-weight: 400; color: ${ink.textSecondary}; }
  .link { margin: 16pt 0 0; font-size: 13pt; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main class="sheet">
  <h1>${escapeHtml(shopName)}</h1>
  ${area ? `<p class="area">${escapeHtml(area)}</p>` : ''}
  <p class="headline">${escapeHtml(headlineEn)}</p>
  <p class="headline ms" lang="ms">${escapeHtml(headlineMs)}</p>
  <div class="qr">${qrSvg(qrMatrix(link))}</div>
  <p class="scan">${escapeHtml(scanEn)}<span lang="ms">${escapeHtml(scanMs)}</span></p>
  <p class="link">${escapeHtml(link)}</p>
</main>
</body>
</html>
`;
}
