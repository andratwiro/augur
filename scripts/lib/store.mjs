// store.mjs — how a CLI script finds the instance it should talk to, and how it
// talks to the bundle store's HTTP API.
//
// Extracted from publish.mjs so publish / export / restore / status all resolve the
// same target the same way. Credential resolution that drifts between tools is how
// you end up backing up one instance and restoring another.
//
// Target origin, in order: AUGUR_ORIGIN env · the engine's .env.deploy · the deploy
// shell's deploy.config.json `siteOrigin` · the cwd space's space.json `siteOrigin`
// (the collaborator layout: a lone space clone with no shell anywhere — the one
// public fact a space repo knows about its instance).
//
// Token, in order: AUGUR_TOKEN env · the pairing `augur connect` saved for this origin ·
// the engine's .env.deploy. The pairing beats the file on purpose: a draft and a landing
// are recorded under the token's label, and a .env.deploy token is the MACHINE's — the one
// a deploy shell's CI publishes with, labelled by whoever minted it — while a pairing is
// the person at the keyboard. With the file first, every landing made from a maintainer's
// clone was the CI token's and nobody's face on the card. Explicit env still wins: CI, the
// test suites and a person choosing a token for one command set it on purpose.

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployConfig, originHost } from "./instance.mjs";

export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readEnvFile(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (e) {}
  return out;
}

export function resolveOrigin(root = ENGINE_ROOT) {
  const env = readEnvFile(path.join(root, ".env.deploy"));
  let cwdSpaceOrigin = "";
  try {
    cwdSpaceOrigin = JSON.parse(readFileSync(path.join(process.cwd(), "space.json"), "utf8")).siteOrigin || "";
  } catch (e) {}
  return (process.env.AUGUR_ORIGIN || env.AUGUR_ORIGIN ||
    deployConfig(root, originHost(cwdSpaceOrigin)).siteOrigin || cwdSpaceOrigin || pairedOrigin() || "")
    .replace(/\/+$/, "");
}

/**
 * The origin this machine last paired with, when nothing else names one. A cold agent
 * in an empty folder has just run `augur connect --origin X` and holds a token for X and
 * nothing else — and `clone`/`open` then refused with "no target origin" until it typed
 * AUGUR_ORIGIN, which the front door had told it the pairing would carry. One saved
 * pairing is the answer; several is the most recent, said on stderr so a wrong guess is
 * visible before anything is written.
 */
export function pairedOrigin() {
  try {
    const saved = JSON.parse(readFileSync(path.join(os.homedir(), ".config", "augur", "tokens.json"), "utf8"));
    const hosts = Object.entries(saved).filter(([h, v]) => h && v && v.token);
    if (!hosts.length) return "";
    hosts.sort((a, b) => String(b[1].at || "").localeCompare(String(a[1].at || "")));
    const [host] = hosts[0];
    if (hosts.length > 1) console.error(`[augur] no origin named — using the last pairing, https://${host} (set AUGUR_ORIGIN to pick another)`);
    return `https://${host}`;
  } catch (e) { return ""; }
}

export function resolveToken(origin, root = ENGINE_ROOT) {
  if (process.env.AUGUR_TOKEN) return process.env.AUGUR_TOKEN;
  return pairedToken(origin) || readEnvFile(path.join(root, ".env.deploy")).AUGUR_TOKEN || "";
}

/** The token `augur connect` saved for this origin's host, or "". */
export function pairedToken(origin) {
  if (!origin) return "";
  try {
    const saved = JSON.parse(readFileSync(path.join(os.homedir(), ".config", "augur", "tokens.json"), "utf8"));
    return (saved[new URL(origin).host] || {}).token || "";
  } catch (e) { return ""; }
}

// Both, with the failure messages a human can act on. `needToken: false` for the
// read-only paths that only touch the public build stamp.
export function target({ root = ENGINE_ROOT, needToken = true } = {}) {
  const origin = resolveOrigin(root);
  if (!origin) {
    throw new Error('no target origin — set AUGUR_ORIGIN, or add "siteOrigin" to space.json.');
  }
  const token = resolveToken(origin, root);
  if (needToken && !token) {
    throw new Error("no publish token — run `augur connect` (or `augur login`, which uses your web credentials) once.");
  }
  return { origin, token };
}

// One fetch wrapper for the whole publish API: bearer auth, non-2xx throws with
// enough of the body to diagnose, 204 tolerated.
export function apiClient(origin, token) {
  const headers = { Authorization: `Bearer ${token}` };
  return async function req(pathPart, init = {}) {
    const url = `${origin}/__publish/${pathPart}`;
    const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!r.ok && r.status !== 204) {
      const body = await r.text().catch(() => "");
      throw new Error(`${init.method || "GET"} ${url} → ${r.status} ${body.slice(0, 300)}`);
    }
    return r;
  };
}

// The public build stamp — the one read that needs no credential at all. Always
// cache-busted: the CDN serves this stale for a minute or two after a publish, and
// a stale read is how you "confirm" the previous state.
export async function buildStamp(origin) {
  const r = await fetch(`${origin}/_build.json?t=${Date.now()}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${origin}/_build.json → ${r.status}`);
  return r.json();
}

// Every publishable id at this instance: the spaces plus the engine-chrome
// pseudo-space, which the stamp reports separately.
export const idsFromStamp = (stamp) => [...Object.keys(stamp.spaces || {}).sort(), "_engine"];

export const ENGINE_ID = "_engine";

// The publish protocol this CLI speaks, declared on every commit as `clientProtocol`.
// One source for every client that commits (publish, restore) — two copies would drift,
// and a client that MISDECLARES its protocol is worse than one that declares nothing:
// the server would wave through guards it cannot actually honour.
//
// Bump this when the CLI learns a new commit-side guard, not when the worker does.
//   1  the original digest protocol
//   2  unpublish guard (`allowUnpublish`)
//   3  revert guard (`baseVersion` + per-unit reconciliation)
//   4  safe adoption: the reconcile writes AUTHORED bytes back into the tree (full
//      build-decoration peel) and never deletes internal files live can't testify
//      about. A protocol-3 reconcile wrote dist-baked pages into a space repo as one
//      person's authorship and deleted research material — an instance that has seen
//      that once sets `minClientProtocol: 4` and old clients self-update on contact.
//   5  composed publish: the live manifest is the base and the client ships per-unit
//      fast-forwards only (git evidence), so adoption and tree writes are GONE — a
//      stale checkout can no longer revert, unpublish, or fork what it never edited.
//      The protocol-4 reconcile still mass-forked under a cache base (the 2026-08-22
//      cascade: 392 false -conflict- units live); a pre-5 client re-litters, so the
//      reference instance floors at 5.
export const CLIENT_PROTOCOL = 5;
