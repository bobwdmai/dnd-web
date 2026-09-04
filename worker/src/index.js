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
    'access-control-allow-methods': 'GET, POST, OPTIONS',
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
          // creators are handed the same fresh code before either connects).
          await stub.fetch(`https://do/status?campaign=${encodeURIComponent(campaign)}`);
          return json(request, { code, campaign });
        }
      }
      return json(request, { error: 'Could not allocate a room code, try again.' }, 500);
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
