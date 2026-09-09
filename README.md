# Ollama D&D

A text-based Dungeons & Dragons game where an AI runs the Dungeon Master: it narrates the scene,
rolls every die itself via a real dice-rolling tool (cryptographically fair, never invented), sketches
a battle map as simple lines, and triggers sound effects for the moments that call for one — all backed
by Cloudflare Workers AI, with no server to run and no API keys shipped to the browser.

[Play it](https://bob-mai.com/dnd/) · the AI Dungeon Master and Cloudflare Worker + Workers AI backend behind it live here.

## How it works

- **Rooms**: starting a game gets you a short join code (`worker/src/index.js`), backed by a
  [Durable Object](https://developers.cloudflare.com/durable-objects/) per room (`worker/src/game-room.js`)
  that holds the room's whole state (chat history, map, character sheets) in SQLite storage and relays
  messages between connected players over WebSockets (Hibernation API — idle rooms cost nothing to keep
  open).
- **The DM**: `worker/src/dm.js` prompts [Workers AI](https://developers.cloudflare.com/workers-ai/)
  (`@cf/openai/gpt-oss-20b`) with two real tools — `roll_dice` and `play_sound_effect` — so the model
  requests a roll or a cue and gets a true result back rather than inventing one, then narrates the
  outcome. A second, focused call turns the narration into simple line-segment map updates.
- **Dice**: `worker/src/dice.js` is a small dice-notation engine (`1d20+5`, advantage/disadvantage via
  `2d20kh1`/`2d20kl1`) using the Web Crypto API for fair randomness.
- **Sound**: every effect is synthesized on the fly in the browser via the Web Audio API
  (`frontend/js/app.js`) — no audio files to host or license.
- **Character sheets**: a PDF's text is extracted entirely client-side with
  [pdf.js](https://mozilla.github.io/pdf.js/) (the file itself never leaves the browser), then sent to
  the Worker to be AI-formatted into a structured sheet.
- **Budget**: `worker/src/budget.js` tracks Workers AI neuron spend per day in KV and refuses new turns
  past a cap, so cost stays bounded regardless of traffic — the same pattern used by
  [ClearSpeak](https://github.com/bobwdmai/clearspeak)'s level generator.
- **Owner & End Game**: the room's state persists on every single action automatically (it's just
  Durable Object storage — there's no separate "save"). Whoever first joins a room becomes its
  owner and is the only one who can end it; ending broadcasts a notice to everyone still connected,
  marks the room closed (further join attempts get a 410), and closes every socket. The data itself
  is never deleted — "closed" only means the room stops accepting new connections.

## Deploy the worker

```sh
cd worker
npm install
npx wrangler kv namespace create ROOM_BUDGET   # then put its id in wrangler.jsonc
npx wrangler deploy
```

## Embed the frontend

`frontend/` is synced into `bob-mai.com`'s Hugo site as `static/dnd/`, with
`layouts/_default/dnd.html` providing the page shell — the same pattern ClearSpeak uses. To point it at
a different Worker deployment, change `WORKER_ORIGIN` at the top of `frontend/js/app.js`.
