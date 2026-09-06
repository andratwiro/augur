// agent-tool.mjs — the one place the engine writes down the agent tool it can set up.
//
// WHY IT IS A MODULE AND NOT A STRING IN TWO FILES. Two sides need these four facts and
// they cannot import each other's copy without one of them going stale: the WORKER (the
// welcome flow's install step, and the installer it hands a person) and the CLI
// (`scripts/lib/adapters.mjs`, which hooks the tool's settings file). The worker cannot
// import from `scripts/` — that folder is node-only and never rides the bundle — so the
// facts live here, in `src/`, and adapters.mjs reads `id`/`name` back out of it. One
// definition, and a rename is a one-line diff.
//
// ⚠️ THIS IS THE ENGINE'S ONE NAMED THIRD-PARTY TOOL, AND IT IS DATA, NOT COPY. No page,
// mail or refusal in this repo may write the name inline: a surface that wants it takes
// it from here, so the engine that supports a second tool tomorrow changes one table
// rather than being audited for a word. Nothing on the welcome page names it at all —
// the flow asks whether a person already runs "a coding agent in a terminal", which is
// the question that is true whatever they run.
export const AGENT_TOOL = Object.freeze({
  id: "claude-code",
  name: "Claude Code",
  install: "npm install -g @anthropic-ai/claude-code",
  bin: "claude",
});
