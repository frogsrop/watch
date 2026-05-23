import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface VoiceInfo {
  voice_id?: number;
  title: string;
  file: string;
  // Для venom-player'а (lordfilm): озвучка = audio track в одном master.m3u8.
  // Если задано — клиент после loadSource выставит hls.audioTrack = audioTrack.
  audioTrack?: number;
}

export interface SubtitleInfo {
  url: string;
  name: string;
  lang?: string;
}

export interface EpisodeInfo {
  id: string;
  title: string;
  voices: VoiceInfo[];
  subtitles?: SubtitleInfo[];
}

export interface SeasonInfo {
  id: string;
  title: string;
  episodes: EpisodeInfo[];
}

export interface PlayerStructure {
  seasons: SeasonInfo[];
}

export interface ExtractResult {
  m3u8: string;
  referer: string;
  cookies: { name: string; value: string; domain: string; path: string }[];
  userAgent: string;
  structure: PlayerStructure;
  current: {
    seasonId: string;
    episodeId: string;
    voiceId?: number;
    voiceTitle: string;
    audioTrack?: number;
  };
}

export interface SelectionOpts {
  season?: string; // either "Сезон 5", "s05", "5", or full season label
  episode?: string;
  voice?: string;
}

export class ExtractorError extends Error {
  constructor(
    message: string,
    readonly stage: 'launch' | 'cloudflare' | 'iframe' | 'playlist' | 'select',
  ) {
    super(message);
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HEADLESS = process.env.WATCH_HEADLESS !== '0';
const CHROME_CHANNEL = process.env.WATCH_CHROME_CHANNEL || undefined;
const DEBUG = process.env.WATCH_DEBUG === '1';

const STEALTH_INIT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {} };
`;

// Перехват JSON.parse — playerjs/cinemar декодирует playlist через JSON.parse(decodedString).
// Сериал: массив сезонов с .folder. Фильм: плоский массив озвучек с .file.
// Ловим оба варианта; score-function отфильтрует false-positives.
const CAPTURE_INIT = `
(() => {
  const caps = [];
  const orig = JSON.parse;
  JSON.parse = function(s, reviver) {
    const r = orig.call(this, s, reviver);
    try {
      if (Array.isArray(r) && r.length > 0 && r[0] && (r[0].folder || r[0].file)) caps.push(r);
    } catch (e) {}
    return r;
  };
  Object.defineProperty(window, '__capturedPlaylists', {
    get: () => caps,
    configurable: true,
  });
})();
`;

// Lordfilm/femd embed: парсим playlist напрямую из HTML-ответа api.femd.ws/embed/movie/*.
// JS-side hook на VenomPlayer.make не работает: player-venom использует
// Object.defineProperty(window, 'VenomPlayer', {value: ..., writable: true, configurable: true})
// что ПЕРЕОПРЕДЕЛЯЕТ accessor-property с нашим setter'ом. Поэтому ловим HTTP-ответ
// через page.on('response') и парсим инлайн `seasons:[...]`.

/** Извлекает seasons-массив из embed HTML (venom inline JS). */
function extractVenomSeasons(html: string): VenomSeason[] | null {
  const marker = 'seasons:';
  let idx = html.indexOf(marker);
  if (idx < 0) return null;
  idx += marker.length;
  while (idx < html.length && /\s/.test(html.charAt(idx))) idx++;
  if (html[idx] !== '[') return null;
  const start = idx;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (; idx < html.length; idx++) {
    const c = html[idx];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === ']') {
        idx++;
        break;
      }
    }
  }
  try {
    return JSON.parse(html.slice(start, idx));
  } catch {
    return null;
  }
}

let sharedBrowser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (launchPromise) return launchPromise;
  launchPromise = chromium
    .launch({
      headless: HEADLESS,
      channel: CHROME_CHANNEL,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
    .then((b) => {
      sharedBrowser = b;
      b.on('disconnected', () => {
        sharedBrowser = null;
      });
      return b;
    })
    .finally(() => {
      launchPromise = null;
    });
  return launchPromise;
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    const b = sharedBrowser;
    sharedBrowser = null;
    await b.close().catch(() => {});
  }
}

function dbg(...args: unknown[]): void {
  if (DEBUG) console.error('[extractor]', ...args);
}

async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser().catch((e) => {
    throw new ExtractorError(`failed to launch chromium: ${(e as Error).message}`, 'launch');
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    extraHTTPHeaders: { 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' },
  });
  await ctx.addInitScript(STEALTH_INIT);
  await ctx.addInitScript(CAPTURE_INIT);
  return ctx;
}

async function waitCloudflare(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    if (!/just a moment|checking your browser|attention required/i.test(title) && title.length > 0)
      return;
    await page.waitForTimeout(500);
  }
  throw new ExtractorError('cloudflare challenge did not resolve', 'cloudflare');
}

async function activateLazyIframes(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
      for (const f of iframes) {
        const ds = f.getAttribute('data-src');
        if (ds && (!f.src || f.src === 'about:blank' || f.src === window.location.href)) {
          f.src = ds;
          f.removeAttribute('loading');
          f.classList.remove('lazy');
        }
        try {
          f.scrollIntoView({ block: 'center' });
        } catch {}
      }
    })
    .catch(() => {});
}

interface RawPlaylistEntry {
  id?: string;
  title?: string;
  folder?: RawPlaylistEntry[];
  voice_id?: number;
  file?: string;
}

function normalizeFileUrl(file: string): string {
  let p = String(file).replace(/\\\//g, '/').trim();
  if (p.startsWith('//')) p = 'https:' + p;
  return p;
}

function structureFromCaptured(caps: RawPlaylistEntry[][]): PlayerStructure {
  // Берём captured playlist с самым большим количеством m3u8 файлов.
  // (cinemar может зарегистрировать несколько JSON.parse'ов — нам нужен фильмовый.)
  const score = (a: RawPlaylistEntry[]): number => {
    let n = 0;
    for (const s of a) {
      if (s.file) n++; // фильм: top-level voice без folder
      for (const e of s.folder ?? []) {
        for (const v of e.folder ?? []) if (v.file) n++;
        if (e.file) n++;
      }
    }
    return n;
  };
  let best: RawPlaylistEntry[] | null = null;
  let bestScore = -1;
  for (const c of caps) {
    const s = score(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (!best || bestScore === 0) return { seasons: [] };

  // cinemar иногда пихает в title флаги-img и прочие inline HTML. Чистим теги.
  const cleanTitle = (s: unknown): string =>
    String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  // Variant A: сериал — массив сезонов с folder=[episodes] и каждый episode имеет folder=[voices]
  // Variant B: фильм без сезонов — массив voices с .file (без вложенной структуры)
  const isFilm = best.every((entry) => !entry.folder && entry.file);
  if (isFilm) {
    return {
      seasons: [
        {
          id: 'film',
          title: 'Фильм',
          episodes: [
            {
              id: 'film',
              title: '1',
              voices: best.map((v) => ({
                voice_id: v.voice_id,
                title: cleanTitle(v.title),
                file: normalizeFileUrl(String(v.file ?? '')),
              })),
            },
          ],
        },
      ],
    };
  }

  const seasons: SeasonInfo[] = [];
  for (const s of best) {
    const sId = String(s.id ?? '');
    const sTitle = cleanTitle(s.title ?? sId);
    const episodes: EpisodeInfo[] = [];
    for (const e of s.folder ?? []) {
      const eId = String(e.id ?? '');
      const eTitle = cleanTitle(e.title ?? eId);
      const voices: VoiceInfo[] = [];
      for (const v of e.folder ?? []) {
        if (!v.file) continue;
        voices.push({
          voice_id: v.voice_id,
          title: cleanTitle(v.title),
          file: normalizeFileUrl(String(v.file)),
        });
      }
      if (voices.length) episodes.push({ id: eId, title: eTitle, voices });
    }
    if (episodes.length) seasons.push({ id: sId, title: sTitle, episodes });
  }
  return { seasons };
}

interface VenomEpisode {
  episode?: string | number;
  hls?: string;
  audio?: { names?: string[]; order?: number[] };
  cc?: { url?: string; name?: string }[];
}

interface VenomSeason {
  season?: string | number;
  episodes?: VenomEpisode[];
}

interface VenomConfig {
  playlist?: { seasons?: VenomSeason[]; id?: number };
}

function structureFromVenom(configs: VenomConfig[]): PlayerStructure {
  // Берём config с наибольшим числом эпизодов.
  let best: VenomConfig | null = null;
  let bestScore = 0;
  for (const cfg of configs) {
    const seasons = cfg?.playlist?.seasons;
    if (!Array.isArray(seasons)) continue;
    let n = 0;
    for (const s of seasons) for (const _ of s.episodes ?? []) n++;
    if (n > bestScore) {
      best = cfg;
      bestScore = n;
    }
  }
  if (!best || !best.playlist?.seasons) return { seasons: [] };

  const cleanTitle = (s: unknown): string =>
    String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  const seasons: SeasonInfo[] = [];
  for (const s of best.playlist.seasons) {
    const sId = String(s.season ?? '');
    if (!sId) continue;
    const sTitle = `Сезон ${sId}`;
    const episodes: EpisodeInfo[] = [];
    for (const e of s.episodes ?? []) {
      if (!e.hls) continue;
      const eId = String(e.episode ?? '');
      const eTitle = `Серия ${eId}`;
      const names = e.audio?.names ?? [];
      const order = e.audio?.order ?? names.map((_, i) => i);
      const voices: VoiceInfo[] = [];
      if (names.length > 0) {
        for (let i = 0; i < names.length; i++) {
          voices.push({
            title: cleanTitle(names[i]),
            file: String(e.hls),
            audioTrack: order[i] ?? i,
          });
        }
      } else {
        voices.push({ title: 'По умолчанию', file: String(e.hls), audioTrack: 0 });
      }
      const subtitles: SubtitleInfo[] = [];
      for (const cc of e.cc ?? []) {
        if (!cc?.url) continue;
        subtitles.push({
          url: String(cc.url),
          name: cleanTitle(cc.name) || 'Субтитры',
          lang: /рус|rus/i.test(cc.name ?? '') ? 'ru' : undefined,
        });
      }
      episodes.push({ id: eId, title: eTitle, voices, subtitles: subtitles.length ? subtitles : undefined });
    }
    if (episodes.length) seasons.push({ id: sId, title: sTitle, episodes });
  }
  return { seasons };
}

async function captureFromLordfilm(
  pageUrl: string,
  timeoutMs: number,
): Promise<{ playlist: PlayerStructure; cookies: ExtractResult['cookies'] }> {
  const context = await newContext();
  try {
    const page = await context.newPage();
    let embedBody: string | null = null;
    // Перехватываем HTTP-ответ от api.femd.ws/embed/* — там в инлайн-JS лежит
    // makePlayer({playlist: {seasons:[...]}}). Парсим seasons-массив прямо из HTML.
    page.on('response', async (res) => {
      if (embedBody) return;
      const u = res.url();
      if (/api\.femd\.ws\/embed\//.test(u)) {
        try {
          const body = await res.text();
          if (body && body.length > 500) {
            embedBody = body;
            dbg(`venom: captured femd embed response ${u} (${body.length} bytes)`);
          }
        } catch (e) {
          dbg(`venom: failed to read femd response: ${(e as Error).message}`);
        }
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // lordfilm не использует Cloudflare; embed iframe инжектится JS'ом lordfilm-страницы.
    await activateLazyIframes(page);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !embedBody) {
      await page.waitForTimeout(500);
      await activateLazyIframes(page);
    }

    if (!embedBody) {
      throw new ExtractorError('failed to capture femd embed response', 'playlist');
    }

    const seasons = extractVenomSeasons(embedBody);
    if (!seasons || seasons.length === 0) {
      throw new ExtractorError('failed to parse venom seasons from embed html', 'playlist');
    }
    const playlist = structureFromVenom([{ playlist: { seasons } }]);
    if (playlist.seasons.length === 0) {
      throw new ExtractorError('venom seasons parsed but empty after normalization', 'playlist');
    }
    const eps = playlist.seasons.reduce((acc, s) => acc + s.episodes.length, 0);
    dbg(`venom: structured ${playlist.seasons.length} seasons, ${eps} eps`);

    const cookies = await context.cookies();
    return {
      playlist,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      })),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureFromKinogo(
  pageUrl: string,
  timeoutMs: number,
): Promise<{ playlist: PlayerStructure; cookies: ExtractResult['cookies'] }> {
  const context = await newContext();
  try {
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitCloudflare(page, timeoutMs);
    await activateLazyIframes(page);

    // Ждём, пока в iframe появится Cinemar-frame и player.js его пропарсит
    const deadline = Date.now() + timeoutMs;
    let playlist: PlayerStructure | null = null;
    while (Date.now() < deadline && (!playlist || playlist.seasons.length === 0)) {
      await page.waitForTimeout(800);
      // активация iframe может срабатывать поздно (lazyload), повторяем
      await activateLazyIframes(page);
      // playerjs-эмбеды от разных провайдеров: cinemar/cinemap (kinogo),
      // plplayer/kalarona (theboys.fun), а также бывают i-trailer.ru, lv9-vid.
      const playerFrames = page.frames().filter((f) =>
        /cinemar|cinemap|plplayer|kalarona|i-trailer\.ru/.test(f.url()),
      );
      if (playerFrames.length === 0) continue;
      const caps: RawPlaylistEntry[][] = [];
      for (const pf of playerFrames) {
        const c = (await pf
          .evaluate(() => (window as unknown as { __capturedPlaylists?: unknown[][] }).__capturedPlaylists ?? [])
          .catch(() => [])) as RawPlaylistEntry[][];
        caps.push(...c);
      }
      if (caps.length > 0) {
        playlist = structureFromCaptured(caps);
        if (playlist.seasons.length > 0) {
          dbg(
            `captured ${caps.length} playlists; structure: ${playlist.seasons.length} seasons, ${playlist.seasons.reduce((s, ss) => s + ss.episodes.length, 0)} episodes`,
          );
          break;
        }
      }
    }

    if (!playlist || playlist.seasons.length === 0) {
      throw new ExtractorError('failed to capture player playlist', 'playlist');
    }

    const cookies = await context.cookies();
    return {
      playlist,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      })),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function matchSeason(
  playlist: PlayerStructure,
  selector?: string,
): SeasonInfo | null {
  if (!selector) return playlist.seasons[0] ?? null;
  const t = selector.trim();
  const numWant = t.match(/(\d+)/)?.[1];
  for (const s of playlist.seasons) {
    if (s.id === t || s.title === t) return s;
    const num = s.title.match(/(\d+)/)?.[1] ?? s.id.match(/(\d+)/)?.[1];
    if (numWant && num === numWant) return s;
  }
  return playlist.seasons[0] ?? null;
}

function matchEpisode(season: SeasonInfo, selector?: string): EpisodeInfo | null {
  if (!selector) return season.episodes[0] ?? null;
  const t = selector.trim();
  const numWant = t.match(/(\d+)/)?.[1];
  for (const e of season.episodes) {
    if (e.id === t || e.title === t) return e;
    const num = e.title.match(/(\d+)/)?.[1] ?? e.id.match(/e(\d+)/)?.[1];
    if (numWant && num === numWant) return e;
  }
  return season.episodes[0] ?? null;
}

function matchVoice(episode: EpisodeInfo, selector?: string): VoiceInfo | null {
  if (!selector) return episode.voices[0] ?? null;
  const t = selector.trim().toLowerCase();
  for (const v of episode.voices) {
    if (v.title === selector) return v;
    if (v.title.toLowerCase() === t) return v;
  }
  // partial match (например "Кубик в Кубе" → "Кубик в Кубе (Проф. двухголосый)")
  for (const v of episode.voices) {
    if (v.title.toLowerCase().startsWith(t)) return v;
  }
  return episode.voices[0] ?? null;
}

export function detectSource(url: string): 'kinogo' | 'lordfilm' | 'theboys' | 'kinomix' | null {
  if (/lordfilm/i.test(url)) return 'lordfilm';
  if (/kinogo/i.test(url)) return 'kinogo';
  if (/theboys\.fun/i.test(url)) return 'theboys';
  if (/kinomix\.web\.app/i.test(url)) return 'kinomix';
  return null;
}

// kinomix.web.app использует api.kinobox.tv в качестве плеер-агрегатора, среди
// прочего отдаёт Collaps (player-venom на api.ortified.ws) — тот же что в lordfilm.
// api.kinobox.tv блокирует datacenter IPs через TLS-фингерпринт, но api.ortified.ws
// доступен с VPS обычным undici-fetch'ом. Маппинг (kinopoisk_id → ortified_id)
// собирается локально через scripts/crawl-kinomix.mjs в data/kinomix-cache.json.
interface KinomixCacheEntry {
  kinopoisk_id: number;
  ortified_id: number;
  title?: string | null;
}
interface KinomixCache {
  source: string;
  entries: Record<string, KinomixCacheEntry>;
}

const kinomixCacheMem = new Map<string, KinomixCacheEntry>();
let kinomixCacheLoaded = false;
async function loadKinomixCache(): Promise<void> {
  if (kinomixCacheLoaded) return;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', '..', 'data', 'kinomix-cache.json'),
      join(here, '..', 'data', 'kinomix-cache.json'),
    ];
    for (const p of candidates) {
      try {
        const raw = await readFile(p, 'utf-8');
        const data = JSON.parse(raw) as KinomixCache;
        for (const [k, v] of Object.entries(data.entries ?? {})) kinomixCacheMem.set(k, v);
        break;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  kinomixCacheLoaded = true;
}

function parseKinomixUrl(pageUrl: string): { kinopoisk_id: number } | null {
  try {
    const u = new URL(pageUrl);
    if (!/kinomix\.web\.app$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:movie|tv)\/(\d+)/i);
    if (!m || !m[1]) return null;
    return { kinopoisk_id: Number(m[1]) };
  } catch {
    return null;
  }
}

async function captureFromKinomix(pageUrl: string): Promise<{
  playlist: PlayerStructure;
  cookies: ExtractResult['cookies'];
}> {
  const parsed = parseKinomixUrl(pageUrl);
  if (!parsed) throw new ExtractorError(`не парсится kinomix URL: ${pageUrl}`, 'playlist');
  await loadKinomixCache();
  const entry = kinomixCacheMem.get(String(parsed.kinopoisk_id));
  if (!entry) {
    throw new ExtractorError(
      `kinopoisk_id=${parsed.kinopoisk_id} нет в кеше — запусти scripts/crawl-kinomix.mjs ${parsed.kinopoisk_id} локально`,
      'playlist',
    );
  }
  // Прямой HTTP fetch к api.ortified.ws (тот же venom-формат что в lordfilm).
  const embedUrl = `https://api.ortified.ws/embed/movie/${entry.ortified_id}`;
  dbg(`kinomix: ${parsed.kinopoisk_id} → ortified ${entry.ortified_id}, fetching ${embedUrl}`);
  const { request } = await import('undici');
  const res = await request(embedUrl, {
    headers: {
      'user-agent': UA,
      referer: 'https://kinomix.web.app/',
    },
  });
  if (res.statusCode !== 200) {
    throw new ExtractorError(`ortified embed HTTP ${res.statusCode}`, 'playlist');
  }
  const body = await res.body.text();
  const seasons = extractVenomSeasons(body);
  if (!seasons || seasons.length === 0) {
    throw new ExtractorError('ortified body: venom seasons не извлеклись', 'playlist');
  }
  const playlist = structureFromVenom([{ playlist: { seasons } }]);
  if (playlist.seasons.length === 0) {
    throw new ExtractorError('venom seasons after normalization пусто', 'playlist');
  }
  return { playlist, cookies: [] };
}

