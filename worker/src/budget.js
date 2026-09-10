// Tracks total Workers AI neurons spent per calendar day (America/New_York, matching
// ClearSpeak's convention) in KV, so cost stays bounded regardless of traffic on this
// publicly-reachable, unauthenticated game.

const TIME_ZONE = 'America/New_York';
const WEEKDAY_BUDGET = 8000; // Mon-Fri
const WEEKEND_BUDGET = 1000; // Sat-Sun

function localDateKey(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Mon-Fri get the higher weekday budget; Sat/Sun drop to the weekend budget. */
function dailyBudgetLimit(date) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(date);
  return (weekday === 'Sat' || weekday === 'Sun') ? WEEKEND_BUDGET : WEEKDAY_BUDGET;
}

/** Returns { used, limit, exceeded }. Read-only — does not spend anything. */
export async function getBudgetStatus(env) {
  const now = new Date();
  const key = `budget:${localDateKey(now)}`;
  const limit = dailyBudgetLimit(now);
  const used = Number((await env.ROOM_BUDGET.get(key)) || 0);
  return { used, limit, exceeded: used >= limit };
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
