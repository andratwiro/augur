// The deploy entry is an export manifest, and that has to stay true.
//
// src/entry.js exists so a Workers deploy can declare things Pages cannot (a Durable
// Object class, a scheduled handler). The danger is that it is also the most convenient
// place anyone will ever find to "just add one check" — and request logic added there
// runs on Workers instances and is absent on Pages instances, while every test in this
// repo drives src/_worker.js and stays green either way. So the boundary is read out of
// the source rather than asserted in a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import entry from "../src/entry.js";
import worker from "../src/_worker.js";

const SRC = fs.readFileSync(fileURLToPath(new URL("../src/entry.js", import.meta.url)), "utf8");
// Comments are where the rule is explained, so they are stripped before it is checked.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the entry's default export IS the worker's, not a copy of it", () => {
  assert.equal(entry, worker, "src/entry.js must re-export src/_worker.js's default, unwrapped");
  assert.equal(typeof entry.fetch, "function");
});

test("the entry holds no request logic", () => {
  for (const [re, what] of [
    [/new Response\s*\(/, "a Response is constructed here"],
    [/\bfetch\s*\(\s*request/, "a request is fetched here"],
    [/\bawait\b/, "there is asynchronous work here"],
    [/\bif\s*\(/, "there is a branch here"],
    [/request\.(?:url|headers|method)/, "the request is inspected here"],
  ]) {
    assert.ok(!re.test(CODE), `${what}. src/entry.js is an export manifest: Pages instances read src/_worker.js and never see this file, so logic here ships to some instances and not others.`);
  }
});

test("the entry is small enough that nobody mistakes it for a module", () => {
  const lines = CODE.split("\n").filter((l) => l.trim()).length;
  assert.ok(lines <= 12, `src/entry.js has ${lines} lines of code; it should be a handful of imports and exports`);
});

test("the tenant-globals lint follows the deploy entry, not the old one", () => {
  // check.yml runs no-tenant-globals with NO arguments on purpose, so its ENTRY constant
  // decides what gets scanned. If the deploy entry moves and the constant does not, any
  // module reachable only from the new entry is silently unscanned — the exact escape by
  // omission that lint exists to catch.
  return import("../scripts/no-tenant-globals.mjs").then((m) => {
    assert.equal(m.ENTRY, "src/entry.js", "scripts/no-tenant-globals.mjs ENTRY must name the file wrangler's `main` points at");
  });
});

test("the shell template's main names the same entry the lint scans", () => {
  // Two files could disagree about which one is the deploy entry, and the disagreement
  // would be invisible: the lint would pass over the wrong graph and the deploy would
  // still work.
  const tpl = fileURLToPath(new URL("../templates/shell/wrangler.example.toml", import.meta.url));
  if (!fs.existsSync(tpl)) return; // the template lands in the same slice; skip until it does
  const main = (fs.readFileSync(tpl, "utf8").match(/^\s*main\s*=\s*"([^"]+)"/m) || [])[1];
  assert.ok(main, "the wrangler template declares no `main`");
  assert.ok(main.endsWith("src/entry.js"), `the template's main is ${main}, which is not the entry the lint scans`);
});
