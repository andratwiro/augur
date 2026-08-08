#!/usr/bin/env bash
# PreToolUse(Write|Edit) hook: once per session, remind the agent of this repo's
# ground rules (this is the ENGINE — generic, public, shared across instances).
set -euo pipefail

input="$(cat)"
sid="$(printf '%s' "$input" | jq -r '.session_id // "nosession"')"

# Once per session — one reminder is enough.
flag="${TMPDIR:-/tmp}/claude-engine-reminder-${sid}"
[ -f "$flag" ] && exit 0
: > "$flag"

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Engine repo: read CLAUDE.md for conventions before editing. The engine is generic and public — no product words or instance values in code (they belong in deploy.config.json / space.json), and stage only the paths you changed (never git add -A)."}}
JSON
