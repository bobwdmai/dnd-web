// Game structure: every room runs a short, finite adventure (3 chapters with an ending) and
// tracks combat as real rounds with an initiative order. The server owns this state — the DM
// drives it through two tools, but it can't be talked into a different order or a fake win.
import * as dice from './dice.js';

const ADVENTURES = [
  {
    id: 'sunken-crypt',
    title: 'The Sunken Crypt',
    hook: 'The well of the village of Marrowick has turned black and foul, and low tremors rumble up from beneath the old chapel. The villagers are terrified, and the elder has begged travelers to find the cause.',
    chapters: [
      { title: 'The Black Well', objective: 'Find out what is fouling the village well and locate the hidden entrance to the crypt beneath the chapel.' },
      { title: 'The Descent', objective: 'Fight through the undead guardians of the crypt and recover the Warden\'s Key that seals the inner vault.' },
      { title: 'The Lich-Priest', objective: 'Confront the risen priest at the heart of the crypt and end his dark ritual before it finishes.' }
    ]
  },
  {
    id: 'goblin-toll-road',
    title: 'The Goblin Toll Road',
    hook: 'The Red Fang goblins have seized the only bridge on the trade road and are robbing every traveler. Merchants are stranded on both sides, and a few have been dragged off to the goblin camp.',
    chapters: [
      { title: 'The Toll Bridge', objective: 'Scout the goblin-held bridge and learn how many goblins there are and who leads them.' },
      { title: 'The Red Fang Camp', objective: 'Get into the goblin camp and free the captured merchants.' },
      { title: 'Chief Grizzlefang', objective: 'Defeat the goblin chieftain and take back the bridge for the road.' }
    ]
  },
  {
    id: 'ashfall-village',
    title: 'Ashfall',
    hook: 'In the shadow of a smoking volcano, the miners of Ashfall have been vanishing one by one. Ash falls like snow, the mine is sealed, and the survivors whisper about a cult that worships fire.',
    chapters: [
      { title: 'The Missing Miners', objective: 'Investigate the disappearances and find proof of who is taking the miners.' },
      { title: 'The Smoldering Mine', objective: 'Sneak or fight your way into the sealed mine and find the cult\'s hidden shrine.' },
      { title: 'The Ember Drake', objective: 'Stop the cult from finishing the ritual that will awaken the ember drake.' }
    ]
  },
  {
    id: 'vanishing-caravan',
    title: 'The Vanishing Caravan',
    hook: 'A rich merchant caravan left the city three days ago and never arrived. Its wagons were found empty and unburned on a lonely stretch of road, with no bodies and no tracks leading away.',
    chapters: [
      { title: 'The Empty Wagons', objective: 'Search the abandoned wagons and follow the faint trail to where the caravan was taken.' },
      { title: 'The Smuggler\'s Den', objective: 'Uncover the hidden hideout behind the disappearance and learn who is really behind it.' },
      { title: 'The Mastermind', objective: 'Rescue the captives and confront the mastermind who took the caravan.' }
    ]
  }
];

/** Picks a fresh adventure, avoiding the one just finished so a restart feels different. */
export function newAdventure(excludeId) {
  const pool = ADVENTURES.filter(a => a.id !== excludeId);
  const template = pool[Math.floor(Math.random() * pool.length)];
  return {
    id: template.id,
    title: template.title,
    hook: template.hook,
    chapters: template.chapters,
    chapter: 0,
    status: 'active', // 'active' | 'victory' | 'defeat'
    summary: '',
    opened: false // has the opening scene been narrated yet
  };
}

export function newCombat() {
  return { active: false, round: 0, turn: 0, order: [] };
}

/** The adventure + combat state, as plain text for the DM's context every turn. */
export function summarizeStructure(state) {
  const adv = state.adventure;
  const lines = [];
  if (adv) {
    const total = adv.chapters.length;
    if (adv.status === 'active') {
      const ch = adv.chapters[adv.chapter];
      lines.push(`Adventure: "${adv.title}". Premise: ${adv.hook}`);
      lines.push(`Current chapter ${adv.chapter + 1} of ${total}: "${ch.title}". Objective: ${ch.objective}`);
    } else {
      lines.push(`Adventure "${adv.title}" has ended in ${adv.status}. ${adv.summary || ''}`.trim());
    }
  }
  const combat = state.combat;
  if (combat?.active) {
    const order = combat.order.map((c, i) => `${i === combat.turn ? '>> ' : ''}${c.name} (${c.initiative})`).join(', ');
    lines.push(`Combat: ACTIVE, round ${combat.round}. Initiative order: ${order}. It is ${combat.order[combat.turn]?.name}'s turn.`);
  } else {
    lines.push('Combat: not active.');
  }
  return lines.join('\n');
}

export const RUN_COMBAT_TOOL = {
  type: 'function',
  function: {
    name: 'run_combat',
    description:
      'Begin or finish a structured fight. action "start": list EVERY combatant and the server rolls ' +
      'initiative and fixes the turn order (it then advances turns and rounds itself). action "end": the ' +
      'fight is over.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'end'] },
        combatants: {
          type: 'array',
          description:
            'Only for action "start": every creature in the fight, one string each. A player character is just ' +
            'their exact name (e.g. "Sable"). An enemy is a unique name plus its initiative modifier, e.g. ' +
            '"Goblin 1 +2" or "Ogre -1".',
          items: { type: 'string' }
        }
      },
      required: ['action']
    }
  }
};

