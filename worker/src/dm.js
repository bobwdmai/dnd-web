import * as dice from './dice.js';
import { parseMapBlock, applyOps } from './map-commands.js';
import { spendNeurons, getBudgetStatus } from './budget.js';

// Hybrid: a real model for the actual storytelling (vibe and remembering the campaign matter
// there), a cheap one for mechanical tasks (turning narration into map lines, turning PDF text
// into JSON) where quality matters far less and cost adds up faster (one extra call every turn).
const NARRATOR_MODEL = '@cf/openai/gpt-oss-20b';
const CHEAP_MODEL = '@cf/ibm-granite/granite-4.0-h-micro';
const MAX_TOOL_ITERATIONS = 8;
const NARRATOR_MAX_TOKENS = 900;
const MAP_MAX_TOKENS = 500; // granite has no hidden-reasoning channel, so it needs far less headroom than gpt-oss did here

const SYSTEM_PROMPT = `You are the Dungeon Master for a text-based Dungeons & Dragons 5th edition game.
Run the world, describe scenes vividly but concisely (2-5 short paragraphs max), voice NPCs, adjudicate
rules fairly and quickly, and react to player actions logically. Address players by name. Keep the story
moving; do not wait on the player for permission to continue the world.

You roll all dice yourself with the roll_dice tool — players never need physical dice. Call it for any
attack roll, saving throw, skill/ability check, damage roll, initiative, or other random outcome. Build
accurate formulas from the party's actual stats given below (ability modifier = floor((score-10)/2), add
the character's proficiency bonus if they're proficient in that skill or save). You can call the tool
more than once in a turn — e.g. roll an attack, see whether it hits, then roll damage — before writing
your narration. Never invent a die result yourself; always get the true result from the tool first, then
narrate the outcome referencing the actual numbers where it matters.

When a character's stats actually change — they take damage, get healed, gain or lose a stat from a
spell/curse/potion, level up, or gain/lose an item — call update_character to make it stick on their
sheet, not just in your narration. Always call it right after the roll that caused the change (e.g.
after a damage roll resolves), using the exact character name from the party list below. Only include
the fields that changed.

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
[/MAP]

Rules:
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
  'fire_crackle', 'water_splash', 'heartbeat'
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
    return `- ${c.name || name}: Level ${c.level || '?'} ${c.race || ''} ${c.class || ''}, ` +
      `HP ${c.hp?.current ?? '?'}/${c.hp?.max ?? '?'}, AC ${c.armorClass ?? '?'}, proficiency bonus +${c.proficiencyBonus ?? 2}\n` +
      `  Abilities: ${mods}\n  Save proficiencies: ${saves}\n  Skill proficiencies: ${skills}`;
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

function contextMessage(state) {
  return {
    role: 'system',
    content: `Campaign: ${state.campaign}\n\nParty:\n${summarizeCharacters(state.characters)}\n\n${summarizeMap(state.map)}`
  };
}

function buildMessages(state, playerName, actionText) {
  const recent = state.history.slice(-24).map(historyEntryToMessage);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    contextMessage(state),
    ...recent,
    { role: 'user', content: `${playerName}: ${actionText}` }
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
      if (/play_sound_effect|roll_dice|update_character/i.test(trimmed)) return false;
      if (/^\*{0,2}(play\s+)?(sound\s+effect|dice\s+roll)s?\s*:?\*{0,2}$/i.test(trimmed)) return false;
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
  const cleaned = text.replace(/\*{1,2}([a-z]+(?:_[a-z]+)+)\*{1,2}/gi, (full, word) => {
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
async function runModel(env, model, messages, { tools, max_tokens } = {}) {
  const result = await env.AI.run(model, { messages, tools, max_tokens: max_tokens || 512 });
  const message = result?.choices?.[0]?.message;
  if (!message) throw new Error('Workers AI returned an unexpected response shape.');
  const neurons = result?.usage?.neurons || 0;
  await spendNeurons(env, neurons);
  return { message, neurons };
}

/**
 * Execute one already-parsed tool call against room state, mutating rollResults/sfxRequests/
 * characterUpdates as a side effect. Shared by both real tool_calls and the leaked-JSON
 * recovery path below, so a call reaches the same logic regardless of how the model expressed it.
 */
function executeTool(state, name, args, { rollResults, sfxRequests, characterUpdates }) {
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
    return result.error ? { error: result.error } : { breakdown: result.breakdown, total: result.total, rolls: result.rolls };
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
  const sideEffects = { rollResults, sfxRequests, characterUpdates };

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const { message } = await runModel(env, NARRATOR_MODEL, messages, {
      tools: [ROLL_TOOL, SFX_TOOL, UPDATE_CHARACTER_TOOL], max_tokens: NARRATOR_MAX_TOKENS
    });

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

    return { narrative: message.content || '', rollResults, sfxRequests, characterUpdates: [...characterUpdates] };
  }

  return {
    narrative: "(The DM got tangled up using tools and couldn't finish that turn. Try again.)",
    rollResults, sfxRequests, characterUpdates: [...characterUpdates]
  };
}

/**
 * Run one DM turn. Returns { narrative, rollResults, sfxRequests, mapOps, budgetExceeded }.
 * If the daily neuron budget is already spent, returns a friendly refusal without calling the model.
 */
export async function takeTurn(env, state, playerName, actionText) {
  const budget = await getBudgetStatus(env);
  if (budget.exceeded) {
    return {
      narrative: "The DM is resting — today's AI usage budget for this free demo has been used up. Please try again tomorrow (Eastern time).",
      rollResults: [], sfxRequests: [], mapOps: [], characterUpdates: [], budgetExceeded: true
    };
  }

  state.history.push({ role: 'user', name: playerName, content: actionText, ts: new Date().toISOString() });

  let rawNarrative = '', rollResults = [], sfxRequests = [], characterUpdates = [];
  try {
    const result = await runNarrator(env, state, buildMessages(state, playerName, actionText));
    rawNarrative = result.narrative;
    rollResults = result.rollResults;
    sfxRequests = result.sfxRequests;
    characterUpdates = result.characterUpdates;
  } catch (err) {
    rawNarrative = `(The DM stumbled: ${errMsg(err)})`;
  }

  const stripped = stripToolMentions(parseMapBlock(rawNarrative).narrative);
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

  let mapOps = [];
  try {
    const { message } = await runModel(env, CHEAP_MODEL, buildMapMessages(state, narrative), { max_tokens: MAP_MAX_TOKENS });
    const rawMap = message.content || '';
    const wrapped = rawMap.includes('[MAP]') ? rawMap : `[MAP]\n${rawMap}\n[/MAP]`;
    const parsedOps = parseMapBlock(wrapped).ops;
    mapOps = parsedOps.length ? applyOps(state.map, parsedOps) : [];
  } catch {
    mapOps = []; // map generation is best-effort; a cartographer failure shouldn't fail the turn
  }

  return { narrative, rollResults, sfxRequests, mapOps, characterUpdates, budgetExceeded: false };
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

  const { message } = await runModel(env, CHEAP_MODEL, messages, { max_tokens: 900 });
  const jsonText = extractJson(message.content || '');
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (err) { throw new Error(`AI did not return valid JSON for the character sheet: ${errMsg(err)}`); }
  if (!parsed.name) parsed.name = playerName;
  return parsed;
}
