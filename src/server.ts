import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  extractM3U8,
  closeBrowser,
  ExtractorError,
  type PlayerStructure,
  type ExtractResult,
} from './extractor.js';
import {
  buildProxyPath,
  decodeProxyPath,
  fetchUpstream,
  isAllowedHost,
  rewriteManifest,
  verifyUrl,
} from './hls-proxy.js';
import { RoomManager } from './room.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const BASE_PATH = (process.env.PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}${BASE_PATH}`).replace(/\/$/, '');
const PROXY_SECRET = process.env.PROXY_SECRET ?? randomBytes(32).toString('hex');

const distPublic = join(__dirname, 'public');
const srcPublic = join(__dirname, '..', 'src', 'public');
const PUBLIC_DIR = existsSync(distPublic) ? distPublic : srcPublic;

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const rooms = new RoomManager();

await fastify.register(fastifyWebsocket);
await fastify.register(fastifyStatic, { root: PUBLIC_DIR, prefix: `${BASE_PATH}/static/` });

async function serveHtml(reply: FastifyReply, filename: string) {
  const raw = await readFile(join(PUBLIC_DIR, filename), 'utf-8');
  const html = raw.replace(/\{\{BASE_PATH\}\}/g, BASE_PATH);
  return reply.type('text/html; charset=utf-8').send(html);
}

fastify.get(`${BASE_PATH}/`, async (_req, reply) => serveHtml(reply, 'index.html'));

fastify.get(`${BASE_PATH}/room/:id`, async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!rooms.get(id)) return reply.code(404).type('text/plain').send('room not found');
  return serveHtml(reply, 'room.html');
});

interface ProbeCacheEntry {
  url: string;
  structure: PlayerStructure;
  cookies: ExtractResult['cookies'];
  referer: string;
  userAgent: string;
  at: number;
}
const probeCache = new Map<string, ProbeCacheEntry>();
const PROBE_TTL_MS = 10 * 60 * 1000;

function gcProbeCache() {
  const now = Date.now();
  for (const [k, v] of probeCache) {
    if (now - v.at > PROBE_TTL_MS) probeCache.delete(k);
  }
}

function validateSourceUrl(url: string): boolean {
  return /^https?:\/\/[^\s]*(kinogo|lordfilm|theboys\.fun|kinomix\.web\.app)[^\s]*$/i.test(url);
}

fastify.post<{ Body: { url: string } }>(`${BASE_PATH}/api/probe`, async (req, reply) => {
  const url = String(req.body?.url ?? '').trim();
  if (!validateSourceUrl(url)) return reply.code(400).send({ error: 'invalid source url (kinogo|lordfilm|theboys.fun|kinomix.web.app)' });

  gcProbeCache();
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return reply.send({ structure: cached.structure, cached: true });
  }

  try {
    const result = await extractM3U8(url, { timeoutMs: 60_000 });
    probeCache.set(url, {
      url,
      structure: result.structure,
      cookies: result.cookies,
      referer: result.referer,
      userAgent: result.userAgent,
      at: Date.now(),
    });
    return reply.send({ structure: result.structure, cached: false });
  } catch (e) {
    const msg = e instanceof ExtractorError ? `${e.stage}: ${e.message}` : (e as Error).message;
    req.log.error({ err: e }, 'probe failed');
    return reply.code(502).send({ error: 'probe_failed', detail: msg });
  }
});

function findInStructure(
  structure: PlayerStructure,
  season?: string,
  episode?: string,
  voice?: string,
): {
  m3u8: string;
  voiceTitle: string;
  seasonId: string;
  seasonTitle: string;
  episodeId: string;
  episodeTitle: string;
  audioTrack?: number;
  subtitles?: { url: string; name: string; lang?: string }[];
} | null {
  const matchByNum = (text: string | undefined, candidates: { id: string; title: string }[]) => {
    if (!text) return candidates[0];
    const numWant = text.match(/(\d+)/)?.[1];
    for (const c of candidates) {
      if (c.id === text || c.title === text) return c;
      const cNum = c.title.match(/(\d+)/)?.[1] ?? c.id.match(/(\d+)/)?.[1];
      if (numWant && cNum === numWant) return c;
    }
    return candidates[0];
  };
  const seasonMatch = matchByNum(season, structure.seasons);
  const season_ = structure.seasons.find((s) => s.id === seasonMatch?.id) ?? structure.seasons[0];
  if (!season_) return null;
  const epMatch = matchByNum(episode, season_.episodes);
  const ep_ = season_.episodes.find((e) => e.id === epMatch?.id) ?? season_.episodes[0];
  if (!ep_) return null;
  let voiceObj = ep_.voices[0];
  if (voice && ep_.voices.length) {
    const tLow = voice.trim().toLowerCase();
    voiceObj =
      ep_.voices.find((v) => v.title === voice) ??
      ep_.voices.find((v) => v.title.toLowerCase() === tLow) ??
      ep_.voices.find((v) => v.title.toLowerCase().startsWith(tLow)) ??
      ep_.voices[0];
  }
  if (!voiceObj) return null;
  return {
    m3u8: voiceObj.file,
    voiceTitle: voiceObj.title,
    seasonId: season_.id,
    seasonTitle: season_.title,
    episodeId: ep_.id,
    episodeTitle: ep_.title,
    audioTrack: voiceObj.audioTrack,
    subtitles: ep_.subtitles,
  };
}

