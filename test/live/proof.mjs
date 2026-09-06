#!/usr/bin/env node
// test/live/proof.mjs — prove the rig end to end before any drill runs on it.
//
//   sign in as the owner with a real mailed code → approve a pairing → hold a token →
//   read presence and history on the first unit as the terminal and as the browser.
import { UNITS, now } from "./env.mjs";
import { human, token, client } from "./persona.mjs";

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const who = process.argv[2] || "owner";
const unit = UNITS()[0];

step(`sign in as ${who} (mail → code → cookie)`);
const h = await human(who);
step(`signed in; cookie held; mail subject: ${h.mail && h.mail.subject}`);

step("pair a terminal as that person");
const t = await token(who, { fresh: true });
if (t.refused) { step(`pairing refused: ${JSON.stringify(t.refused)}`); process.exit(0); }
step(`token scope: ${t.space}`);

step(`presence + history on ${unit}, from the terminal`);
const c = await client(who, "proof");
console.log("  presence:", JSON.stringify(await c.presence(unit)).slice(0, 200));
step("history from the browser");
console.log("  history:", JSON.stringify(await h.history(unit)).slice(0, 200));
step(`drafts index: ${JSON.stringify(await h.drafts()).slice(0, 200)}`);
step(`done at ${now()}`);
