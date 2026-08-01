# watch

Self-hosted синхронный просмотр фильмов с kinogo для 2-4 друзей.

Один хост открывает ссылку на kinogo → сервер прогоняет её через headless Chromium (Cloudflare bypass), извлекает HLS-стрим и проксирует его через свой домен. Друзья просто открывают ссылку комнаты в браузере — никаких установок. Управление воспроизведением — у лидера, остальные синхронизируются с дрейф-коррекцией 1.5 сек.

## Локальная разработка

```powershell
npm ci
npx playwright install chromium
npm run dev
```

Открой http://localhost:3000, вставь URL kinogo, дождись «Готово», открой полученную ссылку в двух вкладках — должна синхронизироваться.

Тесты:
```powershell
npm test                       # unit-тесты (hls-proxy)
$env:RUN_LIVE_TESTS = "1"      # включить тесты с реальным kinogo
npm test
```

## Сборка и деплой на VPS

Прод: **https://frogsrop.dev/watch/** (Debian 13, `/opt/watch`, юнит `watch.service`).

Билд собирается локально и копируется на сервер — на VPS нет ни исходников, ни
devDependencies, ни тулчейна TypeScript.

### Первичная установка (один раз)

Требования на сервере: Google Chrome stable (bundled Chromium не умеет H.264),
`xvfb` и Node ≥22.

```bash
# Node 22 отдельной установкой — системный node может быть старее и
# использоваться другими сервисами на этой же машине
V=$(curl -s https://nodejs.org/dist/index.json | grep -o '"version":"v22\.[0-9.]*"' | head -1 | cut -d'"' -f4)
curl -fsSLO "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
sudo mkdir -p /opt/node22 && sudo tar -xJf "node-$V-linux-x64.tar.xz" -C /opt/node22 --strip-components=1

# Google Chrome stable + xvfb
sudo apt-get install -y gpg xvfb
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update && sudo apt-get install -y google-chrome-stable

# пользователь и каталоги
sudo useradd --system --no-create-home --home-dir /opt/watch --shell /usr/sbin/nologin watch
sudo mkdir -p /opt/watch/dist /opt/watch/data
sudo chown -R $USER:$USER /opt/watch      # чтобы scp-деплой работал без sudo
```

Конфиг (`PROXY_SECRET` генерируется на сервере, не в git):

```bash
sudo tee /etc/watch.env >/dev/null <<EOF
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_PATH=/watch
PUBLIC_BASE_URL=https://frogsrop.dev/watch
PROXY_SECRET=$(openssl rand -hex 32)
WATCH_HEADLESS=0
WATCH_CHROME_CHANNEL=chrome
WATCH_DEBUG=0
LOG_LEVEL=info
EOF
sudo chown root:root /etc/watch.env && sudo chmod 640 /etc/watch.env
sudo chown -R watch:watch /opt/watch/data   # сюда пишется auto-crawl кеш
```

systemd + nginx:

```bash
sudo cp deploy/watch.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now watch

# кеш сегментов — ДО location-блоков, иначе nginx не найдёт зону watch_segments
sudo cp deploy/nginx-watch-cache.conf /etc/nginx/conf.d/watch-cache.conf
sudo mkdir -p /var/cache/nginx/watch && sudo chown www-data:www-data /var/cache/nginx/watch

# содержимое deploy/nginx-watch.conf вставить в server{} блок :443 нужного домена
sudo nginx -t && sudo systemctl reload nginx
```

**Зачем кеш.** Прокси не мультиплексирует: без кеша каждый зритель тянет свою
копию каждого сегмента, поэтому комната из N человек даёт N-кратную нагрузку на
CDN и на канал — при том что все смотрят ровно одни и те же байты. Внутри
комнаты подписанный URL у всех одинаковый, так что сегмент забирается с CDN один
раз. `proxy_cache_lock` обязателен: зрители синхронны и запрашивают сегмент
одновременно, без него все они промахиваются мимо кеша и идут к CDN разом.

Проверить попадания: `curl -sI https://<host>/watch/hls/<room>/p/<...> | grep -i x-cache-status`
→ `MISS` у первого зрителя, `HIT` у остальных.

### HTTP/3 (QUIC) — опционально

Узкое место на frogsrop.dev — не полоса, а **одиночное соединение**: RTT до
зрителей 56–133 мс, сотни ретрансмиссий, один поток тянет 5.8–10 Мбит/с, а три
параллельных — 16.5 Мбит/с суммарно. Это предел вида
`полоса ≈ MSS / (RTT × √потери)`, и именно его лечит QUIC: нет head-of-line
blocking на транспорте (у HTTP/2 при потере пакета встают все стримы) и лучше
восстановление после потерь.

