/**
 * Cinemar embed playlist decoder.
 *
 * Cinemar.cc отдаёт inline `Cinemar({...,"file":"#2<obfuscated>",...})` где после `#2`
 * следует кастомно перетасованная base64-строка, в которой закодирован JSON со всем
 * деревом сезоны → серии → озвучки → m3u8 URL'ы.
 *
 * Алгоритм взят из ProjectBinge (vitaliy-tkachuk/ProjectBinge,
 * packages/provider-sdk/src/playback/hdrezka-playback.ts, функции
 * decodeCinemarPlaylistBin / extractCinemarFileField / extractCinemarTracksByVoiceSegments).
 * Лицензирован MIT, портирован 1:1.
 */

const CINEMAR_SLICE_LEN = 32;

function cinemarSliceJoined(dmAscii: string, payload: string): string {
  const delim = String.fromCharCode(Number(dmAscii));
  return payload
    .split(delim)
    .map((chunk) => {
      const pivot = parseInt(chunk.slice(-1), 10);
      if (Number.isNaN(pivot)) return chunk;
      if (chunk.length > CINEMAR_SLICE_LEN) {
        return (
          chunk.slice(2 * pivot, chunk.length - 3 * pivot - 1) +
          chunk.slice(0, pivot)
        );
      }
      return chunk;
    })
    .join('');
}

function base64ToString(b64: string): string {
  // latin1 — потому что декодированный bin содержит \uXXXX escape sequences
  // (ASCII-литералы), а не raw UTF-8 байты. utf8 ломает невалидные multibyte
  // последовательности заменой на U+FFFD и валит JSON.parse.
  return Buffer.from(b64, 'base64').toString('latin1');
}

export function decodeCinemarPlaylistBin(fileField: string): string {
  if (!fileField.startsWith('#2')) {
    throw new Error('Cinemar file field does not use #2 encoding');
  }
  const body = fileField.slice(2);
  const dm = body.slice(0, 2);
  const sliced = cinemarSliceJoined(dm, body.slice(2));
  let b64 = sliced;
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  return base64ToString(b64);
}

