import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface VoiceInfo {
  voice_id?: number;
  title: string;
  file: string;
}

export interface EpisodeInfo {
  id: string;
  title: string;
  voices: VoiceInfo[];
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
  current: { seasonId: string; episodeId: string; voiceId?: number; voiceTitle: string };
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
      const cinemar = page.frames().find((f) => /cinemar|cinemap/.test(f.url()));
      if (!cinemar) continue;
      const caps = (await cinemar
        .evaluate(() => (window as unknown as { __capturedPlaylists?: unknown[][] }).__capturedPlaylists ?? [])
        .catch(() => [])) as RawPlaylistEntry[][];
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

export async function extractM3U8(
  pageUrl: string,
  opts: SelectionOpts & { timeoutMs?: number } = {},
): Promise<ExtractResult> {
  const { playlist, cookies } = await captureFromKinogo(pageUrl, opts.timeoutMs ?? 45_000);

  const season = matchSeason(playlist, opts.season);
  if (!season) throw new ExtractorError('no seasons in playlist', 'select');
  const episode = matchEpisode(season, opts.episode);
  if (!episode) throw new ExtractorError(`season ${season.title}: no episodes`, 'select');
  const voice = matchVoice(episode, opts.voice);
  if (!voice) throw new ExtractorError(`${season.title}/${episode.title}: no voices`, 'select');

  dbg(`selected ${season.title} / ${episode.title} / ${voice.title}`);

  return {
    m3u8: voice.file,
    referer: 'https://cinemar.cc/',
    cookies,
    userAgent: UA,
    structure: playlist,
    current: {
      seasonId: season.id,
      episodeId: episode.id,
      voiceId: voice.voice_id,
      voiceTitle: voice.title,
    },
  };
}
