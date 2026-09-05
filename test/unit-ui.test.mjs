// test/unit-ui.test.mjs — the draft bar's script tag rides a unit's HTML for members.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { ctxFor, ADA, unitsNamespace } from "./fixtures/unit-env.mjs";

const U = "/checkout/flow/";
const html = (body = "<h1>flow</h1>") => new Response(`<!doctype html><html><body>${body}</body></html>`, {
  status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"abc"', "Content-Length": "60" },
});
const env = { UNITS: unitsNamespace() };
const me = { email: ADA.email, name: ADA.name, role: "editor" };
const tctx = () => ({ ...ctxFor("ui"), PUBLIC_PREFIXES: [U] });
const bootOf = async (res) => JSON.parse(/window\.__augurDraft=(\{.*?\})<\/script>/.exec(await res.text())[1]);

test("a member on a unit page gets the bar; the boot names the unit and the draft", async () => {
  const out = await W.withDraftUi(tctx(), html(), new URL(`https://x.test${U}@k7f3q1/`), me, env);
  const text = await out.clone().text();
  assert.match(text, /<script defer src="\/__drafts\/drafts\.js"><\/script><\/body>/);
  assert.match(text, /<h1>flow<\/h1>/, "the page is otherwise untouched");
  assert.deepEqual(await bootOf(out), { unit: U, draft: "k7f3q1", me: { id: W.personId(ADA.email), role: "editor" } });
  assert.equal(out.headers.get("ETag"), null, "the bytes are no longer the stored blob");
  assert.equal(out.headers.get("Content-Length"), null);
  const main = await bootOf(await W.withDraftUi(tctx(), html(), new URL(`https://x.test${U}pages/two.html`), me, env));
  assert.equal(main.draft, null);
  assert.equal(main.unit, U);
});

test("no bar for a stranger, off a unit, on a non-HTML answer, with ?raw, on a 404, or without UNITS", async () => {
  const untouched = async (res, url, who, e = env, t = tctx()) => (await W.withDraftUi(t, res, new URL(url), who, e)) === res;
  assert.equal(await untouched(html(), `https://x.test${U}`, null), true, "anonymous on a public prototype");
  assert.equal(await untouched(html(), "https://x.test/", me), true, "the gallery is not a unit page");
  assert.equal(await untouched(new Response("body{}", { headers: { "Content-Type": "text/css" } }), `https://x.test${U}a.css`, me), true);
  assert.equal(await untouched(html(), `https://x.test${U}?raw`, me), true);
  assert.equal(await untouched(new Response("no", { status: 404, headers: { "Content-Type": "text/html" } }), `https://x.test${U}`, me), true);
  assert.equal(await untouched(html(), `https://x.test${U}`, me, {}), true, "no UNITS binding, nothing to show");
});

test("an instance with no roster is its operator's: the bar appears for nobody in particular", async () => {
  const open = { ...tctx(), USERS: [] };
  const boot = await bootOf(await W.withDraftUi(open, html(), new URL(`https://x.test${U}`), null, env));
  assert.deepEqual(boot.me, { id: "local", role: "admin" });
});

test("a page without a body tag still gets the tag, at the end", async () => {
  const bare = new Response("<h1>bare</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
  const text = await (await W.withDraftUi(tctx(), bare, new URL(`https://x.test${U}`), me, env)).text();
  assert.match(text, /^<h1>bare<\/h1><script>window\.__augurDraft=/);
});

test("/__drafts/ is engine chrome no space may write", () => {
  assert.equal(W.isEngineChrome("/__drafts/drafts.js"), true);
  assert.equal(W.isEngineChrome("/__draftsy/x.js"), false);
});