fastify.post<{ Body: { url: string; season?: string; episode?: string; voice?: string } }>(
  `${BASE_PATH}/api/extract`,
  async (req, reply) => {
    const url = String(req.body?.url ?? '').trim();
    if (!validateSourceUrl(url)) return reply.code(400).send({ error: 'invalid source url (kinogo|lordfilm|theboys.fun|kinomix.web.app)' });
    let season = req.body?.season?.trim() || undefined;
    let episode = req.body?.episode?.trim() || undefined;
    const voice = req.body?.voice?.trim() || undefined;
    // theboys URL содержит season/episode — используем как default если в body не задано
    const tb = url.match(/theboys\.fun\/[\w-]+?-(\d+)-sezon-(\d+)-seriya/i);
    if (tb) {
      season = season ?? tb[1];
      episode = episode ?? tb[2];
    }
    try {
      gcProbeCache();
      let entry = probeCache.get(url);
      if (!entry || Date.now() - entry.at > PROBE_TTL_MS) {
        const result = await extractM3U8(url, { timeoutMs: 60_000 });
        entry = {
          url,
          structure: result.structure,
          cookies: result.cookies,
          referer: result.referer,
          userAgent: result.userAgent,
          at: Date.now(),
        };
        probeCache.set(url, entry);
      }
      const found = findInStructure(entry.structure, season, episode, voice);
      if (!found) {
        return reply.code(400).send({ error: 'no matching combination' });
      }
      const room = rooms.create({
        sourceUrl: url,
        session: { referer: entry.referer, userAgent: entry.userAgent, cookies: entry.cookies },
        playlist: entry.structure,
        current: {
          seasonId: found.seasonId,
          seasonTitle: found.seasonTitle,
          episodeId: found.episodeId,
          episodeTitle: found.episodeTitle,
          voiceTitle: found.voiceTitle,
          voiceFile: found.m3u8,
          audioTrack: found.audioTrack,
          subtitles: found.subtitles,
        },
      });
      return reply.send({
        roomId: room.id,
        joinUrl: `${PUBLIC_BASE_URL}/room/${room.id}`,
        current: room.current,
      });
    } catch (e) {
      const msg = e instanceof ExtractorError ? `${e.stage}: ${e.message}` : (e as Error).message;
      req.log.error({ err: e }, 'extract failed');
      return reply.code(502).send({ error: 'extract_failed', detail: msg });
    }
  },
);

fastify.post<{
  Params: { roomId: string };
  Body: { season?: string; episode?: string; voice?: string };
}>(`${BASE_PATH}/api/room/:roomId/switch`, async (req, reply) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return reply.code(404).send({ error: 'room not found' });
  const found = findInStructure(
    room.playlist,
    req.body?.season?.trim() || undefined,
    req.body?.episode?.trim() || undefined,
    req.body?.voice?.trim() || undefined,
  );
  if (!found) return reply.code(400).send({ error: 'no matching combination' });
  rooms.switchSource(room.id, null, {
    seasonId: found.seasonId,
    seasonTitle: found.seasonTitle,
    episodeId: found.episodeId,
    episodeTitle: found.episodeTitle,
    voiceTitle: found.voiceTitle,
    voiceFile: found.m3u8,
    audioTrack: found.audioTrack,
    subtitles: found.subtitles,
  });
  return reply.send({ current: room.current, sourceVersion: room.sourceVersion });
});

fastify.get<{ Params: { roomId: string; idx: string } }>(
  `${BASE_PATH}/hls/:roomId/sub/:idx`,
  async (req, reply) => {
    const room = rooms.get(req.params.roomId);
    if (!room) return reply.code(404).send('room not found');
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isFinite(idx) || idx < 0) return reply.code(400).send('bad idx');
    const sub = room.current.subtitles?.[idx];
    if (!sub) return reply.code(404).send('subtitle not found');
    if (!isAllowedHost(sub.url)) return reply.code(403).send('forbidden host');
    try {
      const upstream = await fetchUpstream(sub.url, room.session);
      return reply
        .code(upstream.statusCode)
        .type('text/vtt; charset=utf-8')
        .header('cache-control', upstream.statusCode === 200 ? 'public, max-age=3600' : 'no-store')
        .header('access-control-allow-origin', '*')
        .send(upstream.body);
    } catch (e) {
      req.log.error({ err: e, idx }, 'subtitle fetch failed');
      return reply.code(502).send('upstream error');
    }
  },
);

