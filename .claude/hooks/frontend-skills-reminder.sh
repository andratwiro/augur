#!/usr/bin/env bash
# PreToolUse(Write|Edit) hook: when an edit targets front-end output —
# a prototype's HTML/CSS/JS/SVG, or the site shell build.js — remind the agent
# to load the design skill set per CLAUDE.md's modes (Free mode is the default).
# Fires once per session to avoid repeating on every edit.
set -euo pipefail

input="$(cat)"
fp="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
sid="$(printf '%s' "$input" | jq -r '.session_id // "nosession"')"
[ -z "$fp" ] && exit 0

# Is this front-end output? prototype HTML/CSS/JS/SVG, or the root build.js shell.
case "$fp" in
  *build.js) ;;
  */prototypes/*.html|*/prototypes/*.htm|*/prototypes/*.css|*/prototypes/*.js|*/prototypes/*.mjs|*/prototypes/*.svg) ;;
  *) exit 0 ;;
esac

# Once per session — loading the skills once into context is enough.
flag="${TMPDIR:-/tmp}/claude-fe-skills-${sid}"
[ -f "$flag" ] && exit 0
: > "$flag"

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Front-end work detected (CLAUDE.md). Default is Free mode — load skills/frontend-design/SKILL.md for design craft before editing. Product-specific layers are opt-in per CLAUDE.md (Modes), not front-loaded: pull the space's UI-kit skill to match the real product, and its a11y skill + `npm run audit` before a handoff or when asked. Flag any request that would bake in a visual a11y failure."}}
JSON
