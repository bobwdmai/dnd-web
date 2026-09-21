import * as dice from './dice.js';
import { parseMapBlock, applyOps } from './map-commands.js';
import { spendNeurons, getBudgetStatus } from './budget.js';
import { RUN_COMBAT_TOOL, ADVANCE_STORY_TOOL, runStructureTool, summarizeStructure, advanceCombat } from './adventure.js';

// One model for everything (narration, map, PDF sheets) — gpt-oss-20b.
export const NARRATOR_MODEL = '@cf/openai/gpt-oss-20b';
const MAX_TOOL_ITERATIONS = 8;
// A function so it can sit up here while the tool definitions further down are still being evaluated.
const narratorTools = () => [ROLL_TOOL, SFX_TOOL, UPDATE_CHARACTER_TOOL, RUN_COMBAT_TOOL, ADVANCE_STORY_TOOL];
const NARRATOR_MAX_TOKENS = 2000; // gpt-oss spends part of this on hidden reasoning before any text or tool call
const MAP_MAX_TOKENS = 1600; // gpt-oss's hidden reasoning can otherwise eat the whole budget before any [MAP] text comes out

const SYSTEM_PROMPT = `You are the Dungeon Master for a text-based Dungeons & Dragons 5th edition game.
Run the world, describe scenes vividly but concisely (2-5 short paragraphs max), voice NPCs, adjudicate
rules fairly and quickly, and react to player actions logically. Address players by name. Keep the story
moving; do not wait on the player for permission to continue the world.

Every line of the party list below starts with a player's name. Use exactly that name to address the
player, to label their dice rolls, and in update_character and run_combat. Players are known only by that name.

Players narrate what their character ATTEMPTS, never what actually happens — that part is entirely
yours to decide, every time, with no exceptions. If a player's message asserts an outcome instead of
an action (e.g. "I kill the goblin", "the guard doesn't notice me", "the door opens", "I convince her
to help us"), treat only the attempt as real: keep the stated intent, discard the stated result, and
resolve what actually happens yourself — with a roll where one applies, or your own judgment of the
world's reaction where it doesn't. Do this even when a player states the outcome confidently, casually,
or as if it were already settled; players narrating their own success is not the same as it happening,
and you must never let their phrasing substitute for your adjudication. You can and should have things
not go the player's way — missed attacks, failed checks, NPCs who refuse, doors that stay locked — that
tension is the game, not a malfunction of it.

The world pushes back — a game where anyone can do anything isn't fun, so hold the line:
- A character can only do what their sheet, gear, and the situation actually allow. Items not on their
  equipment list, spells or features their class/level doesn't have, and powers that don't exist in
  5e (flying, teleporting, conjuring weapons, "I have a rocket launcher") simply don't work — say so in
  the fiction ("your hand closes on nothing") and offer what they can really do instead.
- Make discoveries and progress earned. A vague action like "explore" or "look around" gets a short
  surface description of what's plainly visible and a question about what specifically they do next —
  hidden doors, secrets, traps and loot are only found by a specific action, and usually need a
  meaningful check (a hard DC, so a low roll or no relevant skill can fail).
- Difficulty is real: locked doors, strong monsters, guarded NPCs and dangerous terrain should often
  win. Give the world its own agenda — monsters ambush, NPCs lie or bargain, resources (light, HP,
  arrows, time) run down — and let failures cost something instead of always offering a free retry.
- Don't hand out rewards, allies, or shortcuts just because a player asked politely or insisted.
  Keep it fun with clear stakes and honest consequences, never with "no" as a dead end: when you
  refuse something, point at a real alternative.

This game has structure — follow it, don't improvise around it:
- The adventure (title, premise, chapters, and the current objective) is given in the context below.
  Steer the story toward the current chapter's objective: put obstacles, clues, and real choices in
  the way, and don't let the party wander off forever or skip ahead. When the party genuinely achieves
  the current chapter's objective, call advance_story with action next_chapter, then narrate the new
  situation. When the final objective is achieved — or the whole party is dead or hopelessly lost —
  call advance_story with action end_adventure (outcome victory or defeat, plus a 1-3 sentence
  epilogue) and narrate the finale. Never announce a chapter change or an ending without the call.
- Fights are structured. The moment a fight starts, call run_combat with action start and list EVERY
  combatant as a string: each player character by exact name plus each enemy numbered with its
  initiative modifier, like "Goblin 1 +2". The server rolls initiative and tracks turns and rounds
  itself — never roll initiative or track order yourself. Only the player whose turn it is acts (if
  someone else tries, tell them to hold on). Resolve their action, then narrate every enemy turn that
  comes before the next player's turn (rolling those attacks yourself). Call run_combat with action
  end when the fight is over. Outside a fight, never use it.

You roll all dice yourself with the roll_dice tool — players never need physical dice. Call it for any
attack roll, saving throw, skill/ability check, damage roll, or other random outcome (but never initiative —
run_combat rolls that). Build
accurate formulas from the party's actual stats given below (ability modifier = floor((score-10)/2), add
the character's proficiency bonus if they're proficient in that skill or save). You can call the tool
more than once in a turn — e.g. roll an attack, see whether it hits, then roll damage — before writing
your narration. Never invent a die result yourself; always get the true result from the tool first, then
narrate the outcome referencing the actual numbers where it matters.

SPELLS. When a player casts a spell, resolve it by the real 5e rules for that exact spell — do not
improvise or reinvent it. Work out: does it need an attack roll (you roll their spell attack: proficiency +
casting ability mod) or a saving throw (the TARGET saves vs DC 8 + proficiency + casting mod; roll for the
target, not the caster)? Or does it auto-hit or need no roll? Then damage/effect, range, concentration,
and whether the caster has it (check their class and level; a spell they don't know or can't cast yet
doesn't work — say so, and let them choose again). A character's known spells are listed in their party
summary. You may give spells freely, to anyone of any class (fighters and rogues included): as
loot (scrolls, spellbooks, wands), rewards for good play, boons from gods or spirits, teachers,
cursed or wild-magic gifts, or a spell a player reasonably asks to learn when the story supports it. Whenever a
character gains a spell, call update_character with addSpells right then (and addEquipment for any
scroll or item that carries it), so it appears on their sheet. Be generous and creative, but keep
power fitting the level (a level-1 hero finds cantrips and 1st-2nd level spells, not Wish). Reminders:
Sacred Flame (target DEX save, radiant 1d8, ignores cover), Fire Bolt (ranged spell attack, 1d10 fire),
Eldritch Blast (spell attack, 1d10 force per beam), Vicious Mockery (WIS save, 1d4 psychic + disadvantage),
Guidance/Resistance (touch buff, concentration), Cure Wounds (touch heal 1d8+mod), Healing Word (bonus
action heal 1d4+mod, 60 ft), Magic Missile (auto-hit 3 darts 1d4+1 force each), Burning Hands (15 ft cone,
DEX save, 3d6 fire, half on save), Thunderwave (15 ft cube, CON save, 2d8 thunder + push), Sleep (5d8 HP
pool, no save), Shield (reaction, +5 AC), Mage Armor (AC 13+DEX), Bless (3 allies, +1d4 to attacks/saves),
Hex/Hunter's Mark (+1d6 to hits, concentration), Detect Magic (sense magic, concentration, ritual),
Light/Mage Hand/Prestidigitation (minor utility). If a spell is unfamiliar to you, apply the most
standard 5e reading rather than refusing or inventing wild effects. The world reacts to what a spell
truly does (Sacred Flame on an inanimate altar has no DEX save to make; it simply does nothing unless
the fiction says otherwise). Resolve the spell's dice with roll_dice before narrating, and if a roll
comes back as an error, fix the formula and roll again — never narrate an outcome without a valid roll.

When a character's stats actually change — they take damage, get healed, gain or lose a stat from a
spell/curse/potion, level up, or gain/lose an item — call update_character to make it stick on their
sheet, not just in your narration. This applies no matter how small the change is (even 1-3 HP of
damage) — if your narration says a number changed, the sheet must actually change to match, every
time, with no exceptions. Always call it right after the roll that caused the change, using the exact
character name from the party list below and the character's CURRENT hp.current from that party list
(not a guess) minus/plus the roll's result. Only include the fields that changed. For example, if
Thalia is currently at 12/12 HP and a damage roll comes back 3: call update_character with
characterName "Thalia", hpCurrent 9, reason "took 3 damage" — in the same turn, before your narration
mentions her losing HP.

Before you write your narration, always check: does this moment contain one of these? — a weapon or
blow connecting, a door/lid/lock opening or closing, an explosion or fire, a spell or magical effect,
a monster's growl/roar, coins or treasure, an arrow or thrown weapon in flight, water, thunder/storm, a
tense heartbeat-pounding moment, or a roll's dramatic success/failure. If yes, call the play_sound_effect
tool for it (pick the single best-matching effect) before writing your narration — this is a normal,
frequent part of narrating, not a rare exception. Call it at most once or twice per turn, and skip it
only when the beat is pure dialogue or has no physical/sensory moment at all.

When you describe a room, corridor, or area, be spatially concrete: mention rough size, shape,
exits/doors and their directions, and how new areas connect to where the party just was. A separate
cartographer process reads only your narration (not the dice rolls or rules talk) and turns it into
the battle map, so the more concrete the geography in your prose, the more accurate the map will be.
Do not draw the map yourself and do not mention maps, grids, or coordinates in your narration.

You will be given the current party's character sheets and recent conversation history as context.
Use character stats (HP, AC, class, proficiencies, etc.) to keep combat and checks consistent.`;

