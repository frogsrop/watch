import { readFileSync, writeFileSync } from 'node:fs';
import { extractCinemarFileField, decodeCinemarPlaylistBin } from '../dist/cinemar-decode.js';

const html = readFileSync('_research/embed.html', 'utf8');
const file = extractCinemarFileField(html);
const bin = decodeCinemarPlaylistBin(file);
writeFileSync('_research/bin.txt', bin);
console.log('bin length:', bin.length);
const pos = 5004;
console.log(`at ${pos - 30}-${pos + 50}:`, JSON.stringify(bin.slice(pos - 30, pos + 50)));
console.log('chars around pos:', bin.charCodeAt(pos - 2), bin.charCodeAt(pos - 1), bin.charCodeAt(pos), bin.charCodeAt(pos + 1));