// theboys.fun блокирует datacenter IP, поэтому Playwright-extract не работает с VPS.
// Вместо этого читаем pre-crawl'ed JSON-кеш (scripts/crawl-theboys.mjs запускается локально
// с residential IP). voiceFile хранится как маркер 'kalarona-resolve:<video_id>' — сервер
// при /hls/.../index.m3u8 fetch'ит свежий m3u8 URL у kalarona.org/player/responce.php.
interface TheboysCacheVoice {
  voice_id: number;
  voice_name: string;
  video_id: number;
  duration?: number;
}
interface TheboysCacheEpisode {
  episode: number;
  voices: TheboysCacheVoice[];
}
interface TheboysCacheSeason {
  season: number;
  episodes: TheboysCacheEpisode[];
}
interface TheboysCache {
  source: string;
  slug: string;
  playlist_id: number;
  extracted_at: string;
  seasons: TheboysCacheSeason[];
}

const theboysCacheMem = new Map<string, TheboysCache>();
async function loadTheboysCache(slug: string): Promise<TheboysCache | null> {
  const cached = theboysCacheMem.get(slug);
  if (cached) return cached;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/extractor.js → ../../data/, src/extractor.ts → ../data/
    const candidates = [
      join(here, '..', '..', 'data', `theboys-${slug}.json`),
      join(here, '..', 'data', `theboys-${slug}.json`),
    ];
    for (const p of candidates) {
      try {
        const raw = await readFile(p, 'utf-8');
        const data = JSON.parse(raw) as TheboysCache;
        theboysCacheMem.set(slug, data);
        return data;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseTheboysUrl(pageUrl: string): { slug: string; season?: number; episode?: number } | null {
  try {
    const u = new URL(pageUrl);
    if (!/theboys\.fun$/i.test(u.hostname)) return null;
    // Patterns: /pacany-{S}-sezon-{E}-seriya/, /pacany-{S}-sezon/, /pacany/
    const path = u.pathname.replace(/\/$/, '');
    let m = path.match(/^\/([\w-]+?)-(\d+)-sezon-(\d+)-seriya$/i);
    if (m && m[1] && m[2] && m[3]) return { slug: m[1].toLowerCase(), season: Number(m[2]), episode: Number(m[3]) };
    m = path.match(/^\/([\w-]+?)-(\d+)-sezon$/i);
    if (m && m[1] && m[2]) return { slug: m[1].toLowerCase(), season: Number(m[2]) };
    m = path.match(/^\/([\w-]+)$/);
    if (m && m[1]) return { slug: m[1].toLowerCase() };
    return null;
  } catch {
    return null;
  }
}

async function captureFromTheboys(pageUrl: string): Promise<{
  playlist: PlayerStructure;
  cookies: ExtractResult['cookies'];
}> {
  const parsed = parseTheboysUrl(pageUrl);
  if (!parsed) throw new ExtractorError(`не парсится theboys URL: ${pageUrl}`, 'playlist');
  const cache = await loadTheboysCache(parsed.slug);
  if (!cache) {
    throw new ExtractorError(
      `нет cache для theboys/${parsed.slug} — запусти scripts/crawl-theboys.mjs локально`,
      'playlist',
    );
  }
  const seasons: SeasonInfo[] = [];
  for (const s of cache.seasons) {
    const sId = String(s.season);
    const sTitle = `Сезон ${s.season}`;
    const episodes: EpisodeInfo[] = [];
    for (const e of s.episodes) {
      const eId = String(e.episode);
      const eTitle = `Серия ${e.episode}`;
      const voices: VoiceInfo[] = [];
      for (const v of e.voices) {
        if (!v.video_id) continue;
        voices.push({
          voice_id: v.voice_id,
          title: v.voice_name,
          file: `kalarona-resolve:${v.video_id}`,
        });
      }
      if (voices.length) episodes.push({ id: eId, title: eTitle, voices });
    }
    if (episodes.length) seasons.push({ id: sId, title: sTitle, episodes });
  }
  dbg(
    `theboys/${parsed.slug}: cache loaded, ${seasons.length} seasons, ${seasons.reduce((a, s) => a + s.episodes.length, 0)} eps`,
  );
  return { playlist: { seasons }, cookies: [] };
}

export async function extractM3U8(
  pageUrl: string,
  opts: SelectionOpts & { timeoutMs?: number } = {},
): Promise<ExtractResult> {
  const source = detectSource(pageUrl);
  if (!source) throw new ExtractorError('unsupported source url', 'playlist');
  const referer =
    source === 'lordfilm'
      ? 'https://api.femd.ws/'
      : source === 'theboys'
        ? 'https://www.theboys.fun/'
        : source === 'kinomix'
          ? 'https://kinomix.web.app/'
          : 'https://cinemar.cc/';

  // theboys.fun и kinomix.web.app обходятся без Playwright — читаем pre-crawl JSON cache.
  let effectiveOpts = opts;
  let captureResult;
  if (source === 'theboys') {
    captureResult = await captureFromTheboys(pageUrl);
    const parsed = parseTheboysUrl(pageUrl);
    if (parsed) {
      effectiveOpts = {
        season: opts.season ?? (parsed.season !== undefined ? String(parsed.season) : undefined),
        episode: opts.episode ?? (parsed.episode !== undefined ? String(parsed.episode) : undefined),
        voice: opts.voice,
        timeoutMs: opts.timeoutMs,
      };
    }
  } else if (source === 'kinomix') {
    captureResult = await captureFromKinomix(pageUrl);
  } else {
    const capture = source === 'lordfilm' ? captureFromLordfilm : captureFromKinogo;
    captureResult = await capture(pageUrl, opts.timeoutMs ?? 45_000);
  }
  const { playlist, cookies } = captureResult;

  const season = matchSeason(playlist, effectiveOpts.season);
  if (!season) throw new ExtractorError('no seasons in playlist', 'select');
  const episode = matchEpisode(season, effectiveOpts.episode);
  if (!episode) throw new ExtractorError(`season ${season.title}: no episodes`, 'select');
  const voice = matchVoice(episode, effectiveOpts.voice);
  if (!voice) throw new ExtractorError(`${season.title}/${episode.title}: no voices`, 'select');

  dbg(`selected ${season.title} / ${episode.title} / ${voice.title} (source=${source})`);

  return {
    m3u8: voice.file,
    referer,
    cookies,
    userAgent: UA,
    structure: playlist,
    current: {
      seasonId: season.id,
      episodeId: episode.id,
      voiceId: voice.voice_id,
      voiceTitle: voice.title,
      audioTrack: voice.audioTrack,
    },
  };
}
