// Nothing on the welcome page is a dead end, and the download is never required.
//
// A person who runs a terminal already — or who did once and now sits on the install step
// this browser remembered — has to be able to get the command and approve a code from the
// page itself. On 7 Sep 2026 the install step offered a download, a code field and nothing
// else, and a code in the link only moved a browser off the FIRST question: one that had
// visited the install step before stayed there, download button first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWelcomePage } from "../src/welcome-page.mjs";

const html = renderWelcomePage({ origin: "https://ws.example.test", me: { email: "ana@example.test" } });
const step = (name) => { const m = html.match(new RegExp(`<section data-step="${name}">([\\s\\S]*?)</section>`)); assert.ok(m, `the ${name} step renders`); return m[1]; };

test("the install step offers the command, and the connect step offers the download — each is one click from the other", () => {
  assert.match(step("install"), /data-go="connect"/, "install → connect");
  assert.match(step("connect"), /data-go="install"/, "connect → install");
  assert.match(step("install"), /data-approve/, "a code can be approved from the install step too");
  assert.match(step("connect"), /data-approve/, "and from the connect step");
});

test("a code in the link opens the connect step whatever this browser remembered", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /if \(linkCode\) \{\s*at = "connect";/, "no step keeps a code away from the command");
  assert.doesNotMatch(script, /if \(at === "agent"\) at = "connect"/);
});

test("an expired code tells the person what to do, in the terminal's terms", () => {
  assert.match(html, /That code has expired\. Run the command again for a fresh one\./);
});

test("the code from the link is written into EVERY approve field — the helper that returns them all, not the first", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /\$\$\("\[data-approve\] input\.code"\)\.forEach/, "a single-element query has no forEach, and the page dies before its buttons are wired");
});
