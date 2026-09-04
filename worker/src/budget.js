// Tracks total Workers AI neurons spent per calendar day (America/New_York, matching
// ClearSpeak's convention) in KV, so cost stays bounded regardless of traffic on this
// publicly-reachable, unauthenticated game.

const TIME_ZONE = 'America/New_York';
export const DAILY_NEURON_BUDGET = 8000; // leaves headroom under the 10,000/day free tier for other workers

function localDateKey(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Returns { used, limit, exceeded }. Read-only — does not spend anything. */
export async function getBudgetStatus(env) {
  const key = `budget:${localDateKey(new Date())}`;
  const used = Number((await env.ROOM_BUDGET.get(key)) || 0);
  return { used, limit: DAILY_NEURON_BUDGET, exceeded: used >= DAILY_NEURON_BUDGET };
}

/**
 * Record neurons spent (from a Workers AI response's usage.neurons) against today's budget.
 * Simple read-then-write counter, not atomic under concurrent requests — acceptable here:
 * worst case is a small overshoot on a personal-use, low-traffic budget cap, not a hard
 * billing boundary (mirrors ClearSpeak's worker).
 */
export async function spendNeurons(env, neurons) {
  if (!neurons || neurons <= 0) return;
  const key = `budget:${localDateKey(new Date())}`;
  const used = Number((await env.ROOM_BUDGET.get(key)) || 0);
  await env.ROOM_BUDGET.put(key, String(used + neurons), { expirationTtl: 172800 });
}
