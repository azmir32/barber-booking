// Renders the app icon, Android adaptive icon layers, splash image and
// favicon from the Ionicons scissors glyph. Re-run after changing BRAND.
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const BRAND = '#C8283C';
const GLYPH = String.fromCodePoint(62107); // Ionicons "cut"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const font = fs
  .readFileSync(path.join(root, 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf'))
  .toString('base64');

const outputs = [
  // file, canvas size, background (null = transparent), glyph size, corner radius
  ['assets/images/icon.png', 1024, BRAND, 620, 0],
  ['assets/images/android-icon-background.png', 512, BRAND, 0, 0],
  ['assets/images/android-icon-foreground.png', 512, null, 230, 0],
  ['assets/images/android-icon-monochrome.png', 432, null, 200, 0],
  ['assets/images/splash-icon.png', 512, null, 440, 0],
  ['assets/images/favicon.png', 48, BRAND, 32, 10],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, background, glyphSize, radius] of outputs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`
    <style>
      @font-face { font-family: Ionicons; src: url(data:font/ttf;base64,${font}); }
      html, body { margin: 0; background: transparent; }
      div {
        width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center;
        background: ${background ?? 'transparent'}; border-radius: ${radius}px;
        font-family: Ionicons; font-size: ${glyphSize}px; line-height: 1; color: #fff;
      }
    </style>
    <div>${glyphSize ? GLYPH : ''}</div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(root, file), omitBackground: true });
  console.log(`wrote ${file}`);
}
await browser.close();
