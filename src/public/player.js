(() => {
  const BASE = window.__WATCH_BASE_PATH || '';
  const roomId = location.pathname.split('/').filter(Boolean).pop();
  const video = document.getElementById('player');
  const stage = document.querySelector('.stage');
  const roleEl = document.getElementById('role');
  const viewersEl = document.getElementById('viewers');
  const currentEl = document.getElementById('current');
  const toastEl = document.getElementById('toast');
  const copyBtn = document.getElementById('copyLink');
  const pickerBtn = document.getElementById('picker-btn');
  const pickerEl = document.getElementById('picker');
  const pickerCancel = document.getElementById('picker-cancel');
  const pickerApply = document.getElementById('picker-apply');
  const pickerHint = document.getElementById('picker-hint');
  const selSeason = document.getElementById('sel-season');
  const selEpisode = document.getElementById('sel-episode');
  const selProvider = document.getElementById('sel-provider');
  const selVoice = document.getElementById('sel-voice');
  const guestControls = document.getElementById('guest-controls');
  const gcMute = document.getElementById('gc-mute');
  const gcVolume = document.getElementById('gc-volume');
  const gcCc = document.getElementById('gc-cc');
  const gcPip = document.getElementById('gc-pip');
  const gcFs = document.getElementById('gc-fs');
  const rowSeason = document.getElementById('row-season');
  const rowEpisode = document.getElementById('row-episode');
  const rowProvider = document.getElementById('row-provider');

  let selfId = null;
  let leaderId = null;
  let members = new Map();
  let ws = null;
  let lastHeartbeat = 0;
  let hls = null;
  let playlist = null;
  let current = null;
  let sourceVersion = 1;

  // Sync tuning
  const HEARTBEAT_INTERVAL_MS = 10_000; // лидер шлёт snapshot времени раз в 10с
  const DRIFT_RESYNC_THRESHOLD_S = 1.5; // порог для playback-событий (play/pause/seek)
  // Дрифт ниже DRIFT_DEADZONE_S не трогаем вообще, между ним и DRIFT_HARD_SEEK_S
  // подгоняем скоростью, и только выше — прыгаем. Прыжок стоит перебуферизации:
  // hls.js сбрасывает буфер и качает сегменты заново, поэтому на секунде
  // расхождения он лечит меньше, чем ломает.
  const DRIFT_DEADZONE_S = 0.3;
  const DRIFT_HARD_SEEK_S = 4;
  const PING_INTERVAL_MS = 15_000;

  // Смещение наших часов относительно серверных, в миллисекундах.
  let clockOffset = 0;
  let clockSynced = false;
  let bestRtt = Infinity;
  let pingTimer = null;

  /** Серверное «сейчас» по нашим часам. */
  function serverNow() {
    return Date.now() + clockOffset;
  }

  function handlePong(msg) {
    const rtt = Date.now() - msg.t;
    if (!(rtt >= 0) || typeof msg.serverTime !== 'number') return;
    // Берём замер с наименьшим RTT: у него самая маленькая неопределённость по
    // тому, в какой момент серверное время было снято. Пересчитываем и когда RTT
    // явно улучшился, и в первый раз.
    if (!clockSynced || rtt <= bestRtt) {
      bestRtt = rtt;
      clockOffset = msg.serverTime - (msg.t + rtt / 2);
      clockSynced = true;
    }
  }

  function manifestUrl() {
    return `${BASE}/hls/${roomId}/index.m3u8?v=${sourceVersion}`;
  }

  function isLeader() {
    return selfId && selfId === leaderId;
  }

  function toast(msg, ms = 2500) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.hidden = true), ms);
  }

  function applyAudioTrack() {
    if (!hls || !current) return;
    const track = current.audioTrack;
    if (typeof track !== 'number') return;
    const tracks = hls.audioTracks || [];
    if (track >= 0 && track < tracks.length && hls.audioTrack !== track) {
      try { hls.audioTrack = track; } catch {}
    }
  }

  function applySubtitleTracks() {
    // Remove old <track> elements
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    const subs = current?.subtitles || [];
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.src = `${BASE}/hls/${roomId}/sub/${i}`;
      t.label = s.name || `Субтитры ${i + 1}`;
      if (s.lang) t.srclang = s.lang;
      video.appendChild(t);
    }
    // Default to disabled — user сам включает через CC button или native menu
    queueMicrotask(() => {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'disabled';
      updateCaptionsAvailability();
    });
  }

  function loadSource(url, startPosition) {
    if (hls) {
      try { hls.destroy(); } catch {}
      hls = null;
    }
    // Позиция известна заранее (зритель заходит в середину фильма) — говорим её
    // hls.js сразу. Без этого он начинает грузить нулевой фрагмент, и только
    // потом мы прыгаем на нужное место, выбрасывая скачанное.
    const startAt = typeof startPosition === 'number' && startPosition > 1 ? startPosition : -1;
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        startPosition: startAt,
        enableWorker: true,
        lowLatencyMode: false,
        // Не тянуть 1080p в окно 800px — на узком канале это разница между
        // просмотром и слайдшоу. В fullscreen кап поднимается сам.
        capLevelToPlayerSize: true,
        // ABR смотрит только на скорость канала. Если канала хватает, а машина не
        // успевает декодировать 1080p (софтверный декод), картинка идёт рывками при
        // полном буфере — и сам ABR это не лечит. Это роняет уровень по доле
        // выпавших кадров.
        capLevelOnFPSDrop: true,
        // Дефолтные 0.7 означают «поднимайся на уровень, если 0.7 * скорость >
        // битрейт», т.е. для 1080p (5.2 Мбит/с) хватает 7.4 Мбит/с — запас всего
        // в полтора раза. Зритель, у которого канал болтается ровно вокруг этой
        // границы, скачет на 1080p, не удерживает его и лагает, тогда как более
        // быстрым и более медленным соседям в той же комнате хорошо. 0.5 требует
        // двукратного запаса, поэтому граничный случай остаётся на 720p.
        abrBandWidthUpFactor: 0.5,
        // Больше запаса на дрожащем канале: зритель переживёт провал скорости,
        // не опустошив буфер и не словив ресинк-рывок от лидера.
        maxBufferLength: 60,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, applyAudioTrack);
      hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, applyAudioTrack);
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        clogHlsError(data);
        if (data.fatal) toast('Ошибка воспроизведения: ' + data.type);
      });
      hls.on(window.Hls.Events.LEVEL_SWITCHED, (_e, d) => {
        const l = hls && hls.levels ? hls.levels[d.level] : null;
        clog('level', { h: l ? l.height : d.level });
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      if (startAt > 0) {
        video.addEventListener('loadedmetadata', function once() {
          video.removeEventListener('loadedmetadata', once);
          withExpectedSeek(startAt, () => { video.currentTime = startAt; });
        });
      }
    } else {
      toast('HLS не поддерживается этим браузером');
    }
  }

  // Когда у зрителя «идёт по кадру», по логам сервера не видно, сеть это или
  // декодер: серверу оба случая выглядят одинаково. Просим открыть консоль
  // (F12) и выполнить watchStats() — большой dropped при полном буфере значит,
  // что машина не тянет уровень, а не что канал узкий.
  window.watchStats = function () {
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const level = hls && hls.levels ? hls.levels[hls.currentLevel] : null;
    return {
      роль: isLeader() ? 'лидер' : 'зритель',
      качество: level ? level.height + 'p @ ' + Math.round(level.bitrate / 1000) + ' kbps' : 'н/д',
      уровнейВсего: hls && hls.levels ? hls.levels.length : 0,
      выпалоКадров: q ? q.droppedVideoFrames + ' из ' + q.totalVideoFrames : 'н/д',
      буферВперёд:
        video.buffered.length
          ? +(video.buffered.end(video.buffered.length - 1) - video.currentTime).toFixed(1) + 'с'
          : '0с',
      времяВидео: +video.currentTime.toFixed(1),
    };
  };

  // ===== Телеметрия → сервер =====
  // Кейс ElkjulQKv896AuLr8FzEH: у зрителя видеодекодер выдал 264 кадра за десятки
  // минут при 110с буфера — с сервера клиент выглядел здоровым (сегменты качались
  // в темпе). Шлём периодические stats + события плеера батчами на сервер, там
  // они попадают в journalctl (grep clientlog).
  const LOG_FLUSH_MS = 20_000;
  const clientId = Math.random().toString(36).slice(2, 10);
  let logQueue = [];
  let logDead = 0; // 5 неудачных отправок подряд (рестарт сервера, комната умерла) — молчим
  let lastHlsErr = '';
  let lastHlsErrAt = 0;
  let lastWaitAt = 0;
  let statsPrev = null;

  function clog(k, data) {
    if (logQueue.length >= 80) return;
    logQueue.push(Object.assign({ t: Date.now(), k }, data));
  }

  function flushLogs(useBeacon) {
    if (!logQueue.length || logDead >= 5) return;
    const body = JSON.stringify({ client: clientId, logs: logQueue.splice(0, 50) });
    const url = `${BASE}/api/room/${roomId}/log`;
    if (useBeacon && navigator.sendBeacon) {
      try { navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })); } catch {}
      return;
    }
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).then(
      (r) => { logDead = r.ok ? 0 : logDead + 1; },
      () => { logDead += 1; },
    );
  }

  // Строка рендерера WebGL выдаёт состояние GPU: «SwiftShader» / «llvmpipe» =
  // аппаратного ускорения нет, картинку рисует CPU — главный подозреваемый при
  // «идёт по кадру» на любом качестве.
  function gpuString() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 'no-webgl';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 120);
    } catch {
      return 'webgl-error';
    }
  }

  // Буфер от ТЕКУЩЕЙ позиции, а не от конца последнего range (как в watchStats):
  // buf=0 при ranges>0 значит, что currentTime сидит в дыре между range'ами.
  function bufferAheadS() {
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.currentTime >= video.buffered.start(i) - 0.5 && video.currentTime <= video.buffered.end(i)) {
          return +(video.buffered.end(i) - video.currentTime).toFixed(1);
        }
      }
    } catch {}
    return 0;
  }

  function collectStats() {
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const now = performance.now();
    const snap = {
      wall: now,
      ct: video.currentTime,
      frames: q ? q.totalVideoFrames : -1,
      dropped: q ? q.droppedVideoFrames : -1,
    };
    if (statsPrev) {
      const dt = (now - statsPrev.wall) / 1000;
      if (dt > 1) {
        const level = hls && hls.levels && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : null;
        clog('stats', {
          lvl: level ? level.height : -1,
          ct: +video.currentTime.toFixed(1),
          // Скорость currentTime за окно: 1.0 = реальное время. У зрителя ресинки
          // маскируют застой (прыжки вперёд суммируются в ct) — поэтому решающий
          // показатель именно fps: сколько кадров реально показано в секунду.
          speed: +((snap.ct - statsPrev.ct) / dt).toFixed(2),
          fps: snap.frames >= 0 && statsPrev.frames >= 0 ? +((snap.frames - statsPrev.frames) / dt).toFixed(1) : -1,
          drop: snap.dropped >= 0 && statsPrev.dropped >= 0 ? snap.dropped - statsPrev.dropped : -1,
          buf: bufferAheadS(),
          ranges: video.buffered.length,
          paused: video.paused ? 1 : 0,
          rs: video.readyState,
          vis: document.visibilityState === 'visible' ? 1 : 0,
          leader: isLeader() ? 1 : 0,
        });
      }
    }
    statsPrev = snap;
  }

  function clogHlsError(data) {
    // buffer*Error могут сыпаться раз в секунду — дедупим одинаковые в 10с окне
    const key = data.type + '/' + data.details;
    const now = Date.now();
    if (key === lastHlsErr && now - lastHlsErrAt < 10_000) return;
    lastHlsErr = key;
    lastHlsErrAt = now;
    clog('hlsError', { details: data.details, type: data.type, fatal: data.fatal ? 1 : 0, buf: bufferAheadS() });
  }

  video.addEventListener('error', () => {
    const err = video.error;
    clog('videoError', {
      code: err ? err.code : -1,
      msg: err && err.message ? String(err.message).slice(0, 120) : '',
    });
  });
  video.addEventListener('waiting', () => {
    const now = Date.now();
    if (now - lastWaitAt < 5000) return;
    lastWaitAt = now;
    clog('waiting', { ct: +video.currentTime.toFixed(1), buf: bufferAheadS(), rs: video.readyState });
  });

  clog('hello', {
    gpu: gpuString(),
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    cores: navigator.hardwareConcurrency || 0,
    mem: navigator.deviceMemory || 0,
    hlsjs: window.Hls ? (window.Hls.version || 'yes') : 'none',
    mse: !!(window.Hls && window.Hls.isSupported()),
  });

  setInterval(() => {
    collectStats();
    flushLogs(false);
  }, LOG_FLUSH_MS);
  window.addEventListener('pagehide', () => flushLogs(true));

  // ===== Своё эхо =====
  // Применяя состояние лидера, мы двигаем собственный плеер, и он честно
  // отвечает событиями play/pause/seeked — а обработчики лидера рассылают их
  // обратно в комнату. Флаг, снимаемый в микротаске, эту дыру не закрывал:
  // video.play() асинхронен, и событие приходило уже после снятия флага. Поэтому
  // запоминаем, что именно попросили, и на короткое время глотаем совпадающее.
  const ECHO_WINDOW_MS = 800;
  let expectedPaused = null;
  let expectedSeek = null;

  function expectPaused(value) {
    expectedPaused = { value, until: Date.now() + ECHO_WINDOW_MS };
  }

  function expectSeek(time) {
    expectedSeek = { time, until: Date.now() + ECHO_WINDOW_MS };
  }

  function withExpectedSeek(time, fn) {
    expectSeek(time);
    fn();
  }

  function consumeExpectedPaused(value) {
    if (!expectedPaused) return false;
    if (Date.now() > expectedPaused.until) { expectedPaused = null; return false; }
    if (expectedPaused.value !== value) return false;
    expectedPaused = null;
    return true;
  }

  function consumeExpectedSeek() {
    if (!expectedSeek) return false;
    if (Date.now() > expectedSeek.until) { expectedSeek = null; return false; }
    if (Math.abs(expectedSeek.time - video.currentTime) > 0.5) return false;
    expectedSeek = null;
    return true;
  }

  // ===== Подстройка под лидера =====
  // Зритель, отставший на секунду, раньше получал прыжок currentTime: hls.js на
  // этом сбрасывает буфер и качает сегменты заново, то есть лечение выглядело как
  // та же остановка картинки, от которой лечим. Вместо прыжка тихо меняем
  // скорость — при 1.03 секунда догоняется за полминуты и на слух это незаметно
  // (браузер сам сохраняет высоту голоса). Прыжок остаётся только для большого
  // расхождения, где скоростью догонять слишком долго.
  let isStalled = false;

  function setRate(rate) {
    if (Math.abs(video.playbackRate - rate) < 0.001) return;
    try { video.playbackRate = rate; } catch {}
  }

  function resetRate() {
    setRate(1);
  }

  video.addEventListener('waiting', () => { isStalled = true; });
  video.addEventListener('stalled', () => { isStalled = true; });
  video.addEventListener('canplay', () => { isStalled = false; });
  video.addEventListener('playing', () => { isStalled = false; });

  /**
   * Подтянуть зрителя к target. drift > 0 — мы впереди, < 0 — отстали.
   * Возвращает true, если пришлось прыгнуть.
   */
  function correctDrift(target) {
    const drift = video.currentTime - target;
    const mag = Math.abs(drift);

    if (mag >= DRIFT_HARD_SEEK_S) {
      // Застрявшего зрителя прыжок вперёд только добивает: он отстал потому, что
      // ему не хватает данных, а прыжок отменяет всё уже скачанное. Пока он
      // буферизуется, ждём — вернётся сам, а если отстанет совсем далеко, прыжок
      // всё равно случится по нижней ветке.
      if (isStalled && mag < DRIFT_HARD_SEEK_S * 2.5) return false;
      resetRate();
      clog('resync', { drift: +drift.toFixed(2), ct: +video.currentTime.toFixed(1), buf: bufferAheadS() });
      withExpectedSeek(target, () => { video.currentTime = target; });
      return true;
    }

    if (mag < DRIFT_DEADZONE_S || video.paused) {
      resetRate();
      return false;
    }

    if (drift < 0) {
      // Отстали — ускоряемся, но только если есть что играть впереди. Иначе
      // ускорение просто быстрее опустошит буфер.
      if (isStalled || bufferAheadS() < 3 || video.readyState < 3) {
        resetRate();
        return false;
      }
      setRate(mag >= 1 ? 1.08 : 1.03);
    } else {
      // Убежали вперёд — притормаживаем; буфер при этом только растёт.
      setRate(mag >= 1 ? 0.92 : 0.97);
    }
    return false;
  }

  function isMovie() {
    return playlist && playlist.seasons.length === 1 && playlist.seasons[0].id === 'film';
  }

  function updateRoleBadge() {
    const lead = isLeader();
    roleEl.classList.toggle('leader', !!lead);
    roleEl.textContent = lead ? '★ лидер' : 'зритель';
    viewersEl.textContent = `${members.size} в комнате`;
    pickerBtn.toggleAttribute('disabled', !lead);
    pickerBtn.classList.toggle('ghost', true);
    pickerBtn.textContent = isMovie() ? 'Выбрать озвучку' : 'Сменить серию';
    updateControlsForRole();
  }

  function updateControlsForRole() {
    const lead = isLeader();
    if (lead) {
      video.setAttribute('controls', '');
      guestControls.hidden = true;
    } else {
      video.removeAttribute('controls');
      guestControls.hidden = false;
    }
  }

  function updateVolumeUi() {
    const muted = video.muted || video.volume === 0;
    gcMute.querySelector('.gc-icon-vol-on').hidden = muted;
    gcMute.querySelector('.gc-icon-vol-off').hidden = !muted;
    gcVolume.value = String(Math.round((video.muted ? 0 : video.volume) * 100));
  }

  function updateFsUi() {
    const fs = !!document.fullscreenElement;
    gcFs.querySelector('.gc-icon-fs-enter').hidden = fs;
    gcFs.querySelector('.gc-icon-fs-exit').hidden = !fs;
  }

  function updateCaptionsAvailability() {
    const tracks = video.textTracks;
    let has = false;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.kind === 'subtitles' || t.kind === 'captions') { has = true; break; }
    }
    gcCc.hidden = !has;
  }

  // ===== Guest control wiring =====
  gcMute.addEventListener('click', () => {
    if (video.muted) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else {
      video.muted = true;
    }
  });

  gcVolume.addEventListener('input', () => {
    const v = parseFloat(gcVolume.value) / 100;
    video.volume = v;
    if (v === 0) {
      video.muted = true;
    } else if (video.muted) {
      video.muted = false;
    }
  });

  video.addEventListener('volumechange', updateVolumeUi);

  gcFs.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (stage.requestFullscreen) {
      stage.requestFullscreen().catch(() => {});
    } else if (stage.webkitRequestFullscreen) {
      stage.webkitRequestFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', updateFsUi);
  document.addEventListener('webkitfullscreenchange', updateFsUi);

  gcPip.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
        await video.requestPictureInPicture();
      }
    } catch {}
  });
  if (!document.pictureInPictureEnabled) {
    gcPip.hidden = true;
  }

  gcCc.addEventListener('click', () => {
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.kind === 'subtitles' || t.kind === 'captions') {
        const enable = t.mode !== 'showing';
        t.mode = enable ? 'showing' : 'disabled';
        gcCc.classList.toggle('is-active', enable);
        break;
      }
    }
  });
  if (video.textTracks) {
    video.textTracks.addEventListener?.('addtrack', updateCaptionsAvailability);
    video.textTracks.addEventListener?.('removetrack', updateCaptionsAvailability);
  }

  // ===== Block keyboard shortcuts and contextmenu for guests =====
  document.addEventListener('keydown', (e) => {
    if (isLeader()) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // Block: play/pause + seek + skip + frame-step + go-to-start/end
    const blocked = ['Space', 'KeyK', 'ArrowLeft', 'ArrowRight', 'KeyJ', 'KeyL', 'Comma', 'Period', 'Home', 'End'];
    if (blocked.indexOf(e.code) !== -1) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  video.addEventListener('contextmenu', (e) => {
    if (!isLeader()) e.preventDefault();
  });

  function updateCurrentBadge() {
    if (!current) return;
    const voice = current.provider
      ? `${current.voiceTitle} · ${current.provider}`
      : current.voiceTitle;
    currentEl.textContent = isMovie()
      ? voice
      : `${current.seasonTitle} · ${current.episodeTitle} · ${voice}`;
  }

  function fillSel(sel, items, currentLabel) {
    sel.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.title;
      o.textContent = it.title;
      if (it.title === currentLabel) o.selected = true;
      sel.appendChild(o);
    }
  }

  function distinctProviders(voices) {
    const seen = new Set();
    const out = [];
    for (const v of voices ?? []) {
      const p = v.provider;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }

  function renderPickerCascade() {
    if (!playlist || !current) return;
    const wantS = selSeason.value || current.seasonTitle;
    fillSel(selSeason, playlist.seasons, wantS);
    const season = playlist.seasons.find((s) => s.title === selSeason.value) ?? playlist.seasons[0];
    const wantE = selEpisode.value || current.episodeTitle;
    fillSel(selEpisode, season?.episodes ?? [], wantE);
    const ep = season?.episodes.find((e) => e.title === selEpisode.value) ?? season?.episodes[0];
    const allVoices = ep?.voices ?? [];
    // Если в эпизоде есть провайдеры (kinomix-агрегатор) — показываем row "Плеер"
    // и фильтруем голоса. Иначе row скрыт и показываем все голоса как раньше.
    const providers = distinctProviders(allVoices);
    // Row показываем только если есть ИЗ ЧЕГО выбирать (≥2 провайдеров).
    // Если 1 — нет смысла, фильтрация всё равно не меняет список голосов.
    const hasProvider = providers.length > 1;
    rowProvider.hidden = !hasProvider;
    let voiceList = allVoices;
    if (hasProvider) {
      // Если selProvider пустой или его нет в текущем списке провайдеров,
      // используем current.provider или первый из списка.
      const currentP = current?.provider;
      const wantP = (selProvider.value && providers.includes(selProvider.value))
        ? selProvider.value
        : (currentP && providers.includes(currentP) ? currentP : providers[0]);
      fillSelOpts(selProvider, providers.map((p) => ({ value: p, label: p })), wantP);
      voiceList = allVoices.filter((v) => v.provider === wantP);
    }
    const wantV = selVoice.value || current.voiceTitle;
    fillSel(selVoice, voiceList, wantV);
  }

  function fillSelOpts(sel, opts, currentValue) {
    sel.innerHTML = '';
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === currentValue) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function openPicker() {
    if (!playlist) return;
    pickerHint.hidden = isLeader();
    pickerApply.disabled = !isLeader();
    selSeason.disabled = selEpisode.disabled = selProvider.disabled = selVoice.disabled = !isLeader();
    selSeason.value = current.seasonTitle;
    selEpisode.value = current.episodeTitle;
    selProvider.value = current.provider || '';
    selVoice.value = current.voiceTitle;
    rowSeason.hidden = isMovie();
    rowEpisode.hidden = isMovie();
    renderPickerCascade();
    pickerEl.hidden = false;
  }

  pickerBtn.addEventListener('click', openPicker);
  pickerCancel.addEventListener('click', () => (pickerEl.hidden = true));
  selSeason.addEventListener('change', () => {
    selEpisode.value = '';
    selProvider.value = '';
    selVoice.value = '';
    renderPickerCascade();
  });
  selEpisode.addEventListener('change', () => {
    selProvider.value = '';
    selVoice.value = '';
    renderPickerCascade();
  });
  selProvider.addEventListener('change', () => {
    selVoice.value = '';
    renderPickerCascade();
  });

  pickerApply.addEventListener('click', async () => {
    if (!isLeader()) return;
    pickerApply.disabled = true;
    try {
      const res = await fetch(`${BASE}/api/room/${roomId}/switch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          season: selSeason.value,
          episode: selEpisode.value,
          voice: selVoice.value,
          provider: rowProvider.hidden ? undefined : selProvider.value,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      }
      pickerEl.hidden = true;
    } catch (err) {
      toast('Не удалось переключить: ' + err.message);
    } finally {
      pickerApply.disabled = false;
    }
  });

  /**
   * Где комната находится сейчас по данным snapshot'а. Snapshot обновляется
   * только heartbeat'ами лидера, то есть раз в десять секунд, поэтому без
   * поправки на его возраст новый зритель встаёт до десяти секунд позади — и
   * первый же heartbeat вырывал его вперёд прыжком.
   */
  function snapshotTarget(snap) {
    if (snap.paused) return snap.currentTime;
    return snap.currentTime + Math.max(0, (serverNow() - snap.updatedAt) / 1000);
  }

  function applySnapshot(snap) {
    if (!snap) return;
    const target = snapshotTarget(snap);
    if (Math.abs(video.currentTime - target) > 0.5) {
      withExpectedSeek(target, () => { video.currentTime = target; });
    }
    if (snap.paused && !video.paused) {
      expectPaused(true);
      video.pause();
    }
    if (!snap.paused && video.paused) {
      expectPaused(false);
      video.play().catch(() => {});
    }
  }

  /** Лидер нажал play/pause. */
  function applyPlayback(msg) {
    const lag = msg.paused ? 0 : Math.max(0, (serverNow() - msg.fromTime) / 1000);
    const target = msg.currentTime + lag;
    if (Math.abs(video.currentTime - target) > DRIFT_RESYNC_THRESHOLD_S) {
      resetRate();
      withExpectedSeek(target, () => { video.currentTime = target; });
    }
    if (msg.paused && !video.paused) {
      resetRate();
      expectPaused(true);
      video.pause();
    }
    if (!msg.paused && video.paused) {
      expectPaused(false);
      video.play().catch(() => {});
    }
  }

  /**
   * Лидер сам прыгнул по таймлайну. Это осознанный разрыв, поэтому повторяем его
   * прыжком, а не подгонкой скорости. Состояние play/pause не трогаем: его нет в
   * сообщении, а раньше сюда подставлялось состояние самого зрителя.
   */
  function applySeek(msg) {
    const lag = video.paused ? 0 : Math.max(0, (serverNow() - msg.fromTime) / 1000);
    const target = msg.currentTime + lag;
    resetRate();
    withExpectedSeek(target, () => { video.currentTime = target; });
  }

  function applyHeartbeat(msg) {
    if (isLeader()) return;
    const lag = video.paused ? 0 : Math.max(0, (serverNow() - msg.fromTime) / 1000);
    correctDrift(msg.currentTime + lag);
  }

  function applySourceChange(msg) {
    const prev = current;
    // Если сменилась только озвучка в venom-стриме (тот же эпизод, тот же hls,
    // только другой audioTrack) — переключаем track без destroy/recreate hls.
    const sameEpisode =
      prev &&
      msg.current &&
      prev.seasonId === msg.current.seasonId &&
      prev.episodeId === msg.current.episodeId &&
      prev.voiceFile === msg.current.voiceFile &&
      typeof msg.current.audioTrack === 'number';

    sourceVersion = msg.version;
    current = msg.current;
    clog('source', { v: msg.version, sameEpisode: sameEpisode ? 1 : 0 });
    updateCurrentBadge();

    if (sameEpisode && hls) {
      applyAudioTrack();
    } else {
      resetRate();
      expectPaused(true);
      video.pause();
      withExpectedSeek(0, () => { video.currentTime = 0; });
      loadSource(manifestUrl());
      applySubtitleTracks();
    }
    toast(
      isMovie()
        ? `Озвучка: ${current.voiceTitle}`
        : `Источник: ${current.seasonTitle} · ${current.episodeTitle} · ${current.voiceTitle}`,
      3500,
    );
  }

  function startPinging() {
    clearInterval(pingTimer);
    // Первый обмен сразу: до него поправка часов равна нулю, то есть работает
    // прежняя арифметика по «сырым» Date.now().
    send({ type: 'ping', t: Date.now() });
    pingTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), PING_INTERVAL_MS);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}${BASE}/ws/${roomId}`);
    ws.addEventListener('open', startPinging);
    ws.addEventListener('close', () => {
      clearInterval(pingTimer);
      clog('wsClose', {});
      toast('Связь потеряна, переподключаюсь…', 1500);
      setTimeout(connect, 1500);
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case 'welcome': {
          // Обрыв WebSocket'а — это ещё не смена источника. Раньше любой разрыв
          // (а переподключение идёт каждые 1.5с) пересоздавал плеер: буфер
          // выбрасывался, манифест запрашивался заново, картинка вставала. Если
          // источник тот же и плеер жив — оставляем его в покое.
          const sameSource = hls !== null && sourceVersion === (msg.sourceVersion || 1);
          selfId = msg.selfId;
          leaderId = msg.leaderId;
          members = new Map(msg.members.map((m) => [m.id, m]));
          playlist = msg.playlist;
          current = msg.current;
          sourceVersion = msg.sourceVersion || 1;
          updateRoleBadge();
          updateCurrentBadge();
          if (!sameSource) {
            loadSource(manifestUrl(), msg.snapshot ? snapshotTarget(msg.snapshot) : undefined);
            applySubtitleTracks();
          }
          applySnapshot(msg.snapshot);
          clog('welcome', {
            leader: isLeader() ? 1 : 0,
            members: members.size,
            v: sourceVersion,
            kept: sameSource ? 1 : 0,
          });
          flushLogs(false); // hello + welcome уходят сразу, не ждём 20с тика
          break;
        }
        case 'member-join':
          members.set(msg.id, { id: msg.id, name: msg.name });
          updateRoleBadge();
          toast(`${msg.name} присоединился`);
          break;
        case 'member-leave':
          members.delete(msg.id);
          updateRoleBadge();
          break;
        case 'leader-change':
          leaderId = msg.leaderId;
          updateRoleBadge();
          // Лидер ни к кому не подстраивается: если он унаследовал подкрученную
          // скорость от роли зрителя, комната поедет за ним быстрее нормы.
          if (isLeader()) {
            resetRate();
            toast('Ты теперь лидер');
          }
          break;
        case 'playback':
          applyPlayback(msg);
          break;
        case 'seek':
          applySeek(msg);
          break;
        case 'heartbeat':
          applyHeartbeat(msg);
          break;
        case 'pong':
          handlePong(msg);
          break;
        case 'source-change':
          applySourceChange(msg);
          break;
        case 'error':
          toast(msg.message || 'ошибка');
          break;
      }
    });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  video.addEventListener('play', () => {
    if (consumeExpectedPaused(false) || !isLeader()) return;
    send({ type: 'playback', paused: false, currentTime: video.currentTime });
  });
  video.addEventListener('pause', () => {
    if (consumeExpectedPaused(true) || !isLeader()) return;
    send({ type: 'playback', paused: true, currentTime: video.currentTime });
  });
  video.addEventListener('seeked', () => {
    if (consumeExpectedSeek() || !isLeader()) return;
    // Лидер прыгнул руками — скорость больше подгонять не нужно.
    resetRate();
    send({ type: 'seek', currentTime: video.currentTime });
  });
  video.addEventListener('timeupdate', () => {
    if (!isLeader()) return;
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeat = now;
    send({ type: 'heartbeat', currentTime: video.currentTime });
  });

  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    return new Promise((resolve) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(ta);
      resolve(ok);
    });
  }

  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(location.href);
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать');
  });

  connect();
})();
