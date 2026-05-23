// Поймать decoded playlist в момент когда player.js его парсит.
// Стратегия: addInitScript в iframe context — переопределяем JSON.parse чтобы захватить
// массив с .folder (это и есть playlist).

import { chromium } from 'playwright';

const KINOGO_URL = process.argv[2] || 'https://lv.kinogo.ec/9957--pacany-1.html';

const browser = await chromium.launch({
  channel: process.env.WATCH_CHROME_CHANNEL || 'chrome',
  headless: false,
});
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
});

// Инжектируем в КАЖДУЮ страницу/iframe init script:
// перехватываем JSON.parse, копим все массивы с .folder
await ctx.addInitScript(() => {
  const captured = [];
  const orig = JSON.parse;
  JSON.parse = function (s, reviver) {
    const r = orig.call(this, s, reviver);
    try {
      if (Array.isArray(r) && r.length > 0 && r[0]?.folder) {
        captured.push(r);
      }
    } catch {}
    return r;
  };
  Object.defineProperty(window, '__capturedPlaylists', {
    get: () => captured,
    configurable: true,
  });
});

const page = await ctx.newPage();
await page.goto(KINOGO_URL, { waitUntil: 'domcontentloaded' });

// Wait for Cloudflare
for (let i = 0; i < 30; i++) {
  const title = await page.title();
  if (!/just a moment|checking your browser/i.test(title)) break;
  await page.waitForTimeout(500);
}

// Activate lazy iframe
await page.evaluate(() => {
  const f = document.querySelector('iframe.lazy, iframe[data-src*="cinemar"]');
  if (f && f.dataset?.src) f.src = f.dataset.src;
  f?.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(5000);

const frames = page.frames();
const cinemar = frames.find((f) => /cinemar|cinemap/.test(f.url()));
if (!cinemar) {
  console.log('no cinemar frame');
  await browser.close();
  process.exit(1);
}
console.log('cinemar frame:', cinemar.url().slice(0, 90));

// Wait for playerjs to parse
await page.waitForTimeout(4000);

const result = await cinemar.evaluate(() => {
  const caps = window.__capturedPlaylists || [];
  // берём самый «толстый» — у него больше всего данных
  const playlist = caps.reduce((best, p) => {
    if (!best) return p;
    const score = (a) =>
      a.reduce(
        (sum, s) =>
          sum +
          (s.folder || []).reduce(
            (s2, e) => s2 + (e.folder ? e.folder.length : (e.file ? 1 : 0)),
            0,
          ),
        0,
      );
    return score(p) > score(best) ? p : best;
  }, null);
  if (!playlist) return { err: 'no playlist captured' };

  return playlist.slice(0, 5).map((s) => ({
    id: s.id,
    title: s.title,
    episodes: (s.folder || []).slice(0, 2).map((e) => ({
      id: e.id,
      title: e.title,
      voices: (e.folder || []).slice(0, 3).map((v) => ({
        voice_id: v.voice_id,
        title: v.title?.slice(0, 50),
        file: v.file?.slice(0, 120),
      })),
      totalVoices: (e.folder || []).length,
    })),
    totalEpisodes: (s.folder || []).length,
  }));
});
console.log(JSON.stringify(result, null, 2));

await browser.close();
