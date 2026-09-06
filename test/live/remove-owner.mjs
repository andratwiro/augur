#!/usr/bin/env node
// remove-owner.mjs — the last suite person off the workspace through the admin operation,
// which is the one path that revokes sessions and tokens as it removes.
import { addressOf } from "./env.mjs";
import { human } from "./persona.mjs";

const owner = await human("owner");
const before = await owner.users(process.env.LIVE_SPACE);
const box = process.env.LIVE_MAILBOX; const [local, dom] = box.split("@");
const ours = (before.users || []).filter((u) => u.email.startsWith(local + "+") && u.email.endsWith("@" + dom));
console.log(`suite people the object still lists: ${ours.map((u) => u.email.replace(local, "<qa>") + ":" + u.role).join(", ") || "none"}`);
for (const u of ours.filter((u) => u.email !== addressOf("owner"))) {
  console.log(`  admin remove ${u.email.replace(local, "<qa>")}: ${(await owner.admin({ op: "remove", email: u.email })).status}`);
}
const self = await owner.admin({ op: "remove", email: addressOf("owner") });
console.log(`owner removes themself: ${self.status} ${JSON.stringify(self).slice(0, 160)}`);
const after = await owner.get("/__admin/tokens");
console.log(`owner cookie afterwards: ${after.status}`);
