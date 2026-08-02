import { createHmac, timingSafeEqual } from 'node:crypto';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { Agent, interceptors, request, setGlobalDispatcher, Dispatcher } from 'undici';

// hls.js держит впереди минуту видео, поэтому сегменты запрашиваются пачками с
// долгими паузами между ними. С дефолтным keepAliveTimeout в 4 секунды сокет к
// CDN умирает в каждой такой паузе, и следующая пачка начинается с TLS-хендшейка
// — на RTT до российских CDN это лишние сотни миллисекунд перед каждым всплеском.
// connections ограничивает сокеты на origin: на 1 vCPU лучше короткая очередь,
// чем сотня параллельных загрузок, дерущихся за канал. Очередь per-origin, так
// что медленный CDN одной комнаты не блокирует остальные.
// Таймауты вместо дефолтных пяти минут: bodyTimeout у undici считается между
// чанками, а не на весь ответ, так что медленный-но-живой сегмент он не рвёт.
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    connections: 16,
    pipelining: 1,
    connect: { timeout: 10_000 },
    headersTimeout: 20_000,
    bodyTimeout: 30_000,
    // Свой кеш DNS: без него каждое новое соединение к CDN идёт через
    // dns.lookup, а тот живёт в пуле потоков libuv — там же, где сжатие и
    // файловые операции. Соединения переоткрываются весь фильм: сегменты
    // качаются пачками с паузами, и часть сокетов в паузах всё равно истекает.
  }).compose(interceptors.dns({ maxTTL: 300_000, maxItems: 100 })),
);

export interface SessionHeaders {
  referer: string;
  userAgent: string;
  cookies: { name: string; value: string; domain: string }[];
}

const ALLOWED_HOSTS_RE = /(^|\.)(cinemap\.cc|cinemar\.cc|aniqit\.com|kinogo\.ec|interkh\.com|femd\.ws|kalarona\.org|werberk\.pro|ortified\.ws|rtbcdn\.cloud|kinohd\.co|factorios\.live|videoseedcdn\.com|videoseed\.tv|tv-1-kinoserial\.net|kinescopecdn\.net)$/i;

export function isAllowedHost(url: string): boolean {
  try {
    return ALLOWED_HOSTS_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function signUrl(roomId: string, url: string, secret: string): string {
  return createHmac('sha256', secret).update(`${roomId}|${url}`).digest('base64url').slice(0, 16);
}

export function verifyUrl(roomId: string, url: string, sig: string, secret: string): boolean {
  const expected = signUrl(roomId, url, secret);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export interface ProxyPath {
  encodedUrl: string;
  sig: string;
}

export function buildProxyPath(
  roomId: string,
  absoluteUrl: string,
  secret: string,
  selfBase: string,
): string {
  const encoded = Buffer.from(absoluteUrl, 'utf8').toString('base64url');
  const sig = signUrl(roomId, absoluteUrl, secret);
  return `${selfBase.replace(/\/$/, '')}/hls/${roomId}/p/${encoded}.${sig}`;
}

export function decodeProxyPath(encodedUrl: string): string {
  return Buffer.from(encodedUrl, 'base64url').toString('utf8');
}

const URI_ATTR_RE = /URI="([^"]+)"/g;

export function rewriteManifest(
  manifest: string,
  baseUrl: string,
  roomId: string,
  secret: string,
  selfBase: string,
): string {
  const base = new URL(baseUrl);

  const rewriteOne = (raw: string): string => {
    const resolved = new URL(raw, base).toString();
    if (!isAllowedHost(resolved)) return raw;
    return buildProxyPath(roomId, resolved, secret, selfBase);
  };

  const lines = manifest.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      out.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      out.push(
        line.replace(URI_ATTR_RE, (_m, uri: string) => `URI="${rewriteOne(uri)}"`),
      );
    } else {
      out.push(rewriteOne(line));
    }
  }
  return out.join('\n');
}

function cookieHeaderFor(targetUrl: string, session: SessionHeaders): string {
  const host = new URL(targetUrl).hostname.toLowerCase();
  const pairs: string[] = [];
  for (const c of session.cookies) {
    const dom = c.domain.replace(/^\./, '').toLowerCase();
    if (host === dom || host.endsWith(`.${dom}`)) {
      pairs.push(`${c.name}=${c.value}`);
    }
  }
  return pairs.join('; ');
}

export async function fetchUpstream(
  targetUrl: string,
  session: SessionHeaders,
  range?: string,
  opts?: { acceptEncoding?: string },
): Promise<Dispatcher.ResponseData> {
  const headers: Record<string, string> = {
    'user-agent': session.userAgent,
    referer: session.referer,
    accept: '*/*',
    'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
    // Сегмент уходит клиенту стримом, поэтому его content-length мы просто
    // пробрасываем — а значит тело должно быть тем же, что посчитал CDN. Сжатый
    // ответ пришлось бы либо распаковывать, либо отдавать вместе с
    // content-encoding, и любой промах здесь ломает ABR (см. hls.js и
    // lengthComputable в server.ts). Просим identity и снимаем вопрос.
    //
    // Плейлист — исключение: его мы читаем целиком и переписываем, наружу уходит
    // уже наш текст, так что чужой content-length не нужен. Там вызывающий
    // передаёт acceptEncoding и читает ответ через readTextBody.
    'accept-encoding': opts?.acceptEncoding ?? 'identity',
  };
  const cookie = cookieHeaderFor(targetUrl, session);
  if (cookie) headers.cookie = cookie;
  if (range) headers.range = range;
  return request(targetUrl, { method: 'GET', headers, maxRedirections: 3 });
}

/**
 * Тело ответа текстом, с распаковкой, если CDN ответил сжатым: undici сам
 * ничего не распаковывает, даже когда мы попросили gzip.
 */
export async function readTextBody(res: Dispatcher.ResponseData): Promise<string> {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (!enc || enc === 'identity') return res.body.text();
  const buf = Buffer.from(await res.body.arrayBuffer());
  try {
    if (enc === 'gzip') return gunzipSync(buf).toString('utf8');
    if (enc === 'br') return brotliDecompressSync(buf).toString('utf8');
    if (enc === 'deflate') return inflateSync(buf).toString('utf8');
  } catch {
    // Битый или не тот кодек — отдаём как есть: вызывающий не разберёт плейлист
    // и вернёт 502, что честнее молчаливой подмены пустой строкой.
  }
  return buf.toString('utf8');
}
