// 5e spell-slot tables and helpers. Slots live on the sheet as { max: {"1": 2, ...}, used: {"1": 1} }.
const FULL = [
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]
];
const FULL_CASTERS = ['bard', 'cleric', 'druid', 'sorcerer', 'wizard'];
const HALF_CASTERS = ['paladin', 'ranger'];

export function maxSlots(cls, level) {
  const c = String(cls || '').trim().toLowerCase();
  const lvl = Math.min(Math.max(Math.round(level) || 1, 1), 20);
  let row = [];
  if (FULL_CASTERS.includes(c)) row = FULL[lvl - 1];
  else if (HALF_CASTERS.includes(c)) row = lvl >= 2 ? FULL[Math.ceil(lvl / 2) - 1] : [];
  else if (c === 'warlock') { // pact magic: a few slots, all of the same (highest) level
    const count = lvl >= 17 ? 4 : lvl >= 11 ? 3 : lvl >= 2 ? 2 : 1;
    const slotLevel = Math.min(5, Math.ceil(lvl / 2));
    const out = {}; out[slotLevel] = count; return out;
  }
  const out = {};
  row.forEach((n, i) => { if (n) out[i + 1] = n; });
  return out;
}

/** Makes sure the sheet has a consistent slots object for its class and level (keeps what's been used). */
export function ensureSlots(sheet) {
  const max = maxSlots(sheet.class, sheet.level);
  const used = {};
  for (const [lvl, n] of Object.entries(max)) used[lvl] = Math.min(Math.max(Math.round(sheet.slots?.used?.[lvl]) || 0, 0), n);
  sheet.slots = { max, used };
  return sheet.slots;
}

export function slotsSummary(sheet) {
  const { max, used } = ensureSlots(sheet);
  const parts = Object.keys(max).map(l => `level ${l}: ${max[l] - (used[l] || 0)}/${max[l]} left`);
  return parts.length ? parts.join(', ') : 'none (no spellcasting slots)';
}

/** Spends one slot of `level`, or the lowest higher slot if that level is used up. */
export function spendSlot(sheet, level) {
  const slots = ensureSlots(sheet);
  for (let l = Math.max(1, Math.round(level) || 1); l <= 9; l++) {
    if (slots.max[l] && (slots.used[l] || 0) < slots.max[l]) {
      slots.used[l] = (slots.used[l] || 0) + 1;
      return { spentLevel: l, remaining: slotsSummary(sheet) };
    }
  }
  return { error: `No spell slots left of level ${level} or higher: the spell cannot be cast. Slots now: ${slotsSummary(sheet)}.` };
}

export function restoreSlots(sheet) {
  const slots = ensureSlots(sheet);
  slots.used = {};
  for (const l of Object.keys(slots.max)) slots.used[l] = 0;
}
