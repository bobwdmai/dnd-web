#!/usr/bin/env bash
# Runs the local copy: the game Worker on :8787 (AI via Ollama's cloud gpt-oss:20b) and the page on :8080.
# Needs Ollama running locally (it proxies gpt-oss:20b-cloud) — no Cloudflare account or quota involved.
set -e
cd "$(dirname "$0")/.."
node local/serve.js &
PAGE_PID=$!
trap 'kill $PAGE_PID 2>/dev/null' EXIT
cd worker
npx wrangler dev -c wrangler.local.jsonc --local --port 8787 --persist-to ../local/.data
