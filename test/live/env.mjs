// test/live/env.mjs — the live suite's one reading of its environment.
//
// Nothing under test/live/ names an instance, a domain, a person or a credential. Every
// address and secret arrives as a `LIVE_*` variable, set by a runner OUTSIDE this repo
// that reads them by path from wherever the deployment keeps them. A missing variable is
// a refusal with the variable's name, never a default: a live drill that silently ran
// against the wrong origin would be worse than one that did not run.
//
//   LIVE_ORIGIN        the workspace's origin, e.g. https://acme.example
//   LIVE_SPACE         the space id the unit routes belong to
//   LIVE_STAR_TOKEN    a star-scope publish token (state export/import, roster setup)
//   LIVE_MAILBOX       an address whose mailbox the suite can read; personas are
//                      plus-addresses on it (local+tag@domain)
//   LIVE_IMAP_HOST / LIVE_IMAP_USER / LIVE_IMAP_PASS   how to read that mailbox
//   LIVE_UNITS         comma-separated unit paths the drills may edit (old prototypes),
//                      e.g. /toolkit/cards-embed/,/broad-listening/queue/
//   LIVE_WORK          a folder for draft checkouts and registries (default: a temp dir)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`live suite: ${name} is not set — set it in the runner, never in the repo`);
  return v;
}

export const ORIGIN = () => need("LIVE_ORIGIN").replace(/\/$/, "");
export const SPACE = () => need("LIVE_SPACE");
export const STAR = () => need("LIVE_STAR_TOKEN");
export const UNITS = () => need("LIVE_UNITS").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * The hosted account origin and this workspace's id there — OPTIONAL. Set, the suite signs
 * a person back into the workspace through their account session (`/enter?workspace=`)
 * rather than by mailing a second code: the mailer withholds a code for an address that
 * was sent one inside MAIL_COOLDOWN_MS, so a drill that signs one person in twice would
 * otherwise wait out a timeout on a mail that never comes. Unset, every sign-in mails.
 */
export const ACCOUNT_ORIGIN = () => (process.env.LIVE_ACCOUNT_ORIGIN || "").replace(/\/$/, "");
export const WORKSPACE = () => process.env.LIVE_WORKSPACE || "";
/** How long the account store withholds a second code for one address (its `PROOF_MINT_COOLDOWN_MS`). */
export const MAIL_COOLDOWN_MS = Number(process.env.LIVE_MAIL_COOLDOWN_MS || 15 * 60 * 1000);

/** The people the suite plays, as plus-addresses on the readable mailbox. */
export const PERSONAS = Object.freeze({
  owner: { tag: "owner", name: "QA Owner", role: "admin", initials: "QO", color: "#7c3aed" },
  editor: { tag: "editor", name: "QA Editor", role: "editor", initials: "QE", color: "#0891b2" },
  editor2: { tag: "editor2", name: "QA Editor Two", role: "editor", initials: "Q2", color: "#059669" },
  viewer: { tag: "viewer", name: "QA Viewer", role: "viewer", initials: "QV", color: "#b45309" },
  // The `invited` variant's person: mailed a real invite, never added to the roster ahead
  // of time. Starts with no session and no cookie at all — see `human(..., {noSignIn})`.
  invitee: { tag: "invitee", name: "QA Invitee", role: "editor", initials: "QI", color: "#dc2626" },
});

/**
 * The personas `roster.mjs` provisions directly through the `users:roster` overlay
 * import — every persona EXCEPT `invitee`. That one exists to be added by a real admin
 * invite (the whole point of the `invited` variant), so a bulk `roster.mjs add` run
 * before it must not pre-create their membership through a shortcut that bypasses mail
 * entirely — that would make `owner.admin({op:"invite", …})` answer `already-a-user`
 * and the variant would have nothing left to test.
 */
export const ROSTER_PERSONAS = Object.keys(PERSONAS).filter((k) => k !== "invitee");

export function addressOf(persona) {
  const box = need("LIVE_MAILBOX");
  const at = box.indexOf("@");
  return `${box.slice(0, at)}+${PERSONAS[persona].tag}${box.slice(at)}`;
}
/** The mailbox folder a plus-tagged message lands in (the provider files by tag). */
export const folderOf = (persona) => PERSONAS[persona].tag;

export function imapConfig() {
  return { host: need("LIVE_IMAP_HOST"), user: need("LIVE_IMAP_USER"), pass: need("LIVE_IMAP_PASS") };
}

let workRoot = null;
/** A scratch folder for this run; one per process, removed by the caller when it wants to. */
export function workDir(sub = "") {
  if (!workRoot) {
    workRoot = process.env.LIVE_WORK || fs.mkdtempSync(path.join(os.tmpdir(), "augur-live-"));
    fs.mkdirSync(workRoot, { recursive: true });
  }
  const d = path.join(workRoot, sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();

/** A short stamp that makes every test edit recognisable and every run distinguishable. */
export const RUN = process.env.LIVE_RUN || `live-${Date.now().toString(36)}`;
