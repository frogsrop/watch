// Probe: что cinemar player выставляет в window после загрузки.
// Запускать ЛОКАЛЬНО (не через VPS) с настоящим Chrome — Playwright Chromium bundled
// не имеет H.264, и playerjs может отказаться загружать.
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
await ctx.addInitScript(`
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
`);
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
await page.waitForTimeout(3000);

const frames = page.frames();
const cinemar = frames.find((f) => /cinemar|cinemap/.test(f.url()));
if (!cinemar) {
  console.log('no cinemar frame found. frames:', frames.map((f) => f.url()).slice(0, 5));
  await browser.close();
  process.exit(1);
}
console.log('cinemar frame:', cinemar.url().slice(0, 90));

// Wait for playerjs to init
await page.waitForTimeout(5000);

const info = await cinemar.evaluate(() => {
  const w = window;
  const out = {};
  const p = w.pljssglobal?.[0];
  if (!p) return { err: 'no pljssglobal[0]' };

  // Все API calls которые могут вернуть полезное
  const apiCalls = ['playlist', 'audiotracks', 'time', 'duration', 'video'];
  out.apiResults = {};
  for (const cmd of apiCalls) {
    try {
      const r = p.api(cmd);
      out.apiResults[cmd] = JSON.stringify(r)?.slice(0, 300) || 'undefined';
    } catch (e) {
      out.apiResults[cmd] = 'err: ' + e.message;
    }
  }

  // Все enumerable properties (включая non-own)
  const allProps = new Set();
  let cur = p;
  while (cur && cur !== Object.prototype) {
    Object.getOwnPropertyNames(cur).forEach((n) => allProps.add(n));
    cur = Object.getPrototypeOf(cur);
  }
  out.allPlayerProps = [...allProps].slice(0, 50);

  // Поиск decoded playlist в любых глобалах: ищем массив со {folder:[...]}
  const found = [];
  const scanned = new Set();
  function scan(obj, path, depth) {
    if (depth > 3 || scanned.has(obj) || !obj || typeof obj !== 'object') return;
    scanned.add(obj);
    if (Array.isArray(obj) && obj.length > 0 && obj[0]?.folder) {
      found.push({ path, len: obj.length, firstId: obj[0].id, firstTitle: obj[0].title });
      return;
    }
    try {
      for (const k of Object.keys(obj).slice(0, 30)) {
        if (k.startsWith('_') && depth > 0) continue;
        scan(obj[k], path + '.' + k, depth + 1);
      }
    } catch {}
  }
  for (const k of Object.keys(w)) {
    if (typeof w[k] === 'object') {
      scan(w[k], 'window.' + k, 0);
    }
  }
  out.foundPlaylists = found.slice(0, 10);
  return out;
});
console.log(JSON.stringify(info, null, 2));

await browser.close();
