# Implementing remaining kinomix.web.app providers

Этот документ — фиксированный аудит остальных 6 провайдеров kinomix.web.app,
сделанный 2026-05-24. Цель была расширить охват озвучек.

---

## TL;DR (итог 2 итераций аудита)

| Provider | Verdict | Notes |
|---|---|---|
| **Collaps** | ✅ shipped | (76de998) Multi-audio HLS, 720p. Direct undici-fetch с VPS. |
| **Videoseed** | ✅ shipped | Playwright + route-fulfill `videoseed.tv` wrapper (Sec-Fetch-Dest: iframe) + base64 Playerjs decode. CDN `storage.videoseedcdn.com`. Добавляет голос "Comedy Central". |
| **Vibix** | ✅ shipped | Playwright + coldfilm.ink wrapper с publisher SDK по kp_id → kinescopecdn iframe → embed-(serials\|movies) API response → XOR-decode (lampac key `RySdvcyu5iTUxn97vn4HwoniwgxaCynA`) → прямые подписанные m3u8. Единственный 1080p источник. |
| **Flixcdn** | ⚠️ opt-in (`WATCH_FLIXCDN=1`) | Код готов, но Cloudflare Turnstile блокирует Playwright fingerprint (401 на cdn-cgi/.../pat). Голоса дублируют Videoseed (Comedy Central) — нет смысла включать. |
| **Gencit** | ❌ defer | Anti-frame: горсез.org → ylitron.pro отдаёт "404 Not Found" с JS-стрипом body в iframe. Нет open-source решения. |
| **Turbo** | ❌ defer | `wsdk.js` proprietary anti-bot SDK, 403 даже в Playwright. Лампак комментарий "usually doesn't work". |
| **Alloha (sansa)** | ❌ defer | Требует **paid token** ($30/мес) для прямого API. Иначе только iframe-passthrough. |

**Итог**: для тестового kp_id 277565 — было 2 голоса (Collaps), стало 6:
Collaps×2 (Кураж-Бамбей multi-audio, Eng.Original) + Videoseed×3 (Кураж-Бамбей,
Английский, Comedy Central) + Vibix×1 (Кураж-Бамбей в 1080p).

**Архитектурное решение**: `captureFromKinomix` агрегирует voices от всех провайдеров
в одну `PlayerStructure`, дедуп по имени с суффиксом `(Videoseed)`/`(Vibix)`.
URL'ы Vibix/Videoseed валидны ~1h — re-resolve при probeCache miss. Crawler
`scripts/crawl-kinomix.mjs` сохраняет `videoseed_iframe`, `vibix_available`,
`ortified_id`, `flixcdn.*` в `data/kinomix-cache.json`.

**Не реализовано** (с обоснованием):
- Gencit/Turbo — нет public solution (research lampac/reyohoho)
- Alloha — требует платный token API
- Flixcdn — Cloudflare Turnstile блокирует автоматизированный браузер

---

## Архитектура (быстрый refresher)

Три паттерна экстракции уже реализованы:

| Паттерн | Пример | Файлы | Когда применять |
|---|---|---|---|
| **Playwright + JSON.parse hook** | kinogo (cinemar), lordfilm (venom) | `captureFromKinogo`, `captureFromLordfilm` в `src/extractor.ts` | Когда плеер декодирует обфусцированный playlist на клиенте через `JSON.parse(decoded)` |
| **HTTP + Pre-crawl cache** | theboys.fun, kinomix.web.app | `captureFromTheboys`, `captureFromKinomix` | Когда сайт блокирует datacenter IPs или требует SPA-context, но backend embed-сервиса доступен напрямую |
| **Per-request resolver** | theboys (kalarona) | `resolveKalaronaVoice` в `src/server.ts` | Когда нужно динамически дёрнуть свежий m3u8 URL перед каждой раздачей |

