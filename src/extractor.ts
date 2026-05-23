import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface VoiceInfo {
  voice_id?: number;
  title: string;
  file: string;
  // Для venom-player'а (lordfilm): озвучка = audio track в одном master.m3u8.
  // Если задано — клиент после loadSource выставит hls.audioTrack = audioTrack.
  audioTrack?: number;
  // Имя провайдера для kinomix-агрегатора (Collaps/Videoseed/Vibix). У других
  // источников undefined — UI скрывает row выбора плеера.
  provider?: string;
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
    provider?: string;
  };
}

export interface SelectionOpts {
  season?: string; // either "Сезон 5", "s05", "5", or full season label
  episode?: string;
  voice?: string;
  provider?: string;
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

function matchVoice(episode: EpisodeInfo, selector?: string, provider?: string): VoiceInfo | null {
  // Если задан провайдер — фильтруем кандидатов сначала по нему; если ни одного
  // голоса в episode с этим провайдером нет — фолбэк на полный список.
  const candidates = provider
    ? episode.voices.filter((v) => (v.provider ?? '').toLowerCase() === provider.toLowerCase())
    : episode.voices;
  const pool = candidates.length > 0 ? candidates : episode.voices;
  if (!selector) return pool[0] ?? null;
  const t = selector.trim().toLowerCase();
  for (const v of pool) {
    if (v.title === selector) return v;
    if (v.title.toLowerCase() === t) return v;
  }
  // partial match (например "Кубик в Кубе" → "Кубик в Кубе (Проф. двухголосый)")
  for (const v of pool) {
    if (v.title.toLowerCase().startsWith(t)) return v;
  }
  return pool[0] ?? null;
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
interface FlixcdnPayload {
  show_id: number;
  is_serial: boolean;
  seasons_episodes: Record<string, number[]>;
  translations: { id: number; title: string }[];
}
interface KinomixCacheEntry {
  kinopoisk_id: number;
  ortified_id?: number;
  flixcdn?: FlixcdnPayload;
  videoseed_iframe?: string;
  vibix_available?: boolean;
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

/**
 * Videoseed (tv-1-kinoserial.net) — Playerjs формат с base64-кодированным
 * playlist. Direct undici-fetch возвращает 503 (anti-bot по cookie/session
 * binding), iframe-load в Playwright проходит. Открываем iframe-URL с Referer
 * https://videoseed.tv/, перехватываем response, парсим Playerjs("#2<base64>"),
 * стрипаем #2 и |||...== маркеры, base64-decode → JSON. Voices в каждом
 * эпизоде — строка вида "{voice} url.m3u8;{voice} url.m3u8;...".
 */
async function captureFromVideoseed(iframeUrl: string): Promise<PlayerStructure> {
  const context = await newContext();
  try {
    const page = await context.newPage();
    // Прямой page.goto(iframeUrl) триггерит anti-bot: Videoseed ловит
    // Sec-Fetch-Dest: document. Воркэраунд (как у lampac): грузим wrapper-HTML
    // на хосте videoseed.tv (route-fulfill), внутри iframe = настоящий embed —
    // он загружается с Sec-Fetch-Dest: iframe + Referer: videoseed.tv.
    const wrapperUrl = 'https://videoseed.tv/__watch_wrapper__';
    await page.route('**/*', async (route) => {
      try {
        const url = route.request().url();
        if (url === wrapperUrl) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html><html><body style="margin:0"><iframe src="${iframeUrl.replace(/"/g, '&quot;')}" style="width:100vw;height:100vh;border:0"></iframe></body></html>`,
          });
          return;
        }
        await route.continue();
      } catch {
        try { await route.continue(); } catch {}
      }
    });
    let captured: string | null = null;
    page.on('response', async (res) => {
      if (res.url() === iframeUrl && !captured) {
        try { captured = await res.text(); } catch {}
      }
    });
    await page.goto(wrapperUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    if (!captured) {
      try { await page.waitForResponse((r) => r.url() === iframeUrl, { timeout: 15_000 }); } catch {}
      if (!captured) await page.waitForTimeout(1500);
    }
    if (!captured) throw new ExtractorError('videoseed: не перехватили iframe response', 'playlist');

    const m = (captured as string).match(/new Playerjs\("([^"]+)"\)/);
    if (!m || !m[1]) throw new ExtractorError('videoseed: Playerjs("...") не найден', 'playlist');
    // Strip leading `#2`, strip `|||...==` watermarks, base64-decode.
    let s = m[1].substring(2).replace(/\|\|\|[^=|]+==/g, '');
    let json: string;
    try {
      json = Buffer.from(s, 'base64').toString('utf-8');
    } catch (e) {
      throw new ExtractorError(`videoseed: base64 decode failed: ${(e as Error).message}`, 'playlist');
    }
    let root: { file?: unknown };
    try {
      root = JSON.parse(json);
    } catch {
      throw new ExtractorError('videoseed: decoded body не JSON', 'playlist');
    }

    const parseVoices = (str: string): VoiceInfo[] => {
      const voices: VoiceInfo[] = [];
      for (const part of String(str).split(';')) {
        const vm = part.trim().match(/^\{([^}]+)\}\s*(https?:\/\/\S+\.m3u8\S*)/);
        if (vm && vm[1] && vm[2]) voices.push({ title: vm[1].trim(), file: vm[2].trim() });
      }
      return voices;
    };

    const seasons: SeasonInfo[] = [];
    const fileNode = root.file;
    if (Array.isArray(fileNode)) {
      // Сериал: file = [{title:"1 сезон", folder:[{title:"1 серия", id:"s1v1", file:"..."}]}]
      for (const s of fileNode as Array<{ title?: string; folder?: Array<{ id?: string; title?: string; file?: string }> }>) {
        const sNumMatch = String(s.title ?? '').match(/(\d+)/);
        const sId = sNumMatch && sNumMatch[1] ? sNumMatch[1] : String(seasons.length + 1);
        const episodes: EpisodeInfo[] = [];
        for (const e of s.folder ?? []) {
          const eNumMatch = String(e.title ?? e.id ?? '').match(/(\d+)/);
          const eId = eNumMatch && eNumMatch[1] ? eNumMatch[1] : String(episodes.length + 1);
          const voices = parseVoices(e.file ?? '');
          if (voices.length) episodes.push({ id: eId, title: `Серия ${eId}`, voices });
        }
        if (episodes.length) seasons.push({ id: sId, title: `Сезон ${sId}`, episodes });
      }
    } else if (typeof fileNode === 'string') {
      // Фильм: один эпизод со списком голосов.
      const voices = parseVoices(fileNode);
      if (voices.length) {
        seasons.push({ id: 'film', title: 'Фильм', episodes: [{ id: 'film', title: '1', voices }] });
      }
    }
    return { seasons };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Vibix (kinescopecdn.net). lampac-style coldfilm flow:
 *  - Грузим coldfilm.ink (route-fulfill с `<ins data-publisher-id="674784070"
 *    data-type="kp" data-id="<kp>">` + rendex-sdk.min.js). SDK инжектит iframe
 *    с kinescopecdn.net на основе kp_id.
 *  - Перехватываем response от `kinescopecdn.net/api/v1/embed-(serials|movies)/<id>`.
 *    Это `{p: <base64-reversed-XOR>, v: 1}` JSON.
 *  - Декодируем: `reverse(p)` → base64 → XOR с фиксированным ключом lampac
 *    `RySdvcyu5iTUxn97vn4HwoniwgxaCynA` → JSON со структурой и СРАЗУ подписанными
 *    m3u8 URLs (`?expires=<unix>&sign=<hex>`, ~1h TTL).
 */
