#!/usr/bin/env node
// browser.mjs — "your browser", as the human session sees it.
//
//   browser <url>                  open a page and read it (as text)
//   browser <url> --type <code>    type a code into the page's box and press the button
//   browser <url> --accept         follow a passwordless invite link (keeps the cookie)
//   browser <url> --next           press "Next" (client-side only: re-reads the status)
//   browser <url> --finish         press "Open the workspace" (posts done:true)
//
// The page is fetched as the persona named in LIVE_HUMAN (default owner), signed in; the
// person never sees a sign-in screen because they were already signed in to their
// workspace when they handed the assistant the link — EXCEPT for `--accept`, whose whole
// point is that this person has no session at all until the invite link gives them one.
import { human, saveCookies } from "../../persona.mjs";
import { canAccept, canType, renderPageText } from "./browser-lib.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const typeAt = args.indexOf("--type");
const code = typeAt > -1 ? args[typeAt + 1] : null;
const accept = args.includes("--accept");
const next = args.includes("--next");
const finish = args.includes("--finish");
const who = process.env.LIVE_HUMAN || "owner";
if (!url) { console.log("usage: browser <url> [--type <code>] [--accept] [--next] [--finish]"); process.exit(2); }

// `noSignIn` for --accept only: this is the one call that is allowed to hold no session
// yet. Every other verb behaves exactly as it always has — signed in, or nothing to do.
const h = await human(who, accept ? { noSignIn: true } : {});
const u = new URL(url);
if (u.origin !== h.origin) {
  console.log(`You open ${url}. It is not your workspace's site (${h.origin}); you close the tab.`);
  process.exit(0);
}

if (accept) {
  if (!canAccept(u.pathname)) {
    console.log(`There is nothing to accept at ${u.pathname} — it is not an invite link.`);
    process.exit(0);
  }
  const r = await h.acceptInvite(url);
  saveCookies(who); // a later `./browser` call is a fresh process; the cookie has to survive it
  if (!r.ok) {
    console.log(`You open the link. The page says: "This link is no longer valid. Ask for a new one." (${r.status})`);
    process.exit(0);
  }
  console.log(`You open the link and it signs you straight in — no password. It takes you to ${r.landedUrl}.`);
  console.log(renderPageText(r.text, "text/html").slice(0, 2500) || "(a blank page)");
  process.exit(0);
}

if (code) {
  if (!canType(u.pathname)) {
    console.log(`There is no box to type a code into on ${u.pathname}.`);
    process.exit(0);
  }
  const r = await h.approvePairing(code.replace(/[^A-Za-z0-9]/g, ""));
  if (r.status === 200) console.log(`You type ${code} and press Approve. The page says: "Connected. You can close this tab."`);
  else console.log(`You type ${code} and press Approve. The page says: "${r.message || r.error || "Something went wrong"}" (${r.status})`);
  process.exit(0);
}

if (next || finish) {
  // "Next" is client-side state on the welcome page — nothing to press on the server, so
  // this just re-reads the workspace's own record of where the person is. "Open the
  // workspace" is the one button on that page that actually writes something.
  if (finish) {
    const r = await h.json("/__onboarding/me", { done: true });
    console.log(`You press "Open the workspace". The page sends you to your workspace. (${r.status})`);
  } else {
    const r = await h.json("/__onboarding/me", null, "GET");
    const line = r.landed ? `It's live: ${r.url}` : r.drafting ? "Your agent is editing…" : "Waiting for your agent…";
    console.log(`You press Next. The page now says: "${line}"`);
  }
  process.exit(0);
}

const r = await h.get(u.pathname + u.search);
const raw = await r.text();
const ct = r.headers.get("content-type") || "";
console.log(`[${r.status}] ${url}`);
console.log(renderPageText(raw, ct).slice(0, 2500) || "(a blank page)");