export function extractCinemarFileField(embedHtml: string): string | null {
  const fromCall = embedHtml.match(
    /Cinemar\s*\(\s*\{[\s\S]*?"file"\s*:\s*"((?:\\"|[^"])*)"\s*,/i,
  );
  if (fromCall?.[1]) {
    return fromCall[1].replace(/\\"/g, '"').replace(/\\\//g, '/');
  }
  const simple = embedHtml.match(/"file"\s*:\s*"(#2[^"]+)"/);
  return simple?.[1] ?? null;
}

export function extractCinemarVid(embedHtml: string): number | null {
  const m = embedHtml.match(/"vid"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Дерево из embed playlist. Структура такая:
 *
 *   playlist (root, array)
 *     ├── { id:"s01", title:"Сезон 1", folder:[
 *     │     ├── { id:"s01e01", title:"Серия 1", folder:[
 *     │     │     ├── { id, src_id, voice_id, title:"LostFilm...", file:"https://..." }
 *     │     │     ├── { voice_id, title:"HDrezka...", file:"..." }
 *     │     │   ]},
 *     │     ├── { id:"s01e02", ... }
 *     │   ]},
 *     ├── { id:"s02", ... }
 *
 * Для одной серии fields для каждой озвучки: { id, src_id, voice_id, title, file, title2, poster }
 */
export interface VoiceTrack {
  id?: string;
  src_id?: number;
  voice_id?: number;
  title: string;
  title2?: string;
  file: string;
  poster?: string;
}

export interface EpisodeNode {
  id: string;
  title: string;
  voices: VoiceTrack[];
}

export interface SeasonNode {
  id: string;
  title: string;
  episodes: EpisodeNode[];
}

export interface CinemarPlaylist {
  seasons: SeasonNode[];
}

function normalizeFileUrl(file: string): string {
  let p = file.replace(/\\\//g, '/').trim();
  if (p.startsWith('//')) p = 'https:' + p;
  return p;
}

function decodeUnicodeEscapes(s: string): string {
  let r = s;
  for (let n = 0; n < 4 && /\\u[0-9a-fA-F]{4}/.test(r); n++) {
    r = r.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
  }
  return r;
}

/**
 * Извлекает все voice tracks из decoded bin через regex (потому что bin содержит
 * остатки бинарной обфускации в местах между валидными JSON-фрагментами — JSON.parse
 * целиком не работает).
 *
 * Группирует voices по серии (используя ближайший предыдущий `"id":"sXXeYY"` маркер)
 * и серии по сезонам (`"id":"sXX"`).
 */
export function parseCinemarPlaylist(bin: string): CinemarPlaylist {
  // Находим все "id":"sXX" / "id":"sXXeYY" / voice блоки в одном pass с их позициями.
  // Маркеры серии: `"id":"s01e02","title":"...","folder":[`
  // Маркеры сезона: `"id":"s01","title":"...","folder":[`
  // Voice: `"voice_id":N,"title":"...","file":"//..."` (или title до voice_id — порядок не гарантирован)

  type Marker =
    | { kind: 'season'; id: string; title: string; pos: number }
    | { kind: 'episode'; id: string; title: string; pos: number }
    | { kind: 'voice'; voiceId?: number; title: string; file: string; pos: number };

  const markers: Marker[] = [];

  const folderRe = /"id"\s*:\s*"(s\d+(?:e\d+)?)"\s*,\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"folder"/g;
  for (const m of bin.matchAll(folderRe)) {
    const id = m[1]!;
    const title = decodeUnicodeEscapes(m[2]!.replace(/\\"/g, '"'));
    const pos = m.index!;
    markers.push({
      kind: /^s\d+e\d+$/.test(id) ? 'episode' : 'season',
      id,
      title,
      pos,
    });
  }

  // voice блоки. Title и voice_id могут идти в любом порядке. Сначала ловим file URL.
  const fileRe = /"file"\s*:\s*"(\\?\/\\?\/[^"]+m3u8[^"]*)"/g;
  for (const m of bin.matchAll(fileRe)) {
    const file = normalizeFileUrl(m[1]!);
    const pos = m.index!;
    // ищем title и voice_id в ближайшем окне (-2000..pos)
    const window = bin.slice(Math.max(0, pos - 3000), pos);
    const titleMatches = [...window.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    const lastTitle = titleMatches.length
      ? decodeUnicodeEscapes(titleMatches[titleMatches.length - 1]![1]!.replace(/\\"/g, '"'))
      : '';
    const voiceIdMatch = window.match(/"voice_id"\s*:\s*(\d+)(?![\s\S]*"voice_id")/);
    const voiceId = voiceIdMatch ? Number(voiceIdMatch[1]) : undefined;
    markers.push({ kind: 'voice', voiceId, title: lastTitle, file, pos });
  }

  markers.sort((a, b) => a.pos - b.pos);

  // Группируем
  const seasons: SeasonNode[] = [];
  let curSeason: SeasonNode | null = null;
  let curEpisode: EpisodeNode | null = null;

  for (const mk of markers) {
    if (mk.kind === 'season') {
      curSeason = { id: mk.id, title: mk.title, episodes: [] };
      seasons.push(curSeason);
      curEpisode = null;
    } else if (mk.kind === 'episode') {
      // если до этого не было сезона (single-season формат) — создаём фейковый
      if (!curSeason) {
        curSeason = { id: 's01', title: 'Сезон 1', episodes: [] };
        seasons.push(curSeason);
      }
      curEpisode = { id: mk.id, title: mk.title, voices: [] };
      curSeason.episodes.push(curEpisode);
    } else {
      // voice — добавляем в текущую серию. Если её нет (фильм без серий) — создаём.
      if (!curSeason) {
        curSeason = { id: 'film', title: 'Фильм', episodes: [] };
        seasons.push(curSeason);
      }
      if (!curEpisode) {
        curEpisode = { id: `${curSeason.id}-1`, title: '1', voices: [] };
        curSeason.episodes.push(curEpisode);
      }
      curEpisode.voices.push({
        voice_id: mk.voiceId,
        title: mk.title || `Voice ${curEpisode.voices.length + 1}`,
        file: mk.file,
      });
    }
  }

  // Убираем сезоны/серии без voices
  for (const s of seasons) {
    s.episodes = s.episodes.filter((e) => e.voices.length > 0);
  }
  return { seasons: seasons.filter((s) => s.episodes.length > 0) };
}

export function decodeCinemarEmbedHtml(embedHtml: string): CinemarPlaylist {
  const fileField = extractCinemarFileField(embedHtml);
  if (!fileField) throw new Error('cinemar: file field not found in embed HTML');
  if (!fileField.startsWith('#2')) {
    throw new Error('cinemar: file field is not #2-encoded (unsupported format)');
  }
  const bin = decodeCinemarPlaylistBin(fileField);
  return parseCinemarPlaylist(bin);
}
