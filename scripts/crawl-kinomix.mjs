#!/usr/bin/env node
// Локальный crawler kinomix.web.app → JSON cache.
//
// api.kinobox.tv (агрегатор плееров который kinomix юзает) делает TLS-фингерпринтинг
// и блокирует не-браузерные клиенты (curl, undici/fetch — TLS handshake принимается,
// но request body отбрасывается). Используем Playwright с реальным Chrome — он
// проходит. Из ответа kinobox достаём:
//   - Collaps iframeUrl → ortified_id  (доступен с VPS через undici)
//   - Flixcdn iframeUrl → factorios.live HTML → __PLAYER_PAYLOAD__ JSON
//     (id, seasons_episodes, translations). VPS-side m3u8 resolve требует
//     Cloudflare Turnstile-pass (POST /api/player/files), делается через
//     shared Playwright из extractor.ts.
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

      const entry = {
        kinopoisk_id: Number(kpId),
        title: null,
        updated_at: new Date().toISOString(),
      };

      // Collaps (player-venom на api.ortified.ws)
      const collaps = (json.data || []).find((p) => p.type === 'Collaps');
      if (collaps?.iframeUrl) {
        const m = collaps.iframeUrl.match(/api\.ortified\.ws\/embed\/movie\/(\d+)/);
        if (m) {
          entry.ortified_id = Number(m[1]);
          console.error(`[${kpId}] collaps ortified_id=${entry.ortified_id}`);
        } else {
          console.error(`[${kpId}] collaps: не распарсил ortified_id из ${collaps.iframeUrl}`);
        }
      } else {
        console.error(`[${kpId}] Collaps не доступен`);
      }

      // Flixcdn (factorios.live) — забираем __PLAYER_PAYLOAD__ напрямую.
      // GET /show/kinopoisk/<id> отдаёт inline JSON со структурой
      // (id, is_serial, seasons_episodes, translations). Runtime m3u8 resolve
      // делается через Playwright на VPS (нужен Turnstile-pass).
      const flixcdn = (json.data || []).find((p) => p.type === 'Flixcdn');
      if (flixcdn?.iframeUrl) {
        try {
          // Cross-origin fetch блокируется Cloudflare — открываем embed-page в
          // отдельном табе и читаем window.__PLAYER_PAYLOAD__ (он inline в HTML).
          const flixPage = await ctx.newPage();
          await flixPage.goto(flixcdn.iframeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          const payload = await flixPage.evaluate(() => window.__PLAYER_PAYLOAD__);
          await flixPage.close();
          if (!payload) throw new Error('PLAYER_PAYLOAD пуст');
          // Берём только то что нужно для extract + resolve.
          entry.flixcdn = {
            show_id: payload.id,
            is_serial: !!payload.is_serial,
            seasons_episodes: payload.seasons_episodes || (payload.episodes ? { 1: payload.episodes } : {}),
            translations: (payload.translations || []).map((t) => ({ id: t.id, title: t.title })),
          };
          const sCount = Object.keys(entry.flixcdn.seasons_episodes).length;
          const eCount = Object.values(entry.flixcdn.seasons_episodes).reduce((a, e) => a + (e?.length || 0), 0);
          console.error(
            `[${kpId}] flixcdn show_id=${entry.flixcdn.show_id} (${sCount} seasons, ${eCount} eps, ${entry.flixcdn.translations.length} voices)`,
          );
        } catch (e) {
          console.error(`[${kpId}] flixcdn payload error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
        }
      }

      // Videoseed (tv-1-kinoserial.net) — сохраняем iframe URL с токеном.
      // Token имеет TTL (точно неизвестен, скорее всего дни-недели); при истечении
      // надо re-crawl. Резолв m3u8 происходит в extractor.ts через Playwright
      // (Playerjs("...") → strip 2 + strip |||...== → base64).
      const videoseed = (json.data || []).find((p) => p.type === 'Videoseed');
      if (videoseed?.iframeUrl) {
        entry.videoseed_iframe = videoseed.iframeUrl;
        console.error(`[${kpId}] videoseed iframe saved`);
      }

      // Vibix (coldfilm.ink + kinescopecdn.net) — для lampac-flow достаточно
      // только kp_id (передаётся в data-id публишер-SDK). Сохраняем флаг
      // что Vibix доступен (на случай если для kp_id Vibix не возвращает данных).
      const vibix = (json.data || []).find((p) => p.type === 'Vibix');
      if (vibix?.iframeUrl) {
        entry.vibix_available = true;
        console.error(`[${kpId}] vibix flagged`);
      }

      if (!entry.ortified_id && !entry.flixcdn && !entry.videoseed_iframe && !entry.vibix_available) {
        console.error(`[${kpId}] нет ни одного провайдера — пропускаем`);
        continue;
      }
      cache.entries[String(kpId)] = entry;
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
