// The `invited` variant of the live first-experience rig (test/live/first-experience/),
// tested at the level that runs with no network, no persona, no live workspace: the
// person's opener instruction, the browser tool's verb/path guards and page rendering,
// and the mail link extraction the person's own `./inbox` tool relies on.
//
// Everything ELSE about that variant — a real invite mail, a person with no session,
// `Human.acceptInvite`'s form POST, the `/__onboarding/me` polling — needs a live
// workspace and is exercised by the live suite itself (`test/live/first-experience/run.mjs
// invited`), never here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteOpenerInstruction } from "./live/first-experience/invited-lib.mjs";
import { canAccept, canType, renderPageText, typeSuccessMessage, meStateLine } from "./live/first-experience/human-tools/browser-lib.mjs";
import { parseCredentialMail } from "./live/inbox.mjs";
import { PERSONAS, ROSTER_PERSONAS, folderOf } from "./live/env.mjs";

test("inviteOpenerInstruction names both tools and asks for the command verbatim", () => {
  const msg = inviteOpenerInstruction();
  assert.match(msg, /\.\/inbox/);
  assert.match(msg, /\.\/browser/);
  assert.match(msg, /--accept/);
  assert.match(msg, /Quote the command exactly/);
  // No pasteable agent prompt on any screen (global-constraints.md) — this instruction is
  // addressed to the PERSON about tools they hold, not text meant to be handed to an agent.
  assert.doesNotMatch(msg, /npx|npm|token|claude/i);
});

test("canAccept — only an invite redemption link", () => {
  assert.equal(canAccept("/__invite"), true);
  assert.equal(canAccept("/__invite?t=abc"), true, "canAccept is called with a pathname only, but must not choke on one that still carries a query string");
  assert.equal(canAccept("/__welcome"), false);
  assert.equal(canAccept("/__connect"), false);
  assert.equal(canAccept("/start-here/abc123/"), false);
});

test("canType — the connect page and the welcome flow's own approve form, nothing else", () => {
  assert.equal(canType("/__connect"), true);
  assert.equal(canType("/__welcome"), true);
  assert.equal(canType("/__invite"), false);
  assert.equal(canType("/start-here/abc123/"), false);
});

test("renderPageText strips scripts/styles/tags for an HTML response and leaves anything else alone", () => {
  const html = `<html><head><style>.x{color:red}</style></head><body><script>evil()</script><h1>Hi&nbsp;there</h1></body></html>`;
  assert.equal(renderPageText(html, "text/html; charset=utf-8"), "Hi there");
  const json = `{"paired":true}`;
  assert.equal(renderPageText(json, "application/json"), json, "a non-HTML body is returned verbatim");
});

test("parseCredentialMail pulls the invite link out of a realistic roster-invite mail body", () => {
  // The exact shape src/mail.mjs's textBody() produces: paragraphs, then the bare link on
  // its own line, then the footer — this is what the person's ./inbox prints, and what
  // inbox.mjs's own "Link:" line (added for this variant) is parsed from.
  const text = [
    "QA Owner invited you to Acme.",
    "It is where the team's prototypes live: pages your coding agent builds and shares as real links.",
    "Open it and it walks you through connecting your agent; the first thing you make appears on your own page.",
    "The link can be used once, and stops working in 72 hours.",
    "",
    "https://acme.example/__invite?t=abcDEF123456",
    "",
    "If you weren't expecting this, ignore this message.",
  ].join("\n\n");
  const { link } = parseCredentialMail(text);
  assert.equal(link, "https://acme.example/__invite?t=abcDEF123456");
});

test("typeSuccessMessage — the welcome page's own words after approval, not the connect page's", () => {
  assert.equal(typeSuccessMessage("/__welcome"), "Connected. Press Next.");
  assert.equal(typeSuccessMessage("/__connect"), "Connected. You can close this tab.");
  // canType also allows a query string / trailing detail on the pathname; the message
  // selection must not choke on it either.
  assert.equal(typeSuccessMessage("/__welcome/"), "Connected. Press Next.");
});

test("meStateLine — what the change step would say, in the person's own words, for the three states --next can read", () => {
  assert.equal(meStateLine({ paired: false }), "Waiting for a terminal…");
  assert.equal(meStateLine(null), "Waiting for a terminal…");
  assert.equal(
    meStateLine({ paired: true, unit: "/start-here/qa-invitee/", url: "https://acme.example/start-here/qa-invitee/", landed: false }),
    'Your page is live at https://acme.example/start-here/qa-invitee/. Ask your assistant to open start-here/qa-invitee and change the line on it.',
  );
  assert.equal(
    meStateLine({ paired: true, unit: "/start-here/qa-invitee/", url: "https://acme.example/start-here/qa-invitee/", landed: true }),
    'It\'s live: https://acme.example/start-here/qa-invitee/. Press Next, then "Open the workspace".',
  );
});

test("the invited variant's person is addressable and files into its own mail folder, but is excluded from the roster-overlay shortcut", () => {
  assert.ok(PERSONAS.invitee, "env.mjs must carry an `invitee` persona");
  assert.equal(folderOf("invitee"), "invitee");
  assert.ok(!ROSTER_PERSONAS.includes("invitee"),
    "ROSTER_PERSONAS must exclude invitee — they arrive only through a real admin invite, " +
    "never through roster.mjs's state-import shortcut, or the variant's own invite call " +
    "would answer already-a-user");
  assert.ok(ROSTER_PERSONAS.includes("owner") && ROSTER_PERSONAS.includes("editor")
    && ROSTER_PERSONAS.includes("editor2") && ROSTER_PERSONAS.includes("viewer"),
    "every other persona is unaffected");
});
