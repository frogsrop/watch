import { readFileSync } from 'node:fs';
import { decodeCinemarEmbedHtml } from '../dist/cinemar-decode.js';

const html = readFileSync(process.argv[2] || '_research/embed.html', 'utf8');
const t0 = Date.now();
const playlist = decodeCinemarEmbedHtml(html);
const ms = Date.now() - t0;

console.log(`decoded in ${ms}ms`);
console.log(`seasons: ${playlist.seasons.length}`);
for (const s of playlist.seasons) {
  console.log(`  ${s.id} (${s.title}): ${s.episodes.length} episodes`);
  for (const e of s.episodes.slice(0, 2)) {
    console.log(`    ${e.id} (${e.title}): ${e.voices.length} voices`);
    for (const v of e.voices.slice(0, 3)) {
      console.log(`      voice_id=${v.voice_id} "${v.title}" → ${v.file.slice(0, 80)}...`);
    }
    if (e.voices.length > 3) console.log(`      ... +${e.voices.length - 3} more voices`);
  }
  if (s.episodes.length > 2) console.log(`    ... +${s.episodes.length - 2} more episodes`);
}
