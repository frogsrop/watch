# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project goal

Synchronized watch-party — host вставляет URL, друзья открывают ссылку и смотрят синхронно одно и то же видео. Лидер выбирает сезон/серию/озвучку (или озвучку для фильма) прямо в комнате; смена источника broadcast'ится всем зрителям.

**Supported sources** (autodetected по URL):
- **kinogo.ec** (cinemar embed) — Variant A сериал / Variant B фильм. Каждая озвучка = свой m3u8.
- **lordfilm.*** (femd.ws embed → player-venom) — multi-track HLS: один master.m3u8 на эпизод, озвучка = `hls.audioTrack` индекс.
- **theboys.fun** (plplayer.online → kalarona.org) — Variant D. Сайт **блокирует datacenter IPs**, поэтому Playwright-extract с VPS не работает. Воркэраунд: pre-crawl всей серии локально (`scripts/crawl-theboys.mjs` с residential IP) → JSON-кеш `data/theboys-<slug>.json` шипится в репо. На проде voiceFile хранится как маркер `kalarona-resolve:<video_id>`; при `/hls/.../index.m3u8` сервер `fetch`'ит `kalarona.org/player/responce.php?video_id=N` (с Referer theboys.fun) — kalarona отдаёт свежий signed m3u8 URL — дальше обычный rewriteManifest. kalarona.org из datacenter IPs не блокирует.
- **kinomix.web.app** (`api.kinobox.tv` агрегатор) — Variant E. Aggregator-паттерн: `captureFromKinomix` склеивает голоса от нескольких kinobox-провайдеров в одну `PlayerStructure`, дедуп по имени с суффиксом провайдера для коллизий. Поддерживаются:
  - **Collaps** (`api.ortified.ws` venom) — undici-fetch с VPS работает; multi-audio HLS как у lordfilm. Default источник по умолчанию.
  - **Videoseed** (`tv-1-kinoserial.net` → Playerjs + base64-decoded JSON, CDN `storage.videoseedcdn.com`) — Playwright runtime: открываем wrapper-HTML на `videoseed.tv` через route-fulfill (нужен Sec-Fetch-Dest: iframe), перехватываем response iframe URL'a, decode `#2{base64}` (strip `|||...==` watermarks). Token iframe-URL имеет TTL ~неделя — при истечении надо re-crawl.
  - **Vibix** (`coldfilm.ink` → `kinescopecdn.net`) — Playwright runtime: route-fulfill `coldfilm.ink` с `<ins data-publisher-id="674784070" data-type="kp" data-id="<kp>">` + `rendex-sdk.min.js`, SDK резолвит kp_id в kinescopecdn iframe → перехватываем `/api/v1/embed-(serials|movies)/N` response → `{p, v: 1}` JSON → reverse(p) + base64 + XOR с ключом lampac `RySdvcyu5iTUxn97vn4HwoniwgxaCynA` → JSON с **прямыми подписанными m3u8 URLs** (1080p доступен — единственный 1080p-источник у нас). Подписи `?expires=<unix>&sign=<hex>` валидны ~1h.
  - **Flixcdn** (опт-ин `WATCH_FLIXCDN=1`) — Cloudflare Turnstile блокирует Playwright fingerprint (401 на cdn-cgi/challenge-platform/.../pat); код готов, voiceFile = `flixcdn-resolve:<show>|<trans>|<s>|<e>`, но resolve фейлится без серьёзного stealth.

  `api.kinobox.tv` сама блокирует datacenter IPs через **TLS-фингерпринтинг** (даже undici/curl с VPS падает HTTP/2 PROTOCOL_ERROR), но fetch из контекста уже загруженной kinomix.web.app проходит. Crawl: `scripts/crawl-kinomix.mjs <kp_id>` локально через Playwright делает `page.evaluate(() => fetch('/api/players?kinopoisk=N'))` и сохраняет `data/kinomix-cache.json` с полями `ortified_id`, `flixcdn.{show_id,is_serial,seasons_episodes,translations}`, `videoseed_iframe`, `vibix_available`. На проде Vibix/Videoseed резолвят m3u8 каждый раз через свой Playwright-flow (URL signing с TTL делает upfront-cache бессмысленным). Контент стримится с `*.interkh.com` + `*.rtbcdn.cloud` (Collaps/lordfilm), `storage.videoseedcdn.com` (Videoseed), `*.kinescopecdn.net` (Vibix), `*.kinohd.co` (Flixcdn) — все в whitelist.

Users в России. Self-hosted на одном VPS — kinogo/lordfilm сами играют в РФ, наш сервер только: (a) обходит Cloudflare на kinogo через Playwright (lordfilm без Cloudflare), (b) проксирует HLS-сегменты с whitelisted CDN'ов через свой домен с HMAC-подписями, (c) синхронизирует play/pause/seek по WebSocket.

## Current state — что работает

Self-hosted Ubuntu 22.04+ VPS (минимум 2 GB RAM / 1 vCPU + Node 22+, Google Chrome stable, xvfb, systemd, nginx/Caddy reverse proxy). Поддерживается root-deploy и subpath-deploy (см. `PUBLIC_BASE_PATH` ниже).

### Лендинг (`/`)
Одно URL-поле → POST `/api/extract` → создаётся комната с default-источником. Spinner SVG в `.status::before` показывает прогресс, ошибки рендерятся с красным X-icon. После успеха появляется `.result` карточка с copy-полем + ссылкой «Открыть плеер».