const VIBIX_XOR_KEY = Buffer.from('RySdvcyu5iTUxn97vn4HwoniwgxaCynA', 'ascii');

interface VibixData {
  data?: {
    playlist?: { title?: string; folder?: { title?: string; file?: string }[] }[];
    file?: string;
  };
}

function parseVibixFile(file: string): VoiceInfo[] {
  // Формат: [Qp]{voice}url,[Qp]{voice}url,... — один URL на (voice, quality).
  // Из качества пикаем максимально доступное (1080 → 720 → 480).
  const byVoice = new Map<string, Map<number, string>>();
  const re = /\[(\d+)p\]\{([^}]+)\}(https?:\/\/[^,\s[]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file)) !== null) {
    const q = Number(m[1]);
    const voice = m[2]!.trim();
    const url = m[3]!.trim();
    if (!byVoice.has(voice)) byVoice.set(voice, new Map());
    byVoice.get(voice)!.set(q, url);
  }
  const voices: VoiceInfo[] = [];
  for (const [name, qmap] of byVoice) {
    const url = qmap.get(1080) ?? qmap.get(720) ?? qmap.get(480) ?? [...qmap.values()][0];
    if (url) voices.push({ title: name, file: url });
  }
  return voices;
}

async function captureFromVibix(kpId: number): Promise<PlayerStructure> {
  const context = await newContext();
  try {
    const page = await context.newPage();
    let embedBody: string | null = null;
    page.on('response', async (res) => {
      if (embedBody) return;
      if (/\/api\/v1\/embed-(serials|movies)\/\d+\?/.test(res.url())) {
        try { embedBody = await res.text(); } catch {}
      }
    });
    await page.route('**/*', async (route) => {
      try {
        const url = route.request().url();
        if (url.startsWith('https://coldfilm.ink')) {
          await route.fulfill({
            status: 200, contentType: 'text/html',
            body:
              `<html lang="ru"><head><meta charset="UTF-8">` +
              `<script src="https://graphicslab.io/sdk/v2/rendex-sdk.min.js"></script>` +
              `</head><body><ins data-publisher-id="674784070" data-type="kp" data-id="${kpId}"></ins></body></html>`,
          });
          return;
        }
        // Ускорение: грузим только нужные хосты, обрезаем /hls/ (фактическое видео).
        if (!/(kinescopecdn|graphicslab|coldfilm)\./.test(url) || url.includes('/hls/')) {
          try { await route.abort(); } catch {}
          return;
        }
        await route.continue();
      } catch {
        try { await route.continue(); } catch {}
      }
    });
    await page.goto('https://coldfilm.ink/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    for (let i = 0; i < 40 && !embedBody; i++) await page.waitForTimeout(500);
    if (!embedBody) throw new ExtractorError('vibix: не перехватили embed response', 'playlist');

    let parsed: { p?: string; v?: number };
    try { parsed = JSON.parse(embedBody); } catch { throw new ExtractorError('vibix: embed body не JSON', 'playlist'); }
    if (!parsed.p || parsed.v !== 1) throw new ExtractorError('vibix: нет {p,v=1}', 'playlist');

    const reversed = parsed.p.split('').reverse().join('');
    const padded = reversed + '='.repeat((4 - (reversed.length % 4)) % 4);
    const buf = Buffer.from(padded, 'base64');
    const keyLen = VIBIX_XOR_KEY.length;
    for (let i = 0; i < buf.length; i++) buf[i]! ^= VIBIX_XOR_KEY[i % keyLen]!;
    const text = buf.toString('utf-8');

    let root: VibixData;
    try { root = JSON.parse(text); } catch { throw new ExtractorError('vibix: decoded body не JSON', 'playlist'); }
    const data = root.data;
    if (!data) throw new ExtractorError('vibix: пустой data', 'playlist');

    const seasons: SeasonInfo[] = [];
    if (Array.isArray(data.playlist)) {
      for (const s of data.playlist) {
        const sNumMatch = String(s.title ?? '').match(/(\d+)/);
        const sId = sNumMatch && sNumMatch[1] ? sNumMatch[1] : String(seasons.length + 1);
        const episodes: EpisodeInfo[] = [];
        for (const e of s.folder ?? []) {
          const eNumMatch = String(e.title ?? '').match(/(\d+)/);
          const eId = eNumMatch && eNumMatch[1] ? eNumMatch[1] : String(episodes.length + 1);
          const voices = parseVibixFile(e.file ?? '');
          if (voices.length) episodes.push({ id: eId, title: `Серия ${eId}`, voices });
        }
        if (episodes.length) seasons.push({ id: sId, title: `Сезон ${sId}`, episodes });
      }
    } else if (typeof data.file === 'string') {
      const voices = parseVibixFile(data.file);
      if (voices.length) seasons.push({ id: 'film', title: 'Фильм', episodes: [{ id: 'film', title: '1', voices }] });
    }
    return { seasons };
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureCollapsForKinomix(ortifiedId: number): Promise<PlayerStructure> {
  const embedUrl = `https://api.ortified.ws/embed/movie/${ortifiedId}`;
  dbg(`kinomix: collaps ortified_id=${ortifiedId}, fetching ${embedUrl}`);
  const { request } = await import('undici');
  const res = await request(embedUrl, {
    headers: { 'user-agent': UA, referer: 'https://kinomix.web.app/' },
  });
  if (res.statusCode !== 200) throw new ExtractorError(`ortified embed HTTP ${res.statusCode}`, 'playlist');
  const body = await res.body.text();
  const seasons = extractVenomSeasons(body);
  if (!seasons || seasons.length === 0) throw new ExtractorError('ortified: venom seasons не извлеклись', 'playlist');
  return structureFromVenom([{ playlist: { seasons } }]);
}

/**
 * Строит PlayerStructure из Flixcdn payload. Каждый episode получает voiceFile
 * = `flixcdn-resolve:<show>|<trans>|<s>|<e>` маркер. Сервер при запросе
 * /hls/.../index.m3u8 вызывает resolveFlixcdnVoice() через shared Playwright.
 */
function flixcdnPayloadToStructure(p: FlixcdnPayload): PlayerStructure {
  const seasons: SeasonInfo[] = [];
  // p.is_serial=true → seasons_episodes={"1":[1..],"2":[1..]}; иначе фильм.
  if (p.is_serial && Object.keys(p.seasons_episodes).length > 0) {
    for (const [sNum, eps] of Object.entries(p.seasons_episodes)) {
      const episodes: EpisodeInfo[] = [];
      for (const eNum of eps) {
        const voices: VoiceInfo[] = p.translations.map((t) => ({
          voice_id: t.id,
          title: t.title,
          file: `flixcdn-resolve:${p.show_id}|${t.id}|${sNum}|${eNum}`,
        }));
        if (voices.length) episodes.push({ id: String(eNum), title: `Серия ${eNum}`, voices });
      }
      if (episodes.length) seasons.push({ id: String(sNum), title: `Сезон ${sNum}`, episodes });
    }
  } else {
    // Фильм: один сезон 'film' / один эпизод 'film', один voice per translation.
    const voices: VoiceInfo[] = p.translations.map((t) => ({
      voice_id: t.id,
      title: t.title,
      file: `flixcdn-resolve:${p.show_id}|${t.id}|1|1`,
    }));
    if (voices.length) {
      seasons.push({ id: 'film', title: 'Фильм', episodes: [{ id: 'film', title: '1', voices }] });
    }
  }
  return { seasons };
}

/**
 * Сливает структуры разных провайдеров в одну, проставляя `voice.provider`.
 * Сезоны/эпизоды объединяются по id; voices конкатенируются. Provider используется
 * UI'ем для отдельного row выбора плеера (кросс-провайдерные одноимённые голоса
 * не сливаются в один — пользователь выбирает оба независимо).
 */
function mergeStructures(base: PlayerStructure, baseProvider: string, add: PlayerStructure, addProvider: string): PlayerStructure {
  const stamp = (s: PlayerStructure, provider: string): PlayerStructure => ({
    seasons: s.seasons.map((sn) => ({
      ...sn,
      episodes: sn.episodes.map((e) => ({
        ...e,
        voices: e.voices.map((v) => ({ ...v, provider: v.provider ?? provider })),
      })),
    })),
  });
  const baseS = stamp(base, baseProvider);
  const addS = stamp(add, addProvider);
  if (baseS.seasons.length === 0) return addS;
  if (addS.seasons.length === 0) return baseS;
  const seasonMap = new Map<string, SeasonInfo>();
  for (const s of baseS.seasons) seasonMap.set(s.id, { ...s, episodes: s.episodes.map((e) => ({ ...e, voices: [...e.voices] })) });
  for (const s of addS.seasons) {
    const existing = seasonMap.get(s.id);
    if (!existing) {
      seasonMap.set(s.id, { ...s, episodes: s.episodes.map((e) => ({ ...e, voices: [...e.voices] })) });
      continue;
    }
    const epMap = new Map<string, EpisodeInfo>(existing.episodes.map((e) => [e.id, e]));
    for (const e of s.episodes) {
      const eExisting = epMap.get(e.id);
      if (!eExisting) {
        existing.episodes.push({ ...e, voices: [...e.voices] });
        continue;
      }
      for (const v of e.voices) eExisting.voices.push(v);
    }
  }
  // Восстанавливаем порядок сезонов: base первым, потом новые из add.
  const merged: SeasonInfo[] = [];
  const seen = new Set<string>();
  for (const s of baseS.seasons) { merged.push(seasonMap.get(s.id)!); seen.add(s.id); }
  for (const s of addS.seasons) if (!seen.has(s.id)) merged.push(seasonMap.get(s.id)!);
  return { seasons: merged };
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

  let playlist: PlayerStructure = { seasons: [] };
  const errors: string[] = [];

  if (entry.ortified_id) {
    try {
      const collaps = await captureCollapsForKinomix(entry.ortified_id);
      playlist = mergeStructures(playlist, 'Collaps', collaps, 'Collaps');
    } catch (e) {
      errors.push(`collaps: ${(e as Error).message}`);
    }
  }
  // Flixcdn выключен по умолчанию: Cloudflare Turnstile на /api/player/files
  // блокирует Playwright fingerprint (401 на cdn-cgi/challenge-platform/.../pat),
  // даже headed Google Chrome stable не проходит. Опт-ин через WATCH_FLIXCDN=1
  // (например на VPS с другим IP/историей сессий есть шанс что пройдёт).
  if (entry.flixcdn && process.env.WATCH_FLIXCDN === '1') {
    try {
      const flix = flixcdnPayloadToStructure(entry.flixcdn);
      playlist = mergeStructures(playlist, 'Collaps', flix, 'Flixcdn');
    } catch (e) {
      errors.push(`flixcdn: ${(e as Error).message}`);
    }
  }
  if (entry.videoseed_iframe) {
    dbg(`videoseed: fetching ${entry.videoseed_iframe}`);
    try {
      const vs = await captureFromVideoseed(entry.videoseed_iframe);
      dbg(`videoseed: got ${vs.seasons.length} seasons, ${vs.seasons.reduce((a, s) => a + s.episodes.length, 0)} eps`);
      playlist = mergeStructures(playlist, 'Collaps', vs, 'Videoseed');
    } catch (e) {
      dbg(`videoseed FAILED: ${(e as Error).message}`);
      errors.push(`videoseed: ${(e as Error).message}`);
    }
  } else {
    dbg(`videoseed: no iframe in cache for kp=${parsed.kinopoisk_id}`);
  }
  if (entry.vibix_available) {
    dbg(`vibix: capturing for kp=${parsed.kinopoisk_id}`);
    try {
      const vx = await captureFromVibix(parsed.kinopoisk_id);
      dbg(`vibix: got ${vx.seasons.length} seasons, ${vx.seasons.reduce((a, s) => a + s.episodes.length, 0)} eps`);
      playlist = mergeStructures(playlist, 'Collaps', vx, 'Vibix');
    } catch (e) {
      dbg(`vibix FAILED: ${(e as Error).message}`);
      errors.push(`vibix: ${(e as Error).message}`);
    }
  }

  if (playlist.seasons.length === 0) {
    throw new ExtractorError(`kinomix: нет данных (${errors.join('; ') || 'кеш пуст'})`, 'playlist');
  }
  dbg(
    `kinomix kp=${parsed.kinopoisk_id}: ${playlist.seasons.length} seasons, ${playlist.seasons.reduce((a, s) => a + s.episodes.length, 0)} eps`,
  );
  return { playlist, cookies: [] };
}

/**
 * Резолвит flixcdn-resolve:<show>|<trans>|<s>|<e> маркер в свежий m3u8 URL.
 * tarantino.factorios.live/api/player/files требует Cloudflare Turnstile-pass
 * (POST с не-браузерным fingerprint отвечает "captcha failed"), поэтому делаем
 * через shared Playwright: открываем embed-страницу в контексте, выполняем
 * fetch() из контекста — Cloudflare cf_clearance автоматически set'ится.
 * Возвращает URL качества 720 (или максимально доступного).
 */
export async function resolveFlixcdnVoice(marker: string): Promise<string | null> {
  const m = marker.match(/^flixcdn-resolve:(\d+)\|(\d+)\|(\d+)\|(\d+)$/);
  if (!m) return null;
  const [, showId, translation, seasonNum, episodeNum] = m;
  // Embed URL должен быть по kinopoisk_id, но у нас нет обратного маппинга
  // show_id → kp_id. Используем любой URL, который Flixcdn принимает —
  // /show/kinopoisk/0 тоже отдаёт страницу с Cloudflare challenge, но эта
  // страница не содержит data для нашего show_id. Используем формат с показом
  // по внутреннему id: /show/<show_id> (если такой роут есть), иначе передаём
  // через какой-нибудь kp страницы — Cloudflare check универсален per-domain.
  // Простейший вариант: грузим /show/kinopoisk/277565 как разогрев Cloudflare,
  // потом fetch'им API с нашим show_id (cf_clearance работает на весь домен).
  const context = await newContext();
  try {
    const page = await context.newPage();
    // Загрузка embed-страницы инициализирует Cloudflare JS challenge → cf_clearance
    // cookie. Сам player на странице сразу делает POST /api/player/files когда
    // готов — ждём это вместо blind timeout.
    const playerCallDone = page
      .waitForResponse(
        (r) => r.url().includes('/api/player/files') && r.request().method() === 'POST',
        { timeout: 25_000 },
      )
      .catch(() => null);
    await page.goto(`https://tarantino.factorios.live/show/kinopoisk/${showId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    }).catch(() => {});
    await playerCallDone;
    const res = await page.evaluate(async (body) => {
      const r = await fetch('https://tarantino.factorios.live/api/player/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      });
      const text = await r.text();
      return { status: r.status, text };
    }, {
      id: Number(showId),
      translation: Number(translation),
      season_number: Number(seasonNum),
      episode_number: Number(episodeNum),
      force_cdn: '',
    });
    if (res.status !== 200) {
      dbg(`flixcdn resolve HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      return null;
    }
    let json: { file?: string };
    try {
      json = JSON.parse(res.text);
    } catch {
      dbg(`flixcdn resolve: bad json ${res.text.slice(0, 200)}`);
      return null;
    }
    if (!json.file) return null;
    // file = "[360]url,[480]url,[720]url,[1080]url" — пикаем 720 (или 1080, или max).
    const qualities = new Map<number, string>();
    for (const part of json.file.split(',')) {
      const mm = part.match(/^\[(\d+)\](.+)$/);
      if (mm && mm[1] && mm[2]) qualities.set(Number(mm[1]), mm[2]);
    }
    if (qualities.size === 0) return null;
    const prefer = [720, 1080, 480, 360];
    for (const q of prefer) if (qualities.has(q)) return qualities.get(q) ?? null;
    return [...qualities.values()][0] ?? null;
  } finally {
    await context.close().catch(() => {});
  }
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
  const voice = matchVoice(episode, effectiveOpts.voice, effectiveOpts.provider);
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
      provider: voice.provider,
    },
  };
}