```bash
sudo ufw allow 443/udp        # без этого браузер просто не увидит h3
# содержимое deploy/nginx-watch-quic.conf вставить в тот же server{} :443
sudo nginx -t && sudo systemctl reload nginx
```

Проверка: `curl --http3-only -sI https://frogsrop.dev/watch/api/health` → `HTTP/3 200`.
В браузере — DevTools → Network → колонка Protocol → `h3`. Первый запрос всегда
идёт по TCP, браузер переключается со следующего (по заголовку `Alt-Svc`).

Оговорки: помогает только на участке зритель↔сервер, участок сервер↔CDN остаётся
TCP. У зрителей в РФ DPI нередко режет UDP/443 — тогда браузер молча откатывается
на HTTP/2, то есть хуже не будет, но и лучше может не стать. TCP-listen убирать
нельзя ни при каких условиях: QUIC — дополнение, а не замена.

Более дешёвая альтернатива, влияющая на **всех** клиентов независимо от браузера
и DPI: сменить congestion control на BBR (сейчас на сервере `hybla`, модуль
`tcp_bbr` в ядре есть, но не загружен) — `sysctl -w net.ipv4.tcp_congestion_control=bbr`.

### Обновление

```bash
npm run typecheck && npm test && npm run build
scp -r dist/* frogsrop@frogsrop.dev:/opt/watch/dist/
scp data/*.json frogsrop@frogsrop.dev:/opt/watch/data/     # если менялись кеши
ssh frogsrop@frogsrop.dev 'sudo systemctl restart watch'
```

Если менялся `package.json` — дополнительно:
```bash
scp package.json package-lock.json frogsrop@frogsrop.dev:/opt/watch/
ssh frogsrop@frogsrop.dev 'cd /opt/watch && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 /opt/node22/bin/npm ci --omit=dev'
```

Проверка: `curl -s https://frogsrop.dev/watch/api/health` → `{"ok":true,...}`.
Логи: `ssh frogsrop@frogsrop.dev 'sudo journalctl -u watch -f'`.

## Архитектура

- `src/extractor.ts` — Playwright headless Chromium. Открывает kinogo URL, ждёт Cloudflare, активирует lazy iframe, ловит `.m3u8` в Network через `page.on('response')`. Хрупкий компонент — ломается, когда сайт меняет структуру. Browser-инстанс шарится между extraction'ами (lazy launch), context — отдельный на каждую сессию.
- `src/hls-proxy.ts` — переписывает HLS-манифесты (как master, так и media playlists, включая `URI="..."` в `#EXT-X-*` тегах). Все сегменты идут через `/hls/<roomId>/p/<base64url(url)>.<hmac-sha256-sig>` — подпись HMAC-SHA256, ограничение по домену (`*.cinemap.cc`, `*.cinemar.cc` и пр.) защищает от использования прокси как open relay.
- `src/room.ts` — `RoomManager`: WebSocket-комнаты с моделью «follow the leader». Лидер = первый зашедший, перевыборы при disconnect. События `playback` / `seek` / `heartbeat` от лидера бродкастятся остальным с timestamp'ом, фронтенд догоняет.
- `src/server.ts` — Fastify, связывает всё: `POST /api/extract`, `GET /hls/:roomId/...`, `WS /ws/:roomId`, статика.
- `src/public/` — vanilla HTML/JS/CSS, hls.js с CDN.

## Что вне скоупа

- Чат — голос/текст оставляем Discord/Telegram.
- Другие источники (rezka, lordfilm) — extractor можно расширить, но реализован только kinogo (lv.kinogo.ec и зеркала).
- Авторизация — секретный roomId длиной 21 символ достаточен для масштаба 4 человек.

## Известные ограничения

- Каждая extraction'а стоит ~5-15 секунд и ~300 MB RAM (Playwright Chromium). Делать чаще раза в фильм нежелательно.
- Если cinemar/kinogo меняют структуру обфускации или поднимают anti-bot — extractor сломается. Тогда нужно прогнать вручную через Playwright в headed режиме, посмотреть network и обновить `activateLazyIframes` / детекцию Cloudflare.
- Toкенизованный m3u8 URL имеет TTL (несколько часов). Если фильм идёт долго или комната висит — может понадобиться re-extract. В MVP не реализовано: при истечении токена нужно создать комнату заново.
- Юридический статус контента kinogo в РФ — серая зона. Хостинг прокси на своём VPS привязывает трафик к тебе. Используй на свой риск.
