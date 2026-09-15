// Firebase identity verification, shared between the HTTP router (index.js) and the Durable
// Object (game-room.js, for the WebSocket 'join' message). This app's own dedicated Firebase
// project, using the same reservation scheme originally built for KnightAuraChess: a
// `usernames` collection reserves each name to one uid, and `users/{uid}` is publicly readable,
// so a signed-in player's username can be trusted here without ever letting them just claim
// any name they type over the wire.

const idTokenCache = new Map(); // idToken -> { uid, expiresAt }
const AUTH_CACHE_MAX_MS = 30 * 60 * 1000;
const TOKEN_CLOCK_SKEW_SEC = 60;

function decodeJwtPayload(idToken) {
  const [, payload] = idToken.split('.');
  if (!payload) return null;
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  try { return JSON.parse(atob(padded)); } catch { return null; }
}

/** Verifies a Firebase ID token by asking Google to check its signature (accounts:lookup) —
 *  no JWKS/service-account machinery needed, matching the pattern already proven out in
 *  KnightAuraChess's functions/api/move.js. Returns the verified uid. */
export async function verifyFirebaseIdToken(idToken, env) {
  const claims = decodeJwtPayload(idToken);
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims?.exp && nowSec > Number(claims.exp) + TOKEN_CLOCK_SKEW_SEC) {
    throw new Error('Token expired');
  }

  const cached = idTokenCache.get(idToken);
  if (cached && cached.expiresAt > Date.now()) return cached.uid;

  const apiKey = env.FIREBASE_WEB_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_WEB_API_KEY is not configured');
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.users) || !data.users[0]?.localId) {
    throw new Error('Invalid ID token');
  }
  const uid = data.users[0].localId;
  const jwtExpMs = claims?.exp ? Number(claims.exp) * 1000 : Date.now() + AUTH_CACHE_MAX_MS;
  const expiresAt = Math.min(jwtExpMs - TOKEN_CLOCK_SKEW_SEC * 1000, Date.now() + AUTH_CACHE_MAX_MS);
  idTokenCache.set(idToken, { uid, expiresAt });
  return uid;
}

/** users/{uid} is publicly readable per this project's Firestore rules, so this is a plain
 *  unauthenticated REST GET — no service-account OAuth token needed. */
export async function fetchReservedUsername(uid, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`
  );
  if (!res.ok) return null;
  const doc = await res.json();
  return doc?.fields?.displayName?.stringValue || null;
}

/** Verifies an ID token and resolves the caller's reserved username in one step. Returns null
 *  on any failure (missing/invalid token, no reserved username yet) — callers decide whether
 *  that's an error or an acceptable anonymous fallback. */
export async function resolveVerifiedUsername(idToken, env) {
  if (!idToken) return null;
  try {
    const uid = await verifyFirebaseIdToken(idToken, env);
    return await fetchReservedUsername(uid, env);
  } catch {
    return null;
  }
}
