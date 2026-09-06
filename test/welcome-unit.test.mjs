// The page the invite flow makes for one member — a pure module, so the shape of what the
// platform lands is checked without a store, a workspace object or a manifest in sight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { welcomeUnitFor, slugFor } from "../src/welcome-unit.mjs";

test("the slug is the local part, lowercased, dashes for anything else, never empty", () => {
  assert.equal(slugFor("Ada.Lovelace+x@Example.test"), "ada-lovelace-x");
  assert.equal(slugFor("@@@"), "member");
});

test("the page names the person, carries one editable line, and is self-contained", () => {
  const u = welcomeUnitFor({ name: "Ada", email: "ada@x.test" });
  assert.equal(u.unit, "/start-here/ada/");
  const body = u.files["/start-here/ada/index.html"].body;
  assert.match(body, /<!doctype html>/i);
  assert.match(body, /Ada/);
  assert.match(body, /data-line="greeting"/);
  assert.doesNotMatch(body, /<script src=|<link rel="stylesheet" href="http/);
});

// A name is a person's own text and lands in a published page: it is escaped, never
// interpolated raw, or the first member called `<script>` publishes one.
test("the person's own name cannot inject markup", () => {
  const u = welcomeUnitFor({ name: '<script>alert("x")</script>', email: "eve@x.test" });
  const body = u.files["/start-here/eve/index.html"].body;
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&lt;script&gt;/);
});

// No name is the ordinary case for an invite that has not been redeemed yet.
test("with no name the slug stands in, and the unit follows the email", () => {
  const u = welcomeUnitFor({ email: "Grace.Hopper@x.test" });
  assert.equal(u.unit, "/start-here/grace-hopper/");
  assert.match(u.files["/start-here/grace-hopper/index.html"].body, /grace-hopper/);
  assert.equal(u.files["/start-here/grace-hopper/index.html"].ct, "text/html; charset=utf-8");
});