### Комната (`/room/:id`)
- hls.js плеер + WS-комната, follow-the-leader.
- **HUD**: бейджи слева (роль `★ лидер`/`зритель`, viewers count, текущий источник) + кнопки справа (`Сменить серию` для сериалов / `Выбрать озвучку` для фильмов + `Скопировать ссылку`).
- **Picker overlay**: для сериалов 3 row'а (Сезон / Серия / Озвучка), для фильмов только Озвучка (`row-season` и `row-episode` скрыты).
- **Source change**: лидер жмёт «Применить» → `POST /api/room/:id/switch` → WS event `source-change` → все клиенты `hls.destroy() + loadSource('?v=N')` + `video.currentTime = 0` + toast «Источник: ...» (для фильма «Озвучка: ...»).
- **Guest controls**: зрители не видят native controls (`controls` attribute снимается), вместо них — glass-pill снизу с **mute / volume slider / PiP / fullscreen / CC** (CC показывается только если HLS отдаёт subtitle-tracks). Keyboard shortcuts на play/pause/seek (Space, K, ←/→, J/L, Comma/Period, Home/End) интерсептятся для гостя. `controlsList="nodownload noremoteplayback noplaybackrate"` всегда.
- **Sync**: snapshot при welcome, playback/seek события мгновенно. Heartbeat от лидера каждые **10 сек** (`HEARTBEAT_INTERVAL_MS`), зритель ресинкается если дрифт **>1.5 сек** (`DRIFT_RESYNC_THRESHOLD_S`). Тюнятся через константы в `player.js`.

### Видеоконтент
- **kinogo сериал** (Variant A): JSON.parse-hook ловит `[{folder: [episodes], ...}]` → seasons / episodes / voices (каждая озвучка — свой m3u8).
- **kinogo фильм** (Variant B): JSON.parse-hook ловит плоский `[{title, file}, ...]` → оборачивается в один сезон `id: 'film'` / один эпизод `id: 'film'` / N озвучек. UI определяет фильм через `isMovie()` (id == 'film').
- **lordfilm** (Variant C, venom): `page.on('response')` ловит ответ `api.femd.ws/embed/movie/<id>` → `extractVenomSeasons()` парсит инлайн JS `seasons:[...]`. Каждый эпизод имеет ОДИН master.m3u8 + многоязычные audio tracks (LostFilm, AlexFilm, Кубик в кубе, и пр.) + VTT субтитры (Eng full/SDH, Рус, Укр). На клиенте: `hls.audioTrack = current.audioTrack` после `MANIFEST_PARSED` без destroy/recreate hls.
- **Субтитры** (только venom/lordfilm — у cinemar нет): `EpisodeInfo.subtitles?[]` хранит сырые VTT-URL. Server endpoint `/hls/:roomId/sub/:idx` проксирует через interkh.com whitelist с `text/vtt` content-type. Client `applySubtitleTracks()` после loadSource создаёт `<track kind="subtitles">` элементы — нативные controls (для лидера) и `.gc-cc` button (для гостя) автоматически показывают переключатель.
- Все сезоны × серии × до 16+ озвучек работают. Качество 240p–1080p — adaptive bitrate hls.js.

## Архитектура

```
src/
├── extractor.ts          — Playwright Chrome 148 (channel: 'chrome', xvfb-run на VPS).
│                            Открывает kinogo, ждёт Cloudflare, активирует lazy iframe,
│                            перехватывает JSON.parse → ловит и сериалы (folder),
│                            и фильмы (file). structureFromCaptured() возвращает
│                            унифицированную PlayerStructure. cleanTitle() стрипает
│                            HTML-теги из title'ов (cinemar пихает <img> флаги).
├── room.ts               — RoomManager: WS-комнаты, leader election, snapshot,
│                            switchSource() → broadcast 'source-change'.
├── hls-proxy.ts          — Manifest rewrite (master + variant), HMAC-SHA256 signed
│                            segment URLs, allowed-hosts whitelist (cinemap.cc,
│                            cinemar.cc, aniqit.com, kinogo.ec).
├── server.ts             — Fastify: routes под `${BASE_PATH}/` (поддержка subpath
│                            deploy через PUBLIC_BASE_PATH). HTML темплейтится один раз
│                            при старте (`{{BASE_PATH}}`) и отдаётся из памяти.
│                            probeCache(10 мин) + single-flight шарит один
│                            Playwright-заход между комнатами. manifestCache(15 сек)
│                            гасит всплеск запросов index.m3u8.
├── versioned-cache.ts    — кеш на короткий срок + single-flight. Версия сверяется и у
│                            готовой записи, и у ИДУЩЕГО построения — иначе комната,
│                            разом запросившая манифест после смены серии, получала
│                            построение прошлой (был живой баг).
├── extract-gate.ts       — потолок на одновременные Playwright-заходы + короткая
│                            очередь. `/api/extract` открыт без авторизации, а
│                            single-flight склеивает только одинаковые url, поэтому
│                            N разных ссылок = N Chrome на машине с почтой.
├── cinemar-decode.ts     — legacy/research, regex-decoder для cinemar (не используется
│                            в проде, JSON.parse-hook надёжнее).
└── public/
    ├── index.html        — лендинг с одним URL-полем + inline submit JS.
    ├── room.html         — плеер + HUD + picker overlay + guest controls + toast.
    ├── player.js         — hls.js client + WS protocol + picker handler + guest UI.
    ├── styles.css        — Vercel-monochrome design system (см. ниже).
    ├── favicon.svg       — amber dot SVG (matches pulse-dot в watch.).
    ├── vendor/
    │   └── hls.min.js    — hls.js 1.5.13, свой, а не с jsdelivr (см. ниже).
    │                        Апгрейд руками: скачать dist/hls.min.js нужной версии,
    │                        снять строку sourceMappingURL (карту мы не шипим).
    └── fonts/
        └── inter-variable.woff2  — Inter Variable, подмножество (85KB из 352KB,
                                     563 глифа из 2937). Обе оси и cv11/ss03 на
                                     месте — рендер прежний. Пересобирать
                                     scripts/subset-font.mjs (см. ниже).

deploy/
├── watch.service         — systemd. ExecStart через xvfb-run + /opt/node22/bin/node.
├── nginx-watch.conf      — location-блоки для subpath-деплоя (/watch/ + /watch/ws/
│                            + кеширующая regex-локация для сегментов и субтитров,
│                            gzip внутри наших локаций). Вставляются в существующий
│                            server{} :443.
├── nginx-watch-cache.conf — proxy_cache_path для сегментов + upstream watch_node с
│                            keepalive, идут в http{} (/etc/nginx/conf.d/). Без них
│                            nginx не стартует: не найдены ни зона watch_segments,
│                            ни upstream.
├── nginx-watch-quic.conf — HTTP/3: listen 443 quic + Alt-Svc, в server{} :443.
│                            Опционально, требует ufw allow 443/udp. TCP-listen
│                            НЕ убирать — QUIC дополняет, а не заменяет.
└── Caddyfile             — legacy-заготовка под отдельный домен, в проде не используется.

scripts/
├── copy-public.mjs       — build step: cp -r src/public → dist/public + кладёт
│                            рядом .br/.gz (их отдаёт @fastify/static с
│                            preCompressed).
├── subset-font.mjs       — пересборка подмножества шрифта из полного Inter
│                            Variable. Набор символов = фиксированные диапазоны
│                            (латиница+кириллица: заголовки приходят с CDN) плюс
│                            всё непечатное из исходников UI. Проверяет, что
│                            ничего не потерялось, и падает, если потерялось.
│                            Нужен Python + fonttools; полный шрифт брать из
│                            истории git (в репозитории лежит только подмножество).
├── intercept-playlist.mjs — сырая проверка JSON.parse-перехвата.
├── test-extractor.mjs    — full extract probe.
├── probe-room.mjs        — WS+player диагностика.
└── ...                   — прочие dev-утилиты.
```

