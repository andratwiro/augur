// test/live/drills/lib.mjs — what every live drill does: open a draft into a folder as a
// persona, edit a file, save, land, sync, and look at what the site actually serves.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ORIGIN, RUN, now } from "../env.mjs";
import { client, human, draftDir } from "../persona.mjs";
import { doOpen, doSave, doLand, doSync, doClose, readState } from "../../../scripts/lib/draft.mjs";

export { assert, RUN };

/** Open `unit` as `persona` under session label `session`; returns {dir, client, r}. */
export async function open(persona, session, unit, label = session) {
  const c = await client(persona, session);
  const dir = draftDir(persona, label.replace(/[^a-z0-9-]/gi, "-"));
  let r = await doOpen({ client: c, unit, dir, origin: ORIGIN(), space: process.env.LIVE_SPACE, session, now: now() });
  if (!r.ok && r.error === "network") r = await doOpen({ client: c, unit, dir, origin: ORIGIN(), space: process.env.LIVE_SPACE, session, now: now() });
  if (!r.ok) throw new Error(`open ${unit} as ${persona}/${session}: ${JSON.stringify(r)}`);
  return { dir, client: c, r, unit, persona, session };
}

export const draftIdOf = (d) => readState(d.dir).draftId;
export const stateOf = (d) => readState(d.dir);

/** Read/write files in a draft folder. */
export const readFile = (d, rel) => fs.readFileSync(path.join(d.dir, rel), "utf8");
export function writeFile(d, rel, text) {
  const p = path.join(d.dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
export const listFiles = (d) => fs.readdirSync(d.dir, { recursive: true }).filter((f) => !String(f).startsWith(".augur")).map(String).sort();

/** A stamp only this run and this session could have written. */
export const stamp = (d, extra = "") => `<!-- ${RUN} ${d.persona}/${d.session} ${extra} -->`;

export const save = (d, more = {}) => doSave({ client: d.client, dir: d.dir, ...more });
export const land = (d, note) => doLand({ client: d.client, dir: d.dir, note: note || `${RUN} ${d.session}` });
export const sync = (d) => doSync({ client: d.client, dir: d.dir });
export const close = (d, discard = false) => doClose({ client: d.client, dir: d.dir, discard });

/** What the site serves at a path, seen by a signed-in member (main or a draft address). */
export async function served(pathname, persona = "owner") {
  const h = await human(persona);
  const r = await h.get(pathname);
  return { status: r.status, text: await r.text() };
}
/** The draft address the server handed out at open, as a path, with a file under it. */
export const draftAddress = (d, rel = "index.html") => `${new URL(d.r.address).pathname}${rel}`;
export const mainAddress = (unit, rel = "index.html") => `${unit}${rel}`;

/** Main's file table for a unit, as the terminal reads it. */
export const mainTable = async (d) => (await d.client.main(d.unit)).table || {};

/** Wait until `fn` returns truthy, polling — for the serve path's short cache. */
export async function until(fn, { timeoutMs = 15000, everyMs = 750, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Discard every open draft on a unit and restore its first landing, so a unit is clean. */
export async function resetUnit(unit, persona = "owner") {
  const h = await human(persona);
  const p = await h.presence(unit);
  for (const dr of p.drafts || []) await h.discardFromBar(unit, dr.id || dr.draftId);
  const hist = await h.history(unit);
  if (hist.revision && hist.revision > 1) {
    const r = await h.restore(unit, 1, `${RUN} reset`);
    return r;
  }
  return { untouched: true };
}
