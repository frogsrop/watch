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

Целевая платформа: Ubuntu 24.04 LTS, 2 vCPU / 4 GB RAM / ≥100 Мбит. Подходят TimeWeb, Selectel, Beget (рубли/СБП) или Hoster.kg (USD/крипта).

```bash
# на VPS, один раз
sudo apt update && sudo apt install -y nodejs npm caddy
sudo useradd -r -m -d /opt/watch -s /bin/bash watch
sudo -u watch git clone <твой-репо> /opt/watch
cd /opt/watch
sudo -u watch npm ci --omit=dev
sudo -u watch npm run build
sudo -u watch npx playwright install --with-deps chromium

# конфиг
sudo tee /etc/watch.env <<'EOF'
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_URL=https://watch.example.com
PROXY_SECRET=<32+ случайных байт>
LOG_LEVEL=info
EOF
sudo chmod 600 /etc/watch.env

# systemd + caddy
sudo cp deploy/watch.service /etc/systemd/system/
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile  # отредактируй домен
sudo systemctl daemon-reload
sudo systemctl enable --now watch caddy
```

Обновление:
```bash
sudo -u watch git -C /opt/watch pull
sudo -u watch npm --prefix /opt/watch ci --omit=dev
sudo -u watch npm --prefix /opt/watch run build
sudo systemctl restart watch
```

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
