export { GameRoom } from './game-room.js';

const ALLOWED_ORIGINS = new Set([
  'https://bob-mai.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
]);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, avoids look-alikes

function generateRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const headers = {
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...corsHeaders(request) } });
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Admin routes (room stats, room deletion) are gated by a secret set via `wrangler secret put
 *  ADMIN_SECRET`, kept only in a local gitignored file — never public, never in git. */
function isAdmin(request, env) {
  const provided = request.headers.get('x-admin-secret') || '';
  return !!env.ADMIN_SECRET && provided === env.ADMIN_SECRET;
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error('Unhandled error', err instanceof Error ? err.stack : String(err));
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500, headers: { 'content-type': 'application/json', ...corsHeaders(request) }
      });
    }
  }
};

async function handle(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // POST /api/create-room { campaign } -> { code }
    if (url.pathname === '/api/create-room' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* empty body is fine */ }
      const campaign = String(body.campaign || 'New Campaign').slice(0, 80);

      // Vanishingly unlikely to collide (32^6 codes), but check anyway and retry a couple times.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateRoomCode();
        const stub = env.GAME_ROOM.getByName(code);
        const status = await stub.fetch('https://do/status').then(r => r.json());
        if (!status.initialized) {
          // Touch the room so it's marked initialized immediately (avoids a race where two
          // creators are handed the same fresh code before either connects), and tell it its
          // own code so it can update the room registry when it ends.
          await stub.fetch(`https://do/status?campaign=${encodeURIComponent(campaign)}&code=${code}`);
          const createdAt = new Date().toISOString();
          await env.ROOM_REGISTRY.put(`room:${code}`, '', { metadata: { campaign, createdAt, ended: false } });
          return json(request, { code, campaign });
        }
      }
      return json(request, { error: 'Could not allocate a room code, try again.' }, 500);
    }

    // -- Admin routes: secret-gated, used only by the local admin script -------------------

    if (url.pathname === '/api/admin/rooms' && request.method === 'GET') {
      if (!isAdmin(request, env)) return json(request, { error: 'Unauthorized' }, 401);
      const list = await env.ROOM_REGISTRY.list({ prefix: 'room:' });
      const rooms = list.keys.map(k => ({ code: k.name.slice(5), ...k.metadata }));
      const live = rooms.filter(r => !r.ended);
      return json(request, {
        totalCreated: rooms.length,
        live: live.length,
        ended: rooms.length - live.length,
        liveRooms: live
      });
    }

    const adminDeleteMatch = url.pathname.match(/^\/api\/admin\/room\/([A-Za-z0-9]+)$/);
    if (adminDeleteMatch && request.method === 'DELETE') {
      if (!isAdmin(request, env)) return json(request, { error: 'Unauthorized' }, 401);
      const code = normalizeCode(adminDeleteMatch[1]);
      const stub = env.GAME_ROOM.getByName(code);
      const doResponse = await stub.fetch('https://do/delete', { method: 'DELETE' });
      const data = await doResponse.json();
      await env.ROOM_REGISTRY.delete(`room:${code}`); // belt-and-suspenders in case the DO never registered
      return json(request, data, doResponse.status);
    }

    // GET /api/room/:code/status -> whether a room exists (used before joining)
    const statusMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)\/status$/);
    if (statusMatch && request.method === 'GET') {
      const code = normalizeCode(statusMatch[1]);
      const stub = env.GAME_ROOM.getByName(code);
      const status = await stub.fetch('https://do/status').then(r => r.json());
      return json(request, status);
    }

    // POST /api/room/:code/character { playerName, text } -> AI-formatted character sheet
    const charMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)\/character$/);
    if (charMatch && request.method === 'POST') {
      const code = normalizeCode(charMatch[1]);
      const stub = env.GAME_ROOM.getByName(code);
      const doRequest = new Request('https://do/character', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request.body
      });
      const doResponse = await stub.fetch(doRequest);
      const data = await doResponse.json();
      return json(request, data, doResponse.status);
    }

    // POST /api/room/:code/character/create { playerName, sheet } -> a manually-built character sheet
    const charCreateMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)\/character\/create$/);
    if (charCreateMatch && request.method === 'POST') {
      const code = normalizeCode(charCreateMatch[1]);
      const stub = env.GAME_ROOM.getByName(code);
      const doRequest = new Request('https://do/character/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request.body
      });
      const doResponse = await stub.fetch(doRequest);
      const data = await doResponse.json();
      return json(request, data, doResponse.status);
    }

    // DELETE /api/room/:code/character/:playerName -> remove one character sheet
    const charDeleteMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)\/character\/([^/]+)$/);
    if (charDeleteMatch && request.method === 'DELETE') {
      const code = normalizeCode(charDeleteMatch[1]);
      const stub = env.GAME_ROOM.getByName(code);
      const doResponse = await stub.fetch(`https://do/character/${charDeleteMatch[2]}`, { method: 'DELETE' });
      const data = await doResponse.json();
      return json(request, data, doResponse.status);
    }

    // GET /api/room/:code (WebSocket upgrade) -> forward to the room's Durable Object
    const roomMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)$/);
    if (roomMatch) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json(request, { error: 'This endpoint only accepts WebSocket connections.' }, 400);
      }
      const code = normalizeCode(roomMatch[1]);
      const stub = env.GAME_ROOM.getByName(code);
      return stub.fetch(request);
    }

  return json(request, { error: 'Not found' }, 404);
}
