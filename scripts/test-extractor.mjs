import { extractM3U8, probePlayer, closeBrowser } from '../dist/extractor.js';

const URL = 'https://lv.kinogo.ec/9957--pacany-1.html';

process.env.WATCH_HEADLESS = '0';
process.env.WATCH_CHROME_CHANNEL = process.env.WATCH_CHROME_CHANNEL || 'chrome';
process.env.WATCH_DEBUG = '1';

console.log('=== probe ===');
const t0 = Date.now();
const playlist = await probePlayer(URL);
console.log(`probe done in ${(Date.now() - t0) / 1000}s`);
console.log(`seasons: ${playlist.seasons.length}`);
for (const s of playlist.seasons) {
  console.log(`  ${s.id} (${s.title}): ${s.episodes.length} eps`);
}

console.log('\n=== extract S5E3 Кубик в Кубе ===');
const t1 = Date.now();
const result = await extractM3U8(URL, {
  season: 'Сезон 5',
  episode: 'Серия 3',
  voice: 'Кубик в Кубе',
});
console.log(`extract done in ${(Date.now() - t1) / 1000}s`);
console.log('current:', result.current);
console.log('m3u8:', result.m3u8.slice(0, 120));

await closeBrowser();
