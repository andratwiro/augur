#!/usr/bin/env node
// browser.mjs — "your browser", as the human session sees it.
//
//   browser <url>                  open a page and read it (as text)
//   browser <url> --type <code>    type a code into the page's box and press the button
//
// The page is fetched as the persona named in LIVE_HUMAN (default owner), signed in; the
// person never sees a sign-in screen because they were already signed in to their
// workspace when they handed the assistant the link.
import { human } from "../../persona.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const typeAt = args.indexOf("--type");
const code = typeAt > -1 ? args[typeAt + 1] : null;
const who = process.env.LIVE_HUMAN || "owner";
if (!url) { console.log("usage: browser <url> [--type <code>]"); process.exit(2); }

const h = await human(who);
const u = new URL(url);
if (u.origin !== h.origin) {
  console.log(`You open ${url}. It is not your workspace's site (${h.origin}); you close the tab.`);
  process.exit(0);
}
if (code) {
  if (!/__connect/.test(u.pathname)) {
    console.log(`There is no box to type a code into on ${u.pathname}.`);
    process.exit(0);
  }
  const r = await h.approvePairing(code.replace(/[^A-Za-z0-9]/g, ""));
  if (r.status === 200) console.log(`You type ${code} and press Approve. The page says: "Connected. You can close this tab."`);
  else console.log(`You type ${code} and press Approve. The page says: "${r.message || r.error || "Something went wrong"}" (${r.status})`);
  process.exit(0);
}
const r = await h.get(u.pathname + u.search);
const raw = await r.text();
const ct = r.headers.get("content-type") || "";
let text = raw;
if (/html/.test(ct)) {
  text = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
console.log(`[${r.status}] ${url}`);
console.log(text.slice(0, 2500) || "(a blank page)");
