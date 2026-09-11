// NdM, optional keep-highest/lowest (advantage/disadvantage: 2d20kh1 / 2d20kl1), optional flat modifier.
const FORMULA_RE = /^(\d*)d(\d+)(?:(kh|kl)(\d+))?([+-]\d+)?$/i;

/** Unbiased random integer in [1, sides] using rejection sampling over the Web Crypto API. */
function rollDie(sides) {
  const maxUint32 = 0xffffffff;
  const limit = maxUint32 - (maxUint32 % sides);
  let x;
  do {
    x = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (x >= limit);
  return (x % sides) + 1;
}

function parseFormula(formula) {
  // Models often write formulas with spaces around operators (e.g. "1d20 + 5") even when told
  // not to — strip all whitespace rather than reject a perfectly clear formula outright.
  const m = String(formula).replace(/\s+/g, '').match(FORMULA_RE);
  if (!m) return null;

  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  const keepType = m[3] ? m[3].toLowerCase() : null;
  const keepCount = m[4] ? parseInt(m[4], 10) : null;
  const modifier = m[5] ? parseInt(m[5], 10) : 0;

  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
  if (keepCount !== null && (keepCount < 1 || keepCount > count)) return null;

  return { count, sides, keepType, keepCount, modifier };
}

/** Roll a dice formula like "1d20+5", "2d6", or "2d20kh1+3" (advantage). Uses real randomness. */
export function roll(formula) {
  const parsed = parseFormula(formula);
  if (!parsed) throw new Error(`Invalid dice formula: "${formula}"`);
  const { count, sides, keepType, keepCount, modifier } = parsed;

  const rolls = Array.from({ length: count }, () => rollDie(sides));
  let kept = rolls;
  if (keepType && keepCount) {
    const sorted = [...rolls].sort((a, b) => (keepType === 'kh' ? b - a : a - b));
    kept = sorted.slice(0, keepCount);
  }

  const sum = kept.reduce((a, b) => a + b, 0);
  const total = sum + modifier;

  const rollsLabel = keepType
    ? `[${rolls.join(', ')}] keep ${keepType === 'kh' ? 'highest' : 'lowest'} ${keepCount}`
    : `[${rolls.join(', ')}]`;
  const modLabel = modifier ? (modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`) : '';
  const breakdown = `${rollsLabel}${modLabel} = ${total}`;

  return { formula, rolls, kept, modifier, total, breakdown };
}