Точки входа в коде:
- `src/extractor.ts:detectSource()` — диспатч URL → source name
- `src/extractor.ts:extractM3U8()` — основной orchestrator, dispatches на нужную `captureFromX`
- `src/hls-proxy.ts:ALLOWED_HOSTS_RE` — whitelist стрим-CDN'ов
- `src/server.ts:validateSourceUrl()` — какие host'ы принимать в `/api/extract`
- `data/*.json` — pre-crawl кеши
- `scripts/crawl-*.mjs` — локальные краулеры (запускаются с residential IP через
  Playwright Chrome для обхода TLS-фингерпринта)

Маркеры `<provider>-resolve:<id>` хранятся в `room.current.voiceFile` для
provider'ов которые требуют late-binding m3u8 (например `kalarona-resolve:`).
Resolver вызывается в `/hls/:roomId/index.m3u8` handler.

---

## Полный ответ `api.kinobox.tv` для тестового контента

**Тестовый kinopoisk_id**: `277565` (сериал "Все ненавидят Криса" / Everybody Hates Chris).

URL запроса: `https://api.kinobox.tv/api/players?kinopoisk=277565`

Этот хост требует **TLS-fingerprint + warm SPA context** для ответа. Из VPS и
из undici fetch'а возвращает HTTP/2 PROTOCOL_ERROR. Способ воркэраунда:
загрузить `kinomix.web.app` в Playwright Chrome, потом `page.evaluate(() =>
fetch(API_URL))` — fetch из контекста SPA проходит. См.
`scripts/crawl-kinomix.mjs`.

Полный ответ (сжатый):

```json
{
  "data": [
    {
      "type": "Alloha",
      "iframeUrl": "https://sansa.stravers.live/?token_movie=a8313b8a5a4faab74ea053cc0815a7&token=48ac5259825fb8f20103dac69a9029",
      "translations": [
        { "id": 93, "name": "Оригинальный", "quality": "WEB-DL", "iframeUrl": "...&translation=93..." },
        { "id": 70, "name": "Кураж-бамбей", "quality": "WEB-DL", "iframeUrl": "...&translation=70..." },
        { "id": 286, "name": "Comedy Central", "quality": "WEB-DL", "iframeUrl": "...&translation=286..." }
      ]
    },
    {
      "type": "Turbo",
      "iframeUrl": "https://92d73433.obrut.show/embed/MjM/content/kjN3kzM",
      "translations": [{ "id": null, "name": null, "quality": null, "iframeUrl": "..." }]
    },
    {
      "type": "Gencit",
      "iframeUrl": "https://horsez.org/lat/812",
      "translations": [
        { "id": 12, "name": "Дубляж", "iframeUrl": "https://horsez.org/lat/812?voice=12" },
        { "id": 14, "name": "Кураж-Бамбей", "iframeUrl": "https://horsez.org/lat/812?voice=14" }
      ]
    },
    { "type": "Kodik", "iframeUrl": null, "translations": [] },
    {
      "type": "Vibix",
      "iframeUrl": "https://667481665.videoframe2.com/embed-serials/702",
      "translations": [
        { "id": 43, "name": "Кураж-Бамбей", "quality": "FullHD", "iframeUrl": "...?voiceover=43" }
      ]
    },
    {
      "type": "Videoseed",
      "iframeUrl": "https://tv-1-kinoserial.net/embed_serial/913/?token=a82f44b1b020395e7677d9c9132116d6",
      "translations": [
        { "id": null, "name": "Профессиональный (одноголосый закадровый) (Кураж-Бамбей)", "iframeUrl": "..." },
        { "id": null, "name": "[EN] Original (English)", "iframeUrl": "..." },
        { "id": null, "name": "Профессиональный (многоголосый закадровый) (Comedy Central)", "iframeUrl": "..." }
      ]
    },
    {
      "type": "Flixcdn",
      "iframeUrl": "https://tarantino.factorios.live/show/kinopoisk/277565",
      "translations": [
        { "id": 564, "name": "Профессиональный (одноголосый закадровый) (Кураж-Бамбей)", "iframeUrl": "...?translation=564" },
        { "id": 2062, "name": "Профессиональный (многоголосый закадровый) (Comedy Central)", "iframeUrl": "...?translation=2062" }
      ]
    },
    {
      "type": "Collaps",
      "iframeUrl": "https://api.ortified.ws/embed/movie/549",
      "translations": [
        { "id": null, "name": "Кураж-Бамбей", "quality": "FHD (1080p)", "iframeUrl": "..." },
        { "id": null, "name": "Eng.Original", "quality": "FHD (1080p)", "iframeUrl": "..." }
      ]
    }
  ]
}
```

