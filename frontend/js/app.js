import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.worker.min.mjs';

(() => {
  'use strict';

  const WORKER_ORIGIN = 'https://dnd-dm.bob-mai.com';

  // ---- DOM refs ---------------------------------------------------------
  const gate = document.getElementById('dnd-gate');
  const createTabBtn = document.getElementById('dnd-tab-create');
  const joinTabBtn = document.getElementById('dnd-tab-join');
  const globalTabBtn = document.getElementById('dnd-tab-global');
  const createPane = document.getElementById('dnd-pane-create');
  const joinPane = document.getElementById('dnd-pane-join');
  const globalPane = document.getElementById('dnd-pane-global');
  const campaignInput = document.getElementById('dnd-campaign-input');
  const createNameInput = document.getElementById('dnd-create-name-input');
  const createBtn = document.getElementById('dnd-create-btn');
  const codeInput = document.getElementById('dnd-code-input');
  const joinNameInput = document.getElementById('dnd-join-name-input');
  const joinBtn = document.getElementById('dnd-join-btn');
  const globalNameInput = document.getElementById('dnd-global-name-input');
  const globalBtn = document.getElementById('dnd-global-btn');
  const gateStatus = document.getElementById('dnd-gate-status');
  const continueBox = document.getElementById('dnd-continue-box');
  const continueBtn = document.getElementById('dnd-continue-btn');
  const createSoloNote = document.getElementById('dnd-create-solo-note');
  const createAccountNote = document.getElementById('dnd-create-account-note');
  const joinAccountNote = document.getElementById('dnd-join-account-note');
  const globalAccountNote = document.getElementById('dnd-global-account-note');

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
    globalTabBtn.classList.toggle('active', which === 'global');
    createPane.classList.toggle('dnd-hidden', which !== 'create');
    joinPane.classList.toggle('dnd-hidden', which !== 'join');
    globalPane.classList.toggle('dnd-hidden', which !== 'global');
    gateStatus.textContent = '';
  }
  createTabBtn.addEventListener('click', () => selectTab('create'));
  joinTabBtn.addEventListener('click', () => selectTab('join'));
  globalTabBtn.addEventListener('click', () => selectTab('global'));

  function setGateStatus(text, isError) {
    gateStatus.textContent = text;
    gateStatus.classList.toggle('dnd-error', !!isError);
  }

  // ================================================================
  // Account state — driven by the shared /shared/auth.js widget (window.SiteAuth). Signed in:
  // your reserved username is used everywhere, name inputs are hidden. Signed out: today's
  // free-text-name flow stays, except a new game is a solo/unsaved one and the Global Game
  // (the one shared persistent world) requires signing in.
  // ================================================================
  function applyAuthState() {
    const username = window.SiteAuth?.getUsername() || null;

    createSoloNote.classList.toggle('dnd-hidden', !!username);
    createNameInput.classList.toggle('dnd-hidden', !!username);
    createAccountNote.classList.toggle('dnd-hidden', !username);
    if (username) createAccountNote.textContent = `Playing as ${username}`;
    createBtn.textContent = username ? 'Start a New Game' : 'Play Solo';

    joinNameInput.classList.toggle('dnd-hidden', !!username);
    joinAccountNote.classList.toggle('dnd-hidden', !username);
    if (username) joinAccountNote.textContent = `Playing as ${username}`;

    globalNameInput.classList.toggle('dnd-hidden', !!username);
    globalAccountNote.classList.toggle('dnd-hidden', !username);
    if (username) globalAccountNote.textContent = `Playing as ${username}`;
    globalBtn.textContent = username ? 'Join the Global Game' : 'Sign In to Join';
  }
  applyAuthState();
  window.SiteAuth?.onChange(applyAuthState);

  createBtn.addEventListener('click', async () => {
    const username = window.SiteAuth?.getUsername() || null;
    const name = username || createNameInput.value.trim();
    if (!name) { createNameInput.focus(); return; }
    createBtn.disabled = true;
    setGateStatus(username ? 'Creating your game…' : 'Starting a solo game…');
    try {
      const idToken = username ? await window.SiteAuth.getIdToken() : null;
      const res = await fetch(`${WORKER_ORIGIN}/api/create-room`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
        body: JSON.stringify({ campaign: campaignInput.value.trim() || 'New Campaign', solo: !username })
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
    const username = window.SiteAuth?.getUsername() || null;
    const name = username || joinNameInput.value.trim();
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

  globalBtn.addEventListener('click', async () => {
    const username = window.SiteAuth?.getUsername() || null;
    if (!username) {
      setGateStatus('Sign in using the button at the top of the page first.', true);
      return;
    }
    globalBtn.disabled = true;
    setGateStatus('Joining the global game…');
    try {
      const idToken = await window.SiteAuth.getIdToken();
      const res = await fetch(`${WORKER_ORIGIN}/api/global-room`, {
        method: 'POST', headers: { authorization: `Bearer ${idToken}` }
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Could not join the global game.');
      enterRoom(data.code, username);
    } catch (err) {
      setGateStatus(err.message, true);
      globalBtn.disabled = false;
    }
  });

  function enterRoom(code, name) {
    roomCode = code;
    playerName = name;
    saveSession(code, name);
    gate.classList.add('dnd-hidden');
    app.classList.remove('dnd-hidden');
    roomBadge.textContent = code;
    unlockAudio();
    connectSocket();
  }

  // ================================================================
  // Remembering your own game+name across visits — without this, closing the
  // tab and coming back meant retyping the room code and your exact name
  // from memory just to see your own character sheet again.
  // ================================================================
  const SESSION_KEY = 'dnd-last-session';

  function saveSession(code, name) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: code, playerName: name })); }
    catch { /* private browsing or storage disabled — reconnecting just requires retyping */ }
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
    catch { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to clear */ }
  }

  (async function offerContinue() {
    const saved = loadSession();
    if (!saved?.roomCode || !saved?.playerName) return;
    try {
      const res = await fetch(`${WORKER_ORIGIN}/api/room/${encodeURIComponent(saved.roomCode)}/status`);
      const data = await res.json();
      if (!data.initialized || data.ended) { clearSession(); return; }
      continueBtn.textContent = `Continue as ${saved.playerName} in "${data.campaign}" →`;
      continueBox.classList.remove('dnd-hidden');
      continueBtn.addEventListener('click', () => enterRoom(saved.roomCode, saved.playerName));
    } catch { /* network hiccup — not worth surfacing on load, the tabs below still work */ }
  })();

  // ================================================================
  // WebSocket connection
  // ================================================================
  function connectSocket() {
    const wsUrl = WORKER_ORIGIN.replace(/^http/, 'ws') + `/api/room/${encodeURIComponent(roomCode)}`;
    socket = new WebSocket(wsUrl);

    socket.addEventListener('open', async () => {
      // A verified username always wins server-side over `name` — this just lets a signed-in
      // player reconnect with the right identity without retyping anything (and is required
      // for the Global Game specifically).
      const idToken = window.SiteAuth?.getUsername() ? await window.SiteAuth.getIdToken() : null;
      socket.send(JSON.stringify({ type: 'join', name: playerName, idToken }));
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
        pendingTurns = 0; // a fresh log means any earlier "thinking" indicator no longer applies
        for (const h of msg.state.history || []) {
          if (h.role === 'dm') appendMsg({ who: 'DM', text: h.content, cls: 'dnd-dm' });
          else if (h.role === 'roll') appendRoll(h.results || [{ label: h.name, breakdown: h.content }]);
          else appendMsg({ who: h.name, text: h.content, cls: 'dnd-player' });
        }
        sheetsEl.innerHTML = '';
        for (const [name, sheet] of Object.entries(msg.state.characters || {})) renderSheet(name, sheet);
        // The global game is shared and permanent — no one gets an End Game button for it.
        endGameBtn.classList.toggle('dnd-hidden', roomCode === 'GLOBAL' || msg.state.ownerName !== playerName);
        break;
      }
      case 'game-ended':
        gameEnded = true;
        clearSession(); // this room can't be rejoined, so don't keep offering to continue it
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
        hideThinking();
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
      case 'character-removed': {
        const el = document.getElementById(`dnd-sheet-${cssId(msg.playerName)}`);
        if (el) el.remove();
        break;
      }
      case 'error':
        hideThinking();
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

  // Turns can take 10-40s (a real narrator call, sometimes a tool-call round-trip or two), so
  // without this a player has no feedback that anything is happening after they hit Send.
  let pendingTurns = 0;
  function showThinking() {
    pendingTurns++;
    if (document.getElementById('dnd-thinking')) return;
    const div = document.createElement('div');
    div.id = 'dnd-thinking';
    div.className = 'dnd-msg dnd-system';
    div.textContent = 'The DM is thinking…';
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function hideThinking() {
    pendingTurns = Math.max(0, pendingTurns - 1);
    if (pendingTurns > 0) return;
    const el = document.getElementById('dnd-thinking');
    if (el) el.remove();
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
    // /roll is a shortcut the server resolves instantly (no narrator call) — only show the
    // "thinking" indicator for real turns, which can take a while.
    if (!/^\/roll\s+/i.test(text)) showThinking();
  });

  // ================================================================
  // Map rendering
  // ================================================================
  function toPixel(x, y) { return { px: canvas.width / 2 + x * GRID, py: canvas.height / 2 + y * GRID }; }
  function toGrid(px, py) { return { x: (px - canvas.width / 2) / GRID, y: (py - canvas.height / 2) / GRID }; }

  function drawMap() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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

  // ---- 5e reference data: dropdown options, and the skill-pick quota per class ----------------
  const RACES = ['Human', 'Elf', 'Dwarf', 'Halfling', 'Dragonborn', 'Gnome', 'Half-Elf', 'Half-Orc', 'Tiefling'];
  const BACKGROUNDS = ['Acolyte', 'Charlatan', 'Criminal', 'Entertainer', 'Folk Hero', 'Guild Artisan',
    'Hermit', 'Noble', 'Outlander', 'Sage', 'Sailor', 'Soldier', 'Urchin'];
  const ALL_SKILLS = ['Acrobatics', 'Animal Handling', 'Arcana', 'Athletics', 'Deception', 'History', 'Insight',
    'Intimidation', 'Investigation', 'Medicine', 'Nature', 'Perception', 'Performance', 'Persuasion',
    'Religion', 'Sleight of Hand', 'Stealth', 'Survival'];
  // quota = how many skills a class may pick; priority = ability order for the standard array.
  const CLASSES = {
    Barbarian: { hitDie: 12, saves: ['STR', 'CON'], quota: 2, priority: ['STR', 'CON', 'DEX', 'WIS', 'CHA', 'INT'],
      skills: ['Animal Handling', 'Athletics', 'Intimidation', 'Nature', 'Perception', 'Survival'], kit: ['Greataxe', 'Handaxe x2', "Explorer's pack"] },
    Bard: { hitDie: 8, saves: ['DEX', 'CHA'], quota: 3, priority: ['CHA', 'DEX', 'CON', 'WIS', 'INT', 'STR'],
      skills: ALL_SKILLS, kit: ['Rapier', 'Lute', 'Dagger'] },
    Cleric: { hitDie: 8, saves: ['WIS', 'CHA'], quota: 2, priority: ['WIS', 'CON', 'STR', 'CHA', 'DEX', 'INT'],
      skills: ['History', 'Insight', 'Medicine', 'Persuasion', 'Religion'], kit: ['Mace', 'Shield', 'Holy symbol'] },
    Druid: { hitDie: 8, saves: ['INT', 'WIS'], quota: 2, priority: ['WIS', 'CON', 'DEX', 'INT', 'CHA', 'STR'],
      skills: ['Arcana', 'Animal Handling', 'Insight', 'Medicine', 'Nature', 'Perception', 'Religion', 'Survival'], kit: ['Quarterstaff', 'Druidic focus'] },
    Fighter: { hitDie: 10, saves: ['STR', 'CON'], quota: 2, priority: ['STR', 'CON', 'DEX', 'WIS', 'CHA', 'INT'],
      skills: ['Acrobatics', 'Animal Handling', 'Athletics', 'History', 'Insight', 'Intimidation', 'Perception', 'Survival'], kit: ['Longsword', 'Shield', 'Chain mail'] },
    Monk: { hitDie: 8, saves: ['STR', 'DEX'], quota: 2, priority: ['DEX', 'WIS', 'CON', 'STR', 'CHA', 'INT'],
      skills: ['Acrobatics', 'Athletics', 'History', 'Insight', 'Religion', 'Stealth'], kit: ['Shortsword', 'Darts x10'] },
    Paladin: { hitDie: 10, saves: ['WIS', 'CHA'], quota: 2, priority: ['STR', 'CHA', 'CON', 'WIS', 'DEX', 'INT'],
      skills: ['Athletics', 'Insight', 'Intimidation', 'Medicine', 'Persuasion', 'Religion'], kit: ['Longsword', 'Shield', 'Chain mail'] },
    Ranger: { hitDie: 10, saves: ['STR', 'DEX'], quota: 3, priority: ['DEX', 'WIS', 'CON', 'STR', 'INT', 'CHA'],
      skills: ['Animal Handling', 'Athletics', 'Insight', 'Investigation', 'Nature', 'Perception', 'Stealth', 'Survival'], kit: ['Longbow', 'Arrows x20', 'Shortsword x2'] },
    Rogue: { hitDie: 8, saves: ['DEX', 'INT'], quota: 4, priority: ['DEX', 'CON', 'INT', 'CHA', 'WIS', 'STR'],
      skills: ['Acrobatics', 'Athletics', 'Deception', 'Insight', 'Intimidation', 'Investigation', 'Perception', 'Performance', 'Persuasion', 'Sleight of Hand', 'Stealth'], kit: ['Rapier', 'Shortbow', "Thieves' tools", 'Dagger x2'] },
    Sorcerer: { hitDie: 6, saves: ['CON', 'CHA'], quota: 2, priority: ['CHA', 'CON', 'DEX', 'WIS', 'INT', 'STR'],
      skills: ['Arcana', 'Deception', 'Insight', 'Intimidation', 'Persuasion', 'Religion'], kit: ['Light crossbow', 'Arcane focus', 'Dagger x2'] },
    Warlock: { hitDie: 8, saves: ['WIS', 'CHA'], quota: 2, priority: ['CHA', 'CON', 'DEX', 'WIS', 'INT', 'STR'],
      skills: ['Arcana', 'Deception', 'History', 'Intimidation', 'Investigation', 'Nature', 'Religion'], kit: ['Light crossbow', 'Arcane focus', 'Dagger x2'] },
    Wizard: { hitDie: 6, saves: ['INT', 'WIS'], quota: 2, priority: ['INT', 'CON', 'DEX', 'WIS', 'CHA', 'STR'],
      skills: ['Arcana', 'History', 'Insight', 'Investigation', 'Medicine', 'Religion'], kit: ['Quarterstaff', 'Spellbook', 'Component pouch'] }
  };
  const CHARACTER_NAMES = ['Thalia', 'Brom', 'Kessa', 'Doran', 'Mirela', 'Fenn', 'Rurik', 'Sable', 'Tavish', 'Wren', 'Orin', 'Lyra'];
  const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  const abilityMod = score => Math.floor((score - 10) / 2);

  const raceSelect = document.getElementById('cc-race');
  const classSelect = document.getElementById('cc-class');
  const backgroundSelect = document.getElementById('cc-background');
  const skillsBox = document.getElementById('cc-skills-box');
  const skillsCount = document.getElementById('cc-skills-count');
  const levelInput = document.getElementById('cc-level');

  for (const [select, options] of [[raceSelect, RACES], [classSelect, Object.keys(CLASSES)], [backgroundSelect, BACKGROUNDS]]) {
    for (const o of options) select.add(new Option(o, o));
  }

  function skillQuota() { return CLASSES[classSelect.value]?.quota || 0; }
  function pickedSkills() { return [...skillsBox.querySelectorAll('input:checked')].map(i => i.value); }

  function updateSkillLimits() {
    const quota = skillQuota();
    const picked = pickedSkills().length;
    skillsCount.textContent = quota ? `(${picked}/${quota})` : '(pick a class first)';
    for (const box of skillsBox.querySelectorAll('input')) {
      box.disabled = !box.checked && picked >= quota;
    }
  }

  // Rebuilds the checkbox list for the chosen class — only that class's skills are offered, and
  // only as many as its quota allows can be ticked.
  function renderSkillChoices() {
    const cls = CLASSES[classSelect.value];
    skillsBox.innerHTML = '';
    for (const skill of cls?.skills || []) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = skill;
      box.addEventListener('change', updateSkillLimits);
      label.append(box, ` ${skill}`);
      skillsBox.append(label);
    }
    updateSkillLimits();
  }
  classSelect.addEventListener('change', renderSkillChoices);
  createCharForm.addEventListener('reset', () => setTimeout(renderSkillChoices, 0));

  const pick = list => list[Math.floor(Math.random() * list.length)];

  // A random but rules-legal character: standard array ordered by the class's priorities, HP from
  // the class hit die + CON, AC from DEX, and exactly the class's quota of skills.
  document.getElementById('cc-autofill').addEventListener('click', () => {
    const cls = pick(Object.keys(CLASSES));
    const data = CLASSES[cls];
    document.getElementById('cc-name').value = pick(CHARACTER_NAMES);
    raceSelect.value = pick(RACES);
    classSelect.value = cls;
    backgroundSelect.value = pick(BACKGROUNDS);
    levelInput.value = 1;

    const scores = {};
    [15, 14, 13, 12, 10, 8].forEach((score, i) => { scores[data.priority[i]] = score; });
    for (const key of ABILITY_KEYS) document.getElementById(`cc-${key.toLowerCase()}`).value = scores[key];
    document.getElementById('cc-hp').value = data.hitDie + abilityMod(scores.CON);
    document.getElementById('cc-ac').value = 10 + abilityMod(scores.DEX);
    document.getElementById('cc-equipment').value = data.kit.join(', ');

    renderSkillChoices();
    const shuffled = [...data.skills].sort(() => Math.random() - 0.5).slice(0, data.quota);
    for (const box of skillsBox.querySelectorAll('input')) box.checked = shuffled.includes(box.value);
    updateSkillLimits();
  });

  createCharForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('cc-name').value.trim() || playerName;
    const hpMax = parseInt(document.getElementById('cc-hp').value, 10) || 10;
    const level = parseInt(levelInput.value, 10) || 1;
    const sheet = {
      name,
      race: raceSelect.value,
      class: classSelect.value,
      level,
      background: backgroundSelect.value,
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
      proficiencyBonus: 2 + Math.floor((Math.min(Math.max(level, 1), 20) - 1) / 4),
      savingThrows: CLASSES[classSelect.value]?.saves || [],
      skills: pickedSkills().slice(0, skillQuota()),
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
      <button type="button" class="dnd-sheet-remove" title="Remove this character">✕</button>
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
    card.querySelector('.dnd-sheet-remove').addEventListener('click', async () => {
      if (!confirm(`Remove ${sheet.name || name}'s character sheet? This can't be undone.`)) return;
      await fetch(`${WORKER_ORIGIN}/api/room/${encodeURIComponent(roomCode)}/character/${encodeURIComponent(name)}`, { method: 'DELETE' });
    });
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
