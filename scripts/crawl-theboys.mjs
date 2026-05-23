#!/usr/bin/env node
// Локальный crawler theboys.fun → JSON cache.
// theboys.fun блокирует datacenter IPs, но plplayer.online (его embed) принимает запросы
// с Referer = https://www.theboys.fun/. Curl'ом грузим iframe-страницу, регэксом
// вырезаем data-playlist JSON-блок где лежит вся структура серии (season×episode×voice).
//
// Использование:
//   node scripts/crawl-theboys.mjs <slug> [series_id] [voice]
//   node scripts/crawl-theboys.mjs pacany 424 1
//
// Запускать с residential IP — datacenter заблокирован.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const slug = process.argv[2] || 'pacany';
const seriesId = process.argv[3] || '424';
const voice = process.argv[4] || '1';
const PLPLAYER = `https://plplayer.online/s/${seriesId}?season=1&episode=1&voice=${voice}`;
const REFERER = 'https://www.theboys.fun/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

console.error(`crawling ${PLPLAYER}`);
const res = await fetch(PLPLAYER, { headers: { Referer: REFERER, 'User-Agent': UA } });
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();
console.error(`got ${html.length} bytes`);

const m = html.match(/data-playlist="([0-9]+)"[^>]*>(\{[\s\S]+?\})<\/div>/);
if (!m) {
  console.error('inputData JSON block not found');
  process.exit(1);
}
const playlistId = Number(m[1]);
const data = JSON.parse(m[2]);

const out = {
  source: 'theboys.fun',
  slug,
  playlist_id: playlistId,
  extracted_at: new Date().toISOString(),
  seasons: [],
};

for (const seasonKey of Object.keys(data).sort((a, b) => Number(a) - Number(b))) {
  const seasonNum = Number(seasonKey);
  const eps = data[seasonKey];
  const seasonOut = { season: seasonNum, episodes: [] };
  for (const epKey of Object.keys(eps).sort((a, b) => Number(a) - Number(b))) {
    const epNum = Number(epKey);
    if (epNum === 0) continue; // 0 = трейлер/special, пропускаем
    const voices = eps[epKey].map((v) => ({
      voice_id: v.voice_id,
      voice_name: v.voice_name,
      video_id: v.video_id,
      duration: v.duration,
    }));
    seasonOut.episodes.push({ episode: epNum, voices });
  }
  if (seasonOut.episodes.length) out.seasons.push(seasonOut);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'data', `theboys-${slug}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

const totalEps = out.seasons.reduce((a, s) => a + s.episodes.length, 0);
const totalVoices = out.seasons.reduce(
  (a, s) => a + s.episodes.reduce((b, e) => b + e.voices.length, 0),
  0,
);
console.error(
  `saved ${outPath}: ${out.seasons.length} seasons, ${totalEps} episodes, ${totalVoices} (season,ep,voice) tuples`,
);
