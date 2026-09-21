// Background-music mood, chosen by the server from what's actually happening so every player
// hears the same score. Combat state wins; otherwise the latest narration's vocabulary decides.
export const MOODS = ['calm', 'mystery', 'tense', 'battle', 'tavern', 'victory', 'sorrow', 'eerie'];

const RULES = [
  ['victory', /\b(victor(y|ious)|triumph|celebrat\w*|cheer\w*|feast|reward|saved the (village|day)|quest complete|the end)\b/i],
  ['tavern', /\b(tavern|inn|ale|mug|bard plays|fireside|hearth|innkeeper|merchant|market)\b/i],
  ['sorrow', /\b(funeral|grave|mourn\w*|weep\w*|grief|tears|dies|dead body|lament|farewell)\b/i],
  ['eerie', /\b(ghost\w*|spectr\w*|haunt\w*|whisper\w*|undead|skeleton\w*|wail\w*|crypt|tomb|curse[ds]?|ritual|shadowy)\b/i],
  ['tense', /\b(trap|ambush|creeps?|stalk\w*|sneak\w*|sudden(ly)?|rumbl\w*|tremor\w*|collapse|danger\w*|watching|hidden|lurk\w*)\b/i],
  ['mystery', /\b(rune\w*|glyph\w*|ancient|hum(ming)?|glow(ing|s)?|arcane|magic\w*|mist|cavern|corridor|passage|dungeon|ruins?)\b/i]
];

export function detectMood(state, narrative) {
  if (state.combat?.active) return 'battle';
  const text = String(narrative || '');
  let best = null, bestHits = 0;
  for (const [mood, re] of RULES) {
    const hits = (text.match(new RegExp(re.source, 'gi')) || []).length;
    if (hits > bestHits) { best = mood; bestHits = hits; }
  }
  return best || state.music || 'calm';
}
