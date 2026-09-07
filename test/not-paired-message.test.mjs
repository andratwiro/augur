// What a verb says when this machine is not paired — and to whom.
//
// The reader is an agent; the person it works with is the one who has to act. So the
// message names the workspace, carries the whole command for THIS machine, says who runs
// it and what they press, and says nothing about passwords except that none is involved.
// A bare "run `augur connect`" left the agent guessing at the origin and the person out of
// the sentence — and a person who is never told never pairs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { target, notPairedMessage, connectLine } from "../scripts/lib/store.mjs";
import { explainRefusal, tokenNotAccepted, TOKEN_NOT_ACCEPTED } from "../scripts/lib/draft.mjs";

const ORIGIN = "https://ws.example.test";
const saysItAll = (m) => {
  assert.match(m, new RegExp(ORIGIN.replace(/[.]/g, "\\.")), "names the workspace");
  assert.match(m, /connect --origin https:\/\/ws\.example\.test/, "carries the whole command, origin included");
  assert.match(m, /(augur|npx @augurworks\/augur) connect/, "spelled the way this machine can run it");
  assert.match(m, /member you are working with runs this/, "says who runs it");
  assert.match(m, /THIS machine/, "and where");
  assert.match(m, /Approve/, "and what they press");
  assert.match(m, /run this command again/i, "and what happens next");
  assert.match(m, /no password is involved/i, "and says so about passwords, asking for none");
};

test("no token at all: the verb's refusal is the whole instruction", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "augur-engine-"));
  const prev = { HOME: process.env.HOME, AUGUR_TOKEN: process.env.AUGUR_TOKEN, AUGUR_ORIGIN: process.env.AUGUR_ORIGIN };
  process.env.HOME = home; delete process.env.AUGUR_TOKEN; process.env.AUGUR_ORIGIN = ORIGIN;
  try {
    assert.throws(() => target({ root }), (e) => { saysItAll(e.message); assert.match(e.message, /^no publish token for /); return true; });
  } finally {
    process.env.HOME = prev.HOME;
    if (prev.AUGUR_TOKEN === undefined) delete process.env.AUGUR_TOKEN; else process.env.AUGUR_TOKEN = prev.AUGUR_TOKEN;
    if (prev.AUGUR_ORIGIN === undefined) delete process.env.AUGUR_ORIGIN; else process.env.AUGUR_ORIGIN = prev.AUGUR_ORIGIN;
  }
  saysItAll(notPairedMessage(ORIGIN));
  assert.match(connectLine(ORIGIN), /connect --origin https:\/\/ws\.example\.test$/);
});

test("a token the workspace refuses: the same instruction, plus why", () => {
  const r = explainRefusal({ error: "forbidden" }, 403, ORIGIN);
  saysItAll(r.message);
  assert.match(r.message, /revoked|expired|another workspace/);
  assert.equal(r.error, "forbidden", "the error code survives for callers that branch on it");
  // A refusal the server explained keeps its own sentence.
  assert.equal(explainRefusal({ error: "forbidden", message: "viewers may not" }, 403, ORIGIN).message, "viewers may not");
  // No origin known: the generic sentence, unchanged.
  assert.equal(tokenNotAccepted(""), TOKEN_NOT_ACCEPTED);
});
