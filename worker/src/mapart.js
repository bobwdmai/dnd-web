import { runModel, NARRATOR_MODEL } from './dm.js';

const ART_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';

const DESIGNER_PROMPT = `You are the cartographer-in-chief for a fantasy adventure. Design ONE large, richly detailed
top-down map of the main location of this adventure, then write instructions for the AI painter that
will illustrate it. Also invent 3 to 5 SECRET passages, hidden rooms or concealed mechanisms that the
adventurers do not know about. Secrets are for the Dungeon Master only: they must NOT appear in the
painter's instructions in any way (do not mention them, hint at them, or draw them).

Reply with ONLY this JSON, nothing else:
{
  "visible_layout": "One dense paragraph describing every visible feature, room, corridor, landmark, terrain and decoration on the map, with positions (north, center, west wing...).",
  "rooms": ["short names of the main visible areas"],
  "secrets": [{"name": "...", "location": "where it is, relative to the visible rooms", "how_to_find": "what reveals or opens it"}]
}`;

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** The DM's own "artist direction": the model designs the location and its secrets, and only the
 *  visible half of that design is ever handed to the image model. */
export async function designMap(env, state) {
  const adv = state.adventure || {};
  const chapter = adv.chapters?.[adv.chapter];
  const brief = `Campaign: ${state.campaign}\nAdventure: ${adv.title || 'unknown'}\nHook: ${adv.hook || ''}\n` +
    `Current chapter: ${chapter?.title || chapter || ''}`;
  let design = null;
  try {
    const { message } = await runModel(env, NARRATOR_MODEL,
      [{ role: 'system', content: DESIGNER_PROMPT }, { role: 'user', content: brief }], { max_tokens: 1800 });
    design = parseJson(message.content);
  } catch { /* fall through to a generic design */ }
  const layout = String(design?.visible_layout || `The main location of "${adv.title || state.campaign}": several chambers linked by winding passages, with a grand central hall.`).slice(0, 1400);
  const secrets = (Array.isArray(design?.secrets) ? design.secrets : []).slice(0, 6).map(s => ({
    name: String(s?.name || '').slice(0, 80),
    location: String(s?.location || '').slice(0, 200),
    how_to_find: String(s?.how_to_find || '').slice(0, 200)
  })).filter(s => s.name);
  const rooms = (Array.isArray(design?.rooms) ? design.rooms : []).map(r => String(r).slice(0, 60)).slice(0, 14);
  return { layout, secrets, rooms };
}

function paintPrompt(layout) {
  return 'Top-down overhead fantasy dungeon and location map, a large highly detailed hand-drawn battle map ' +
    'in the style of professional tabletop RPG cartography: aged parchment, fine ink linework, watercolor washes, ' +
    'stone walls with visible thickness, flagstone floors, wooden doors, torches, furniture, rubble, water, ' +
    'rich texture in every room, dramatic lighting, sharp and intricate. No text, no letters, no labels, no ' +
    'characters, no grid. Full map fills the whole frame. Layout: ' + layout;
}

async function paint(env, prompt) {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', '1024');
  form.append('height', '768');
  const formResponse = new Response(form);
  const result = await env.AI.run(ART_MODEL, {
    multipart: { body: formResponse.body, contentType: formResponse.headers.get('content-type') }
  });
  const b64 = result?.image;
  if (!b64) throw new Error('The map painter returned no image.');
  return b64;
}

/** Designs and paints the map. Returns { imageB64, secrets, rooms, layout }. */
export async function generateMapArt(env, state) {
  const design = await designMap(env, state);
  const imageB64 = await paint(env, paintPrompt(design.layout));
  return { imageB64, ...design };
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