Полный JSON-ответ для 277565 можно дёрнуть через MCP-браузер: открыть
`https://kinomix.web.app/`, потом
`mcp__playwright__browser_evaluate({function: "() => fetch('https://api.kinobox.tv/api/players?kinopoisk=277565').then(r => r.json())"})`.

---

## Per-provider план

Везде в качестве test-URL: `https://kinomix.web.app/movie/277565`.

### 1. Flixcdn (`tarantino.factorios.live`)

**Embed URL**: `https://tarantino.factorios.live/show/kinopoisk/{kp_id}?translation={voice_id}`

**Почему первым**: kinopoisk_id уже в URL → **не нужен отдельный cache**, можно
напрямую с прода. Translation IDs (564, 2062) тоже в `api.kinobox.tv` ответе
но они стабильны per-provider — возможно можно zaхардкодить mapping.

**Шаги исследования**:
1. Открыть `https://tarantino.factorios.live/show/kinopoisk/277565` в MCP-браузере
2. `browser_network_requests` — посмотреть какой API/m3u8 загружается
3. Если ответ — HTML c inline `playlist:` или подобным → парсить как venom
4. Если ответ делает отдельный API-call (`/api/...`) → curl с правильным
   Referer и UA, посмотреть JSON
5. Найти stream-CDN (там где m3u8 segments)

**Если повезёт**: можно без cache, прямой HTTP-fetch с VPS. Образец —
`captureFromKinomix` но без cache-lookup.

**Voice mapping**: `Кураж-Бамбей` = `translation=564`, `Comedy Central` =
`translation=2062`. Сохранить как константы в коде.

### 2. Vibix (`videoframe2.com`)

**Embed URL**: `https://667481665.videoframe2.com/embed-serials/{id}?voiceover={voice_id}`

**Гипотеза**: префикс `667481665.` — обфусцированный поддомен. Internal ID
`702` нужно кешировать (как Collaps `ortified_id`). FullHD качество (выше чем
у Collaps) — приятный bonus.

**Шаги**:
1. Открыть iframe URL в MCP, проверить нужен ли Referer от kinomix
2. Посмотреть network requests — какой API/CDN
3. Если token-signed m3u8 → нужен resolver (как kalarona)
4. Если плеер использует Playerjs/Venom — переиспользуем существующий парсер

**Кеш**: понадобится `kinopoisk_id → vibix_id` + per-voice mapping.

### 3. Gencit (`horsez.org/lat`)

**Embed URL**: `https://horsez.org/lat/{id}?voice={voice_id}`

**ID**: `812`. **Voices**: 12 (Дубляж), 14 (Кураж-Бамбей).

**Шаги**: то же что Vibix — открыть в MCP, проверить flow, найти m3u8 host.

**Особенность**: «Дубляж» (полный дубляж, не закадровый) — уникален среди
провайдеров. Стоит добавить ради него.

### 4. Turbo (`obrut.show`)

**Embed URL**: `https://92d73433.obrut.show/embed/MjM/content/kjN3kzM`

**Гипотеза**: `MjM`, `kjN3kzM` — base64-like обфускация. `92d73433.` — sharded
поддомен. Сам по себе URL не содержит `277565` → нужна обратная зависимость
для cache (kp → turbo URL → content_id).

**Шаги**:
1. MCP `browser_navigate` к этому URL (с Referer kinomix)
2. Если нужна Playwright + JSON.parse hook (как cinemar) — переиспользуем
3. Если нет вложенной структуры — нужно отдельный extract per (season, episode)

**Сложность**: средняя. Зависит от того насколько обфусцирован decode.

### 5. Videoseed (`tv-1-kinoserial.net`)

**Embed URL**: `https://tv-1-kinoserial.net/embed_serial/{id}/?token={token}`

