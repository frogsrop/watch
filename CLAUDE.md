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
│                            deploy через PUBLIC_BASE_PATH). HTML serve-time templating
│                            заменяет `{{BASE_PATH}}` placeholder. probeCache(10 мин)
│                            шарит один Playwright-заход между несколькими комнатами.
├── cinemar-decode.ts     — legacy/research, regex-decoder для cinemar (не используется
│                            в проде, JSON.parse-hook надёжнее).
└── public/
    ├── index.html        — лендинг с одним URL-полем + inline submit JS.
    ├── room.html         — плеер + HUD + picker overlay + guest controls + toast.
    ├── player.js         — hls.js client + WS protocol + picker handler + guest UI.
    ├── styles.css        — Vercel-monochrome design system (см. ниже).
    ├── favicon.svg       — amber dot SVG (matches pulse-dot в watch.).
    └── fonts/
        └── inter-variable.woff2  — Inter Variable (~350KB, woff2-variations).

deploy/
├── watch.service         — systemd, ExecStart через xvfb-run для Chrome.
└── Caddyfile             — placeholder с watch.example.com. Альтернатива: nginx
                            с location /watch/ { proxy_pass } — см. README.

scripts/
├── copy-public.mjs       — build step: cp -r src/public → dist/public.
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

## Известные хрупкости / TODO

1. **m3u8 expiry**: URL подписан с `:YYYYMMDDHH` бакетом, ~1 час валидности. После 1 часа просмотра комната перестанет грузить сегменты. Решение (не реализовано): при 403 от cinemap.cc → re-probe и обновить current.voiceFile.
2. **Смена источника через `hls.destroy() + new Hls()`** — клиенты теряют буфер. OK для смены серии (0:00), не подходит для смены качества (мы не делаем).
3. **In-memory rooms** — при рестарте сервиса все активные комнаты пропадают, друзья видят «room not found» + WS reconnect loop. Не реализован persistence — оправдано: сессия 1-3 часа, рестарт нечастый.
4. **First extract latency**: на 1 vCPU VPS первый заход ~10-20 сек (Cloudflare wait). Кеш `probeCache` (10 мин TTL) шарит между комнатами с тем же URL.
5. **HTTP-only без домена**: `navigator.clipboard.writeText` не работает в insecure context — fallback через `document.execCommand('copy')`. С TLS-доменом — Caddy auto-LE.
6. **Только kinogo**: extractor не работает для rezka/lordfilm/kodik. Cinemar — главный embed-provider в RuNet, многие сайты-обёртки используют его → расширяемо.
7. **HUD не auto-hide**: всегда видим. YouTube/Netflix фейдят через 3 сек неактивности. Hover'ом мышью убирать оверлей не получится без JS-таймера.
8. **Toast «Связь потеряна»** во время `source-change`: на стороне зрителя hls.destroy + new Hls() триггерит WS reconnect → видно конфликтующий toast. Нужно разделить ws-reconnect message от switch message.

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
LOG_LEVEL=info                         # Fastify log level
```

`WATCH_HEADLESS=0 + xvfb-run + WATCH_CHROME_CHANNEL=chrome` — нужны вместе. Без xvfb-run Playwright не находит display; без channel=chrome берётся bundled Chromium без H.264.

## Деплой

VPS: Ubuntu 22.04+ (≥2 vCPU / 2 GB RAM рекомендовано). Setup описан в `README.md`.

```bash
# обновить код
npm run build
scp -r dist/* <user>@<host>:/opt/watch/dist/
ssh <user>@<host> 'sudo systemctl restart watch'

# конфиг (на сервере)
sudo cat /etc/watch.env
sudo cat /etc/systemd/system/watch.service

# логи
sudo journalctl -u watch -f
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