const MAP_SYSTEM_PROMPT = `You are the cartographer for a text-based Dungeons & Dragons game. You do not
narrate, speak to players, or explain yourself. Your only job is to read the Dungeon Master's latest
narration and the map as currently drawn, then output an updated map as simple line segments on a small
integer grid (roughly -40 to 40), so it stays reasonably to scale with itself over time.

Respond with ONLY a block in this exact format, nothing before or after it:

[MAP]
draw x1,y1 x2,y2 #hexcolor optional-note
label x,y Some Label
size 640 360
[/MAP]

Rules:
- You also control the map canvas dimensions with an optional "size WIDTH HEIGHT" line (pixels, 240-1200;
  default 480 360, about 24 grid units by 18). Pick a size that fits the place being drawn: a small
  room 480 360, a long corridor or wide cavern 960 360, a tall tower 360 480, a big region or
  overworld 1200 800. Only emit "size" when the shape needs to change; it is otherwise kept as-is.
- Work fast and simple: pick round integer coordinates directly by eye (e.g. multiples of 5) and
  move on. Never compute trigonometry, angles, or circle/curve approximations — always approximate
  every room as a plain rectangle, regardless of how the DM described its shape (a "circular
  chamber" is just a rectangle of 4 lines here). Keep your reasoning to one or two short sentences —
  do not deliberate over alternatives, line budgets, or how to best represent something; just pick
  the simplest option immediately and move on.
- Draw ONLY structural boundaries: a room's outer walls (a rectangle: 4 lines) and corridors/doorways
  connecting to it (1-2 lines each). That is the entire scope of this job. Never attempt to represent
  decorative or small-scale details — pillars, statues, furniture, mosaics, rubble, altars, ceiling
  features, etc. — as lines; skip them entirely (the DM's narration already covers them; the map is
  just the floor plan). A typical turn is 0-8 lines total, rarely more.
- Reuse and extend the existing map's coordinates when the new area connects to it (e.g. a corridor
  continuing from an existing doorway) so the map stays spatially consistent turn to turn.
- Start the block with a line containing only "clear" if, and only if, the party has moved somewhere
  entirely new and unconnected to the existing map (e.g. teleported, started a new chapter). A "clear"
  line is NEVER the whole answer — it only means "the room I'm about to draw isn't connected to the old
  one", so it must always be followed by the draw/label lines for that new room in the very same block.
  Otherwise (the new area connects to what's already drawn) skip "clear" entirely and just add the new
  lines/labels for what's new this turn.
- If the narration describes no new physical space (e.g. it's just dialogue, a dice roll, or combat in
  an already-drawn room), output exactly:
[MAP]
[/MAP]

Example — the party breaks into a brand-new room unconnected to anything drawn so far:
[MAP]
clear
draw -10,-10 10,-10 #8a7a5a
draw -10,-10 -10,10 #8a7a5a
draw 10,-10 10,10 #8a7a5a
draw -10,10 10,10 #8a7a5a
label 0,0 Goblin Den
[/MAP]
- Never include any commentary, narration, or text outside the [MAP]...[/MAP] block.`;