**Особенности**: `token` подписан и (возможно) с TTL. `default_audio` query
param используется для переключения дорожек на клиенте — m3u8 один с
multi-audio (как venom).

**Шаги**:
1. Открыть `embed_serial/913/?token=...` в MCP
2. Если token истёк (probably yes) — нужно сначала получить свежий через
   `api.kinobox.tv`
3. Парсить как venom если multi-audio, иначе как per-voice url
4. Если token часто истекает → resolver-pattern (как kalarona)

### 6. Alloha (`sansa.stravers.live`)

**Embed URL**: `https://sansa.stravers.live/?token_movie=...&token=...&translation={voice_id}`

**Наблюдения из MCP network log** (для 277565):
```
POST https://sansa.stravers.live/bnsi/movies/882179 → 200
GET https://e1-72-f3-r402.rtbcdn.cloud/.../master.m3u8 → 200
```

Internal sansa_id = `882179`. m3u8 на `rtbcdn.cloud` (этот хост **уже в
whitelist** из работы с Collaps).

**Сложность**: высокая. Нужно:
1. Получить sansa_id из kinobox API (`token_movie` и `token` — публичные
   токены агрегатора, не плеера)
2. Sansa.stravers.live на GET /?... отвечает HTML iframe-страницей с inline
   JS-декодером
3. JS делает POST `/bnsi/movies/<sansa_id>` с какой-то полезной нагрузкой
4. Ответ — JSON или encoded m3u8 URL
5. Воспроизведение через rtbcdn.cloud

Возможно понадобится:
- Реверсить JS-обфусцированный decoder
- Или MITM весь flow через Playwright (как делали для femd) — захватывать
  `/bnsi/movies/<id>` response

Стоит ли усилий — спорный вопрос. Уникальные озвучки у Alloha: «Оригинальный»
(другая ред. чем `Eng.Original` у Collaps?), уже есть Кураж-бамбей и
Comedy Central в других провайдерах.

---

## Шаблон имплементации (на основе captureFromKinomix)

Имя файла, ключи интерфейса, etc:

```ts
// src/extractor.ts

// 1. Добавить тип в detectSource
export function detectSource(url: string): 'kinogo' | 'lordfilm' | 'theboys' | 'kinomix' | 'flixcdn' | ... | null {
  if (/lordfilm/i.test(url)) return 'lordfilm';
  ...
  if (/kinomix\.web\.app/i.test(url)) return 'kinomix';
  // У большинства новых провайдеров source URL ВСЁ РАВНО будет kinomix.web.app —
  // мы их используем как АЛЬТЕРНАТИВНЫЕ провайдеры внутри kinomix, не как
  // separate URL-sources. То есть detectSource НЕ ВСЕГДА расширяется. См.
  // примечание ниже про "voice selection across providers".
}

// 2. Если нужно cache mapping
interface FlixcdnCacheEntry { kinopoisk_id: number; /* что нужно еще */ }
const flixcdnCache = new Map<string, FlixcdnCacheEntry>();
async function loadFlixcdnCache(): Promise<void> { /* read data/flixcdn-cache.json */ }

// 3. captureFromFlixcdn
async function captureFromFlixcdn(kpId: number): Promise<{ playlist: PlayerStructure; cookies: ExtractResult['cookies'] }> {
  // a. Сконструировать embed URL
  const embedUrl = `https://tarantino.factorios.live/show/kinopoisk/${kpId}`;
  // b. undici fetch
  const { request } = await import('undici');
  const res = await request(embedUrl, {
    headers: { 'user-agent': UA, referer: 'https://kinomix.web.app/' },
  });
  if (res.statusCode !== 200) throw new ExtractorError(`flixcdn HTTP ${res.statusCode}`, 'playlist');
  const body = await res.body.text();
  // c. Парсить body — формат зависит от провайдера
  // Если venom-like: const seasons = extractVenomSeasons(body);
  // Если playerjs-like: нужен Playwright hook ИЛИ regex по inline JS
  // d. Построить PlayerStructure
  ...
}
```

### Когда extractor НЕ нужно расширять

Большинство «других провайдеров» kinomix — это **альтернативные озвучки**
для уже-поддерживаемого Collaps-контента. Если хочется дать пользователю
выбор между озвучками разных провайдеров, лучше расширить **captureFromKinomix**
чтобы он:
1. Достал ВСЕ провайдеры из cache (не только Collaps)
2. Объединил их voices в одну PlayerStructure
3. Маркер voiceFile хранит инфу о провайдере: `flixcdn-resolve:kp=277565&tr=564`
4. /hls/.../index.m3u8 handler роутит на provider-specific resolver

Это **изящнее** чем плодить captureFromX функций. Но требует:
- Расширить cache: `kinomix-cache.json` хранит ВСЕ провайдеры per kp_id, не только Collaps
- Унифицированный resolver-механизм (например `provider-resolve:<provider>:<args>`)
- Per-provider runtime fetch которые работают с VPS

Решение по архитектуре — на твое усмотрение.

---

## Crawler шаблон (для cache-based провайдеров)

`scripts/crawl-X.mjs`:

```js
// Если нужен MCP-стиль "warm-context fetch" (TLS fingerprint workaround)
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();
await page.goto('https://kinomix.web.app/');  // warm SPA context
await page.waitForTimeout(2000);

