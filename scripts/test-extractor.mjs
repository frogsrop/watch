import { extractM3U8, closeBrowser } from '../dist/extractor.js';

const URL = process.argv[2] || 'https://lv.kinogo.ec/9957--pacany-1.html';

process.env.WATCH_HEADLESS = '0';
process.env.WATCH_CHROME_CHANNEL = process.env.WATCH_CHROME_CHANNEL || 'chrome';
process.env.WATCH_DEBUG = '1';

console.log(`=== extract default selection from ${URL} ===`);
const t0 = Date.now();
const result = await extractM3U8(URL);
console.log(`done in ${(Date.now() - t0) / 1000}s`);
console.log(`seasons: ${result.structure.seasons.length}`);
for (const s of result.structure.seasons) {
  console.log(`  ${s.id} (${s.title}): ${s.episodes.length} ep, ${s.episodes[0]?.voices.length ?? 0} voices`);
}
console.log('current:', result.current);
console.log('m3u8:', result.m3u8.slice(0, 120));

await closeBrowser();
