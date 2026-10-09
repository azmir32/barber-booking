/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeHtml, POSTER_TEXT, posterHtml } from './poster.ts';
import { setCurrentLang } from './lang.ts';

const LINK = 'https://potongku.my/shop/kemas-barber-kajang';

test('posterHtml is a whole A4 page with the QR code and the link', () => {
  const html = posterHtml({ shopName: 'Kemas Barber', link: LINK, area: 'Kajang' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('size: A4'));
  assert.ok(html.includes('<svg '));
  assert.ok(html.includes('<h1>Kemas Barber</h1>'));
  assert.ok(html.includes('Kajang'));
  assert.ok(html.includes(`<p class="link">${LINK}</p>`));
  assert.match(html, /<\/html>\s*$/);
});

test('posterHtml escapes what the barber typed', () => {
  const html = posterHtml({
    shopName: 'Ah Seng & Sons <b>"Best"</b>',
    link: 'https://potongku.my/shop/a?x=1&y=<2>',
    area: "Kajang's <i>",
  });
  assert.ok(html.includes('<h1>Ah Seng &amp; Sons &lt;b&gt;&quot;Best&quot;&lt;/b&gt;</h1>'));
  assert.ok(html.includes('<title>Ah Seng &amp; Sons'));
  assert.ok(html.includes('https://potongku.my/shop/a?x=1&amp;y=&lt;2&gt;'));
  assert.ok(html.includes('Kajang&#39;s &lt;i&gt;'));
  assert.ok(!html.includes('<b>') && !html.includes('<i>'));
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('posterHtml is in English and Malay whatever the app language', () => {
  try {
    for (const lang of ['en', 'ms'] as const) {
      setCurrentLang(lang);
      const html = posterHtml({ shopName: 'Kemas Barber', link: LINK });
      for (const line of ['Book your cut online', 'Tempah potongan rambut dalam talian', 'Scan with your phone camera']) {
        assert.ok(html.includes(line), line);
      }
      for (const line of [...POSTER_TEXT.headline, ...POSTER_TEXT.scan]) assert.ok(html.includes(line), line);
    }
  } finally {
    setCurrentLang('en');
  }
});

test('posterHtml leaves out the area when there is none', () => {
  assert.ok(!posterHtml({ shopName: 'Kemas Barber', link: LINK }).includes('class="area"'));
  assert.ok(!posterHtml({ shopName: 'Kemas Barber', link: LINK, area: '' }).includes('class="area"'));
});

test('long shop names get smaller type', () => {
  const size = (name: string) => Number(/h1 \{[^}]*font-size: (\d+)pt/.exec(posterHtml({ shopName: name, link: LINK }))![1]);
  assert.ok(size('Kemas Barber') > size('Kedai Gunting Rambut Pak Abu dan Anak-Anak Kajang'));
});