for (const kpId of ids) {
  const json = await page.evaluate(async (id) => {
    const r = await fetch(`https://api.kinobox.tv/api/players?kinopoisk=${id}`);
    return await r.json();
  }, kpId);
  // ... extract whatever needed for this provider
}

await browser.close();
// save to data/X-cache.json
```

---

## Чек-лист на одну итерацию (один провайдер)

- [ ] Открыть test embed URL в MCP браузере (с Referer kinomix.web.app)
- [ ] `browser_snapshot` — есть ли iframe-вложенность? video element?
- [ ] `browser_network_requests` filter по `m3u8|api|playlist`
- [ ] Найти **resolved m3u8 URL** + его CDN host
- [ ] Понять как из embed URL получаются: список сезонов, эпизодов, озвучек
- [ ] Проверить из VPS (`ssh frogsrop@frogsrop.dev`) — доступен ли CDN-хост и
      api endpoint без блока? Если CDN блокирует — провайдер не наш
- [ ] Решить: cache-based (если нужен Playwright/TLS-bypass) или
      direct HTTP (если undici работает с VPS)
- [ ] Написать `captureFromX` + (опц.) crawler script
- [ ] Добавить CDN-хост в `ALLOWED_HOSTS_RE`
- [ ] `npm run typecheck && npm test && npm run build`
- [ ] scp `dist/*.js` + (опц.) `data/*.json` на прод
- [ ] `ssh ... systemctl restart watch`
- [ ] Тест end-to-end:
      `curl -X POST .../api/extract -d '{"url":"<kinomix URL>", "voice":"<X provider voice name>"}'`
- [ ] Browser test через MCP — duration корректный, video играет

---

## Известные gotchas (повторение если что)

| Симптом | Причина | Воркэраунд |
|---|---|---|
| `HTTP/2 PROTOCOL_ERROR` | TLS fingerprint (api.kinobox.tv) | Playwright `page.evaluate(() => fetch())` после warm-load SPA |
| `403 ACCESS RESTRICTED` | Datacenter IP block (theboys.fun) | Crawl локально, ship cache JSON |
| `404` после редиректа | Referer check (plplayer.online → kalarona) | Set Referer: parent SPA URL |
| Бинарные данные вместо HTML | Без UA-header — server отвечает 0 байт | Set realistic Chrome User-Agent |
| Working hello, but body empty | `curl -I` (HEAD) не support'ит, нужен GET | use `curl -s` (GET без download) |
| `ERR_HTTP2_PROTOCOL_ERROR` в Chrome | Server-side filter | Попробуй `curl --http1.1` |
| Token expired (~1h-3h TTL) | Signed URL | Resolver pattern (как kalarona-resolve) |
| `Object.defineProperty` накатывает наш hook | Webpack UMD redefine | Use `page.on('response')` вместо JS-runtime hook |

---

## Тестовые kinopoisk_ids для разнообразия

| kp_id | Контент | Тип | Зачем |
|---|---|---|---|
| 277565 | Все ненавидят Криса | Сериал, sitcom | Текущий test case |
| 454920 | Пацаны (Boys) | Сериал, drama | Уже работает у нас через theboys.fun cache — можно сравнить с kinomix |
| 535341 | Игра престолов | Сериал, длинный | 8 сезонов, много озвучек — стресс-тест |
| 460586 | Все ненавидят Криса (?) | возможно тот же | сверить |

Можно также взять любой Movie kp_id — структура `{ "1": { "1": [voices] } }`
с одним сезоном/эпизодом.

---

## Файлы которые нужно потрогать (resume map)

```
src/
├── extractor.ts          — добавить captureFromX, расширить detectSource (опционально)
├── server.ts             — расширить validateSourceUrl regex (если URL новых host'ов)
└── hls-proxy.ts          — добавить CDN-host'ы в ALLOWED_HOSTS_RE
data/
├── kinomix-cache.json    — текущий (только Collaps). Расширить под все providers (опционально)
└── <provider>-cache.json — если provider требует отдельный cache
scripts/
├── crawl-kinomix.mjs     — текущий (только Collaps). Расширить
└── crawl-<provider>.mjs  — если provider требует отдельный crawler
docs/
└── players-implementation.md — этот файл (обновляй заметки по ходу)
```

---

## Quick-start команды

```bash
# Локальный тест extractor
node scripts/test-extractor.mjs "https://kinomix.web.app/movie/277565"

# Probe (только структура, без создания комнаты)
curl -s -X POST https://frogsrop.dev/watch/api/probe \
  -H 'content-type: application/json' \
  -d '{"url":"https://kinomix.web.app/movie/277565"}' \
  | jq '.structure.seasons[0].episodes[0].voices[]'

# Extract с конкретной voice
curl -s -X POST https://frogsrop.dev/watch/api/extract \
  -H 'content-type: application/json' \
  -d '{"url":"https://kinomix.web.app/movie/277565","season":"1","episode":"1","voice":"Comedy Central"}' \
  | jq

# Deploy после изменений
cd C:/Projects/watch
npm run typecheck && npm test && npm run build
scp dist/extractor.js dist/server.js dist/hls-proxy.js frogsrop@frogsrop.dev:~/watch/dist/
scp data/*.json frogsrop@frogsrop.dev:~/watch/data/  # если поменялись
ssh frogsrop@frogsrop.dev 'sudo systemctl restart watch'

# Логи на проде
ssh frogsrop@frogsrop.dev 'sudo journalctl -u watch -f'

# Debug на проде (временно включить)
ssh frogsrop@frogsrop.dev 'sudo sed -i "s/WATCH_DEBUG=.*/WATCH_DEBUG=1/" /etc/watch.env && sudo systemctl restart watch'
# не забыть выключить!
ssh frogsrop@frogsrop.dev 'sudo sed -i "s/WATCH_DEBUG=.*/WATCH_DEBUG=0/" /etc/watch.env && sudo systemctl restart watch'
```

---

## Что НЕ делать

- **Не реверсить sansa.stravers.live JS** в первую очередь — это самое сложное.
  Сделать его последним.
- **Не плодить отдельные `captureFromX` функций**, если можно расширить
  существующую (особенно `captureFromKinomix`). Voice selection — это data,
  не code.
- **Не качать m3u8 сегменты с VPS** для тестов — это потратит трафик. Хватит
  `curl -sI` для проверки доступности.
- **Не хардкодить kinopoisk_id** — все cache-структуры key'ются по kp_id для
  расширяемости.

---

## Что нужно подтвердить в первой итерации новой сессии

1. Этот файл актуален (проверить дату последнего коммита `git log -- docs/players-implementation.md`)
2. Прод доступен и работает: `curl -s https://frogsrop.dev/watch/api/health`
3. Все 12 тестов всё ещё проходят: `npm test`
4. MCP-браузер работает (для probe'ов)

Удачи!
