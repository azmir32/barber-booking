// Builds the self-contained demo: the real web app with a pretend backend
// (src/demo) and sample Kajang shops, packed into one HTML file that opens
// anywhere, with no server, network or account.
//
//   node scripts/build-demo.mjs        -> dist-demo/demo.html (page body, for hosts
//                                         that add their own <head>) and
//                                         dist-demo/index.html (a complete page)
//
// The bundle, icon font and images are all inlined, so the page needs nothing
// but itself.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-demo');
const exported = path.join(out, 'export');

console.log('› Exporting the web app in demo mode');
fs.rmSync(out, { recursive: true, force: true });
execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear', '--output-dir', exported], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    EXPO_PUBLIC_DEMO: '1',
    EXPO_PUBLIC_SUPABASE_URL: '',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
    EXPO_PUBLIC_WEB_URL: '',
    EXPO_OFFLINE: process.env.EXPO_OFFLINE ?? '1',
    CI: '1',
  },
});

const html = fs.readFileSync(path.join(exported, 'index.html'), 'utf8');
const src = /<script src="([^"]+\.js)"[^>]*><\/script>/.exec(html)?.[1];
if (!src) throw new Error('No script tag in the exported index.html');
let bundle = fs.readFileSync(path.join(exported, src), 'utf8');

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

// Asset paths are plain string literals in the bundle; swap each for a data: URI.
let inlined = 0;
bundle = bundle.replace(/(["'])(\/assets\/[^"']+?\.(png|jpe?g|gif|webp|ttf|otf|woff2?))\1/g, (whole, quote, file, ext) => {
  const onDisk = path.join(exported, decodeURIComponent(file));
  if (!fs.existsSync(onDisk)) return whole;
  inlined++;
  return `${quote}data:${MIME[ext]};base64,${fs.readFileSync(onDisk).toString('base64')}${quote}`;
});
if (/["']\/assets\//.test(bundle)) throw new Error('An asset in the bundle was left as a path');

// Keep the HTML parser from ending the script early. Both escapes mean the
// same thing inside JavaScript strings, templates and comments.
bundle = bundle.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const body = `<title>PotongKu</title>
<style>
  /* The app draws every screen itself; this only gives it the whole window. */
  :root { --page: #F7F6F3; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page: #0F1115; color-scheme: dark; } }
  :root[data-theme="dark"] { --page: #0F1115; color-scheme: dark; }
  html, body { height: 100%; }
  body { overflow: hidden; background: var(--page); }
  /* Fixed to the edges: the app keeps clear of notches and home bars itself. */
  #root { position: fixed; inset: 0; display: flex; }
</style>
<noscript>PotongKu needs JavaScript to run.</noscript>
<div id="root"></div>
<script>
  // The app finds its screens by path, and a host may serve this page from any
  // path, so start at the front door.
  try { if (location.pathname !== '/') history.replaceState(null, '', '/'); } catch (e) {}
</script>
<script>${bundle}</script>
`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body>
${body}</body>
</html>
`;

fs.writeFileSync(path.join(out, 'demo.html'), body);
fs.writeFileSync(path.join(out, 'index.html'), page);
fs.rmSync(exported, { recursive: true, force: true });
const size = (fs.statSync(path.join(out, 'demo.html')).size / 1024 / 1024).toFixed(1);
console.log(`› dist-demo/demo.html and dist-demo/index.html (${size} MB, ${inlined} assets inlined)`);
