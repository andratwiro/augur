// The page the invite flow makes for one member — a pure module, so the shape of what the
// platform lands is checked without a store, a workspace object or a manifest in sight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { welcomeUnitFor, slugFor } from "../src/welcome-unit.mjs";
import { personIdFor } from "../src/purge.mjs";

// The slug is the member id, not the local part: local parts collide across domains, an
// all-non-ASCII local part is not a folder name, and on a gated workspace a guessable slug
// confirms membership. `slugFor` is `personIdFor` — same hash, same id every `by`/`owner`
// field already carries.
test("the slug is the member id, never the local part", () => {
  assert.equal(slugFor("Ada@Example.test"), personIdFor("ada@example.test"));
  // Two addresses differing only in domain must not share a page.
  assert.notEqual(slugFor("ada@a.test"), slugFor("ada@b.test"));
  // An all-non-ASCII local part still yields a real, address-specific slug — never a
  // literal folder like "member" that every such address would collapse onto.
  const s1 = slugFor("ééé@x.test");
  const s2 = slugFor("üüü@x.test");
  assert.ok(s1 && s1.length > 0);
  assert.notEqual(s1, s2);
});

test("the page names the person, carries one editable line, and is self-contained", () => {
  const u = welcomeUnitFor({ name: "Ada", email: "ada@x.test" });
  const slug = personIdFor("ada@x.test");
  assert.equal(u.unit, `/start-here/${slug}/`);
  const body = u.files[`/start-here/${slug}/index.html`].body;
  assert.match(body, /<!doctype html>/i);
  assert.match(body, /Ada/);
  assert.match(body, /data-line="greeting"/);
  assert.doesNotMatch(body, /<script src=|<link rel="stylesheet" href="http/);
});

// A name is a person's own text and lands in a published page: it is escaped, never
// interpolated raw, or the first member called `<script>` publishes one.
test("the person's own name cannot inject markup", () => {
  const u = welcomeUnitFor({ name: '<script>alert("x")</script>', email: "eve@x.test" });
  const slug = personIdFor("eve@x.test");
  const body = u.files[`/start-here/${slug}/index.html`].body;
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&lt;script&gt;/);
});

// No name is the ordinary case for an invite that has not been redeemed yet.
test("with no name the id stands in, and the unit follows the member id", () => {
  const u = welcomeUnitFor({ email: "Grace.Hopper@x.test" });
  const slug = personIdFor("Grace.Hopper@x.test");
  assert.equal(u.unit, `/start-here/${slug}/`);
  assert.match(u.files[`/start-here/${slug}/index.html`].body, new RegExp(slug));
  assert.equal(u.files[`/start-here/${slug}/index.html`].ct, "text/html; charset=utf-8");
});
