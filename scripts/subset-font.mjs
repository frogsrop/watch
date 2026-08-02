/**
 * Пересборка src/public/fonts/inter-variable.woff2 из полного Inter Variable.
 *
 * Полный файл — 352 КБ (2937 глифов: латиница, кириллица, греческий,
 * вьетнамский, все оси). На холодном заходе в комнату это было 69% всего
 * трафика до первого кадра видео, причём он ещё и в rel=preload, то есть
 * тянулся с высоким приоритетом одновременно с hls.min.js.
 *
 * Что делаем: режем глифы, но НЕ трогаем оси (opsz 14–32, wght 100–900) и
 * фичи cv11/ss03, которые включает styles.css — рендер обязан остаться прежним.
 * Результат ~85 КБ.
 *
 * Набор символов = фиксированные диапазоны (латиница + кириллица + пунктуация:
 * названия сезонов и озвучек приходят с CDN, в репозитории их нет) ПЛЮС всё
 * непечатное, что реально встретилось в исходниках UI — «★» в бейдже лидера и
 * «→» на лендинге живут именно там и в стандартные диапазоны не попадают.
 * После сборки проверяем, что каждый такой символ на месте: молча потерянный
 * глиф выглядит как прямоугольник в интерфейсе и на CI не ловится.
 *
 * Требуется Python с fonttools:  pip install "fonttools[woff]" brotli
 *
 * Исходный полный шрифт в репозитории не лежит. Взять из истории:
 *   git show db06cb0:src/public/fonts/inter-variable.woff2 > /tmp/inter-full.woff2
 * либо скачать Inter Variable с github.com/rsms/inter/releases.
 *
 *   node scripts/subset-font.mjs <путь-к-полному-шрифту>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SRC = process.argv[2];
const OUT = 'src/public/fonts/inter-variable.woff2';
const SCAN = [
  'src/public/index.html',
  'src/public/room.html',
  'src/public/player.js',
  'src/public/styles.css',
];

// Латиница-1, кириллица (вкл. украинские і/ї/є/ґ — так подписаны дорожки
// субтитров), общая пунктуация, валюта, №. Покрывает динамические заголовки.
const BASE_RANGES = [
  'U+0000-00FF', 'U+0131', 'U+0152-0153', 'U+2000-206F', 'U+20AC',
  'U+2122', 'U+2212', 'U+2215', 'U+0400-045F', 'U+0490-0491', 'U+2116',
];

function inBase(cp) {
  return BASE_RANGES.some((r) => {
    const body = r.slice(2);
    if (!body.includes('-')) return cp === parseInt(body, 16);
    const [a, b] = body.split('-');
    return cp >= parseInt(a, 16) && cp <= parseInt(b, 16);
  });
}

if (!SRC) {
  console.error('usage: node scripts/subset-font.mjs <full-inter-variable.woff2|.ttf>');
  process.exit(1);
}

// Всё, что не ASCII, из исходников UI — вместе с местом, где встретилось.
const used = new Map();
for (const file of SCAN) {
  for (const ch of readFileSync(file, 'utf8')) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7f) (used.get(cp) ?? used.set(cp, new Set()).get(cp)).add(file);
  }
}
const extra = [...used.keys()].filter((cp) => !inBase(cp)).sort((a, b) => a - b);
if (extra.length) {
  console.log('вне базовых диапазонов, добавляю:');
  for (const cp of extra) {
    console.log(`  U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(cp)}  ← ${[...used.get(cp)].join(', ')}`);
  }
}
const unicodes = [...BASE_RANGES, ...extra.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)].join(',');

const tmp = mkdtempSync(join(tmpdir(), 'watch-font-'));
const py = (args) => execFileSync('python', args, { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  // pyftsubset не читает woff2 напрямую — распаковываем в ttf.
  const ttf = join(tmp, 'src.ttf');
  py(['-c', `from fontTools.ttLib import TTFont; f=TTFont(r'${SRC}'); f.flavor=None; f.save(r'${ttf}')`]);
  py([
    '-m', 'fontTools.subset', ttf,
    `--output-file=${OUT}`,
    '--flavor=woff2',
    // += вместо =: список по умолчанию (ccmp, kern, mark, locl…) сохраняется,
    // а cv11/ss03 из font-feature-settings в styles.css добавляются к нему.
    '--layout-features+=cv11,ss03,tnum',
    '--drop-tables+=DSIG',
    `--unicodes=${unicodes}`,
  ]);

  const check = py(['-c', `
from fontTools.ttLib import TTFont
f = TTFont(r'${OUT}')
cm = f.getBestCmap()
feats = {r.FeatureTag for r in f['GSUB'].table.FeatureList.FeatureRecord}
missing = [cp for cp in [${[...used.keys()].join(',')}] if cp not in cm]
print('|'.join([
    str(f['maxp'].numGlyphs),
    ' '.join(f'{a.axisTag}:{a.minValue:g}-{a.maxValue:g}' for a in f['fvar'].axes),
    'ok' if {'cv11','ss03'} <= feats else 'MISSING-FEATURES',
    ','.join(hex(c) for c in missing),
]))`]).toString().trim();

  const [glyphs, axes, features, missing] = check.split('|');
  console.log(`\n${OUT}  ${statSync(OUT).size} байт, ${glyphs} глифов`);
  console.log(`оси: ${axes}`);
  if (features !== 'ok') throw new Error('потеряны фичи cv11/ss03 — styles.css их включает');
  if (missing) throw new Error(`в подмножестве нет символов: ${missing}`);
  if (!axes.includes('opsz') || !axes.includes('wght')) {
    throw new Error('потеряна ось — рендер изменится');
  }
  console.log('проверка пройдена: все использованные символы, обе оси и cv11/ss03 на месте');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
