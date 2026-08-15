// Guards the dev.mjs / dev@local login fix. dev.mjs documents a dev@local / "dev"
// fallback login (used when no deploy shell / identity file is found) — but it used
// to seed a PLAINTEXT `pass: "dev"` field while the worker's verifyPassword() accepts
// only a `pbkdf2$…` hash (src/_worker.js: effectiveSecret/verifyPassword), so the
// documented login reproducibly 401ed. This is the ONE sanctioned local fallback the
// engine's agent-contract docs point to when publishing isn't possible, so a broken
// login there is a real dead end, not a cosmetic bug.
//
// dev.mjs has no exports (it's a script whose job is to spawn a real wrangler dev
// server for its side effect) — spawning it for real would need npx to fetch
// wrangler and boot a live worker, well outside this suite's zero-dependency
// `node --test` contract (see .github/workflows/test.yml's own header comment). So
// this checks the two things that stay checkable without that: (1) dev.mjs's source
// seeds a real passHash via the SAME hashing function the real auth path uses, never
// a plaintext `pass` field, and (2) that exact code path — hashPassword("dev") through
// verifyPassword — really does authenticate "dev" and reject everything else, proven
// against the genuine worker functions (nothing reimplemented here). Manually verified
// end to end too: booting dev.mjs for real and POSTing the credential to /__auth
// returns a session, not a 401 (see the PR description for the transcript).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __testables as W } from "../src/_worker.js";

const SRC = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");

test("dev.mjs seeds a real passHash via the worker's own hashPassword — never a plaintext pass", () => {
  assert.match(SRC, /__testables\.hashPassword\(\s*["']dev["']\s*\)/,
    "must derive the seed through the real hashing function, not a hand-rolled one");
  assert.match(SRC, /passHash/, "the roster entry must carry passHash");
  // The exact regression this guards against: a bare `pass: "dev"` field. Word-bounded
  // so it doesn't false-positive on `passHash`.
  assert.doesNotMatch(SRC, /\bpass\s*:\s*["']dev["']/,
    "must not seed a plaintext `pass` field — verifyPassword() only ever accepts a hash");
});

test("dev.mjs imports the real worker hashing rather than a private reimplementation", () => {
  assert.match(SRC, /from\s+["']\.\.\/src\/_worker\.js["']/,
    "the hash must come from the same code the real auth path runs, so the two can never drift apart");
});

test("the seeded credential actually authenticates end to end (real worker functions)", async () => {
  // Exactly what dev.mjs now does: hash "dev" the same way a redeemed invite would.
  const passHash = await W.hashPassword("dev");
  assert.ok(W.isPassHash(passHash), "produces a pbkdf2$… string, not plaintext");
  const user = { email: "dev@local", name: "Dev", passHash, role: "admin" };

  // effectiveSecret with no KV binding (offline/raw build — dev.mjs's own local shell)
  // returns the roster value directly.
  const secret = await W.effectiveSecret(undefined, user);
  assert.equal(secret, passHash);

  assert.equal(await W.verifyPassword("dev", secret), true,
    'the documented dev@local / "dev" login must actually authenticate');
  assert.equal(await W.verifyPassword("wrong", secret), false);
});

test("(regression) the OLD plaintext seed never verifies — proves this is a real fix, not a no-op", async () => {
  // What dev.mjs used to write: `pass: "dev"`. effectiveSecret would still resolve it
  // (`u.passHash || u.pass`), so the account read as active — but verifyPassword
  // rejects any stored value that isn't a pbkdf2$… hash outright. This is the exact
  // shape of the original bug: a plausible-looking, permanently unusable account.
  const oldStylePlaintextSecret = "dev";
  assert.equal(await W.verifyPassword("dev", oldStylePlaintextSecret), false,
    "a bare plaintext stored value must never authenticate, however it got there");
});