export const SFX_CATALOG = [
  'sword_clash', 'footsteps', 'door_creak', 'explosion', 'magic_sparkle', 'coin',
  'monster_growl', 'thunder', 'success_chime', 'failure_buzz', 'arrow_whoosh',
  'fire_crackle', 'water_splash', 'heartbeat',
  'rain', 'wind', 'bell', 'spell_cast', 'heal', 'punch', 'bow_twang', 'shield_block', 'trap_click',
  'door_slam', 'lock_pick', 'gong', 'wolf_howl', 'evil_laugh', 'scream', 'cheer', 'dragon_roar',
  'stone_grind', 'ghost_wail', 'level_up', 'potion_drink', 'rat_squeak', 'bones_rattle', 'glass_shatter'
];

const ROLL_TOOL = {
  type: 'function',
  function: {
    name: 'roll_dice',
    description:
      'Roll dice with standard tabletop notation and get the true, fairly-generated result. Always ' +
      'call this for any attack roll, saving throw, skill/ability check, damage roll, initiative, or ' +
      'other random outcome — never invent a die result yourself.',
    parameters: {
      type: 'object',
      properties: {
        formula: {
          type: 'string',
          description:
            'Dice formula: NdM (e.g. "1d20", "2d6"), optionally with a keep modifier for advantage/' +
            'disadvantage ("2d20kh1" = advantage, "2d20kl1" = disadvantage), and optionally a flat ' +
            'modifier ("1d20+5", "2d6-1").'
        },
        label: {
          type: 'string',
          description: 'What the roll is for, e.g. "Thalia Perception check" or "Goblin attack vs AC 13".'
        }
      },
      required: ['formula', 'label']
    }
  }
};

const SFX_TOOL = {
  type: 'function',
  function: {
    name: 'play_sound_effect',
    description:
      'Play a short sound effect to punctuate a discrete narrative beat for players (a strike landing, ' +
      'a door opening, a monster roaring, coins spilling, a spell firing, a roll\'s success or failure, ' +
      'etc). Call this whenever such a moment occurs, before writing the narration for it.',
    parameters: {
      type: 'object',
      properties: {
        effect: { type: 'string', enum: SFX_CATALOG, description: 'Which effect to play, matching the moment being narrated.' }
      },
      required: ['effect']
    }
  }
};

