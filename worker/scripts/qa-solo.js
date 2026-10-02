#!/usr/bin/env node
// QA helper: plays scripted actions in a private (unsaved) solo room on the live Worker and prints
// each DM reply plus dice, sheet updates and structure changes. Never touches the Global Game.
//   CLS=Wizard LVL=1 node scripts/qa-solo.js "I cast Mage Hand" "I look around"
// Needs the `ws` package (resolved from NODE_PATH or the sibling church project).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let WebSocket;
for (const p of ['ws', '/home/bob/church/node_modules/ws']) { try { WebSocket = require(p); break; } catch { /* try next */ } }
if (!WebSocket) { console.error('Install ws (npm i ws) or set NODE_PATH.'); process.exit(1); }

const H = { 'content-type': 'application/json', origin: 'https://bob-mai.com' };
const W = process.env.WORKER || 'https://dnd-dm.bob-mai.com';
const { code } = await fetch(W + '/api/create-room', { method: 'POST', headers: H, body: JSON.stringify({ campaign: 'QA', solo: true }) }).then(r => r.json());
const sheet = {
  name: 'Tess', race: 'Gnome', class: process.env.CLS || 'Wizard', level: +(process.env.LVL || 1), background: 'Sage',
  abilityScores: { STR: 8, DEX: 14, CON: 13, INT: 15, WIS: 12, CHA: 10 }, hp: { current: 8, max: 8 }, armorClass: 12, speed: 25,
  proficiencyBonus: 2, savingThrows: ['INT', 'WIS'], skills: ['Arcana', 'Investigation'], equipment: [], features: [],
  spells: (process.env.SPELLS || '').split(',').filter(Boolean), notes: ''
};
const cr = await fetch(`${W}/api/room/${code}/character/create`, { method: 'POST', headers: H, body: JSON.stringify({ playerName: 'Tester', sheet }) }).then(r => r.json());
console.log('equipment from kit:', JSON.stringify(cr.sheet?.equipment));
const actions = process.argv.slice(2);
let i = -1;
const ws = new WebSocket(W.replace('https', 'wss') + '/api/room/' + code, { headers: { origin: 'https://bob-mai.com' } });
ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name: 'Tester' })));
const next = () => {
  i++;
  if (i >= actions.length) { console.log('DONE'); process.exit(0); }
  console.log('\n>>> ' + actions[i]);
  ws.send(JSON.stringify({ type: 'chat', text: actions[i] }));
};
ws.on('message', d => {
  const m = JSON.parse(d);
  if (m.type === 'dice-rolled') console.log('DICE', m.rolls.map(r => r.label + ' ' + (r.breakdown || r.error)).join(' | '));
  if (m.type === 'structure') console.log('STRUCT combat', m.combat?.active, (m.combat?.order || []).map(c => c.name).join(','), JSON.stringify(m.conditions || {}));
  if (m.type === 'character-updated') console.log('SHEET equipment=', JSON.stringify(m.sheet.equipment), 'spells=', JSON.stringify(m.sheet.spells), 'hp', m.sheet.hp.current);
  if (m.type === 'error') console.log('ERROR', m.error);
  if (m.type === 'dm-said') { console.log('DM:', m.text.slice(0, 700)); next(); }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 560000);
