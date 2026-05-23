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
  const selVoice = document.getElementById('sel-voice');
  const guestControls = document.getElementById('guest-controls');
  const gcMute = document.getElementById('gc-mute');
  const gcVolume = document.getElementById('gc-volume');
  const gcCc = document.getElementById('gc-cc');
  const gcPip = document.getElementById('gc-pip');
  const gcFs = document.getElementById('gc-fs');
  const rowSeason = document.getElementById('row-season');
  const rowEpisode = document.getElementById('row-episode');

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
  const DRIFT_RESYNC_THRESHOLD_S = 3;   // зритель ресинкается если расхождение > 3с

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

  function loadSource(url) {
    if (hls) {
      try { hls.destroy(); } catch {}
      hls = null;
    }
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) toast('Ошибка воспроизведения: ' + data.type);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    } else {
      toast('HLS не поддерживается этим браузером');
    }
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
    currentEl.textContent = isMovie()
      ? current.voiceTitle
      : `${current.seasonTitle} · ${current.episodeTitle} · ${current.voiceTitle}`;
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

  function renderPickerCascade() {
    if (!playlist || !current) return;
    const wantS = selSeason.value || current.seasonTitle;
    fillSel(selSeason, playlist.seasons, wantS);
    const season = playlist.seasons.find((s) => s.title === selSeason.value) ?? playlist.seasons[0];
    const wantE = selEpisode.value || current.episodeTitle;
    fillSel(selEpisode, season?.episodes ?? [], wantE);
    const ep = season?.episodes.find((e) => e.title === selEpisode.value) ?? season?.episodes[0];
    const wantV = selVoice.value || current.voiceTitle;
    fillSel(selVoice, ep?.voices ?? [], wantV);
  }

  function openPicker() {
    if (!playlist) return;
    pickerHint.hidden = isLeader();
    pickerApply.disabled = !isLeader();
    selSeason.disabled = selEpisode.disabled = selVoice.disabled = !isLeader();
    selSeason.value = current.seasonTitle;
    selEpisode.value = current.episodeTitle;
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
    selVoice.value = '';
    renderPickerCascade();
  });
  selEpisode.addEventListener('change', () => {
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
      suppress = true;
      video.currentTime = target;
      queueMicrotask(() => (suppress = false));
    }
  }

  function applySourceChange(msg) {
    sourceVersion = msg.version;
    current = msg.current;
    updateCurrentBadge();
    suppress = true;
    video.pause();
    video.currentTime = 0;
    loadSource(manifestUrl());
    queueMicrotask(() => (suppress = false));
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
          applySnapshot(msg.snapshot);
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
