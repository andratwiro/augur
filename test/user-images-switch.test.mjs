// The per-instance switch that turns user-supplied image bytes off.
//
// `LAUNCH-demo-open-sandbox`. The demo is the one workspace whose password is printed on
// its own login page and shared by strangers who have agreed to nothing. The exposure is
// not abuse of our data — it is our domain hosting somebody else's illegal image, at a
// stable URL, under our name.
//
// WHY AN INSTANCE SWITCH RATHER THAN A ROLE RULE. "Viewers cannot have a face" would be
// plainly wrong on a private instance, where a viewer is an invited stakeholder looking at
// their own project. And keying on the instance closes the asymmetry that let this in:
// /__asset already refused viewers, /__me/avatar checked only that you were signed in, so
// anyone who could read the password off the login page could store a raster and get a
// stable ungated /__avatar/<hash> back. On the instance axis, a future role change cannot
// silently reopen either path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { instanceFields, emptyTenantContext } from "../src/tenant-context.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

test("the switch defaults to ON, so no existing instance changes", () => {
  assert.equal(emptyTenantContext().USER_IMAGES, true);
  assert.equal(instanceFields({}).USER_IMAGES, true);
  assert.equal(instanceFields({ userImages: true }).USER_IMAGES, true);
});

test("ONLY an explicit false turns it off — a typo leaves it on", () => {
  // The direction this is allowed to be wrong in. Turning it off is the deliberate act, so
  // it is the one that has to be spelled correctly; a config typo must not silently
  // disable a feature every other instance depends on.
  assert.equal(instanceFields({ userImages: false }).USER_IMAGES, false);
  for (const v of ["false", 0, null, undefined, "no", "off", ""]) {
    assert.equal(instanceFields({ userImages: v }).USER_IMAGES, true, `${JSON.stringify(v)} turned it off`);
  }
  assert.equal(instanceFields({ userImagess: false }).USER_IMAGES, true, "a misspelled key turned it off");
});

test("build.js carries it from deploy.config.json into instance.json", () => {
  const src = read("../build.js");
  assert.match(src, /userImages:\s*DEPLOY\.userImages !== false/,
    "build.js does not carry userImages, so the switch would never reach a deployed worker");
});

test("BOTH upload routes consult it, not just the one that was already gated", () => {
  const src = read("../src/_worker.js");
  assert.match(src, /function imagesDisabledRefusal/);
  // /__me/avatar — the route that was open.
  assert.match(src, /async function meAvatarApi\(tenantId, request, env, me, tctx\)/,
    "meAvatarApi cannot see the switch");
  // /__asset — the route that already refused viewers.
  const assetBlock = src.slice(src.indexOf('if (url.pathname.startsWith("/__asset"))'), src.indexOf('return assetApi(tctx, request, url, env);') + 46);
  assert.match(assetBlock, /imagesDisabledRefusal/, "/__asset does not consult the switch");
});

test("the refusal is a 403 with a reason, never a silent no-op", () => {
  // A silent no-op on an upload is the worst version of this: the person sees their photo,
  // reloads, and it is gone, with nothing saying why.
  const src = read("../src/_worker.js");
  const block = src.slice(src.indexOf("const IMAGES_OFF"), src.indexOf("const IMAGES_OFF") + 400);
  assert.match(block, /error: "images-disabled"/);
  assert.match(block, /reason:/, "the refusal carries no human-readable reason for the UI");
  assert.match(block, /403/);
});

test("clearing a photo still works with uploads switched off", () => {
  // Otherwise anyone who set a photo BEFORE the switch can never take it down, which turns
  // a safety measure into a trap.
  const src = read("../src/_worker.js");
  const fn = src.slice(src.indexOf("async function meAvatarApi"), src.indexOf("async function meAvatarApi") + 900);
  assert.match(fn, /if \(request\.method === "POST"\)[\s\S]{0,120}imagesDisabledRefusal/,
    "the switch is not scoped to POST, so DELETE would be refused too");
});

// ── the trap: a refusal that the client turns back into a stored image ───────

test("THE CANVAS MUST NOT FALL BACK TO INLINING A REFUSED IMAGE", () => {
  // The whole switch is decoration without this. The canvas compresses an image, uploads
  // it to /__asset, and on ANY failure falls back to embedding it as a data URL in the
  // board doc — which stores the same bytes by another route and serves them from the same
  // domain. A refusal is not a failure, and the client has to know the difference.
  const src = read("../src/canvas/canvas.js");
  const fn = src.slice(src.indexOf("function compressImage"), src.indexOf("function compressImage") + 3000);
  assert.match(fn, /images-disabled/, "the canvas does not recognise a refusal at all");
  assert.match(fn, /r\.status === 403/);
  // The refusal branch must RETURN without reaching the fallback. Slice to the closing
  // brace of that if-block, not a fixed number of characters — a wider window catches the
  // NEXT branch's fallback and fails on correct code, which is a test that teaches people
  // to edit the test.
  const at = fn.indexOf("r.status === 403");
  const branch = fn.slice(at, fn.indexOf("\n                }", at));
  assert.ok(!/dataUrlFallback/.test(branch),
    `the images-disabled branch reaches dataUrlFallback, so the bytes land in the board doc anyway:\n${branch}`);
  assert.match(branch, /return toast/, "the refusal is silent, or does not return — nothing tells the person why nothing happened");
});

test("the profile photo dialog explains the refusal instead of saying 'could not save'", () => {
  // "Could not save photo" on a workspace that will never accept one sends somebody back
  // to try again with a smaller file, forever.
  const src = read("../build.js");
  const at = src.indexOf("fetch('/__me/avatar'");
  const block = src.slice(at, at + 1200);
  assert.match(block, /images-disabled/);
  assert.match(block, /msg\(d\.reason/, "the dialog does not render the server's reason");
});

test("the ordinary upload failure still falls back, so a sandbox keeps working", () => {
  // The data-URL fallback exists for offline and sandbox runs. Narrowing it to nothing
  // would break every local canvas.
  const src = read("../src/canvas/canvas.js");
  const fn = src.slice(src.indexOf("function compressImage"), src.indexOf("function compressImage") + 3000);
  assert.match(fn, /return dataUrlFallback\(\);/, "the ordinary failure path no longer falls back");
  assert.match(fn, /\.catch\(dataUrlFallback\)/, "a network error no longer falls back");
});