/**
 * theboys.fun хранит voiceFile как маркер 'kalarona-resolve:<video_id>'.
 * Резолвим в живой подписанный m3u8 URL через kalarona.org/player/responce.php.
 * Не кешируем (URL'ы подписаны временной меткой ~3 часа — каждый раз свежий).
 */
async function resolveKalaronaVoice(voiceFile: string, session: { userAgent: string }): Promise<string | null> {
  const m = voiceFile.match(/^kalarona-resolve:(\d+)$/);
  if (!m) return null;
  const videoId = m[1];
  try {
    const resp = await fetchUpstream(`https://kalarona.org/player/responce.php?video_id=${videoId}`, {
      referer: 'https://www.theboys.fun/',
      userAgent: session.userAgent,
      cookies: [],
    });
    if (resp.statusCode !== 200) {
      fastify.log.warn({ statusCode: resp.statusCode, videoId }, 'kalarona resolve non-200');
      return null;
    }
    const json = JSON.parse(await resp.body.text()) as { src?: string };
    return json.src || null;
  } catch (e) {
    fastify.log.error({ err: e, videoId }, 'kalarona resolve failed');
    return null;
  }
}

fastify.get<{ Params: { roomId: string } }>(`${BASE_PATH}/hls/:roomId/index.m3u8`, async (req, reply) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return reply.code(404).send('room not found');
  try {
    // Резолвим kalarona-resolve:N в живой m3u8 URL
    let voiceFile = room.current.voiceFile;
    if (voiceFile.startsWith('kalarona-resolve:')) {
      const resolved = await resolveKalaronaVoice(voiceFile, room.session);
      if (!resolved) return reply.code(502).send('kalarona resolve failed');
      voiceFile = resolved;
    }
    const upstream = await fetchUpstream(voiceFile, room.session);
    if (upstream.statusCode !== 200) {
      return reply.code(502).send(`upstream ${upstream.statusCode}`);
    }
    const body = await upstream.body.text();
    const rewritten = rewriteManifest(body, voiceFile, room.id, PROXY_SECRET, PUBLIC_BASE_URL);
    return reply
      .type('application/vnd.apple.mpegurl')
      .header('cache-control', 'no-store')
      .send(rewritten);
  } catch (e) {
    req.log.error({ err: e }, 'index.m3u8 fetch failed');
    return reply.code(502).send('upstream error');
  }
});

fastify.get<{ Params: { roomId: string; '*': string } }>(
  `${BASE_PATH}/hls/:roomId/p/*`,
  async (req, reply) => {
    const room = rooms.get(req.params.roomId);
    if (!room) return reply.code(404).send('room not found');

    const token = req.params['*'];
    const dot = token.lastIndexOf('.');
    if (dot < 0) return reply.code(400).send('bad token');
    const encoded = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const target = decodeProxyPath(encoded);
    if (!isAllowedHost(target)) return reply.code(403).send('forbidden host');
    if (!verifyUrl(room.id, target, sig, PROXY_SECRET)) {
      return reply.code(403).send('bad signature');
    }

    try {
      const upstream = await fetchUpstream(target, room.session);
      const ct = String(upstream.headers['content-type'] ?? '').toLowerCase();
      const isManifest = /mpegurl/.test(ct) || /\.m3u8(\?|$)/i.test(target);

      reply
        .code(upstream.statusCode)
        .header('cache-control', upstream.statusCode === 200 ? 'public, max-age=300' : 'no-store');

      if (isManifest) {
        const body = await upstream.body.text();
        const rewritten = rewriteManifest(body, target, room.id, PROXY_SECRET, PUBLIC_BASE_URL);
        return reply.type('application/vnd.apple.mpegurl').send(rewritten);
      }

      const ctOut = ct || (target.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
      return reply.type(ctOut).send(upstream.body);
    } catch (e) {
      req.log.error({ err: e, target }, 'segment proxy failed');
      return reply.code(502).send('upstream error');
    }
  },
);

fastify.register(async (instance) => {
  instance.get<{ Params: { roomId: string }; Querystring: { name?: string } }>(
    `${BASE_PATH}/ws/:roomId`,
    { websocket: true },
    (socket, req) => {
      rooms.attach(req.params.roomId, socket, req.query.name);
    },
  );
});

fastify.get(`${BASE_PATH}/api/health`, async () => ({ ok: true, base: PUBLIC_BASE_URL, basePath: BASE_PATH }));

const shutdown = async (signal: string) => {
  fastify.log.info({ signal }, 'shutting down');
  await fastify.close().catch(() => {});
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`watch-party listening on ${PUBLIC_BASE_URL}`);
} catch (e) {
  fastify.log.error(e);
  process.exit(1);
}
