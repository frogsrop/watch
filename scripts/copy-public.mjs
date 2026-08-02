import { cp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const OUT = 'dist/public';

// Чистим перед копированием: cp только накладывает файлы поверх, поэтому
// удалённое из src/public оставалось бы в сборке и продолжало отдаваться, а
// сгенерированные .br/.gz от прошлого билда попадали бы в карту хешей.
await rm(OUT, { recursive: true, force: true });
await cp('src/public', OUT, { recursive: true });

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Ключ в карте хешей — путь от корня статики через прямые слэши. */
const assetKey = (path) => relative(OUT, path).split(sep).join('/');
const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

// Хеш содержимого в ссылке даёт браузеру право не переспрашивать файл вообще:
// адрес меняется ровно тогда, когда меняется содержимое. Без этого имена файлов
// не менялись между деплоями, поэтому срок жизни приходилось держать в час — и
// каждый повторный заход в комнату упирался в три условных запроса ПЕРЕД тем,
// как плеер вообще начнёт грузиться.
const hashes = {};

// Сначала листья — то, на что ссылаются из CSS. Их хеш должен быть известен до
// того, как посчитан хеш самого CSS, иначе правка шрифта не доедет до зрителя.
for await (const path of walk(OUT)) {
  if (extname(path) === '.css') continue;
  hashes[assetKey(path)] = hashOf(await readFile(path));
}

for await (const path of walk(OUT)) {
  if (extname(path) !== '.css') continue;
  const dir = assetKey(path).split('/').slice(0, -1).join('/');
  // url('fonts/inter-variable.woff2') → url('fonts/inter-variable.woff2?h=…').
  // Пути в CSS относительные (так оно работает под любым PUBLIC_BASE_PATH),
  // поэтому ключ собираем от каталога самого файла.
  const css = (await readFile(path, 'utf8')).replace(
    /url\((['"]?)([^'")?#]+)\1\)/g,
    (whole, quote, ref) => {
      if (/^(https?:)?\/\/|^data:/.test(ref)) return whole;
      const key = [dir, ref].filter(Boolean).join('/');
      return hashes[key] ? `url(${quote}${ref}?h=${hashes[key]}${quote})` : whole;
    },
  );
  await writeFile(path, css);
  hashes[assetKey(path)] = hashOf(Buffer.from(css));
}

await writeFile(join(OUT, 'asset-hashes.json'), JSON.stringify(hashes, null, 2));

// Кладём рядом с каждым текстовым файлом .br и .gz — их отдаёт @fastify/static
// с preCompressed. Жать на билде максимальным уровнем можно спокойно: это
// секунда один раз за деплой вместо gzip-5 на каждый запрос, а разница как раз
// на файле, который держит старт плеера (hls.min.js, ~130 КБ gzip → ~103 КБ br).
// woff2 не трогаем — он уже сжат, повторное сжатие только раздувает.
// Идёт последним: CSS выше переписан, сжимать надо итоговый.
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.html', '.json', '.map']);
const MIN_BYTES = 1024;

let count = 0;
for await (const path of walk(OUT)) {
  if (!COMPRESSIBLE.has(extname(path))) continue;
  if ((await stat(path)).size < MIN_BYTES) continue;
  const raw = await readFile(path);
  const [br, gzipped] = await Promise.all([
    brotli(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
    gz(raw, { level: 9 }),
  ]);
  await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gzipped)]);
  count++;
}

console.log(
  `Copied src/public → ${OUT} (хешей: ${Object.keys(hashes).length}, предсжато файлов: ${count})`,
);