const UPDATE_CHARACTER_TOOL = {
  type: 'function',
  function: {
    name: 'update_character',
    description:
      'Update a party member\'s character sheet when the story actually changes it — damage taken, ' +
      'healing, a stat drain or buff, leveling up, or gaining/losing equipment. Only include the ' +
      'fields that changed; leave the rest out.',
    parameters: {
      type: 'object',
      properties: {
        characterName: { type: 'string', description: 'Exact name of the character being updated, matching the party list.' },
        hpCurrent: { type: 'number', description: 'New current HP, if it changed (e.g. after damage or healing).' },
        hpMax: { type: 'number', description: 'New max HP, if it changed (e.g. leveling up, a curse).' },
        armorClass: { type: 'number', description: 'New armor class, if it changed.' },
        abilityScores: {
          type: 'object',
          description: 'Only the ability scores that changed.',
          properties: {
            STR: { type: 'number' }, DEX: { type: 'number' }, CON: { type: 'number' },
            INT: { type: 'number' }, WIS: { type: 'number' }, CHA: { type: 'number' }
          }
        },
        addEquipment: { type: 'array', items: { type: 'string' }, description: 'Item names gained.' },
        addSpells: { type: 'array', items: { type: 'string' }, description: 'Spell names the character newly gains — from loot, a teacher, a boon, a scroll, a level-up, anything. Any class may receive spells.' },
        removeEquipment: { type: 'array', items: { type: 'string' }, description: 'Item names lost, used up, or consumed.' },
        reason: { type: 'string', description: 'Brief reason for the change, e.g. "took 8 slashing damage from the goblin".' }
      },
      required: ['characterName', 'reason']
    }
  }
};

function abilityModifier(score) {
  if (typeof score !== 'number') return null;
  return Math.floor((score - 10) / 2);
}

function summarizeCharacters(characters) {
  const names = Object.keys(characters || {});
  if (names.length === 0) return 'No character sheets have been uploaded yet.';
  return names.map(name => {
    const c = characters[name] || {};
    const ab = c.abilityScores || {};
    const mods = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
      .map(k => `${k} ${ab[k] ?? '-'} (${ab[k] != null ? (abilityModifier(ab[k]) >= 0 ? '+' : '') + abilityModifier(ab[k]) : '?'})`)
      .join(' ');
    const saves = (c.savingThrows || []).join(', ') || 'none listed';
    const skills = (c.skills || []).join(', ') || 'none listed';
    // Deliberately not showing the sheet's own name: players are known by their player name only.
    return `- ${name}: Level ${c.level || '?'} ${c.race || ''} ${c.class || ''}, ` +
      `HP ${c.hp?.current ?? '?'}/${c.hp?.max ?? '?'}, AC ${c.armorClass ?? '?'}, proficiency bonus +${c.proficiencyBonus ?? 2}\n` +
      `  Abilities: ${mods}\n  Save proficiencies: ${saves}\n  Skill proficiencies: ${skills}\n` +
      `  Spells known: ${(c.spells || []).join(', ') || 'none yet (can learn some in the story)'}\n` +
      `  Equipment (all they own): ${(c.equipment || []).join(', ') || 'nothing'}`;
  }).join('\n');
}

function summarizeMap(map) {
  if (!map || (!map.lines?.length && !map.labels?.length)) return 'The map is currently empty.';
  return `The map currently has ${map.lines.length} line segment(s) and ${map.labels.length} label(s) drawn.`;
}

function describeMapPrecisely(map) {
  if (!map || (!map.lines?.length && !map.labels?.length)) return '(empty — nothing has been drawn yet)';
  const lines = (map.lines || []).map(l =>
    `draw ${l.x1},${l.y1} ${l.x2},${l.y2}${l.color ? ' ' + l.color : ''}${l.note ? ' ' + l.note : ''}`);
  const labels = (map.labels || []).map(l => `label ${l.x},${l.y} ${l.text}`);
  return [...lines, ...labels].join('\n');
}

function historyEntryToMessage(h) {
  if (h.role === 'dm') return { role: 'assistant', content: h.content };
  if (h.role === 'roll') return { role: 'user', content: `[Dice roll result] ${h.content}` };
  return { role: 'user', content: `${h.name}: ${h.content}` };
}

/** The illustrated map's visible layout (so narration matches the picture) and the secrets that
 *  only the DM knows. Secrets never leave the server — see #sendStateTo. */
function summarizeMapArt(state) {
  const art = state.mapArt;
  if (!art) return '';
  let out = `\n\nILLUSTRATED MAP the players can see: ${art.layout || ''}`;
  if (art.secrets?.length) {
    out += '\n\nSECRET MAP KNOWLEDGE — the characters do NOT know any of this. Never volunteer it. Reveal one ONLY when a ' +
      'player really finds it (a fitting search/Investigation/Perception check that succeeds, or clever play), ' +
      'hint at most with subtle atmosphere (a draft, scuffed stone, an odd echo), and narrate the discovery vividly when it happens:\n' +
      art.secrets.map(s => `- ${s.name} — ${s.location}. Found by: ${s.how_to_find}`).join('\n');
  }
  return out;
}

function contextMessage(state) {
  return {
    role: 'system',
    content: `Campaign: ${state.campaign}\n\n${summarizeStructure(state)}\n\nParty:\n${summarizeCharacters(state.characters)}\n\n${summarizeMap(state.map)}${summarizeMapArt(state)}`
  };
}

function buildMessages(state, playerName, actionText, opening) {
  const recent = state.history.slice(-24).map(historyEntryToMessage);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    contextMessage(state),
    ...recent,
    // The opening scene isn't a player's message — it's an instruction, so it carries no name.
    { role: 'user', content: opening ? actionText : `${playerName}: ${actionText}` }
  ];
}

function buildMapMessages(state, narrativeText) {
  return [
    { role: 'system', content: MAP_SYSTEM_PROMPT },
    { role: 'user', content: `DM's latest narration:\n${narrativeText}\n\nMap as currently drawn:\n${describeMapPrecisely(state.map)}` }
  ];
}