## Дизайн-система

`src/public/styles.css` — Vercel Geist-inspired monochrome + Radix-disciplined tokens. Dark only.

**Палитра**: pure black `--bg-0` (#000) → 5 surface layers `--bg-1..4` (#0a0a0a → #232323). Foreground 5 ступеней `--fg-0..4` (#fff → #525252). Borders 4 уровня subtle/default/strong/focus. White CTA (`--accent-bg: #fff`). Status colors функциональные: success/warning/danger/info (Radix dark 9). Glass surfaces для over-video chrome.

**Spacing**: 4px base, `--space-1..9` (4/8/12/16/20/24/32/48/64).
**Type**: 9-step scale `--text-xs..4xl` (12 → 48px).
**Radius**: sm/md/lg/xl/full (4/6/8/12/999).
**Motion**: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, durations 120/180/280ms. `prefers-reduced-motion` респектится.
**Font**: Inter Variable (one woff2 file, font-display: swap, fallback system-ui).

**Brand accent**: amber pulse-dot в `watch.` wordmark — `var(--warning)` (#ffb224), 1.8s ease-in-out infinite, opacity 0.45↔1.0, glow box-shadow 8px↔18px. Echoes в favicon.svg. Семантика «projector live».

**Accessibility**: focus-visible outlines везде, WCAG AA контрасты (badge.muted/footer/hint/placeholder подняты с `--fg-3` на `--fg-2`). UI chrome (buttons, badges, labels, h1) имеет `user-select: none` — input'ы и `#joinUrl` сохраняют selectable.

**Responsive**: `@media (max-width: 640px)` — landing form стэкается, HUD переходит в `flex-direction: column` (badges row сверху, buttons row снизу), `.hud .badge` получает `text-overflow: ellipsis` для длинных «Сезон 1 · Серия 1 · LostFilm (Проф. многоголосый)». `@media (max-width: 480px)` — HUD/guest-controls compact, picker rows стэкаются.

## КЛЮЧЕВЫЕ НАХОДКИ — как извлекается playlist

### kinogo (cinemar) — JSON.parse hook
**Cinemar embed HTML содержит весь playlist в одном `"file":"#2..."` поле**: обфусцировано (custom base64 + pepper rotation), regex-based декодеры теряют ~50%. Решение: в Playwright инжектируется init script, который **перехватывает `JSON.parse`** — playerjs сам декодирует поле и парсит JSON, мы ловим результат:

```js
JSON.parse = function(s, r) {
  const result = orig(s, r);
  if (Array.isArray(result) && result.length > 0 && result[0] && (result[0].folder || result[0].file)) {
    caps.push(result);
  }
  return result;
};
```

Сериал: `[{folder: [...], ...}]`. Фильм: `[{title, file}, ...]`.

### lordfilm (player-venom) — HTTP response intercept
player-venom UMD использует `Object.defineProperty(window, 'VenomPlayer', {value, writable:true, configurable:true})` что **переопределяет** наши accessor-property hooks (verified: window.VenomPlayer не triggered наш setter после venom-загрузки). Поэтому JS-runtime подход не работает.

Решение: `page.on('response')` ловит HTTP-ответ от `https://api.femd.ws/embed/movie/<id>` (тот HTML что инжектится в iframe srcdoc). В нём инлайн `makePlayer({playlist: {seasons:[{...}]}})`. Парсим `seasons:` массив через bracket-balance scanner (`extractVenomSeasons`) → `JSON.parse` → нормализуем в `PlayerStructure` где каждая `audio.names[i]` становится отдельной voice с тем же `file` и разным `audioTrack` индексом.

## Subpath deployment (`PUBLIC_BASE_PATH`)

Приложение поддерживает 2 режима:

**Root** (по умолчанию): `PUBLIC_BASE_PATH=""`. Все routes под `/`. Простейший случай.

**Subpath**: `PUBLIC_BASE_PATH=/watch`. Все Fastify routes регистрируются под prefix через template literal в путях: ``fastify.get(`${BASE_PATH}/`, ...)``. HTML serve-time замена `{{BASE_PATH}}` placeholder'а в `<link>` / inline JS. `player.js` читает `window.__WATCH_BASE_PATH` (инжектится в HTML) и использует для `fetch` / WebSocket / HLS-manifest URL'ов. nginx должен **не стрипать** prefix — `proxy_pass http://127.0.0.1:PORT;` без trailing slash.

CSS использует **relative** `url('fonts/inter-variable.woff2')` (не `/static/fonts/...`) чтобы работало под любым prefix без templating.

## Провалы (не повторять)

### UI-клики по dropdown'ам сезон/серия/озвучка cinemar
**Не работают в headless / xvfb даже с Google Chrome stable.** UI label обновляется, но player.js не делает source change. При запуске плеера cinemar показывает 2 рекламы по 15 сек → ad-overlay перекрывает кнопки. Пробовал: `force: true`, абс. координаты, CDP `userGesture`, `--autoplay-policy=no-user-gesture-required`, hover wake — ничего не дало надёжного source-change. **Использовать только JSON.parse перехват.**

### ProjectBinge / pulse regex-decoder
`decodeCinemarPlaylistBin` находит только ~50% данных (для `Boys` 5 markers сезонов вместо 8, ~20 эпизодов вместо 40). Cinemar pepper-cipher с salt нельзя восстановить regex'ами без полного реверса `o.sFHFZaDT` / `pepper(e, -1)` из 918KB обфусцированного player.js.

### curl на Windows ломает UTF-8 в JSON body
`curl ... -d '{"voice":"Кубик..."}'` через Git Bash конвертирует в cp1251 → сервер парсит как сломанный UTF-8 → `voice="??????"`. Для тестов API с русскими — `wsl -d Ubuntu-24.04 -- curl ...`.

### Git Bash на Windows коверкает `/foo` env vars
`PUBLIC_BASE_PATH=/watch npm run dev` через Git Bash MSYS преобразует `/watch` → `C:/Program Files/Git/watch`. Использовать `MSYS_NO_PATHCONV=1` prefix или PowerShell (`$env:PUBLIC_BASE_PATH = '/watch'`).

### Cloudflare
- `https://lv.kinogo.ec/...` без Playwright → 403 (JS challenge).
- `https://cinemar.cc/embed/<id>/+<token>` — 200 с обычным curl, если есть `Referer: https://lv.kinogo.ec/...`. Turnstile не использует.

## Клиентская телеметрия

player.js шлёт батчами (раз в 20с, `sendBeacon` на закрытии вкладки) на `POST /api/room/:id/log`:
- `hello` — GPU-строка из WebGL (**«SwiftShader»/«llvmpipe» = аппаратное ускорение мертво**), screen, cores, deviceMemory, версия hls.js. Сервер дописывает ua + ip.
- `stats` (каждые 20с) — `lvl` (высота уровня), `speed` (скорость currentTime, 1.0 = реальное время), **`fps` (реально показанные кадры/сек — решающий показатель: ресинки маскируют застой в `speed`, но не в `fps`)**, `drop`, `buf` (буфер от текущей позиции; 0 при `ranges>0` = дыра в буфере), `paused/rs/vis/leader`.
- события: `resync` (drift; 6/мин = видео тащится heartbeat'ом), `hlsError` (все, не только fatal, дедуп 10с), `videoError`, `waiting`, `level`, `source`, `welcome`, `wsClose`.

Сервер пишет по строке на событие (`msg: "clientlog"`, поле `cl`), роут с `logLevel: warn` — батч-POST'ы не спамят request-логи. Читать:

```bash
ssh frogsrop@frogsrop.dev 'sudo journalctl -u watch -f | grep clientlog'                  # live
ssh frogsrop@frogsrop.dev 'sudo journalctl -u watch --since "1h ago" | grep clientlog | grep <roomId>'
```

Кейс-эталон (комната Elkjul, 2026-08-01): у зрителя сегменты качались в темпе, буфер 110с, dropped=0 — но декодер выдал 264 кадра за десятки минут (зависший HW-декодер, слайдшоу на любом качестве). С сервера был неотличим от здорового; телеметрия ловит это как `fps≈0` при `paused=0, buf>10`.

## Производительность — что и почему сделано

Нагрузка тут всплесками, а не потоком: зрители заходят одновременно, обрыв WS
поднимал всех сразу, лидер переключает серию. Поэтому почти всё ниже — про то,
чтобы всплеск в N зрителей не превращался в N дорогих проходов.

Замерено на проде 2026-08-02 после выката:

| Что | Результат |
|---|---|
| Холодный extract kinogo (кеш пуст, сервис только поднят) | **1.7 сек** |
| Вариантный плейлист (его тянет каждый зритель при входе) | 203 405 → **11 764 байта** |
| Корневой манифест | сжимается, отдаётся из микрокеша |
| 6 одновременных запросов `index.m3u8` | 190–228 мс при базовом RTT 180 мс |
| Дрифт зрителя от лидера, два браузера | **59 мс**, `playbackRate` 1.0, ресинков 0 |
| Строк в journald | 15 за 10 минут (было по паре на каждый сегмент) |

**Горячий путь (Node)**
- `manifestCache` (`versioned-cache.ts`, TTL 60 сек, ключ — комната, версия
  сверяется при чтении) + single-flight. Один запрос `index.m3u8` = резолв
  маркера (для videoseed это отдельный заход Playwright), загрузка плейлиста с
  CDN и HMAC-перепись нескольких тысяч строк. hls.js берёт VOD-манифест один раз
  на `loadSource`, так что кеш нужен не от потока, а от всплеска. Минута
  безопасна: самая короткая подпись у provider'ов — videoseed, ~30 минут.
- **Версия сверяется и у идущего построения, не только у готовой записи.** Было
  наоборот, и это был живой баг: смена серии рассылает `source-change`, вся
  комната разом просит `index.m3u8`, а построение прошлой серии в этот момент ещё
  идёт (для videoseed — секунды Playwright'а) — и отдавалось именно оно, то есть
  манифест предыдущей серии. Само чинилось следующим запросом, поэтому выглядело
  как «кого-то ненадолго кинуло не на ту серию». Регрессия закрыта тестами в
  `tests/versioned-cache.test.ts`.
- Плейлист с CDN тянется с `accept-encoding: gzip, br` (везде остальное —
  `identity`, см. ниже). Его мы читаем целиком и переписываем, чужой
  content-length не нужен, а сотня килобайт почти одинаковых строк жмётся
  десятикратно. undici сам не распаковывает — этим занят `readTextBody`.
- single-flight в `probeOrExtract` (server.ts) и в `fetchVideoseedRawMap`
  (extractor.ts): два одновременных запроса одного URL больше не запускают два
  Playwright'а.
- undici `Agent` в `hls-proxy.ts`: `keepAliveTimeout` 60 сек вместо дефолтных 4 —
  hls.js буферит минуту вперёд, поэтому сегменты качаются пачками с паузами, и на
  дефолте сокет к CDN умирал в каждой паузе (TLS-хендшейк на каждый всплеск).
  `connections: 16` на origin, таймауты вместо пятиминутных.
- `accept-encoding: identity` наверх: content-length сегмента пробрасывается как
  есть, а без него ABR слепнет (см. коммент про lengthComputable в server.ts).
- HTML темплейтится один раз при старте; статика отдаётся с `max-age` (неделя для
  шрифта и иконки, час для js/css — имена не хешируются, поэтому не `immutable`;
  ETag остаётся, так что после истечения это дешёвый 304).
- `disableRequestLogging` — раньше каждый сегмент давал пару строк в journald.
- Chrome греется при старте (`warmupBrowser`), первый probe не платит за запуск.

**nginx** (шаблоны в `deploy/`, на прод вставляются руками)
- gzip объявлен **внутри наших локаций**, а не в http{}: vhost общий с тремя
  сервисами. Главное — `gzip_proxied any`: его дефолт (`off`) и был причиной, по
  которой http{}-левый `gzip on` не сжимал у нас ничего. Проверено на живом nginx:
  манифест 3004 → 222 байта. `video/mp2t` намеренно не в списке.
- Кеш-локация расширена с `/p/` до `/(p|sub)/` — субтитры теперь тоже тянутся с
  CDN один раз на комнату, а не на зрителя.
- `upstream watch_node` + `keepalive 8` + `Connection ""`: без этого nginx открывал
  новое TCP-соединение к Node на каждый запрос.
- `proxy_cache_valid 200 2h` (было 30m): досмотренный фильм не меняется, диск и так
  ограничен `max_size` по LRU.

**Синхронизация**
- Дрифт до 4 сек подтягивается `playbackRate` (1.03 / 1.08 и обратные), а не
  прыжком: прыжок заставляет hls.js сбросить буфер и качать заново, то есть лечение
  выглядело как та же остановка картинки. Прыжок остался для расхождения ≥ 4 сек.
  Ускоряем только при буфере > 3 сек и `readyState ≥ 3` — отставшего из-за
  нехватки данных разгонять некуда.
- Поправка часов через существовавший `ping`/`pong` (сервер теперь отдаёт в pong
  `serverTime`). До неё зритель с часами, уехавшими на пару секунд, считал, что
  вечно отстаёт, и получал ресинк каждые десять секунд.
- Реконнект WS больше не пересоздаёт плеер, если версия источника та же (заодно
  ушёл конфликтующий toast «Связь потеряна» при смене серии).
- `snapshot` экстраполируется по `updatedAt`, позиция передаётся в hls.js как
  `startPosition` — джойнер больше не грузит нулевой фрагмент, чтобы потом прыгнуть.
- Флаг `suppress` заменён на модель ожидаемого эха (`expectPaused`/`expectSeek`):
  `video.play()` асинхронен, и снятие флага в микротаске событие не покрывало —
  из-за этого свежий лидер рассылал в комнату собственные pause и seek(0).

**Extract** (замер на kinomix kp=277565: было 4.17–4.72 сек, стало 2.61–2.64)
- Ожидания событийные вместо слепых опросов: `createSignal` будит ожидающего в
  момент прихода нужного ответа (videoseed, vibix, lordfilm), Cloudflare ждётся
  через `waitForFunction` вместо опроса `page.title()` раз в полсекунды.
- В kinogo-цикле проверка идёт до сна, а не после: те 800 мс терялись всегда,
  даже когда playerjs уже всё распарсил.
- Провайдеры kinomix (Collaps, Videoseed, Vibix) опрашиваются разом через
  `Promise.allSettled`, но **сливаются в фиксированном порядке** — от порядка
  зависит, какая озвучка останется без суффикса провайдера.
- `blockPageNoise` режет на странице картинки, шрифты, само видео и счётчики.
  Список **запрещающий, а не разрешающий**: страница собирает плеер своим JS, и
  любой не угаданный «разрешённый» хост означал бы сломанный extract — включая
  Cloudflare, который обязан пройти. Выключается `WATCH_KINOGO_LEAN=0`.

### Вес холодного захода в комнату (второй проход, 2026-08-02)

Замер того, что реально едет по проводу до первого байта видео. Было ~512 КБ,
из них 69% — шрифт.

| Актив | Было | Стало |
|---|---|---|
| `fonts/inter-variable.woff2` | 352 240 | **85 832** (подмножество) |
| `vendor/hls.min.js` | 129 761 (gzip-5 от nginx) | **103 031** (brotli-11 с билда) |
| `player.js` | 12 674 | 10 477 |
| `styles.css` | 4 607 | 4 209 |
| Итого | ~512 КБ | ~215 КБ |

- **Манифест уходит в сеть до подключения к комнате.** Раньше первый запрос за
  видео шёл только из обработчика `welcome`, то есть после того, как поднимется
  WebSocket — отдельное TCP со своим TLS и Upgrade, два-три round-trip'а перед
  первым байтом видео. Плеер теперь создаётся сразу с `autoStartLoad: false`,
  манифест грузится параллельно с рукопожатием, а `welcome` только зовёт
  `startLoad(позиция)`. Так можно, потому что `?v` в URL — это только защита от
  кеша браузера: сервер её игнорирует и всегда отдаёт манифест текущего
  источника, значит угадывать версию не нужно и предзагруженный манифест верен
  даже для того, кто зашёл после десяти переключений серии. Нативный плеер (iOS
  без MSE) отложить старт не умеет и идёт прежним путём. В телеметрии `welcome`
  появилось поле `pre`.
- **Ссылки на статику несут хеш содержимого** (`?h=`, проставляет билд, а
  подставляет `renderHtml`) и отдаются как `immutable`. Имена файлов не менялись
  между деплоями, поэтому срок жизни держали в час — и каждый повторный заход
  упирался в три условных запроса ПЕРЕД стартом плеера. Ссылку на шрифт внутри
  CSS переписывает тот же build-шаг, иначе правка шрифта не доехала бы до
  зрителя. Без хешей (dev, прямые ссылки) работает прежнее кеширование.

- **Шрифт**: 2937 глифов урезаны до 563. Оси (`opsz` 14–32, `wght` 100–900) и
  фичи `cv11`/`ss03`, которые включает `styles.css`, оставлены намеренно —
  задача была снять вес, не изменив картинку. Пинать `opsz` в 14 дало бы ещё
  −30 КБ, но заголовок лендинга в 48px рисуется другим начертанием, поэтому не
  стали. `★` (бейдж лидера) и `→` (лендинг) в стандартные диапазоны не входят —
  скрипт добавляет их сам и падает, если после сборки их нет.
- **Порядок тегов в `room.html`**: `<script defer>` объявлены **выше** preload
  шрифта, у hls.js стоит `fetchpriority="high"`. Chrome в начале загрузки
  пропускает пару запросов сразу, и шрифт с таблицей стилей занимали оба слота.
  Сам preload оставлен: **без него шрифт находится из CSS и получает приоритет
  ещё выше**, только на round-trip позже.
- **`.br`/`.gz` кладутся при билде**, отдаёт `@fastify/static` с
  `preCompressed: true`. Смысл не в разгрузке процессора, а в уровне сжатия:
  brotli-11 один раз на деплой вместо gzip-5 на запрос. nginx уже сжатый ответ
  не трогает — его gzip-фильтр пропускает всё с `content-encoding`, так что
  конфиг реверс-прокси менять не пришлось.

### Что проверили и НЕ стали делать

Проверено на живом сервере, чтобы не возвращаться:

- **`aio threads` / крупные `proxy_buffers` / `access_log off` на сегментах** —
  лечат нагрузку, которой нет: `/proc/pressure/io` даёт 4,3 сек залипания за 146
  дней аптайма, кеш сегментов физически пуст, рабочий набор комнаты помещается в
  page cache. `access_log` вдобавок единственный источник истории на 14 дней —
  journald хранит сутки.
- **Range в ключе кеша** — за 14 дней логов ровно один `206`, и тот от своего же
  curl. Ни одного iOS/Safari среди клиентов: `Hls.isSupported()` уводит и Safari,
  и iOS 17.1+ на путь hls.js, нативная ветка `player.js` достаётся только iOS ≤17.
- **`proxy_buffering on` на `/watch/`** — выигрыш есть (сокет к Node не висит на
  медленном клиенте), но с дефолтными буферами манифест на 200 КБ уходит во
  временный файл на диске, то есть меняем память на диск.
- **Относительные пути в переписанном манифесте** — **сломало бы вложенные
  плейлисты**: вариантный плейлист переписывается с базой в виде URL на CDN, а
  клиент забирает его по `/hls/<room>/p/<...>`, поэтому `p/<...>` резолвится в
  `p/p/<...>` → 403. Выигрыш после сжатия при этом 24 байта: одинаковый префикс
  строк LZ77 и так схлопывает.
- **brotli для `index.m3u8` в Node** — измерено: brotli-5 обходит gzip-5 на
  ~2–5 КБ на заход, а brotli-11 на этом входе **хуже** brotli-5 и стоит 136–218 мс
  event loop'а, того самого, где живёт WS-синхронизация.
- **`worker_connections 4096`** — у юнита nginx `LimitNOFILE` soft 1024, так что
  это только напечатает в лог предупреждение и упрётся в EMFILE там же. `nginx -t`
  такое не ловит.
- **`default_qdisc=fq` под BBR** — требование отпало в ядре 4.13 (внутренний
  пейсинг), на машине 6.12. Настройка глобальная, а на этой же машине почта.
- **`initcwnd 30`** — считается верно (~2 RTT вместо 4 на 130 КБ), но действует на
  весь исходящий трафик машины, включая доставку Postfix, и не работает для
  HTTP/3 (у QUIC своё начальное окно). На пути, который сам же описан как
  потерянный, окно в 44 КБ приглашает потерю.
- **`proxy_cache_revalidate on`** — нечем ревалидировать: наверх не проходят ни
  ETag, ни Last-Modified. А если бы проходили, подпись CDN живёт час против
  двухчасового `proxy_cache_valid`, то есть условный запрос вернул бы 403, и
  `proxy_cache_use_stale` его не покрывает (403 в списке нет).
- **Минификация `player.js`** — сэкономила бы ~4 КБ, но это тот самый файл,
  который читают в консоли у зрителя (`watchStats()`, разбор телеметрии).
  Отлаживаемость дороже.
- **Кеш сериализованного `playlist` в `welcome`** — 0,1 мс на пятерых.
- **`backdrop-filter` на HUD поверх видео** — шесть постоянно видимых слоёв,
  каждый пересчитывает размытие по кадрам видео, и в телеметрии есть зрители на
  SwiftShader. Правдоподобно, но НЕ измерено; проверять надо отключением в
  devtools у пострадавшего и сравнением поля `fps`, которое уже собирается.
- **hls.js `startFragPrefetch`** — включает загрузку первого фрагмента, пока media
  не подключена; `loadSource()` и `attachMedia()` идут подряд, окно нулевое.
- **hls.js `backBufferLength: 90`** — лидер умеет перематывать назад, и прыжок
  дальше 90 сек заставил бы всю комнату перекачивать то, что у неё уже было.
- **hls.js 1.6.16** — ломающих изменений под наши `hls.audioTrack` и нативные
  `<track>` нет, но `hls.min.js` растёт со 125,8 до 165,4 КБ gzip, то есть
  отдаёт назад 40 КБ из того, что выиграно на шрифте. Без мотивирующего бага не
  меняем.

## Известные хрупкости / TODO

1. **m3u8 expiry**: URL подписан с `:YYYYMMDDHH` бакетом, ~1 час валидности. После 1 часа просмотра комната перестанет грузить сегменты. Решение (не реализовано): при 403 от cinemap.cc → re-probe и обновить current.voiceFile.
2. **Смена источника через `hls.destroy() + new Hls()`** — клиенты теряют буфер. OK для смены серии (0:00), не подходит для смены качества (мы не делаем).
3. **In-memory rooms** — при рестарте сервиса все активные комнаты пропадают, друзья видят «room not found» + WS reconnect loop. Не реализован persistence — оправдано: сессия 1-3 часа, рестарт нечастый.
4. **First extract latency**: было ~10-20 сек, после прогрева браузера при старте, резки рекламы и событийных ожиданий — 1.7 сек на kinogo (замер на проде 2026-08-02). Кеш `probeCache` (10 мин TTL) + single-flight шарят заход между комнатами с тем же URL. Заход всё ещё может быть долгим, если Cloudflare покажет челлендж или источник — kinomix с холодным кешем.
5. **HTTP-only без домена**: `navigator.clipboard.writeText` не работает в insecure context — fallback через `document.execCommand('copy')`. С TLS-доменом — Caddy auto-LE.
6. **Только kinogo**: extractor не работает для rezka/lordfilm/kodik. Cinemar — главный embed-provider в RuNet, многие сайты-обёртки используют его → расширяемо.
7. **HUD не auto-hide**: всегда видим. YouTube/Netflix фейдят через 3 сек неактивности. Hover'ом мышью убирать оверлей не получится без JS-таймера.
8. **Порядок сезонов от `api.ortified.ws` непредсказуем**: один и тот же kp отдаёт
   сезоны в разном порядке от запроса к запросу (замерено: `1 3 2 4`, `4 1 3 2`,
   `3 1 4 2`). `findInStructure` без явного сезона берёт первый в списке, поэтому
   дефолтная серия при создании комнаты каждый раз из другого сезона. Не связано с
   параллельным опросом провайдеров — проверено на коде до него. Лечится сортировкой
   сезонов по номеру в `mergeStructures`/`structureFromVenom`.

## Env vars

```
PORT=3000                              # default
HOST=0.0.0.0                           # 127.0.0.1 если за reverse proxy
PUBLIC_BASE_PATH=                      # '' для root, '/watch' для subpath
PUBLIC_BASE_URL=http://localhost:3000  # с base path: https://host.tld/watch
PROXY_SECRET=<32+ random hex>          # HMAC ключ для signed m3u8 segments
WATCH_HEADLESS=0                       # 0 для xvfb (нужно для cinemar canPlayType)
WATCH_CHROME_CHANNEL=chrome            # 'chrome' = system Google Chrome stable
WATCH_DEBUG=0                          # 1 включает dbg() логи в extractor
WATCH_KINOGO_LEAN=1                    # 0 отключает blockPageNoise (реклама/шрифты/
                                       # картинки/счётчики грузятся как раньше)
WATCH_UPSTREAM_RETRIES=2               # сколько раз перезапросить сегмент при 5xx
WATCH_EXTRACT_CONCURRENCY=2            # сколько Playwright-заходов идёт разом
WATCH_EXTRACT_QUEUE=8                  # сколько ждёт очереди; сверх — 503 busy
WATCH_FLIXCDN=0                        # 1 включает Flixcdn-провайдера у kinomix
LOG_LEVEL=info                         # Fastify log level
```

`WATCH_HEADLESS=0 + xvfb-run + WATCH_CHROME_CHANNEL=chrome` — нужны вместе. Без xvfb-run Playwright не находит display; без channel=chrome берётся bundled Chromium без H.264.

## Деплой

Прод: **https://frogsrop.dev/watch/**, хост `frogsrop@frogsrop.dev` (Debian 13,
hostname машины — `mail.frogsrop.org`). Первичная установка описана в `README.md`.

Раскладка на сервере:

| Что | Где |
|---|---|
| Код (только билд, без исходников) | `/opt/watch/dist`, владелец `frogsrop` — чтобы scp работал без sudo |
| Кеши (`kinomix-cache.json` и пр.) | `/opt/watch/data`, владелец `watch` — сюда пишет auto-crawl |
| Конфиг | `/etc/watch.env` (root:root 0640, `PROXY_SECRET` сгенерирован на сервере) |
| Юнит | `/etc/systemd/system/watch.service` (шаблон — `deploy/watch.service`) |
| Reverse proxy | блок в `/etc/nginx/sites-available/frogsrop.dev` (шаблон — `deploy/nginx-watch.conf`) |
| Node | `/opt/node22` — **отдельный** от системного |

**Что включено на проде** (состояние на 2026-08-02):

| Что | Где настроено | Проверка |
|---|---|---|
| Кеш сегментов и субтитров | `/etc/nginx/conf.d/watch-cache.conf` + regex-локация `(p\|sub)` в vhost | `X-Cache-Status: HIT` на повторном запросе |
| gzip | внутри наших локаций в vhost (не в http{} — vhost общий) | `curl -H 'Accept-Encoding: gzip' -sI .../index.m3u8` → `content-encoding: gzip` |
| keepalive к Node | `upstream watch_node` в conf.d + `Connection ""` в локациях | `sudo grep -A3 "upstream watch_node" /etc/nginx/conf.d/watch-cache.conf` |
| HTTP/3 (QUIC) | `listen 443 quic reuseport` в vhost, `ufw allow 443/udp` | `curl --http3-only -sI .../api/health` → `HTTP/3 200` |
| BBR | `/etc/sysctl.d/99-bbr.conf` + `/etc/modules-load.d/bbr.conf` | `cat /proc/sys/net/ipv4/tcp_congestion_control` → `bbr` |
| Кеш-лог сегментов | `log_format watch` в conf.d + `access_log` в сегментной локации | `sudo tail /var/log/nginx/watch.log` → строки с `HIT`/`MISS` |
| `tcp_slow_start_after_idle=0` | `/etc/sysctl.d/99-watch.conf` | `cat /proc/sys/net/ipv4/tcp_slow_start_after_idle` → `0` |

**HTTP/3 чинится одним словом — `reuseport`, и это не тюнинг, а обязательное
условие** (диагностика 2026-08-03). Симптом: рукопожатие QUIC доходит до конца,
сертификат проверяется, а потом соединение закрывается (`curl: (7) QUIC
connection has been shut down`); Chrome снаружи молча остаётся на h2, несмотря
на `Alt-Svc`. При этом TCP/h2 полностью здоров, nginx владеет UDP/443, ufw
пропускает, nftables считает входящие пакеты — то есть всё выглядит как проблема
сети, а не конфига.

Причина видна только в debug-логе (`error_log ... debug;` — сборка Debian идёт
`--with-debug`). Два соседних датаграмма одного соединения ушли в **разные
воркеры**:

```
3443120 *1779 quic recvmsg: 159.195.48.180:22603 fd:10 n:1200 → packet rx number:0
3443121 *1778 quic recvmsg: 159.195.48.180:22603 fd:10 n:1200 → packet rx number:1
```

Один клиентский порт, один dcid `58f7803be17cf3d4`, два воркера. Без `reuseport`
воркеры делят один UDP-сокет, и ядро отдаёт датаграмму тому, кто первым позвал
`recvmsg`; состояние QUIC пер-воркерное, поэтому каждый собирает половину
рукопожатия. При `worker_processes auto` на четырёх ядрах h3 не работает вообще,
при одном воркере работал бы — отсюда и «когда-то же проверяли».

Замер: **0/10 запросов до, 20/20 после**. Chrome снаружи переключился на h3, вся
комната с видео (15 запросов, включая сегменты) идёт по h3.

Ловушка при отладке: если временно добавить `error_log` **внутрь server-блока**,
QUIC-события уедут туда, а в главном логе останется только шум epoll — легко
решить, что nginx пакеты не обрабатывает. Уровень надо поднимать в главном
`error_log` в `nginx.conf`.

**Остаточные ~10% отказов на УСТАНОВКЕ соединения** (не в середине). Уже
установленное h3-соединение держит серию из 12 запросов без единого сбоя, а
браузер снаружи прошёл всю комнату с видео (14 запросов, 1080p) с нулём отказов —
то есть на просмотр это не влияет: неудачная попытка h3 у браузера прозрачно
падает обратно на h2. Проверено и отвергнуто как причина: `quic_gso` (9/10 и с
ним, и без), `quic_retry` (16/25 vs 15/25), залипшие после `reload` воркеры
(полный `restart` — 18/25), темп запросов (с паузой 1 с — 18/20). Все замеры
делались curl'ом **с самого сервера** на свой же адрес, браузер столько отказов
не показывал, так что часть остатка может быть артефактом замера.

BBR дал 3.4× на одиночном потоке (6.4 → 22.1 МБ/с на 25 МБ файле) и убрал
разброс: было 4.7–8.5 МБ/с от прогона к прогону, стало 21.8–22.4. До него стоял
`hybla` — loss-based, а значит режущий окно на каждой потере при RTT 56–133 мс.

**Правка nginx на общем vhost.** Наш блок вставлен целиком из
`deploy/nginx-watch.conf` и заменяется как диапазон строк: от комментария
`# nginx location blocks for subpath deploy` до закрывающей скобки последней нашей
локации, перед скобкой, закрывающей `server{}`. Порядок: сначала conf.d (там и зона
кеша, и upstream — без него vhost не поднимется), потом локации, потом `nginx -t`.
Перед вставкой конфиг стоит прогнать в контейнере `nginx:alpine` рядом с чужими
локациями — ошибка в общем vhost роняет и соседей. Бэкапы деплоя 2026-08-02 лежат
в `/root/watch-nginx-backup/` (`frogsrop.dev.*`, `watch-cache.conf.*`).

**Машина общая.** На ней же крутятся kotobilet (`:8787`), vkmusic (`:8770`) и
tg-bot-test (`:3477`) на системном Node 20. Поэтому watch держит свой Node 22 в
`/opt/node22` — апгрейд системного node сломал бы соседей. По той же причине nginx-конфиг
редактируется точечной вставкой блока, а не перезаписью файла (там же `/`, `/api/`
для kotobilet, `/music/`, `/tg-bot-test/`).

`deploy/Caddyfile` — legacy-заготовка для отдельного домена, в проде не используется.

```bash
# обновить код
npm run typecheck && npm test && npm run build
scp -r dist/* frogsrop@frogsrop.dev:/opt/watch/dist/
ssh frogsrop@frogsrop.dev 'sudo systemctl restart watch'

# health + логи
curl -s https://frogsrop.dev/watch/api/health
ssh frogsrop@frogsrop.dev 'sudo journalctl -u watch -f'

# debug на проде (не забыть выключить)
ssh frogsrop@frogsrop.dev 'sudo sed -i "s/WATCH_DEBUG=.*/WATCH_DEBUG=1/" /etc/watch.env && sudo systemctl restart watch'
```

## Локальная разработка

```powershell
# Windows + WSL для curl-тестов с UTF-8
cd C:\Projects\watch
npm ci
npx playwright install chrome   # один раз
$env:WATCH_HEADLESS = "0"; $env:WATCH_CHROME_CHANNEL = "chrome"
npm run dev                     # tsx watch src/server.ts
```

Subpath-тест локально (через Git Bash): `MSYS_NO_PATHCONV=1 PUBLIC_BASE_PATH=/watch PORT=3041 npm run dev`. Или PowerShell: `$env:PUBLIC_BASE_PATH = '/watch'; npm run dev`.

Тесты: `npm test` (vitest, 12 тестов hls-proxy + extractor stub) + `npm run typecheck`.

## Глоссарий

- **Probe** — извлечь playlist (структура season/episode/voice tree, или плоская озвучка для фильма) из kinogo. Кешируется по url 10 мин.
- **Extract** — то же что probe, плюс создание комнаты с конкретным выбором (default = первая серия первого сезона первой озвучки; для фильма — первая озвучка).
- **Switch** — лидер меняет источник внутри уже созданной комнаты. Бесплатно (использует кеш probe), не требует нового Playwright run.
- **Source version** — счётчик в Room, инкрементится при switch. Клиенты используют как `?v=N` для cache-busting m3u8.
- **Variant A** — сериал с структурой seasons / episodes / voices.
- **Variant B** — фильм с одной озвучкой (или несколькими) без вложенной структуры. Внутри нормализуется в один season `id: 'film'`.
