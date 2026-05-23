# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project goal

Synchronized watch-party for kinogo.ec — host вставляет URL, друзья открывают ссылку и смотрят синхронно одно и то же видео. Лидер выбирает сезон/серию/озвучку прямо в комнате; смена источника broadcast'ится всем зрителям.

Users в России. Self-hosted на одном VPS — kinogo сам играет в РФ, наш сервер только: (a) обходит Cloudflare на kinogo один раз, (b) проксирует HLS-сегменты с домена cinemap.cc через свой домен, (c) синхронизирует play/pause/seek по WebSocket.

## Current state — что работает

Прод: self-hosted Ubuntu VPS (минимум 2 GB RAM / 1 vCPU; systemd unit + Caddy/nginx reverse proxy на :80/:443; SSH-доступ из локалки через `~/.ssh/<key>`).

- Главная: одно поле URL → POST `/api/extract` → создаётся комната с default-источником (Сезон 1, Серия 1, дефолтная озвучка обычно LostFilm).
- Комната: hls.js плеер + WS-комната, follow-the-leader. Кнопка «Сменить серию» в HUD — лидер выбирает сезон/серия/озвучка в overlay-picker'е, нажимает «Применить» → `POST /api/room/:id/switch` → WS event `source-change` → все клиенты `hls.destroy() + loadSource('?v=N')` + `video.currentTime = 0`.
- Sync: snapshot в welcome, playback/seek/heartbeat от лидера → broadcasts → дрейф-коррекция 1.5 сек.
- Все 5 сезонов × 8 серий × до 16 озвучек работают (Boys S5E3 «Кубик в Кубе» проверено).
- Качество (240p–1080p) — adaptive bitrate автоматически hls.js. Ручного выбора в UI нет (планировалось, но не реализовано).

## Архитектура

```
src/
├── extractor.ts       — Playwright Chrome 148 (channel: 'chrome', xvfb-run на VPS)
│                         Открывает kinogo, ждёт Cloudflare, активирует lazy iframe,
│                         перехватывает JSON.parse через addInitScript → ловит весь
│                         playlist в момент когда player.js его декодирует.
├── room.ts            — RoomManager: WS-комнаты, leader/viewers, snapshot,
│                         switchSource() → broadcast 'source-change'.
├── hls-proxy.ts       — Master/variant manifest rewrite, HMAC-signed segment URLs,
│                         allowed-hosts whitelist (cinemap.cc, cinemar.cc).
├── server.ts          — Fastify: /api/extract, /api/room/:id/switch, /hls/...,
│                         WS /ws/:roomId. probeCache(10 мин) разделяет один заход
│                         в Playwright между несколькими комнатами.
└── public/
    ├── index.html     — лендинг с одним URL-полем
    ├── room.html      — плеер + HUD + picker overlay
    ├── player.js      — hls.js client + WS protocol + picker handler
    └── styles.css

deploy/
├── watch.service      — systemd, запуск через xvfb-run для headed Chrome
└── Caddyfile          — HTTP :80 → reverse_proxy 127.0.0.1:3000 (без TLS — нет домена)
```

## КЛЮЧЕВАЯ НАХОДКА — как извлекается playlist

**Cinemar embed HTML содержит весь сериал в одном `"file":"#2..."` поле**: 5 сезонов × 8 серий × десятки озвучек, у каждой прямой подписанный m3u8 URL. Поле обфусцировано (custom base64 + pepper rotation), и **regex-based декодеры (ProjectBinge / pulse) теряют ~50% данных** из-за неточной деобфускации.

**Решение**: не декодировать самим. В Playwright перед загрузкой страницы инжектируется init script, который **перехватывает `JSON.parse`** — playerjs сам декодирует поле и парсит JSON, мы ловим результат:

```js
const captured = [];
const orig = JSON.parse;
JSON.parse = function(s, reviver) {
  const r = orig.call(this, s, reviver);
  if (Array.isArray(r) && r.length > 0 && r[0]?.folder) captured.push(r);
  return r;
};
Object.defineProperty(window, '__capturedPlaylists', { get: () => captured });
```

После `iframe load + 5s` → `frame.evaluate(() => window.__capturedPlaylists)` → массив сезонов с полными данными. Один заход Playwright (~5-7 сек, Cloudflare + capture) даёт всё.

## Провалы (не повторять)

### UI-клики по dropdown'ам сезон/серия/озвучка cinemar
**Не работают в headless / xvfb даже с Google Chrome stable.** Накопленный опыт:

- UI label обновляется (видно `current confirmed` в debug-логах), но player.js не делает source change. Серия 1 продолжает играть.
- Причина (вероятно): Chromium **bundled with Playwright** не имеет H.264/AAC. `canPlayType()` возвращает `""`, playerjs тихо отказывается грузить. **Установка Chrome stable (`channel: 'chrome'`) даёт canPlayType="probably" но source change всё равно не происходит** — возможно есть и другие проверки (audio context, MSE, или сам user-activation hidden подвохом).
- При запуске плеера (`clickPlayer`) cinemar показывает **2 рекламы по ~15 сек подряд** = 30 сек ad-overlay перекрывает кнопки → клики на опции уходят в overlay рекламы.
- Если applySelection до запуска плеера — DOM-кнопки клацают, но cinemar JS handler не подключен (плеер не initialized).
- Пробовал: `force: true`, `page.mouse.click(absoluteCoords)`, `elementHandle.click`, CDP `Runtime.evaluate({userGesture: true})`, `--autoplay-policy=no-user-gesture-required`, hover для overlay wake, `waitForAdGone` через regex по тексту «Реклама N/M». Никакая комбинация не дала надёжного source-change.