function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  // Some models (e.g. granite-4.0-h-micro) double-encode: the arguments string, once parsed,
  // is itself still a JSON string rather than an object — parse once more in that case.
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  return (parsed && typeof parsed === 'object') ? parsed : {};
}

function tokenize(name) {
  return String(name).toLowerCase().replace(/[^a-z]+/g, '_').split('_').filter(Boolean);
}
function tokensMatch(a, b) {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}
/** Models pick a plausible effect name (e.g. "creaky_door") but not always the exact catalog
 *  string (e.g. "door_creak"); resolve by token overlap so near-misses still play the right sound. */
function resolveEffectName(raw) {
  if (!raw) return null;
  const normalized = tokenize(raw).join('_');
  if (SFX_CATALOG.includes(normalized)) return normalized;
  const rawTokens = tokenize(raw);
  let best = null, bestScore = 0;
  for (const candidate of SFX_CATALOG) {
    const candTokens = candidate.split('_');
    const score = rawTokens.filter(rt => candTokens.some(ct => tokensMatch(rt, ct))).length;
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return bestScore > 0 ? best : null;
}

/** Rarely, the model narrates its own tool call instead of just the outcome — as a mention of
 *  the tool's name, a fenced code block of pseudo-JSON, or a bolded pseudo-heading. Real DM
 *  narration never legitimately needs any of these, so strip all three wholesale. */
function stripToolMentions(text) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks (e.g. a leaked {"effect": "..."} blob)
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (/play_sound_effect|roll_dice|update_character|run_combat|advance_story/i.test(trimmed)) return false;
      // A "**Play Sound Effect:**" style header line (optionally naming the effect) is the model
      // labeling its own tool use, never narration. Normalize invisible characters and a
      // full-width colon first so a near-miss variant doesn't slip past the match.
      const normalized = trimmed.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\uFF1A/g, ':');
      if (/^[\s*_#>\-–—]*(?:play\s+)?(?:a\s+)?(?:sound\s*effects?|sfx|dice\s*rolls?)\b[\s*_:.\-–—]*(?:[a-z_]+(?:\s+[a-z_]+){0,2})?[\s*_.]*$/i.test(normalized)) return false;
      // A bare JSON object/array line (e.g. `{"effect":"door_creak"}`) is never real narration —
      // it's the model writing tool-call arguments directly instead of actually calling the tool.
      if (/^[{[][\s\S]*[}\]]$/.test(trimmed)) {
        try { JSON.parse(trimmed); return false; } catch { /* not actually JSON, keep the line */ }
      }
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

/**
 * Sometimes, instead of calling play_sound_effect, the model writes a stray stage-direction-style
 * marker directly in its prose (e.g. "*door_creak*"). Recover the intent instead of just deleting
 * it: strip the marker from the displayed text and trigger the matching sound effect for real.
 *
 * Only matches words containing an underscore — real catalog names always do ("door_creak",
 * "sword_clash"), while ordinary italicized prose emphasis never does ("*creaks*", "*slams*").
 * That keeps this from eating legitimate narrative emphasis.
 */
function extractStrayEffectMentions(text) {
  const extraEffects = [];
  // (?:_[a-z]+)* (zero-or-more, not one-or-more) so a single-word catalog entry written as a
  // bare cue like "*footsteps*" or "*heartbeat*" is still recognized, not just multi-word ones
  // like "*sword_clash*". resolveEffectName() gates what actually gets treated as a real effect,
  // so widening this just means more candidate words get checked, not more risk of false strips.
  // A bare "effect: sword_clash" line is the tool call's argument written out as text — play it
  // (if it names a real effect) instead of just showing it or silently dropping the sound.
  const withoutEffectLines = text.replace(/^[ \t]*[*_]*effect[*_]*[ \t]*[:=][ \t]*["'`]?([a-z_ -]+?)["'`]?[ \t]*,?[ \t]*$/gim, (full, word) => {
    const effect = resolveEffectName(word);
    if (effect) { extraEffects.push(effect); return ''; }
    return full;
  });
  const cleaned = withoutEffectLines.replace(/\*{1,2}([a-z]+(?:_[a-z]+)*)\*{1,2}/gi, (full, word) => {
    const effect = resolveEffectName(word);
    if (effect) { extraEffects.push(effect); return ''; }
    return full;
  });
  return { cleanText: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), extraEffects };
}

/** Exact match first, then case-insensitive — the model doesn't always echo a name's exact casing. */
export function findCharacterName(characters, rawName) {
  if (!rawName) return null;
  if (characters[rawName]) return rawName;
  const lower = String(rawName).toLowerCase();
  return Object.keys(characters).find(k => k.toLowerCase() === lower) || null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function errMsg(err) {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

/** Thin wrapper around env.AI.run that unpacks the OpenAI-shaped response and tracks neuron spend. */
export async function runModel(env, model, messages, { tools, max_tokens } = {}) {
  // Ollama: either a local daemon (OLLAMA_HOST, the local copy) or Ollama's cloud API directly
  // (OLLAMA_API_KEY, no local machine needed). If the cloud call fails and Workers AI is bound,
  // fall back to it so a hiccup at one provider doesn't stop the game.
  if (env.OLLAMA_HOST || env.OLLAMA_API_KEY) {
    try {
      return await runOllama(env, messages, { tools, max_tokens });
    } catch (err) {
      if (!env.AI) throw err;
    }
  }

  const result = await env.AI.run(model, { messages, tools, max_tokens: max_tokens || 512 });
  const message = result?.choices?.[0]?.message;
  if (!message) throw new Error('Workers AI returned an unexpected response shape.');
  const neurons = result?.usage?.neurons || 0;
  await spendNeurons(env, neurons);
  return { message, neurons };
}

async function runOllama(env, messages, { tools, max_tokens }) {
  // Ollama wants tool-call arguments as objects; the tool-call recovery path stores them as strings.
  const normalized = messages.map(m => (m.role === 'assistant' && Array.isArray(m.tool_calls))
    ? { ...m, tool_calls: m.tool_calls.map(c => ({ ...c, function: { ...c.function, arguments: parseToolArgs(c.function?.arguments) } })) }
    : m);
  // Ollama also wants each tool result labeled with the tool's name, not just an id.
  const nameById = {};
  for (const m of normalized) for (const c of m.tool_calls || []) if (c.id) nameById[c.id] = c.function?.name;
  for (const m of normalized) if (m.role === 'tool' && !m.tool_name) m.tool_name = nameById[m.tool_call_id] || undefined;
  const host = env.OLLAMA_HOST || 'https://ollama.com';
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(env.OLLAMA_API_KEY ? { authorization: `Bearer ${env.OLLAMA_API_KEY}` } : {}) },
    body: JSON.stringify({
      model: env.OLLAMA_MODEL || (env.OLLAMA_HOST ? 'gpt-oss:20b-cloud' : 'gpt-oss:20b'),
      messages: normalized,
      stream: false,
      ...(tools ? { tools } : {}),
      options: { temperature: 0.8, num_predict: max_tokens || 512 }
    })
  });
  if (!res.ok) throw new Error(`Ollama request failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  if (!data?.message) throw new Error('Ollama returned an unexpected response shape.');
  return { message: data.message, neurons: 0 };
}

/**
 * Execute one already-parsed tool call against room state, mutating rollResults/sfxRequests/
 * characterUpdates as a side effect. Shared by both real tool_calls and the leaked-JSON
 * recovery path below, so a call reaches the same logic regardless of how the model expressed it.
 */
function executeTool(state, name, args, sideEffects) {
  const { sfxRequests, characterUpdates } = sideEffects;
  const { rollResults } = sideEffects;
  if (name === 'run_combat' || name === 'advance_story') return runStructureTool(state, name, args, sideEffects);
  if (name === 'play_sound_effect') {
    const effect = resolveEffectName(args.effect);
    if (effect) { sfxRequests.push(effect); return { played: effect }; }
    return { error: `Unknown effect "${args.effect}"` };
  }
  if (name === 'roll_dice') {
    let result;
    try { result = { label: args.label || 'Roll', ...dice.roll(args.formula) }; }
    catch (err) { result = { label: args.label || 'Roll', formula: args.formula, error: errMsg(err) }; }
    rollResults.push(result);
    return result.error ? { error: result.error + '. Use a plain formula like 1d20+6 (sum the modifiers yourself) and call roll_dice again.' } : { breakdown: result.breakdown, total: result.total, rolls: result.rolls };
  }
  if (name === 'update_character') {
    const actualName = findCharacterName(state.characters, args.characterName);
    if (!actualName) return { error: `No character named "${args.characterName}"` };
    const sheet = state.characters[actualName];
    if (typeof args.hpMax === 'number') sheet.hp.max = Math.max(1, Math.round(args.hpMax));
    if (typeof args.hpCurrent === 'number') sheet.hp.current = clamp(Math.round(args.hpCurrent), 0, sheet.hp.max);
    if (typeof args.armorClass === 'number') sheet.armorClass = Math.round(args.armorClass);
    if (args.abilityScores && typeof args.abilityScores === 'object') {
      for (const [k, v] of Object.entries(args.abilityScores)) {
        if (['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].includes(k) && typeof v === 'number') {
          sheet.abilityScores[k] = Math.round(v);
        }
      }
    }
    if (Array.isArray(args.addEquipment)) {
      for (const item of args.addEquipment) {
        if (typeof item === 'string' && item.trim() && !sheet.equipment.includes(item.trim())) {
          sheet.equipment.push(item.trim());
        }
      }
    }
    if (Array.isArray(args.addSpells)) {
      if (!Array.isArray(sheet.spells)) sheet.spells = [];
      for (const spell of args.addSpells) {
        if (typeof spell === 'string' && spell.trim() && !sheet.spells.some(x => x.toLowerCase() === spell.trim().toLowerCase())) {
          sheet.spells.push(spell.trim().slice(0, 60));
        }
      }
    }
    if (Array.isArray(args.removeEquipment)) {
      const toRemove = args.removeEquipment.map(i => String(i).toLowerCase());
      sheet.equipment = sheet.equipment.filter(i => !toRemove.includes(i.toLowerCase()));
    }
    characterUpdates.add(actualName);
    return { updated: true, hp: sheet.hp, armorClass: sheet.armorClass, abilityScores: sheet.abilityScores };
  }
  return { error: `Unknown tool "${name}"` };
}

/**
 * gpt-oss-20b occasionally writes a tool call out as plain JSON text instead of using real
 * tool-calling (e.g. content is literally `{"effect":"sword_clash"}` or
 * `{"name":"functions.play_sound_effect","arguments":"{...}"}`). stripToolMentions() already
 * recognizes and removes that JSON so it never leaks into player-facing narration — but until
 * this recovers it, the requested side effect (a sound, a roll, a stat change) was silently lost
 * and the turn produced no narration at all. Detect the same shapes here so the caller can
 * replay them as a real tool call instead of just discarding them.
 */
function detectLeakedToolCall(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed || !/^[{[][\s\S]*[}\]]$/.test(trimmed)) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  if (typeof parsed.name === 'string' && 'arguments' in parsed) {
    return { name: parsed.name.replace(/^functions\./, ''), args: parseToolArgs(parsed.arguments) };
  }
  if (['start', 'end'].includes(parsed.action)) return { name: 'run_combat', args: parsed };
  if (['next_chapter', 'end_adventure'].includes(parsed.action)) return { name: 'advance_story', args: parsed };
  if (typeof parsed.effect === 'string') return { name: 'play_sound_effect', args: parsed };
  if (typeof parsed.formula === 'string') return { name: 'roll_dice', args: parsed };
  if (typeof parsed.characterName === 'string') return { name: 'update_character', args: parsed };
  return null;
}

async function runNarrator(env, state, initialMessages) {
  const messages = [...initialMessages];
  const rollResults = [];
  const sfxRequests = [];
  const characterUpdates = new Set();
  const sideEffects = { rollResults, sfxRequests, characterUpdates, structureChanged: false, combatStarted: false };

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let message;
    try {
      ({ message } = await runModel(env, NARRATOR_MODEL, messages, { tools: narratorTools(), max_tokens: NARRATOR_MAX_TOKENS }));
    } catch {
      // Workers AI occasionally fails a call with "3043: Internal server error". Retry once; if
      // the same request keeps failing, drop the tools and just ask for the narration so the
      // turn still produces a story beat (the tool effects already applied are kept).
      try {
        ({ message } = await runModel(env, NARRATOR_MODEL, messages, { tools: narratorTools(), max_tokens: NARRATOR_MAX_TOKENS }));
      } catch {
        ({ message } = await runModel(env, NARRATOR_MODEL,
          [...messages, { role: 'user', content: 'Now narrate what happens for the players, in the story. No tool calls.' }],
          { max_tokens: NARRATOR_MAX_TOKENS }));
      }
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        const toolResponse = executeTool(state, call.function?.name, parseToolArgs(call.function?.arguments), sideEffects);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResponse) });
      }
      continue;
    }

    const leaked = detectLeakedToolCall(message.content);
    if (leaked) {
      const syntheticId = `leaked_${iteration}`;
      const toolResponse = executeTool(state, leaked.name, leaked.args, sideEffects);
      messages.push({
        role: 'assistant', content: '',
        tool_calls: [{ id: syntheticId, type: 'function', function: { name: leaked.name, arguments: JSON.stringify(leaked.args) } }]
      });
      messages.push({ role: 'tool', tool_call_id: syntheticId, content: JSON.stringify(toolResponse) });
      messages.push({ role: 'user', content: 'Now narrate that moment for the player.' });
      continue;
    }

    // An empty reply after the tools ran means the model spent its budget thinking — ask again
    // for the narration rather than showing the players nothing.
    if (!String(message.content || '').trim() && iteration < MAX_TOOL_ITERATIONS - 1) {
      messages.push({ role: 'user', content: 'Now narrate what happens for the players, in the story.' });
      continue;
    }

    // A damage roll that never reached anyone's HP would leave the sheet out of sync with the
    // story — nudge once to apply it (or confirm it hit nobody) before narrating.
    if (!sideEffects.damageNudged && !characterUpdates.size && iteration < MAX_TOOL_ITERATIONS - 1
        && rollResults.some(r => !r.error && /damage|dmg|fall|trap/i.test(r.label || ''))) {
      sideEffects.damageNudged = true;
      messages.push({ role: 'assistant', content: message.content || '' });
      messages.push({ role: 'user', content: 'You rolled damage. If it hurt a party member, call update_character now with their new hpCurrent (current HP minus the damage), then narrate. If it hurt no one, just narrate.' });
      continue;
    }

    return { narrative: message.content || '', rollResults, sfxRequests, characterUpdates: [...characterUpdates], structureChanged: sideEffects.structureChanged, combatStarted: sideEffects.combatStarted };
  }

  return {
    narrative: "(The DM got tangled up using tools and couldn't finish that turn. Try again.)",
    rollResults, sfxRequests, characterUpdates: [...characterUpdates], structureChanged: sideEffects.structureChanged, combatStarted: sideEffects.combatStarted
  };
}

/**
 * Run one DM turn. Returns { narrative, rollResults, sfxRequests, mapOps, budgetExceeded }.
 * If the daily neuron budget is already spent, returns a friendly refusal without calling the model.
 */
export async function takeTurn(env, state, playerName, actionText, { opening = false } = {}) {
  const budget = await getBudgetStatus(env);
  if (budget.exceeded) {
    return {
      narrative: "The DM is resting — today's AI usage budget for this free demo has been used up. Please try again tomorrow (Eastern time).",
      rollResults: [], sfxRequests: [], mapOps: [], characterUpdates: [], structureChanged: false, budgetExceeded: true
    };
  }

  if (!opening) state.history.push({ role: 'user', name: playerName, content: actionText, ts: new Date().toISOString() });

  let rawNarrative = '', rollResults = [], sfxRequests = [], characterUpdates = [], structureChanged = false, combatStarted = false;
  try {
    const result = await runNarrator(env, state, buildMessages(state, playerName, actionText, opening));
    rawNarrative = result.narrative;
    rollResults = result.rollResults;
    sfxRequests = result.sfxRequests;
    characterUpdates = result.characterUpdates;
    structureChanged = result.structureChanged;
    combatStarted = result.combatStarted;
  } catch (err) {
    rawNarrative = `(The DM stumbled: ${errMsg(err)})`;
  }

  // The model sometimes writes update_character's arguments as plain "key: value" lines instead of
  // calling the tool. Apply them for real (so HP actually changes) and hide them from the chat.
  let leakBlock = parseMapBlock(rawNarrative).narrative;
  const leaked = {};
  leakBlock = leakBlock.replace(/^[ \t]*(characterName|hpCurrent|hpMax|armorClass|reason)[ \t]*[:=][ \t]*["'`]?(.*?)["'`]?[ \t]*,?[ \t]*$/gim,
    (full, key, val) => { leaked[key] = val; return ''; });
  if (leaked.characterName) {
    const args = { characterName: leaked.characterName, reason: leaked.reason };
    for (const k of ['hpCurrent', 'hpMax', 'armorClass']) if (leaked[k] !== undefined && !isNaN(+leaked[k])) args[k] = +leaked[k];
    const touched = new Set(characterUpdates);
    try { executeTool(state, 'update_character', args, { rollResults: [], sfxRequests: [], characterUpdates: touched }); } catch { /* best effort */ }
    characterUpdates = [...touched];
  }
  const stripped = stripToolMentions(leakBlock);
  const { cleanText, extraEffects } = extractStrayEffectMentions(stripped);
  // If stripping left nothing (the model's whole reply was a leaked tool-call artifact), show a
  // brief placeholder rather than a blank chat bubble — never make up story content here.
  const narrative = cleanText || "(The DM pauses for a moment, gathering their thoughts...)";
  if (extraEffects.length) sfxRequests.push(...extraEffects);

  if (rollResults.length) {
    const rollSummary = rollResults
      .map(r => r.error ? `${r.label}: invalid roll (${r.error})` : `${r.label}: ${r.breakdown}`)
      .join('\n');
    state.history.push({ role: 'roll', name: 'Dice', content: rollSummary, results: rollResults, ts: new Date().toISOString() });
  }

  state.history.push({ role: 'dm', name: 'DM', content: narrative, ts: new Date().toISOString() });
  if (advanceCombat(state, combatStarted)) structureChanged = true;

  let mapOps = [];
  try {
    const { message } = await runModel(env, NARRATOR_MODEL, buildMapMessages(state, narrative), { max_tokens: MAP_MAX_TOKENS });
    const rawMap = message.content || '';
    const wrapped = rawMap.includes('[MAP]') ? rawMap : `[MAP]\n${rawMap}\n[/MAP]`;
    const parsedOps = parseMapBlock(wrapped).ops;
    mapOps = parsedOps.length ? applyOps(state.map, parsedOps) : [];
  } catch {
    mapOps = []; // map generation is best-effort; a cartographer failure shouldn't fail the turn
  }

  return { narrative, rollResults, sfxRequests, mapOps, characterUpdates, structureChanged, budgetExceeded: false };
}

