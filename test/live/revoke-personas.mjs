#!/usr/bin/env node
// revoke-personas.mjs — leave no credential behind: put the owner back on the roster just
// long enough to revoke every token the suite minted through the admin route, remove the
// other three people through the admin operation (which revokes as it goes), then take the
// owner off again. Verifies each cached token answers a refusal afterwards.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORIGIN, PERSONAS, addressOf, workDir } from "./env.mjs";
import { human } from "./persona.mjs";

const ROSTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "roster.mjs");
const box = process.env.LIVE_MAILBOX; const [local, dom] = box.split("@");
const ours = (label) => String(label || "").startsWith(local + "+") && String(label || "").endsWith("@" + dom);

execFileSync(process.execPath, [ROSTER, "add"], { env: process.env, stdio: "pipe" });
const owner = await human("owner");
const list = await owner.json("/__admin/tokens", null, "GET");
const mine = Object.entries(list.tokens || {}).filter(([, t]) => ours(t.label));
console.log(`suite tokens on the workspace: ${mine.length}`);
for (const [hash, t] of mine) {
  const r = await owner.json("/__admin/tokens", { hash }, "DELETE");
  console.log(`  revoke ${t.space} ${t.label.replace(local, "<qa>")}: ${r.status}`);
}
for (const p of ["editor", "editor2", "viewer"]) {
  const r = await owner.admin({ op: "remove", email: addressOf(p) });
  console.log(`  admin remove ${p}: ${r.status}`);
}
execFileSync(process.execPath, [ROSTER, "remove"], { env: process.env, stdio: "pipe" });
for (const p of Object.keys(PERSONAS)) {
  const f = path.join(workDir("tokens"), `${p}.json`);
  if (!fs.existsSync(f)) continue;
  const { token } = JSON.parse(fs.readFileSync(f, "utf8"));
  const r = await fetch(`${ORIGIN()}/__unit/drafts`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`  ${p} cached token now: ${r.status}`);
}
const again = await owner.json("/__admin/tokens", null, "GET");
console.log(`owner cookie after own removal: ${again.status}`);
