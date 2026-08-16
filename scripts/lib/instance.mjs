// instance.mjs — how a script in this engine finds ITS instance's config.
//
// The engine is generic and shared by every instance: it carries no account ids, no
// worker names, no origins. Those live in the DEPLOY SHELL — a sibling repo holding
// identity.json + deploy.config.json — whose repo NAME differs per instance. So the
// shell is resolved by SHAPE, never by name: a sibling dir with an identity.json at its
// root that is not a space and is not the engine. Explicit env always wins; a raw engine
// clone with no shell resolves to nothing, and callers fall back or fail loudly.
//
// build.js takes the same values through GV_IDENTITY_PATH / GV_DEPLOY_CONFIG_PATH (the
// shell's CI passes them explicitly); this is the local-script equivalent.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function findShellDir(root = ENGINE_ROOT, originHost = "") {
  const parent = path.join(root, "..");
  try {
    const shells = readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".")
        && path.resolve(parent, e.name) !== path.resolve(root)
        && !existsSync(path.join(parent, e.name, "space.json"))
        && existsSync(path.join(parent, e.name, "identity.json")))
      .map((e) => path.join(parent, e.name)).sort();
    // Several instances can share one parent folder. When the caller knows which
    // ORIGIN it is talking to, the shell whose declared siteOrigin matches that
    // host wins; with one shell, or no host, it is the first by name.
    if (originHost && shells.length > 1) {
      const match = shells.find((s) => {
        try {
          const o = JSON.parse(readFileSync(path.join(s, "deploy.config.json"), "utf8")).siteOrigin || "";
          return new URL(o).host === originHost;
        } catch { return false; }
      });
      if (match) return match;
    }
    return shells[0] || null;
  } catch { return null; }
}

// The host of an origin URL, or "" if it isn't one. Shared so every caller feeds
// findShellDir the same shape.
export function originHost(origin) {
  try { return new URL(origin).host; } catch { return ""; }
}

// The instance's deploy.config.json (siteOrigin, realtimeOrigin, …) — the same file the
// build injects into the worker. GV_DEPLOY_CONFIG_PATH wins, then the shell's, then one
// at the engine root (a single-repo instance). Missing or unreadable → {}.
//
// `preferHost` disambiguates when several instances share one parent folder. Without
// it findShellDir falls back to the first shell BY NAME, so with two shells checked
// out side by side the alphabetically-first one answered for every space in the
// folder — and since this config's siteOrigin outranks the space's own in every
// origin-resolving caller, `augur publish` and `augur login` from space B aimed
// themselves at instance A. Which live instance a publish reached came down to
// directory sort order.
//
// Callers pass the host of the space's OWN declared siteOrigin: the space repo names
// the instance it belongs to, so it is the right tiebreak. It is only ever a
// tiebreak — with one shell (the ordinary case, and anyone who cloned a starter
// space to run their own instance) the answer is that shell either way, so a fork
// still publishes to ITS shell rather than to the origin its space.json inherited.
export function deployConfig(root = ENGINE_ROOT, preferHost = "") {
  const shell = findShellDir(root, preferHost);
  const file = process.env.GV_DEPLOY_CONFIG_PATH
    || [shell && path.join(shell, "deploy.config.json"), path.join(root, "deploy.config.json")]
      .filter(Boolean).find((f) => existsSync(f));
  if (!file || !existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}
