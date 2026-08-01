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
  let suppress = false;
  let ws = null;
  let lastHeartbeat = 0;
  let hls = null;
  let playlist = null;
  let current = null;
  let sourceVersion = 1;

  // Sync tuning
  const HEARTBEAT_INTERVAL_MS = 10_000; // лидер шлёт snapshot времени раз в 10с
  const DRIFT_RESYNC_THRESHOLD_S = 1.5; // зритель ресинкается если расхождение > 1.5с

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

  function loadSource(url) {
    if (hls) {
      try { hls.destroy(); } catch {}
      hls = null;
    }
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
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

  function applySnapshot(snap) {
    if (!snap) return;
    suppress = true;
    if (Math.abs(video.currentTime - snap.currentTime) > 0.5) {
      video.currentTime = snap.currentTime;
    }
    if (snap.paused && !video.paused) video.pause();
    if (!snap.paused && video.paused) video.play().catch(() => {});
    queueMicrotask(() => (suppress = false));
  }

  function applyPlayback(msg) {
    suppress = true;
    const lag = (Date.now() - msg.fromTime) / 1000;
    const target = msg.paused ? msg.currentTime : msg.currentTime + lag;
    if (Math.abs(video.currentTime - target) > 1.5) {
      video.currentTime = target;
    }
    if (msg.paused && !video.paused) video.pause();
    if (!msg.paused && video.paused) video.play().catch(() => {});
    queueMicrotask(() => (suppress = false));
  }

  function applyHeartbeat(msg) {
    if (isLeader()) return;
    const lag = (Date.now() - msg.fromTime) / 1000;
    const target = msg.currentTime + (video.paused ? 0 : lag);
    const drift = video.currentTime - target;
    if (Math.abs(drift) > DRIFT_RESYNC_THRESHOLD_S) {
      // Постоянные ресинки (6/мин) = видео у зрителя само не идёт, его тащит
      // heartbeat — так выглядел зависший декодер в кейсе Elkjul.
      clog('resync', { drift: +drift.toFixed(2), ct: +video.currentTime.toFixed(1), buf: bufferAheadS() });
      suppress = true;
      video.currentTime = target;
      queueMicrotask(() => (suppress = false));
    }
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
      suppress = true;
      video.pause();
      video.currentTime = 0;
      loadSource(manifestUrl());
      applySubtitleTracks();
      queueMicrotask(() => (suppress = false));
    }
    toast(
      isMovie()
        ? `Озвучка: ${current.voiceTitle}`
        : `Источник: ${current.seasonTitle} · ${current.episodeTitle} · ${current.voiceTitle}`,
      3500,
    );
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}${BASE}/ws/${roomId}`);
    ws.addEventListener('close', () => {
      clog('wsClose', {});
      toast('Связь потеряна, переподключаюсь…', 1500);
      setTimeout(connect, 1500);
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case 'welcome':
          selfId = msg.selfId;
          leaderId = msg.leaderId;
          members = new Map(msg.members.map((m) => [m.id, m]));
          playlist = msg.playlist;
          current = msg.current;
          sourceVersion = msg.sourceVersion || 1;
          updateRoleBadge();
          updateCurrentBadge();
          loadSource(manifestUrl());
          applySubtitleTracks();
          applySnapshot(msg.snapshot);
          clog('welcome', { leader: isLeader() ? 1 : 0, members: members.size, v: sourceVersion });
          flushLogs(false); // hello + welcome уходят сразу, не ждём 20с тика
          break;
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
          if (isLeader()) toast('Ты теперь лидер');
          break;
        case 'playback':
          applyPlayback(msg);
          break;
        case 'seek':
          applyPlayback({ ...msg, paused: video.paused });
          break;
        case 'heartbeat':
          applyHeartbeat(msg);
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
    if (suppress || !isLeader()) return;
    send({ type: 'playback', paused: false, currentTime: video.currentTime });
  });
  video.addEventListener('pause', () => {
    if (suppress || !isLeader()) return;
    send({ type: 'playback', paused: true, currentTime: video.currentTime });
  });
  video.addEventListener('seeked', () => {
    if (suppress || !isLeader()) return;
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
