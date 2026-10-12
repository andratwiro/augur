// E-28, second cut. The canvas tools send the pairing saved for a site to that site so a
// gated board answers them — and a token must not leave on plain http. `siteAuth` returns
// no header unless the site is https, or is this machine itself (localhost / 127.0.0.1).
// The token lookup is injected: no saved pairing is read, and none is needed.
import { test } from "node:test";
import assert from "node:assert/strict";

// The tool resolves its site at import; a harmless one keeps the import quiet.
process.env.CANVAS_SITE_ORIGIN ||= "https://example.test";
const { siteAuth } = await import("../scripts/clawd-canvas.mjs");

const asked = [];
const token = (site) => { asked.push(site); return "tok-for-test"; };
const HEADER = { authorization: "Bearer tok-for-test" };

test("https, and this machine over http: the header is sent", () => {
  for (const site of ["https://ws.example.test", "https://ws.example.test:8443/", "http://localhost:8788", "http://127.0.0.1:8788", "https://localhost"]) {
    assert.deepEqual(siteAuth(site, token), HEADER, site);
  }
});

test("plain http to anywhere else: no header, and the token is not even looked up", () => {
  asked.length = 0;
  for (const site of [
    "http://ws.example.test", "http://ws.example.test:443", "ws://ws.example.test",
    "http://localhost.example.test", "http://127.0.0.1.example.test", "http://127.0.0.2:8788", "http://[::1]:8788",
    "ftp://ws.example.test", "file:///etc/hosts", "ws.example.test", "", undefined, null,
  ]) {
    assert.deepEqual(siteAuth(site, token), {}, String(site));
  }
  assert.deepEqual(asked, []);
});

test("https with no pairing saved: no header", () => {
  assert.deepEqual(siteAuth("https://ws.example.test", () => ""), {});
});