**Этот путь не делать.** Использовать JSON.parse перехват.

### ProjectBinge / pulse regex-decoder
`decodeCinemarPlaylistBin` из ProjectBinge — частичный декодер: для `Boys` он находит 5 markers сезонов (только s01), ~20 эпизодов вместо 40, теряет ~50% озвучек. Cinemar использует расширенный pepper-cipher с salt, ProjectBinge упрощает. Не работает без полного реверса `o.sFHFZaDT` / `pepper(e, -1)` из `cinemar/assets/player.<hash>.js` (~918 KB обфусцированного JS).

**Сохранил в `_research/`**:
- `cinemar_player.js` — full player.js bundle
- `hdrezka-playback.ts` — ProjectBinge оригинал
- `embed.html` — пример сырого embed
- `bin.txt` — частично-декодированный binary (можно использовать как fixture для regex-парсинга)

### curl на Windows ломает UTF-8 в JSON body
`curl ... -d '{"voice":"Кубик..."}'` через Git Bash на Windows конвертирует в cp1251 → сервер парсит как сломанный UTF-8 → `voice="??????"` → не находит trans. **Для тестов API на сервере — использовать curl через WSL** (`wsl -d Ubuntu-24.04 -- bash -c "curl ... charset=utf-8 ..."`).

### Cloudflare: kinogo блокирует curl, cinemar — только проверяет Referer
- `https://lv.kinogo.ec/...` без Playwright → 403 (Cloudflare JS challenge).
- `https://cinemar.cc/embed/<id>/+<token>` — 200 с обычным curl, если есть `Referer: https://lv.kinogo.ec/...`. Cinemar не использует Turnstile.

## Известные хрупкости / TODO

1. **m3u8 expiry**: URL подписан сервером с `:YYYYMMDDHH` бакетом, ~1 час валидности. После переключения серии через час комната перестанет грузить сегменты. Решение (не реализовано): при 403 от cinemap.cc — re-probe (свежий заход в kinogo) и обновить current.voiceFile.
2. **Сменa источника через `hls.destroy() + new Hls()`** — клиенты теряют буфер. Это OK для смены серии (новый эпизод с 0:00), но не для смены качества (мы не делаем).
3. **In-memory comments lost при рестарте watch.service**: все активные комнаты пропадают, друзья получают «room not found» и WS reconnect loop. Не реализован persistence — оправдано: сериал смотрят в одной сессии 1-3 часа, рестарт нечастый.
4. **VPS 1 vCPU**: при ad-tracking 30+ сек первый extract долгий (требует ждать Cloudflare). Кеш probe на 10 мин помогает следующим комнатам с тем же URL.
5. **HTTP-only (без домена)**: `navigator.clipboard.writeText` не работает на HTTP — есть fallback через `document.execCommand('copy')`. Если будет домен — Caddy auto-TLS на LE.
6. **Только kinogo**: extractor не работает для других сайтов (rezka, lordfilm, kodik). Структурно cinemar — главный embed-provider в RuNet, многие сайты-обёртки используют его же → потенциально расширяемо.

## Деплой

VPS: любой Ubuntu 22.04+ (≥2 vCPU / 2 GB RAM). Setup описан в `README.md`.

```bash
# обновить код
npm run build
scp -r dist/* <user>@<host>:/opt/watch/dist/
ssh <user>@<host> 'sudo systemctl restart watch'

# конфиг (на сервере)
sudo cat /etc/watch.env      # PORT, PROXY_SECRET, PUBLIC_BASE_URL, WATCH_CHROME_CHANNEL=chrome
sudo cat /etc/systemd/system/watch.service  # ExecStart=/usr/bin/xvfb-run -a /usr/bin/node dist/server.js

# логи
sudo journalctl -u watch -f
```

WATCH_HEADLESS=0 + xvfb-run + WATCH_CHROME_CHANNEL=chrome — нужны вместе. Без xvfb-run Playwright не находит display, без channel=chrome берётся bundled Chromium без H.264.

## Локальная разработка

```powershell
# Windows + WSL для curl-тестов
cd C:\Projects\watch
npm ci
npx playwright install chrome   # один раз
$env:WATCH_HEADLESS = "0"; $env:WATCH_CHROME_CHANNEL = "chrome"
npm run dev                     # tsx watch src/server.ts

# Тестовые скрипты в scripts/
node scripts/intercept-playlist.mjs    # сырая проверка JSON.parse перехвата
node scripts/test-extractor.mjs        # full extract probe
node scripts/probe-room.mjs <url>      # WS+player диагностика
```

Тесты юнит: `npm test` (vitest, 12 тестов hls-proxy + extractor stub).

## Глоссарий

- **Probe** — извлечь playlist (структура season/episode/voice tree) из kinogo. Кешируется по url 10 мин.
- **Extract** — то же что probe, плюс создание комнаты с конкретным выбором (default = первая серия первого сезона первой озвучки).
- **Switch** — лидер меняет источник внутри уже созданной комнаты. Бесплатно (использует кеш probe), не требует нового Playwright run.
- **Source version** — счётчик в Room, инкрементится при switch. Клиенты используют как `?v=N` для cache-busting m3u8.
