// test/live/persona.mjs — one identity's terminal and browser, kept apart from every other.
//
// A persona is a person on the roster (env.mjs PERSONAS) with: a signed-in browser (a
// Human), a publish token obtained by pairing as that person, and a terminal environment
// of its own — its token, its own draft registry, its own session label — so two personas
// on one machine share nothing, which is exactly the situation drill F examines.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORIGIN, SPACE, workDir, PERSONAS } from "./env.mjs";
import { Human, pairFor } from "./human.mjs";
import { unitClient } from "../../scripts/lib/draft.mjs";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ENGINE, "scripts", "cli.mjs");
const tokenFile = (p) => path.join(workDir("tokens"), `${p}.json`);

const humans = new Map();
const cookieFile = (p) => path.join(workDir("cookies"), `${p}.json`);
/**
 * The signed-in browser for a persona. A cookie from an earlier process is reused while
 * the workspace still honours it — one mailed code per person per day, not per drill —
 * and a fresh sign-in happens only when it does not.
 */
export async function human(persona, { fresh = false } = {}) {
  if (!PERSONAS[persona]) throw new Error(`no persona ${persona}`);
  // `fresh` means "sign in again now", also for a person this process already holds: a
  // drill that revoked their session (a role change, a removal) needs the next sign-in to
  // happen, not the dead cookie handed back.
  if (fresh) humans.delete(persona);
  if (!humans.has(persona)) {
    const h = new Human(persona);
    const f = cookieFile(persona);
    let ok = false;
    // The whole jar comes back — the workspace cookie AND the account session the mailed
    // sign-in opened — so a fresh sign-in can go through the account rather than the mailer.
    if (fs.existsSync(f)) {
      try { h.jarLoad(JSON.parse(fs.readFileSync(f, "utf8"))); } catch (e) { h.jar.clear(); }
    }
    if (!fresh && h.cookie) {
      try { ok = (await h.get("/__unit/drafts", { accept: "application/json" })).status === 200; } catch (e) { ok = false; }
    }
    if (!ok) {
      h.jar.delete("__Host-augur_user");
      try { await h.signIn(); }
      finally { fs.writeFileSync(f, JSON.stringify(h.jarDump())); } // the account session is worth keeping even when the workspace said no
    }
    humans.set(persona, h);
  }
  return humans.get(persona);
}

/** The persona's publish token: paired once and kept under the work dir, re-paired on demand. */
export async function token(persona, { fresh = false } = {}) {
  const f = tokenFile(persona);
  if (!fresh && fs.existsSync(f)) {
    // A token from an earlier process is reused while the workspace still honours it —
    // a role change or a removal revokes every token a person held, and then the only
    // way back is to pair again, exactly as a person's terminal would have to.
    const saved = JSON.parse(fs.readFileSync(f, "utf8"));
    const r = await fetch(`${ORIGIN()}/__unit/drafts`, { headers: { Authorization: `Bearer ${saved.token}` } });
    if (r.status === 200) return saved;
  }
  let h = await human(persona);
  let t = await pairFor(h, { label: `live ${persona}` });
  if (t.refused && t.refused.status === 401) {
    // The browser session died with the role change or the removal; sign in again.
    humans.delete(persona);
    h = await human(persona, { fresh: true });
    t = await pairFor(h, { label: `live ${persona}` });
  }
  if (t.refused) return t;
  fs.writeFileSync(f, JSON.stringify(t));
  return t;
}

/** An in-process unit client acting as this persona's terminal with a session label. */
export async function client(persona, session) {
  const t = await token(persona);
  if (t.refused) throw new Error(`${persona} cannot pair: ${JSON.stringify(t.refused)}`);
  return unitClient({ origin: ORIGIN(), token: t.token, space: SPACE(), session });
}

/** The environment the CLI runs under as this persona: its token, its own registry, its label. */
export async function cliEnv(persona, session) {
  const t = await token(persona);
  if (t.refused) throw new Error(`${persona} cannot pair: ${JSON.stringify(t.refused)}`);
  return {
    ...process.env,
    AUGUR_ORIGIN: ORIGIN(),
    AUGUR_TOKEN: t.token,
    AUGUR_SESSION: session,
    AUGUR_DRAFTS_REGISTRY: path.join(workDir(`registry-${persona}`), "drafts.json"),
    AUGUR_NO_ADAPTERS: "1",
  };
}

/** Run one CLI verb as a persona; resolves with stdout, stderr and the exit code. */
export async function cli(persona, session, args, { cwd } = {}) {
  const env = await cliEnv(persona, session);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: cwd || workDir(`cwd-${persona}`), env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err, last: out.trim().split("\n").pop() || "" }));
  });
}

/** A fresh empty folder for a draft checkout, named so a transcript reads well. */
export function draftDir(persona, label) {
  const d = path.join(workDir(`drafts-${persona}`), `${label}-${Date.now().toString(36)}`);
  return d;
}
