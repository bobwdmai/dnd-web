#!/usr/bin/env node
// Local-only admin CLI for Dragon's Mud. Reads the admin secret from a gitignored file next to
// this script (worker/.admin-secret) and calls the Worker's secret-gated admin routes. Never
// exposed publicly — this only works because the secret lives on this machine.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ORIGIN = 'https://dnd-dm.bob-mai.com';
const SECRET_FILE = join(__dirname, '..', '.admin-secret');

function loadSecret() {
  try {
    return readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    console.error(`Could not read admin secret at ${SECRET_FILE}.`);
    console.error('Set it with: echo -n "<secret>" > worker/.admin-secret');
    process.exit(1);
  }
}

async function call(pathAndQuery, options = {}) {
  const secret = loadSecret();
  const res = await fetch(`${WORKER_ORIGIN}${pathAndQuery}`, {
    ...options,
    headers: { ...(options.headers || {}), 'x-admin-secret': secret }
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Error (HTTP ${res.status}):`, data.error || JSON.stringify(data));
    process.exit(1);
  }
  return data;
}

async function stats() {
  const data = await call('/api/admin/rooms');
  console.log(`Total rooms ever created: ${data.totalCreated}`);
  console.log(`Live (not ended):         ${data.live}`);
  console.log(`Ended:                    ${data.ended}`);
  if (data.liveRooms.length) {
    console.log('\nLive rooms:');
    for (const r of data.liveRooms) {
      console.log(`  ${r.code}  "${r.campaign || '(unknown)'}"  created ${r.createdAt}`);
    }
  }
}

async function del(code) {
  if (!code) {
    console.error('Usage: node scripts/admin.js delete <ROOM_CODE>');
    process.exit(1);
  }
  const data = await call(`/api/admin/room/${encodeURIComponent(code)}`, { method: 'DELETE' });
  console.log(data.deleted ? `Deleted room ${data.deleted}.` : 'Nothing to delete (room did not exist).');
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'stats') return stats();
  if (cmd === 'delete') return del(arg);
  console.log('Usage:');
  console.log('  node scripts/admin.js stats');
  console.log('  node scripts/admin.js delete <ROOM_CODE>');
  process.exit(1);
}

main();
