#!/usr/bin/env node
// Локальный crawler kinomix.web.app → JSON cache.
//
// api.kinobox.tv (агрегатор плееров который kinomix юзает) делает TLS-фингерпринтинг
// и блокирует не-браузерные клиенты (curl, undici/fetch — TLS handshake принимается,
// но request body отбрасывается). Используем Playwright с реальным Chrome — он
// проходит. api.ortified.ws (Collaps/venom) на VPS доступен через обычный curl;
// маппинг (kinopoisk_id → ortified_id) собираем здесь, шипим в data/kinomix-cache.json,
// а runtime extraction в extractor.ts captureFromKinomix() дёргает api.ortified.ws
// напрямую через undici.
//
// Использование:
//   node scripts/crawl-kinomix.mjs <kinopoisk_id> [<kinopoisk_id> ...]
//   node scripts/crawl-kinomix.mjs 277565 454920

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cachePath = resolve(__dirname, '..', 'data', 'kinomix-cache.json');

const cache = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, 'utf-8'))
  : { source: 'kinomix.web.app', entries: {} };

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: node scripts/crawl-kinomix.mjs <kinopoisk_id> [...]');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
// api.kinobox.tv ругается на прямой goto (HTTP/2 PROTOCOL_ERROR), но из контекста
// kinomix.web.app браузерный fetch проходит. Грузим kinomix один раз, потом
// делаем fetch() через page.evaluate.
console.error('warming up kinomix.web.app...');
await page.goto('https://kinomix.web.app/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(2000);

try {
  for (const kpId of ids) {
    console.error(`[${kpId}] fetch api.kinobox.tv via kinomix context`);
    try {
      const json = await page.evaluate(async (id) => {
        const r = await fetch(`https://api.kinobox.tv/api/players?kinopoisk=${id}`, {
          credentials: 'omit',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      }, kpId);
      const collaps = (json.data || []).find((p) => p.type === 'Collaps');
      if (!collaps || !collaps.iframeUrl) {
        console.error(`[${kpId}] Collaps не доступен`);
        continue;
      }
      const m = collaps.iframeUrl.match(/api\.ortified\.ws\/embed\/movie\/(\d+)/);
      if (!m) {
        console.error(`[${kpId}] не распарсил ortified_id из ${collaps.iframeUrl}`);
        continue;
      }
      const ortifiedId = Number(m[1]);
      cache.entries[String(kpId)] = {
        kinopoisk_id: Number(kpId),
        ortified_id: ortifiedId,
        title: null,
        updated_at: new Date().toISOString(),
      };
      console.error(`[${kpId}] → ortified_id=${ortifiedId}`);
    } catch (e) {
      console.error(`[${kpId}] error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
} finally {
  await browser.close();
}

cache.updated_at = new Date().toISOString();
mkdirSync(dirname(cachePath), { recursive: true });
writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
console.error(`saved ${cachePath} (${Object.keys(cache.entries).length} entries)`);
