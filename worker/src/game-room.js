import { DurableObject } from 'cloudflare:workers';
import { takeTurn, formatCharacterSheet } from './dm.js';
import * as dice from './dice.js';

function freshState(campaign) {
  return {
    campaign: campaign || 'New Campaign',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    map: { lines: [], labels: [] },
    characters: {},
    history: []
  };
}

function errMsg(err) {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
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

  #ensureInitialized(campaign) {
    if (!this.state) {
      this.state = freshState(campaign);
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
      // A campaign param means "reserve this code": initialize the room now so a concurrent
      // create-room request sees it as taken instead of handing out the same fresh code twice.
      if (!wasInitialized && campaignParam) this.#ensureInitialized(campaignParam);
      return Response.json({ initialized: wasInitialized, campaign: this.state?.campaign || null });
    }

    if (url.pathname.endsWith('/character') && request.method === 'POST') {
      return this.#handleCharacterUpload(request);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade or a known API route', { status: 400 });
    }

    const campaign = url.searchParams.get('campaign') || undefined;
    this.#ensureInitialized(campaign);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async #handleCharacterUpload(request) {
    this.#ensureInitialized();
    try {
      const body = await request.json();
      const playerName = String(body.playerName || 'Adventurer').trim().slice(0, 40) || 'Adventurer';
      const text = String(body.text || '');
      if (!text.trim()) return Response.json({ ok: false, error: 'No text extracted from that PDF.' }, { status: 422 });

      const sheet = await formatCharacterSheet(this.env, text, playerName);
      this.state.characters[playerName] = sheet;
      this.#persist();
      this.#broadcast({ type: 'character-updated', playerName, sheet });
      return Response.json({ ok: true, sheet });
    } catch (err) {
      return Response.json({ ok: false, error: errMsg(err) }, { status: 500 });
    }
  }

  // -- WebSocket message handling (Hibernation API) ----------------------------------------

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    this.#ensureInitialized();

    if (msg.type === 'join') {
      const name = String(msg.name || 'Adventurer').trim().slice(0, 40) || 'Adventurer';
      ws.serializeAttachment({ name });
      this.#send(ws, { type: 'state', state: this.state });
      this.#broadcast({ type: 'players', list: this.#playerList() });
      return;
    }

    const attachment = ws.deserializeAttachment();
    const playerName = attachment?.name || 'Adventurer';

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
        const { narrative, rollResults, sfxRequests, mapOps, budgetExceeded } =
          await takeTurn(this.env, this.state, playerName, action);
        this.#persist();
        if (rollResults.length) this.#broadcast({ type: 'dice-rolled', rolls: rollResults });
        if (sfxRequests.length) this.#broadcast({ type: 'sfx-played', effects: sfxRequests });
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
