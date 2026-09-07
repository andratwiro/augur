// Which token a CLI verb acts with — because a draft and a landing are RECORDED under it.
//
// The token's label is who the landing was by. A pairing (`augur connect`) is labelled
// with the person's address; a token in the engine clone's `.env.deploy` is the machine's,
// labelled by whoever minted it for a deploy shell's CI. Read the file first and every
// landing made from a maintainer's clone was that token's: the gallery chip showed "?"
// and the history named nobody, while a perfectly good pairing for the same host sat
// unused in tokens.json. So: explicit env, then the pairing for this origin, then the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveToken, pairedToken } from "../scripts/lib/store.mjs";

function rig({ paired, file }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "augur-engine-"));
  if (paired) {
    fs.mkdirSync(path.join(home, ".config", "augur"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "augur", "tokens.json"),
      JSON.stringify({ "ws.example.test": { token: paired, email: "ana@example.test", at: "2026-09-01T00:00:00Z" } }));
  }
  if (file) fs.writeFileSync(path.join(root, ".env.deploy"), `AUGUR_ORIGIN=https://ws.example.test\nAUGUR_TOKEN=${file}\n`);
  return { home, root };
}

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test("the pairing for this origin beats the engine clone's .env.deploy token", async () => {
  const { home, root } = rig({ paired: "paired-person", file: "machine-ci" });
  await withEnv({ HOME: home, AUGUR_TOKEN: undefined }, () => {
    assert.equal(pairedToken("https://ws.example.test"), "paired-person");
    assert.equal(resolveToken("https://ws.example.test", root), "paired-person");
  });
});

test("with no pairing for the origin, the .env.deploy token still serves", async () => {
  const { home, root } = rig({ paired: "paired-person", file: "machine-ci" });
  await withEnv({ HOME: home, AUGUR_TOKEN: undefined }, () => {
    assert.equal(resolveToken("https://other.example.test", root), "machine-ci", "a different host has no pairing");
    assert.equal(resolveToken("", root), "machine-ci", "no origin at all → the file");
  });
  const bare = rig({ file: "machine-ci" });
  await withEnv({ HOME: bare.home, AUGUR_TOKEN: undefined }, () => {
    assert.equal(resolveToken("https://ws.example.test", bare.root), "machine-ci");
  });
});

test("an explicit AUGUR_TOKEN beats both — CI, the suites and a person choosing set it on purpose", async () => {
  const { home, root } = rig({ paired: "paired-person", file: "machine-ci" });
  await withEnv({ HOME: home, AUGUR_TOKEN: "chosen" }, () => {
    assert.equal(resolveToken("https://ws.example.test", root), "chosen");
  });
});

test("nothing anywhere is an empty string, not a throw", async () => {
  const { home, root } = rig({});
  await withEnv({ HOME: home, AUGUR_TOKEN: undefined }, () => {
    assert.equal(resolveToken("https://ws.example.test", root), "");
    assert.equal(pairedToken("not a url"), "");
  });
});
