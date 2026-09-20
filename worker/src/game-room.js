import { DurableObject } from 'cloudflare:workers';
import { takeTurn, formatCharacterSheet, findCharacterName } from './dm.js';
import { resolveVerifiedUsername } from './firebase-auth.js';
import { newAdventure, newCombat } from './adventure.js';
import * as dice from './dice.js';

/** Case/whitespace-insensitive identity check — "Bob" and "bob" are the same player. */
function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function freshState(campaign, roomCode, ephemeral) {
  return {
    campaign: campaign || 'New Campaign',
    roomCode: roomCode || null, // so this room can update its own entry in the room registry
    ephemeral: !!ephemeral, // solo/anonymous games: never written to storage, never registered
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerName: null, // set to whoever first joins; only they may end the game
    ended: false,
    endedAt: null,
    map: { lines: [], labels: [] },
    characters: {},
    history: [],
    adventure: newAdventure(),
    combat: newCombat()
  };
}

const OPENING_INSTRUCTION =
  '[The adventure begins. Open with a vivid opening scene built from the Adventure premise and the ' +
  'current chapter in your context: place the party in the scene, introduce the hook, and end by giving ' +
  'them a clear first choice or question. Do not ask them to describe themselves or their characters.]';

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
  #turnQueue = Promise.resolve(); // serializes takeTurn() calls (see #handleChat)

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
    if (this.state.ephemeral) return; // solo/anonymous games are never written to storage
    this.state.updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO room (id, state_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      JSON.stringify(this.state), this.state.updatedAt
    );
  }

  /** Update this room's entry in the KV registry (used by the local-only admin script). */
  async #updateRegistry(patch) {
    if (!this.state?.roomCode || this.state.ephemeral) return;
    await this.env.ROOM_REGISTRY.put(`room:${this.state.roomCode}`, '', {
      metadata: { campaign: this.state.campaign, createdAt: this.state.createdAt, ended: false, ...patch }
    });
  }

  #ensureInitialized(campaign, roomCode, ephemeral) {
    if (!this.state) {
      this.state = freshState(campaign, roomCode, ephemeral);
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

  /** Send to every socket currently attached to the given player name (usually one, but a
   *  player could have more than one tab open) — used to keep character sheets private instead
   *  of broadcasting stats to the whole room. */
  #sendToPlayer(name, payload) {
    const json = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.name && sameName(attachment.name, name)) {
        try { ws.send(json); } catch { /* socket may be closing; ignore */ }
      }
    }
  }

  /** The party list and narration are shared, but stat blocks are private — each player only
   *  ever receives their own character sheet, never anyone else's. */
  #ownCharacterView(playerName) {
    const key = findCharacterName(this.state.characters, playerName);
    return key ? { [key]: this.state.characters[key] } : {};
  }

  /** Rooms created before adventures/combat existed get them on next contact. An old room that
   *  already has story keeps its history and skips the opening scene. */
  #ensureStructure() {
    let changed = false;
    if (!this.state.adventure) {
      this.state.adventure = newAdventure();
      this.state.adventure.opened = this.state.history.length > 0;
      changed = true;
    }
    if (!this.state.combat) { this.state.combat = newCombat(); changed = true; }
    if (changed) this.#persist();
  }

  #sendStateTo(ws, name) {
    this.#send(ws, { type: 'state', state: { ...this.state, characters: this.#ownCharacterView(name) } });
  }

  /** Runs one DM turn behind the queue (see below) and broadcasts everything it produced. */
  #queueTurn(playerName, action, opts) {
    // Two chat messages sent close together can both reach the room before either finishes — the
    // Durable Object doesn't serialize async work across events, so without this two takeTurn()
    // calls would run concurrently against the same mutable this.state (e.g. both reading a
    // character's HP before either writes back a change, silently dropping one of the updates).
    // Chaining onto a queue forces turns to run one at a time, in the order they arrived.
    this.#turnQueue = this.#turnQueue.then(async () => {
      try {
        const { narrative, rollResults, sfxRequests, mapOps, characterUpdates, structureChanged, budgetExceeded } =
          await takeTurn(this.env, this.state, playerName, action, opts);
        // A failed opening (AI error, quota) must not leave the room with a broken first message
        // and no way to retry — undo it so the next join tries the opening scene again.
        if (opts?.opening && (budgetExceeded || /^\(The DM (stumbled|got tangled|pauses|is resting)/.test(narrative))) {
          this.state.history = [];
          this.state.adventure.opened = false;
          this.#persist();
          this.#broadcast({ type: 'error', error: "The DM couldn't open the scene just now — it will try again when someone rejoins." });
          return;
        }
        this.#persist();
        if (rollResults.length) this.#broadcast({ type: 'dice-rolled', rolls: rollResults });
        if (sfxRequests.length) this.#broadcast({ type: 'sfx-played', effects: sfxRequests });
        for (const name of characterUpdates) {
          this.#sendToPlayer(name, { type: 'character-updated', playerName: name, sheet: this.state.characters[name] });
        }
        if (structureChanged) this.#broadcast({ type: 'structure', adventure: this.state.adventure, combat: this.state.combat });
        this.#broadcast({ type: 'dm-said', text: narrative, budgetExceeded });
        if (mapOps.length) this.#broadcast({ type: 'map-ops', ops: mapOps });
      } catch (err) {
        this.#broadcast({ type: 'error', error: errMsg(err) });
      }
    });
    return this.#turnQueue;
  }

  /** A fresh room's first visitor gets the opening scene instead of a blank log. */
  #maybeOpen() {
    const adv = this.state.adventure;
    if (adv.status !== 'active' || adv.opened || this.state.history.length > 0) return;
    adv.opened = true; // set before queueing so two near-simultaneous joins can't both open
    this.#persist();
    this.#queueTurn('', OPENING_INSTRUCTION, { opening: true });
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
      const ephemeralParam = url.searchParams.get('ephemeral') === '1';
      // A campaign param means "reserve this code": initialize the room now so a concurrent
      // create-room request sees it as taken instead of handing out the same fresh code twice.
      if (!wasInitialized && campaignParam) this.#ensureInitialized(campaignParam, codeParam, ephemeralParam);
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
      // The form enforces a per-class skill quota (max 4, a Rogue's); this stops a hand-built
      // request from claiming more than any class could ever pick.
      sheet.skills = sheet.skills.slice(0, 4);
      // Reuse an existing character stored under a differently-cased/spaced version of this
      // name (e.g. "Bob" vs "bob" on reconnect) instead of creating a stray duplicate.
      const key = findCharacterName(this.state.characters, playerName) || playerName;
      this.state.characters[key] = sheet;
      this.#persist();
      this.#sendToPlayer(key, { type: 'character-updated', playerName: key, sheet });
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
      this.#sendToPlayer(key, { type: 'character-updated', playerName: key, sheet });
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
      // A verified username (from a signed-in account) always wins over whatever free-text
      // name the client sent — this is what actually makes impersonation impossible, since the
      // client can't forge who a valid ID token belongs to. Anonymous joins (no token) keep
      // today's free-text behavior, except the Global Game, which requires a verified identity.
      const verifiedName = await resolveVerifiedUsername(msg.idToken, this.env);
      if (this.state.roomCode === 'GLOBAL' && !verifiedName && !this.env.LOCAL_MODE) {
        this.#send(ws, { type: 'error', error: 'Sign in to join the Global Game.' });
        return;
      }
      const name = verifiedName || (String(msg.name || 'Adventurer').trim().slice(0, 40) || 'Adventurer');
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
      this.#ensureStructure();
      this.#sendStateTo(ws, name);
      this.#broadcast({ type: 'players', list: this.#playerList() });
      this.#maybeOpen();
      return;
    }

    const attachment = ws.deserializeAttachment();
    const playerName = attachment?.name || 'Adventurer';

    if (msg.type === 'end-game') {
      if (this.state.roomCode === 'GLOBAL') {
        this.#send(ws, { type: 'error', error: 'The global game is shared and can\'t be ended.' });
        return;
      }
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

      this.#ensureStructure();
      if (this.state.adventure.status !== 'active') {
        this.#send(ws, { type: 'error', error: 'This adventure is over — begin a new adventure to keep playing.' });
        return;
      }

      this.#broadcast({ type: 'player-said', name: playerName, text: action });

      await this.#queueTurn(playerName, action);
      return;
    }

    if (msg.type === 'new-adventure') {
      this.#ensureStructure();
      if (this.state.adventure.status === 'active') {
        this.#send(ws, { type: 'error', error: 'The current adventure is still going.' });
        return;
      }
      // The Global Game has no owner to speak for it, so anyone in it may start the next
      // adventure once the last one is over; a private room leaves that to its owner.
      if (this.state.roomCode !== 'GLOBAL' && !sameName(playerName, this.state.ownerName)) {
        this.#send(ws, { type: 'error', error: 'Only the game owner can begin a new adventure.' });
        return;
      }
      this.state.adventure = newAdventure(this.state.adventure.id);
      this.state.combat = newCombat();
      this.state.history = [];
      this.state.map = { lines: [], labels: [] };
      // Characters carry over, fully healed for the fresh start.
      for (const sheet of Object.values(this.state.characters)) {
        if (sheet?.hp) sheet.hp.current = sheet.hp.max;
      }
      this.#persist();
      for (const socket of this.ctx.getWebSockets()) {
        const who = socket.deserializeAttachment()?.name;
        if (who) this.#sendStateTo(socket, who);
      }
      this.#maybeOpen();
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
