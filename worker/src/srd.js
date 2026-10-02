// Rules data from the 5e System Reference Document 5.1 (c) Wizards of the Coast LLC, licensed under
// CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/). Spell entries are condensed from the SRD text.
import spellData from './srd-spells.json';

const byLower = new Map(Object.entries(spellData).map(([name, v]) => [name.toLowerCase(), { name, ...v }]));

export function findSpell(name) {
  return byLower.get(String(name || '').trim().toLowerCase()) || null;
}

/** One compact rules line for a spell, for the DM's context. */
export function spellFacts(name) {
  const s = findSpell(name);
  if (!s) return `${name} (no SRD entry: use the standard 5e reading)`;
  const lvl = s.l === 0 ? 'cantrip' : `level ${s.l}`;
  return `${s.name} [${lvl} ${s.s}; ${s.t}; ${s.r}; ${s.d}]: ${s.x}`;
}

// SRD weapon table: name = damage (type), properties.
export const WEAPON_TABLE = `Simple melee: club 1d4 bludgeoning (light); dagger 1d4 piercing (finesse, light, thrown 20/60); greatclub 1d8 bludgeoning (two-handed);
handaxe 1d6 slashing (light, thrown 20/60); javelin 1d6 piercing (thrown 30/120); light hammer 1d4 bludgeoning (light, thrown 20/60);
mace 1d6 bludgeoning; quarterstaff 1d6 bludgeoning (versatile 1d8); sickle 1d4 slashing (light); spear 1d6 piercing (thrown 20/60, versatile 1d8).
Simple ranged: light crossbow 1d8 piercing (80/320, loading, two-handed); shortbow 1d6 piercing (80/320, two-handed); dart 1d4 piercing (finesse, thrown 20/60); sling 1d4 bludgeoning (30/120).
Martial melee: battleaxe 1d8 slashing (versatile 1d10); flail 1d8 bludgeoning; glaive 1d10 slashing (heavy, reach, two-handed); greataxe 1d12 slashing (heavy, two-handed);
greatsword 2d6 slashing (heavy, two-handed); halberd 1d10 slashing (heavy, reach, two-handed); lance 1d12 piercing (reach); longsword 1d8 slashing (versatile 1d10);
maul 2d6 bludgeoning (heavy, two-handed); morningstar 1d8 piercing; pike 1d10 piercing (heavy, reach, two-handed); rapier 1d8 piercing (finesse); scimitar 1d6 slashing (finesse, light);
shortsword 1d6 piercing (finesse, light); trident 1d6 piercing (thrown 20/60, versatile 1d8); war pick 1d8 piercing; warhammer 1d8 bludgeoning (versatile 1d10); whip 1d4 slashing (finesse, reach).
Martial ranged: hand crossbow 1d6 piercing (30/120, light, loading); heavy crossbow 1d10 piercing (100/400, heavy, loading, two-handed); longbow 1d8 piercing (150/600, heavy, two-handed).
Unarmed strike: 1 bludgeoning damage + Strength modifier. Weapon damage adds the same ability modifier as the attack roll (not for off-hand attacks).`;
