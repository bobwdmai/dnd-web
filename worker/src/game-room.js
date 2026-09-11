import { DurableObject } from 'cloudflare:workers';
import { takeTurn, formatCharacterSheet, findCharacterName } from './dm.js';
import * as dice from './dice.js';

/** Case/whitespace-insensitive identity check — "Bob" and "bob" are the same player. */
function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function freshState(campaign, roomCode) {
  return {
    campaign: campaign || 'New Campaign',
    roomCode: roomCode || null, // so this room can update its own entry in the room registry
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerName: null, // set to whoever first joins; only they may end the game
    ended: false,
    endedAt: null,
    map: { lines: [], labels: [] },
    characters: {},
    history: []
  };
}

function errMsg(err) {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

function str(v, max) { return String(v ?? '').trim().slice(0, max); }
function num(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function strList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string' && x.trim()).slice(0, maxItems).map(x => str(x, maxLen));
}

/** Validates and clamps a manually-submitted character sheet — this endpoint is public and
 *  unauthenticated, so never trust shapes or sizes from the client. */
function sanitizeSheet(raw, playerName) {
  const ab = raw?.abilityScores || {};
  const hpMax = num(raw?.hp?.max, 1, 999, 10);
  return {
    name: str(raw?.name, 40) || playerName,
    race: str(raw?.race, 40),
    class: str(raw?.class, 40),
    level: num(raw?.level, 1, 20, 1),
    background: str(raw?.background, 60),
    alignment: str(raw?.alignment, 30),
    abilityScores: {
      STR: num(ab.STR, 1, 30, 10), DEX: num(ab.DEX, 1, 30, 10), CON: num(ab.CON, 1, 30, 10),
      INT: num(ab.INT, 1, 30, 10), WIS: num(ab.WIS, 1, 30, 10), CHA: num(ab.CHA, 1, 30, 10)
    },
    hp: { current: num(raw?.hp?.current, 0, hpMax, hpMax), max: hpMax },
    armorClass: num(raw?.armorClass, 1, 40, 10),
    speed: num(raw?.speed, 0, 200, 30),
    proficiencyBonus: num(raw?.proficiencyBonus, 0, 10, 2),
    savingThrows: strList(raw?.savingThrows, 20, 30),
    skills: strList(raw?.skills, 30, 40),
    equipment: strList(raw?.equipment, 40, 60),
    features: strList(raw?.features, 30, 80),
    spells: strList(raw?.spells, 40, 60),
    notes: str(raw?.notes, 1000)
  };
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null; // loaded lazily on first use (see #ensureLoaded)

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      const row = this.ctx.storage.sql.exec('SELECT state_json FROM room WHERE id = 1').toArray()[0];
      this.state = row ? JSON.parse(row.state_json) : null;
    });
  }

  #persist() {
    this.state.updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO room (id, state_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      JSON.stringify(this.state), this.state.updatedAt
    );
  }

  /** Update this room's entry in the KV registry (used by the local-only admin script). */
  async #updateRegistry(patch) {
    if (!this.state?.roomCode) return;
    await this.env.ROOM_REGISTRY.put(`room:${this.state.roomCode}`, '', {
      metadata: { campaign: this.state.campaign, createdAt: this.state.createdAt, ended: false, ...patch }
    });
  }

  #ensureInitialized(campaign, roomCode) {
    if (!this.state) {
      this.state = freshState(campaign, roomCode);
      this.#persist();
    }
  }

  #broadcast(payload, exceptWs) {
    const json = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exceptWs) {
        try { ws.send(json); } catch { /* socket may be closing; ignore */ }
      }
    }
  }

  #send(ws, payload) {
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }

  #playerList() {
    const names = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.name) names.push(attachment.name);
    }
    return names;
  }

  // -- HTTP entry point: WebSocket upgrade, character upload, status check -----------------

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/status')) {
      const wasInitialized = !!this.state;
      const campaignParam = url.searchParams.get('campaign');
      const codeParam = url.searchParams.get('code');
      // A campaign param means "reserve this code": initialize the room now so a concurrent
      // create-room request sees it as taken instead of handing out the same fresh code twice.
      if (!wasInitialized && campaignParam) this.#ensureInitialized(campaignParam, codeParam);
      return Response.json({
        initialized: wasInitialized,
        campaign: this.state?.campaign || null,
        ended: !!this.state?.ended
      });
    }

    if (url.pathname.endsWith('/delete') && request.method === 'DELETE') {
      const roomCode = this.state?.roomCode;
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(1000, 'Room deleted'); } catch { /* already closing */ }
      }
      await this.ctx.storage.deleteAll();
      this.state = null;
      if (roomCode) await this.env.ROOM_REGISTRY.delete(`room:${roomCode}`);
      return Response.json({ ok: true, deleted: roomCode || null });
    }

    if (url.pathname.endsWith('/character/create') && request.method === 'POST') {
      return this.#handleCharacterCreate(request);
    }

    if (url.pathname.endsWith('/character') && request.method === 'POST') {
      return this.#handleCharacterUpload(request);
    }

    const deleteMatch = url.pathname.match(/^\/character\/(.+)$/);
    if (deleteMatch && request.method === 'DELETE') {
      return this.#handleCharacterDelete(decodeURIComponent(deleteMatch[1]));
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade or a known API route', { status: 400 });
    }

    if (this.state?.ended) {
      return Response.json({ error: 'This game has already ended.' }, { status: 410 });
    }

    const campaign = url.searchParams.get('campaign') || undefined;
    this.#ensureInitialized(campaign);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Build a character sheet directly from form fields — no AI call, no PDF needed. */
  async #handleCharacterCreate(request) {
    this.#ensureInitialized();
    try {
      const body = await request.json();
      const playerName = str(body.playerName, 40) || 'Adventurer';
      const sheet = sanitizeSheet(body.sheet, playerName);
      // Reuse an existing character stored under a differently-cased/spaced version of this
      // name (e.g. "Bob" vs "bob" on reconnect) instead of creating a stray duplicate.
      const key = findCharacterName(this.state.characters, playerName) || playerName;
      this.state.characters[key] = sheet;
      this.#persist();
      this.#broadcast({ type: 'character-updated', playerName: key, sheet });
      return Response.json({ ok: true, sheet });
    } catch (err) {
      return Response.json({ ok: false, error: errMsg(err) }, { status: 500 });
    }
  }

  async #handleCharacterUpload(request) {
    this.#ensureInitialized();
    try {
      const body = await request.json();
      const playerName = String(body.playerName || 'Adventurer').trim().slice(0, 40) || 'Adventurer';
      const text = String(body.text || '');
      if (!text.trim()) return Response.json({ ok: false, error: 'No text extracted from that PDF.' }, { status: 422 });

      // Same bounds-checking as the manual-creation path — the AI's JSON is a plausible D&D
      // sheet almost always, but nothing stops a bad response from carrying a 0 max HP or an
      // out-of-range ability score straight into persisted state without this.
      const sheet = sanitizeSheet(await formatCharacterSheet(this.env, text, playerName), playerName);
      // Reuse an existing character stored under a differently-cased/spaced version of this
      // name (e.g. "Bob" vs "bob" on reconnect) instead of creating a stray duplicate.
      const key = findCharacterName(this.state.characters, playerName) || playerName;
      this.state.characters[key] = sheet;
      this.#persist();
      this.#broadcast({ type: 'character-updated', playerName: key, sheet });
      return Response.json({ ok: true, sheet });
    } catch (err) {
      return Response.json({ ok: false, error: errMsg(err) }, { status: 500 });
    }
  }

  /** Remove a character sheet (case-insensitive name match) — anyone in the room can do this,
   *  same trust model as the rest of this unauthenticated demo. */
  #handleCharacterDelete(rawName) {
    this.#ensureInitialized();
    const key = findCharacterName(this.state.characters, rawName);
    if (!key) return Response.json({ ok: false, error: `No character named "${rawName}"` }, { status: 404 });
    delete this.state.characters[key];
    this.#persist();
    this.#broadcast({ type: 'character-removed', playerName: key });
    return Response.json({ ok: true });
  }

  // -- WebSocket message handling (Hibernation API) ----------------------------------------

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    this.#ensureInitialized();

    if (this.state.ended) {
      this.#send(ws, { type: 'error', error: 'This game has ended.' });
      return;
    }

    if (msg.type === 'join') {
      const name = String(msg.name || 'Adventurer').trim().slice(0, 40) || 'Adventurer';
      ws.serializeAttachment({ name });
      if (!this.state.ownerName) {
        this.state.ownerName = name; // first to join created the game and owns it
        this.#persist();
      } else if (sameName(name, this.state.ownerName) && name !== this.state.ownerName) {
        // Same player reconnecting with different capitalization/whitespace than last time —
        // keep recognizing them as owner rather than silently losing that status.
        this.state.ownerName = name;
        this.#persist();
      }
      this.#send(ws, { type: 'state', state: this.state });
      this.#broadcast({ type: 'players', list: this.#playerList() });
      return;
    }

    const attachment = ws.deserializeAttachment();
    const playerName = attachment?.name || 'Adventurer';

    if (msg.type === 'end-game') {
      if (!sameName(playerName, this.state.ownerName)) {
        this.#send(ws, { type: 'error', error: 'Only the game owner can end the game.' });
        return;
      }
      this.state.ended = true;
      this.state.endedAt = new Date().toISOString();
      this.#persist();
      await this.#updateRegistry({ ended: true, endedAt: this.state.endedAt });
      this.#broadcast({ type: 'game-ended', endedBy: playerName });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(1000, 'Game ended'); } catch { /* already closing */ }
      }
      return;
    }

    if (msg.type === 'chat') {
      const action = String(msg.text || '').trim().slice(0, 2000);
      if (!action) return;

      const rollMatch = action.match(/^\/roll\s+(.+)$/i);
      if (rollMatch) {
        try {
          const result = dice.roll(rollMatch[1].trim());
          const entry = { label: `${playerName}'s roll`, ...result };
          this.state.history.push({
            role: 'roll', name: 'Dice', content: `${entry.label}: ${entry.breakdown}`,
            results: [entry], ts: new Date().toISOString()
          });
          this.#persist();
          this.#broadcast({ type: 'dice-rolled', rolls: [entry] });
        } catch (err) {
          this.#send(ws, { type: 'error', error: errMsg(err) });
        }
        return;
      }

      this.#broadcast({ type: 'player-said', name: playerName, text: action });

      try {
        const { narrative, rollResults, sfxRequests, mapOps, characterUpdates, budgetExceeded } =
          await takeTurn(this.env, this.state, playerName, action);
        this.#persist();
        if (rollResults.length) this.#broadcast({ type: 'dice-rolled', rolls: rollResults });
        if (sfxRequests.length) this.#broadcast({ type: 'sfx-played', effects: sfxRequests });
        for (const name of characterUpdates) {
          this.#broadcast({ type: 'character-updated', playerName: name, sheet: this.state.characters[name] });
        }
        this.#broadcast({ type: 'dm-said', text: narrative, budgetExceeded });
        if (mapOps.length) this.#broadcast({ type: 'map-ops', ops: mapOps });
      } catch (err) {
        this.#broadcast({ type: 'error', error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'map-draw') {
      const line = msg.line;
      if (typeof line?.x1 === 'number' && typeof line?.y1 === 'number' && typeof line?.x2 === 'number' && typeof line?.y2 === 'number') {
        const entry = { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2, color: line.color || '#e8e2d0', note: line.note || '' };
        this.state.map.lines.push(entry);
        this.#persist();
        this.#broadcast({ type: 'map-ops', ops: [{ type: 'line', ...entry }] });
      }
      return;
    }

    if (msg.type === 'map-clear') {
      this.state.map.lines = [];
      this.state.map.labels = [];
      this.#persist();
      this.#broadcast({ type: 'map-ops', ops: [{ type: 'clear' }] });
      return;
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already closing */ }
    this.#broadcast({ type: 'players', list: this.#playerList() }, ws);
  }

  async webSocketError() {
    // Hibernation API surfaces transport errors here; nothing room-specific to clean up —
    // storage already holds the source of truth, and webSocketClose will follow.
  }
}
