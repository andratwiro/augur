#!/usr/bin/env bash
# PreToolUse(Write|Edit) hook: when an edit targets front-end output —
# a prototype's HTML/CSS/JS/SVG, or the site shell build.js — remind the agent
# to load the required GoVocal front-end skill set first (see CLAUDE.md).
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
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Front-end work detected (CLAUDE.md rule). Before editing, load the required skill set: read skills/govocal-design/SKILL.md, skills/frontend-design/SKILL.md, skills/govocal-a11y/SKILL.md, and skills/webapp-testing/SKILL.md. Build to WCAG 2.2 AA, then close the loop with a Playwright screenshot (.venv/bin/python) and `npm run audit`."}}
JSON
