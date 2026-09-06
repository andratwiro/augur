// Probe: two fresh sign-ins for one person inside the mailer's cooldown.
//   The first may mail (or go through a kept account session); the second MUST go through
//   the account session — no mail, a workspace cookie within seconds. This is what lets a
//   drill revoke somebody's session twice in a row and stay green.
import { human } from "./persona.mjs";

const who = process.argv[2] || "editor2";
for (const n of [1, 2]) {
  const t0 = Date.now();
  const h = await human(who, { fresh: true });
  console.log(`sign-in ${n}: ${((Date.now() - t0) / 1000).toFixed(1)} s, workspace cookie ${h.cookie ? "yes" : "no"}, account session ${h.accountCookie ? "kept" : "none"}, mailed ${h.mail ? "yes" : "no"}`);
  delete h.mail;
}
