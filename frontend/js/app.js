import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.worker.min.mjs';

(() => {
  'use strict';

  const WORKER_ORIGIN = 'https://dnd-dm.bob-mai.com';

  // ---- DOM refs ---------------------------------------------------------
  const gate = document.getElementById('dnd-gate');
  const createTabBtn = document.getElementById('dnd-tab-create');
  const joinTabBtn = document.getElementById('dnd-tab-join');
  const createPane = document.getElementById('dnd-pane-create');
  const joinPane = document.getElementById('dnd-pane-join');
  const campaignInput = document.getElementById('dnd-campaign-input');
  const createNameInput = document.getElementById('dnd-create-name-input');
  const createBtn = document.getElementById('dnd-create-btn');
  const codeInput = document.getElementById('dnd-code-input');
  const joinNameInput = document.getElementById('dnd-join-name-input');
  const joinBtn = document.getElementById('dnd-join-btn');
  const gateStatus = document.getElementById('dnd-gate-status');

  const app = document.getElementById('dnd-app');
  const roomBadge = document.getElementById('dnd-room-badge');
  const campaignNameEl = document.getElementById('dnd-campaign-name');
  const playersListEl = document.getElementById('dnd-players-list');
  const log = document.getElementById('dnd-log');
  const chatForm = document.getElementById('dnd-chat-form');
  const chatInput = document.getElementById('dnd-chat-input');

  const canvas = document.getElementById('dnd-map-canvas');
  const ctx = canvas.getContext('2d');
  const drawModeToggle = document.getElementById('dnd-draw-mode');
  const mapClearBtn = document.getElementById('dnd-map-clear-btn');

  const uploadForm = document.getElementById('dnd-upload-form');
  const pdfInput = document.getElementById('dnd-pdf-input');
  const uploadStatus = document.getElementById('dnd-upload-status');
  const sheetsEl = document.getElementById('dnd-sheets');

  const sfxToggleBtn = document.getElementById('dnd-sfx-toggle');
  const endGameBtn = document.getElementById('dnd-end-game-btn');

  // ---- State --------------------------------------------------------------
  let mapState = { lines: [], labels: [] };
  let playerName = '';
  let roomCode = '';
  let socket = null;
  let gameEnded = false;
  const GRID = 12;

  // ================================================================
  // Room gate: create or join
  // ================================================================
  function selectTab(which) {
    createTabBtn.classList.toggle('active', which === 'create');
    joinTabBtn.classList.toggle('active', which === 'join');
    createPane.classList.toggle('dnd-hidden', which !== 'create');
    joinPane.classList.toggle('dnd-hidden', which !== 'join');
    gateStatus.textContent = '';
  }
  createTabBtn.addEventListener('click', () => selectTab('create'));
  joinTabBtn.addEventListener('click', () => selectTab('join'));

  function setGateStatus(text, isError) {
    gateStatus.textContent = text;
    gateStatus.classList.toggle('dnd-error', !!isError);
  }

  createBtn.addEventListener('click', async () => {
    const name = createNameInput.value.trim();
    if (!name) { createNameInput.focus(); return; }
    createBtn.disabled = true;
    setGateStatus('Creating your game…');
    try {
      const res = await fetch(`${WORKER_ORIGIN}/api/create-room`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaign: campaignInput.value.trim() || 'New Campaign' })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Could not create a game.');
      enterRoom(data.code, name);
    } catch (err) {
      setGateStatus(err.message, true);
      createBtn.disabled = false;
    }
  });

  joinBtn.addEventListener('click', async () => {
    const name = joinNameInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    if (!code) { codeInput.focus(); return; }
    if (!name) { joinNameInput.focus(); return; }
    joinBtn.disabled = true;
    setGateStatus('Looking for that game…');
    try {
      const res = await fetch(`${WORKER_ORIGIN}/api/room/${encodeURIComponent(code)}/status`);
      const data = await res.json();
      if (!data.initialized) throw new Error(`No game found with code "${code}".`);
      if (data.ended) throw new Error('That game has already ended.');
      enterRoom(code, name);
    } catch (err) {
      setGateStatus(err.message, true);
      joinBtn.disabled = false;
    }
  });
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });
  joinNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });
  createNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });

  function enterRoom(code, name) {
    roomCode = code;
    playerName = name;
    gate.classList.add('dnd-hidden');
    app.classList.remove('dnd-hidden');
    roomBadge.textContent = code;
    unlockAudio();
    connectSocket();
  }

  // ================================================================
  // WebSocket connection
  // ================================================================
  function connectSocket() {
    const wsUrl = WORKER_ORIGIN.replace(/^http/, 'ws') + `/api/room/${encodeURIComponent(roomCode)}`;
    socket = new WebSocket(wsUrl);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', name: playerName }));
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleServerMessage(msg);
    });

    socket.addEventListener('close', () => {
      if (gameEnded) return; // expected close after End Game — don't reconnect or alarm anyone
      appendMsg({ text: 'Disconnected from the game. Reconnecting…', cls: 'dnd-system' });
      setTimeout(() => { if (roomCode) connectSocket(); }, 2000);
    });

    socket.addEventListener('error', () => { /* close handler will retry */ });
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  endGameBtn.addEventListener('click', () => {
    if (!confirm('End this game for everyone? The room will close and no one will be able to rejoin with this code.')) return;
    send({ type: 'end-game' });
  });

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'state': {
        campaignNameEl.textContent = msg.state.campaign || 'New Campaign';
        mapState = msg.state.map || { lines: [], labels: [] };
        drawMap();
        log.innerHTML = '';
        for (const h of msg.state.history || []) {
          if (h.role === 'dm') appendMsg({ who: 'DM', text: h.content, cls: 'dnd-dm' });
          else if (h.role === 'roll') appendRoll(h.results || [{ label: h.name, breakdown: h.content }]);
          else appendMsg({ who: h.name, text: h.content, cls: 'dnd-player' });
        }
        sheetsEl.innerHTML = '';
        for (const [name, sheet] of Object.entries(msg.state.characters || {})) renderSheet(name, sheet);
        endGameBtn.classList.toggle('dnd-hidden', msg.state.ownerName !== playerName);
        break;
      }
      case 'game-ended':
        gameEnded = true;
        appendMsg({ text: `🏁 ${msg.endedBy} ended the game. This room is now closed — thanks for playing!`, cls: 'dnd-system' });
        chatInput.disabled = true;
        chatForm.querySelector('button').disabled = true;
        endGameBtn.disabled = true;
        break;
      case 'players':
        playersListEl.textContent = msg.list.length ? msg.list.join(', ') : '—';
        break;
      case 'player-said':
        appendMsg({ who: msg.name, text: msg.text, cls: 'dnd-player' });
        break;
      case 'dm-said':
        appendMsg({ who: 'DM', text: msg.text, cls: 'dnd-dm' });
        if (msg.budgetExceeded) appendMsg({ text: "(This free demo's daily AI budget is used up — the DM will be back tomorrow.)", cls: 'dnd-system' });
        break;
      case 'dice-rolled':
        appendRoll(msg.rolls);
        break;
      case 'sfx-played':
        msg.effects.forEach((effect, i) => setTimeout(() => playSfx(effect), i * 120));
        break;
      case 'map-ops':
        for (const op of msg.ops) {
          if (op.type === 'clear') { mapState.lines = []; mapState.labels = []; }
          else if (op.type === 'line') mapState.lines.push(op);
          else if (op.type === 'label') mapState.labels.push(op);
        }
        drawMap();
        break;
      case 'character-updated':
        renderSheet(msg.playerName, msg.sheet);
        break;
      case 'error':
        appendMsg({ text: msg.error, cls: 'dnd-error' });
        break;
    }
  }

  // ================================================================
  // Chat log rendering
  // ================================================================
  function appendMsg({ who, text, cls }) {
    const div = document.createElement('div');
    div.className = `dnd-msg ${cls}`;
    if (who) {
      const whoSpan = document.createElement('span');
      whoSpan.className = 'dnd-who';
      whoSpan.textContent = who + ':';
      div.appendChild(whoSpan);
    }
    const textSpan = document.createElement('span');
    textSpan.className = 'dnd-text';
    textSpan.textContent = text;
    div.appendChild(textSpan);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function appendRoll(rolls) {
    const div = document.createElement('div');
    div.className = 'dnd-msg dnd-roll';
    div.innerHTML = rolls.map(r => `
      <div class="dnd-roll-line">
        <span>🎲</span>
        <span class="dnd-roll-label">${escapeHtml(r.label)}</span>
        <span class="dnd-roll-detail">${r.error ? `invalid roll (${escapeHtml(r.error)})` : escapeHtml(r.breakdown)}</span>
      </div>`).join('');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    chatInput.value = '';
  });

  // ================================================================
  // Map rendering
  // ================================================================
  function toPixel(x, y) { return { px: canvas.width / 2 + x * GRID, py: canvas.height / 2 + y * GRID }; }
  function toGrid(px, py) { return { x: (px - canvas.width / 2) / GRID, y: (py - canvas.height / 2) / GRID }; }

  function drawMap() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#241f1a';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= canvas.width; gx += GRID) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, canvas.height); ctx.stroke(); }
    for (let gy = 0; gy <= canvas.height; gy += GRID) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(canvas.width, gy); ctx.stroke(); }

    const origin = toPixel(0, 0);
    ctx.strokeStyle = '#3a3229';
    ctx.beginPath(); ctx.moveTo(origin.px - 6, origin.py); ctx.lineTo(origin.px + 6, origin.py); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(origin.px, origin.py - 6); ctx.lineTo(origin.px, origin.py + 6); ctx.stroke();

    for (const line of mapState.lines || []) {
      const a = toPixel(line.x1, line.y1), b = toPixel(line.x2, line.y2);
      ctx.strokeStyle = line.color || '#e8e2d0';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    }
    ctx.fillStyle = '#c9973f';
    ctx.font = '11px Georgia, serif';
    for (const label of mapState.labels || []) {
      const p = toPixel(label.x, label.y);
      ctx.fillText(label.text, p.px + 4, p.py - 4);
    }
  }

  mapClearBtn.addEventListener('click', () => send({ type: 'map-clear' }));

  let dragging = false, dragStart = null;
  canvas.addEventListener('mousedown', e => {
    if (!drawModeToggle.checked) return;
    dragging = true;
    const rect = canvas.getBoundingClientRect();
    dragStart = toGrid((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height));
  });
  canvas.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const rect = canvas.getBoundingClientRect();
    const end = toGrid((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height));
    send({ type: 'map-draw', line: { x1: Math.round(dragStart.x), y1: Math.round(dragStart.y), x2: Math.round(end.x), y2: Math.round(end.y), color: '#7fb0c9' } });
  });

  // ================================================================
  // Character sheet upload: extract PDF text in-browser (pdf.js), then ask the
  // Worker's AI to format it. The raw PDF file itself never leaves the browser.
  // ================================================================
  async function extractPdfText(file) {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
    }
    return text;
  }

  uploadForm.addEventListener('submit', async e => {
    e.preventDefault();
    const file = pdfInput.files[0];
    if (!file) { uploadStatus.textContent = 'Choose a PDF first.'; return; }

    uploadStatus.textContent = 'Reading PDF in your browser…';
    try {
      const text = await extractPdfText(file);
      if (!text.trim()) throw new Error('Could not extract any text from that PDF.');

      uploadStatus.textContent = 'Asking the AI to format it…';
      const res = await fetch(`${WORKER_ORIGIN}/api/room/${encodeURIComponent(roomCode)}/character`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerName, text })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Upload failed');
      uploadStatus.textContent = `Loaded ${data.sheet.name || playerName}.`;
      pdfInput.value = '';
    } catch (err) {
      uploadStatus.textContent = `Error: ${err.message}`;
    }
  });

  // ================================================================
  // Character sheet creation: build a sheet directly, no PDF or AI needed.
  // ================================================================
  const charTabUploadBtn = document.getElementById('dnd-char-tab-upload');
  const charTabCreateBtn = document.getElementById('dnd-char-tab-create');
  const createCharForm = document.getElementById('dnd-create-char-form');
  const createCharStatus = document.getElementById('dnd-create-status');

  function selectCharTab(which) {
    charTabUploadBtn.classList.toggle('active', which === 'upload');
    charTabCreateBtn.classList.toggle('active', which === 'create');
    uploadForm.classList.toggle('dnd-hidden', which !== 'upload');
    createCharForm.classList.toggle('dnd-hidden', which !== 'create');
  }
  charTabUploadBtn.addEventListener('click', () => selectCharTab('upload'));
  charTabCreateBtn.addEventListener('click', () => selectCharTab('create'));

  function splitList(value) {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }

  createCharForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('cc-name').value.trim() || playerName;
    const hpMax = parseInt(document.getElementById('cc-hp').value, 10) || 10;
    const sheet = {
      name,
      race: document.getElementById('cc-race').value.trim(),
      class: document.getElementById('cc-class').value.trim(),
      level: parseInt(document.getElementById('cc-level').value, 10) || 1,
      background: document.getElementById('cc-background').value.trim(),
      alignment: '',
      abilityScores: {
        STR: parseInt(document.getElementById('cc-str').value, 10) || 10,
        DEX: parseInt(document.getElementById('cc-dex').value, 10) || 10,
        CON: parseInt(document.getElementById('cc-con').value, 10) || 10,
        INT: parseInt(document.getElementById('cc-int').value, 10) || 10,
        WIS: parseInt(document.getElementById('cc-wis').value, 10) || 10,
        CHA: parseInt(document.getElementById('cc-cha').value, 10) || 10
      },
      hp: { current: hpMax, max: hpMax },
      armorClass: parseInt(document.getElementById('cc-ac').value, 10) || 10,
      speed: 30,
      proficiencyBonus: 2,
      savingThrows: splitList(document.getElementById('cc-saves').value),
      skills: splitList(document.getElementById('cc-skills').value),
      equipment: splitList(document.getElementById('cc-equipment').value),
      features: [],
      spells: [],
      notes: document.getElementById('cc-notes').value.trim()
    };

    createCharStatus.textContent = 'Creating…';
    try {
      const res = await fetch(`${WORKER_ORIGIN}/api/room/${encodeURIComponent(roomCode)}/character/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerName, sheet })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not create character');
      createCharStatus.textContent = `Created ${data.sheet.name}.`;
      createCharForm.reset();
    } catch (err) {
      createCharStatus.textContent = `Error: ${err.message}`;
    }
  });

  function cssId(name) { return String(name).replace(/[^a-z0-9]/gi, '_'); }

  function renderSheet(name, sheet) {
    const id = `dnd-sheet-${cssId(name)}`;
    let card = document.getElementById(id);
    if (!card) {
      card = document.createElement('div');
      card.className = 'dnd-sheet-card';
      card.id = id;
      sheetsEl.appendChild(card);
    }
    const ab = sheet.abilityScores || {};
    const abilityOrder = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
    card.innerHTML = `
      <h3>${escapeHtml(sheet.name || name)}</h3>
      <div class="dnd-meta">Level ${escapeHtml(sheet.level ?? '?')} ${escapeHtml(sheet.race || '')} ${escapeHtml(sheet.class || '')} · HP ${escapeHtml(sheet.hp?.current ?? '?')}/${escapeHtml(sheet.hp?.max ?? '?')} · AC ${escapeHtml(sheet.armorClass ?? '?')}</div>
      <div class="dnd-abilities">${abilityOrder.map(k => `<div>${ab[k] ?? '-'}<small>${k}</small></div>`).join('')}</div>
      <details>
        <summary>Equipment, features &amp; notes</summary>
        <p><strong>Equipment:</strong> ${escapeHtml((sheet.equipment || []).join(', ') || '—')}</p>
        <p><strong>Features:</strong> ${escapeHtml((sheet.features || []).join(', ') || '—')}</p>
        <p><strong>Spells:</strong> ${escapeHtml((sheet.spells || []).join(', ') || '—')}</p>
        <p><strong>Notes:</strong> ${escapeHtml(sheet.notes || '—')}</p>
      </details>`;
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ================================================================
  // Sound effects: procedurally synthesized via the Web Audio API.
  // ================================================================
  let audioCtx = null;
  let sfxEnabled = true;

  function unlockAudio() {
    if (!(window.AudioContext || window.webkitAudioContext)) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  sfxToggleBtn.addEventListener('click', () => {
    sfxEnabled = !sfxEnabled;
    sfxToggleBtn.classList.toggle('active', sfxEnabled);
    sfxToggleBtn.textContent = sfxEnabled ? '🔊 SFX' : '🔇 SFX';
  });

  function tone(freq, duration, { type = 'sine', gain = 0.25, delay = 0, freqEnd = null } = {}) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
    gainNode.gain.setValueAtTime(gain, t0);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gainNode).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function noiseBurst(duration, { filterFreq = 2000, filterType = 'lowpass', gain = 0.3, delay = 0 } = {}) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const bufferSize = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, t0);
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(gain, t0);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    noise.connect(filter).connect(gainNode).connect(audioCtx.destination);
    noise.start(t0);
    noise.stop(t0 + duration + 0.02);
  }

  const SFX_LIBRARY = {
    sword_clash: () => { noiseBurst(0.08, { filterFreq: 4000, gain: 0.3 }); tone(1800, 0.08, { type: 'square', gain: 0.15, delay: 0.02, freqEnd: 800 }); tone(2400, 0.06, { type: 'square', gain: 0.12, delay: 0.1, freqEnd: 900 }); },
    footsteps: () => { [0, 0.18, 0.36].forEach(d => noiseBurst(0.08, { filterFreq: 200, gain: 0.25, delay: d })); },
    door_creak: () => { tone(220, 0.6, { type: 'sawtooth', gain: 0.12, freqEnd: 280 }); noiseBurst(0.6, { filterFreq: 600, gain: 0.05 }); },
    explosion: () => { noiseBurst(0.5, { filterFreq: 800, gain: 0.4 }); tone(60, 0.5, { type: 'sine', gain: 0.3, freqEnd: 30 }); },
    magic_sparkle: () => { [660, 880, 1100, 1320].forEach((f, i) => tone(f, 0.15, { type: 'sine', gain: 0.15, delay: i * 0.07 })); },
    coin: () => { tone(1200, 0.08, { type: 'square', gain: 0.2 }); tone(1800, 0.12, { type: 'square', gain: 0.15, delay: 0.06 }); },
    monster_growl: () => { tone(90, 0.5, { type: 'sawtooth', gain: 0.25, freqEnd: 60 }); noiseBurst(0.5, { filterFreq: 300, gain: 0.15 }); },
    thunder: () => { noiseBurst(1.2, { filterFreq: 250, gain: 0.35 }); },
    success_chime: () => { [523, 659, 784].forEach((f, i) => tone(f, 0.2, { type: 'triangle', gain: 0.2, delay: i * 0.09 })); },
    failure_buzz: () => { tone(160, 0.35, { type: 'square', gain: 0.2, freqEnd: 80 }); },
    arrow_whoosh: () => { noiseBurst(0.25, { filterFreq: 3000, gain: 0.2 }); tone(1200, 0.25, { type: 'sine', gain: 0.1, freqEnd: 300 }); },
    fire_crackle: () => { for (let i = 0; i < 6; i++) noiseBurst(0.05, { filterFreq: 1500 + Math.random() * 1500, gain: 0.08, delay: Math.random() * 0.5 }); },
    water_splash: () => { noiseBurst(0.3, { filterFreq: 1200, gain: 0.25 }); },
    heartbeat: () => { tone(60, 0.15, { type: 'sine', gain: 0.3 }); tone(55, 0.15, { type: 'sine', gain: 0.25, delay: 0.22 }); }
  };

  function playSfx(effect) {
    if (!sfxEnabled) return;
    unlockAudio();
    const fn = SFX_LIBRARY[effect];
    if (fn) fn();
  }

  selectTab('create');
  drawMap();
})();