export const ADVANCE_STORY_TOOL = {
  type: 'function',
  function: {
    name: 'advance_story',
    description:
      'Move the adventure forward. action "next_chapter": the party has truly achieved the current chapter\'s ' +
      'objective. action "end_adventure": the final objective is achieved (victory) or the whole party is ' +
      'dead or hopelessly lost (defeat) — include a short epilogue summary.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['next_chapter', 'end_adventure'] },
        outcome: { type: 'string', enum: ['victory', 'defeat'], description: 'Only for end_adventure.' },
        summary: { type: 'string', description: 'Only for end_adventure: 1-3 sentence epilogue.' }
      },
      required: ['action']
    }
  }
};

function findCharacterName(characters, rawName) {
  if (!rawName) return null;
  if (characters[rawName]) return rawName;
  const lower = String(rawName).toLowerCase();
  return Object.keys(characters).find(k => k.toLowerCase() === lower) || null;
}

function abilityMod(score) {
  return typeof score === 'number' ? Math.floor((score - 10) / 2) : 0;
}

/** Applies one run_combat / advance_story call to room state. Returns the tool response for the
 *  model. Initiative uses the same real dice engine as every other roll — the model never picks it. */
export function runStructureTool(state, name, args, sideEffects) {
  if (name === 'run_combat') return runCombat(state, args, sideEffects);
  return advanceStory(state, args, sideEffects);
}

function runCombat(state, args, sideEffects) {
  const combat = state.combat || (state.combat = newCombat());

  if (args.action === 'start') {
    if (combat.active) return { error: 'Combat is already active — end it first.' };
    const list = Array.isArray(args.combatants) ? args.combatants.slice(0, 12) : [];
    if (!list.length) return { error: 'start needs a non-empty combatants list.' };

    const rolled = list.map(c => {
      // Each entry is "Name" or "Name +2"; an object {name, initiativeBonus} is tolerated too.
      let label, enemyBonus;
      if (typeof c === 'string') {
        const m = c.trim().match(/^(.*?)\s*([+-]\s*\d+)?$/);
        label = (m?.[1] || c).slice(0, 40) || 'Unknown';
        enemyBonus = m?.[2] ? Number(m[2].replace(/\s+/g, '')) : 0;
      } else {
        label = String(c?.name || 'Unknown').slice(0, 40);
        enemyBonus = Number(c?.initiativeBonus) || 0;
      }
      const pcKey = findCharacterName(state.characters, label);
      const bonus = pcKey
        ? abilityMod(state.characters[pcKey].abilityScores?.DEX)
        : Math.max(-5, Math.min(10, Math.round(enemyBonus)));
      const roll = dice.roll(`1d20${bonus >= 0 ? '+' : ''}${bonus}`);
      const display = pcKey || label;
      sideEffects.rollResults.push({ label: `Initiative: ${display}`, ...roll });
      return { name: display, initiative: roll.total, bonus };
    });
    rolled.sort((a, b) => b.initiative - a.initiative || b.bonus - a.bonus);
    state.combat = {
      active: true, round: 1, turn: 0,
      order: rolled.map(({ name: n, initiative }) => ({ name: n, initiative }))
    };
    sideEffects.structureChanged = true;
    sideEffects.combatStarted = true;
    return { started: true, round: 1, order: state.combat.order, current: state.combat.order[0].name };
  }

  if (!combat.active) return { error: 'Combat is not active.' };

  if (args.action === 'end') {
    state.combat = newCombat();
    sideEffects.structureChanged = true;
    return { ended: true };
  }

  return { error: `Unknown combat action "${args.action}".` };
}

function advanceStory(state, args, sideEffects) {
  const adv = state.adventure;
  if (!adv || adv.status !== 'active') return { error: 'There is no active adventure.' };

  if (args.action === 'next_chapter') {
    if (adv.chapter >= adv.chapters.length - 1) {
      return { error: 'That was the final chapter — use end_adventure with outcome "victory".' };
    }
    adv.chapter += 1;
    sideEffects.structureChanged = true;
    const ch = adv.chapters[adv.chapter];
    return { chapter: adv.chapter + 1, title: ch.title, objective: ch.objective };
  }

  if (args.action === 'end_adventure') {
    if (args.outcome !== 'victory' && args.outcome !== 'defeat') return { error: 'end_adventure needs outcome "victory" or "defeat".' };
    if (args.outcome === 'victory' && adv.chapter < adv.chapters.length - 1) {
      return { error: 'The party has not reached the final chapter yet — use next_chapter until they do.' };
    }
    adv.status = args.outcome;
    adv.summary = String(args.summary || '').slice(0, 400);
    state.combat = newCombat();
    sideEffects.structureChanged = true;
    return { ended: true, outcome: adv.status };
  }

  return { error: `Unknown story action "${args.action}".` };
}

/** After a DM response in an active fight, the server (not the model) moves the spotlight: enemy
 *  turns are narrated inside the same reply, so it lands on the next PLAYER in initiative order,
 *  bumping the round when the order wraps. Right after a fight starts it just settles on the
 *  first player instead of advancing. */
export function advanceCombat(state, justStarted) {
  const combat = state.combat;
  if (!combat?.active || !combat.order.length) return false;
  const n = combat.order.length;
  const isPlayer = i => !!findCharacterName(state.characters, combat.order[i].name);
  let steps = 0;
  if (justStarted) {
    while (!isPlayer(combat.turn) && steps < n) { combat.turn = (combat.turn + 1) % n; steps++; }
  } else {
    do {
      combat.turn += 1;
      if (combat.turn >= n) { combat.turn = 0; combat.round += 1; }
      steps++;
    } while (!isPlayer(combat.turn) && steps < n);
  }
  return true;
}