const SHEET_SCHEMA_HINT = `{
  "name": "", "race": "", "class": "", "level": 1, "background": "", "alignment": "",
  "abilityScores": { "STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10 },
  "hp": { "current": 0, "max": 0 }, "armorClass": 10, "speed": 30, "proficiencyBonus": 2,
  "savingThrows": [], "skills": [], "equipment": [], "features": [], "spells": [], "notes": ""
}`;

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

/** Ask the model to turn raw (client-extracted) PDF text into a structured character sheet. */
export async function formatCharacterSheet(env, rawText, playerName) {
  const budget = await getBudgetStatus(env);
  if (budget.exceeded) throw new Error("Today's AI usage budget has been used up. Please try again tomorrow (Eastern time).");

  const trimmed = String(rawText).slice(0, 12000);
  const messages = [
    {
      role: 'system',
      content:
        'You convert messy text extracted from a Dungeons & Dragons 5th edition character sheet PDF ' +
        'into clean structured JSON. Respond with ONLY valid JSON, no markdown fences, no commentary. ' +
        'If a field is missing, make a reasonable inference from context, or use an empty/zero value. ' +
        'Match this exact schema (types included):\n' + SHEET_SCHEMA_HINT
    },
    { role: 'user', content: `Player name (if the sheet doesn't state one, use this): ${playerName}\n\nExtracted PDF text:\n${trimmed}` }
  ];

  const { message } = await runModel(env, NARRATOR_MODEL, messages, { max_tokens: 1600 });
  const jsonText = extractJson(message.content || '');
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (err) { throw new Error(`AI did not return valid JSON for the character sheet: ${errMsg(err)}`); }
  if (!parsed.name) parsed.name = playerName;
  return parsed;
}
