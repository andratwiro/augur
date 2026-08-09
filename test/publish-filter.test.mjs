// Guards for the ship-verbatim filter — the single authoritative boundary between a
// space's working tree and public URLs.
//
// Publishing is folder-whitelisted (prototypes/, the gallery tiers, playground/), but
// INSIDE a shipped folder copyDir copies everything it finds, verbatim, minus whatever
// isInternalOnly() rejects. So that one predicate is what stands between a stray file in
// someone's working tree and a world-readable URL — and `augur publish` ships the WORKING
// TREE, so a file that was never committed (never filtered by .gitignore) still ships.
//
// build.js exports nothing, so these lift the predicate out of the source and run it for
// real, rather than asserting on the shape of the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../build.js", import.meta.url), "utf8");

// Pull the filter regexes and the isInternalOnly declaration out of build.js and rebuild
// the real function around them.
const reLines = SRC.split("\n").filter((l) => /^const (SECRET_FILE_RE|VCS_DIR_RE) = \//.test(l));
const fnStart = SRC.indexOf("function isInternalOnly(");
const fnSrc = SRC.slice(fnStart, SRC.indexOf("\n}", fnStart) + 2);
const isInternalOnly = new Function(`${reLines.join("\n")}\n${fnSrc}\nreturn isInternalOnly;`)();

const ships = (name) => !isInternalOnly(name);

test("the predicate was actually lifted out of build.js", () => {
  assert.equal(reLines.length, 2, "both filter regexes were found in build.js");
  assert.equal(typeof isInternalOnly, "function");
});

test("research and context material never ships", () => {
  for (const n of ["research", "context", "research.md", "context.md"])
    assert.equal(ships(n), false, `${n} must not ship`);
});

test("env files never ship, whichever way they are named", () => {
  // `.env` and `.env.local` were always covered. A file named for its environment —
  // `prod.env` — is the same thing with the dot on the other side, and `augur publish`
  // ships the working tree, so gitignore is not the backstop here.
  for (const n of [".env", ".env.local", ".ENV", "prod.env", "staging.env", "local.env"])
    assert.equal(ships(n), false, `${n} must not ship`);
});

test("keys, credential dumps and secret-named files never ship", () => {
  for (const n of ["server.pem", "private.key", "cert.pfx", "id_rsa", "secrets.json",
                   "my-secrets.yml", "credentials", "aws-credentials.csv", "SECRET.md"])
    assert.equal(ships(n), false, `${n} must not ship`);
});

test("credential dotfiles never ship", () => {
  // Each of these is a credential store by definition; none has any business in a
  // published folder, and all of them are world-readable once one is.
  for (const n of [".npmrc", ".netrc", ".pgpass", ".htpasswd", ".ssh", ".aws", ".gnupg"])
    assert.equal(ships(n), false, `${n} must not ship`);
});

test("a nested VCS directory never ships", () => {
  // copyDir recurses into directories, so a repo checked out inside a shipped folder
  // would publish its entire history — every deleted file, every past commit — at a
  // public URL.
  for (const n of [".git", ".hg", ".svn"])
    assert.equal(ships(n), false, `${n} must not ship`);
});

test("ordinary prototype content still ships", () => {
  // The filter is a denylist, deliberately: prototypes ship fixture data, and blocking a
  // whole extension would break real content. This asserts the denylist stays narrow.
  for (const n of ["index.html", "app.js", "styles.css", "data.json", "fixtures.csv",
                   "notes.txt", "README.md", "photo.png", "design-tokens.json",
                   "password-field.html", "id_rsa.pub"])
    assert.equal(ships(n), true, `${n} must still ship`);
});
