// Which workspace a hostname names, and what happens when none does.
//
// `B-resolver-dynamic`. The resolver is the one place that decides whose request this is,
// and it runs before anything else — so every wrong answer here is a wrong answer to
// everything downstream: whose config is loaded, whose roster the gate checks, whose
// content is served. There is no later check that would catch it.
//
// The parsing half is pure string work and is tested as such. The resolving half is tested
// through the real `resolveTenant`, because the property that matters is not "the regex
// works" — it is that a request for one hostname never comes back with another's workspace,
// and that a hostname naming nobody comes back with NOBODY rather than with a default.
//
// `idFromName` IS A STUB HERE, and the real one was checked separately. The stub proves
// the resolver derives an object from the label and from nothing else; whether two labels
// give two objects is Cloudflare's guarantee, not this repo's. It was confirmed anyway,
// under `wrangler dev --local` against a real TENANTS namespace through a `/__whoami`
// echo: tenant-a and tenant-b came back with different 64-character ids, and the mixed
// case, trailing dot and port forms of a host all came back with the SAME id as its plain
// form, while `www.`, the apex and a deeper hostname came back null.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import {
  tenantLabelFromHost, normalizeHost, isReservedLabel, RESERVED_LABELS, TENANT_LABEL_RE,
} from "../src/tenant-host.mjs";

const SUFFIX = ".example.com";
const req = (host) => new Request("https://ignored.test/", { headers: { host } });

/** A namespace stub that records what it was asked for. Real `idFromName` is a hash. */
function namespace() {
  const asked = [];
  return {
    asked,
    idFromName(name) { asked.push(name); return { name, toString: () => `id:${name}` }; },
    get(id) { return { id, __stub: true }; },
  };
}

// ── the parsing ──────────────────────────────────────────────────────────────

test("the first label of the host IS the workspace", () => {
  assert.equal(tenantLabelFromHost("acme.example.com", SUFFIX), "acme");
  assert.equal(tenantLabelFromHost("voracious-eel-294.example.com", SUFFIX), "voracious-eel-294");
});

test("a port, mixed case and a trailing dot are the same request", () => {
  // Every one of these is something a real client sends: a local run carries the port, the
  // header is case-insensitive, and the trailing dot is the fully-qualified form.
  for (const host of ["acme.example.com:8787", "ACME.Example.COM", "acme.example.com.", "  acme.example.com. "]) {
    assert.equal(tenantLabelFromHost(host, SUFFIX), "acme", `${host} did not resolve to acme`);
  }
});

test("A DEEPER HOSTNAME IS NOT A WORKSPACE", () => {
  // The one that would matter. `evil.acme.example.com` must not read as `acme`, and it
  // must not read as `evil.acme` either — a label with a dot in it is not a label, and
  // treating it as one is how a workspace id gets a separator in it downstream.
  assert.equal(tenantLabelFromHost("evil.acme.example.com", SUFFIX), null);
  assert.equal(tenantLabelFromHost("a.b.c.example.com", SUFFIX), null);
});

test("the apex itself names no workspace", () => {
  assert.equal(tenantLabelFromHost("example.com", SUFFIX), null);
  assert.equal(tenantLabelFromHost(".example.com", SUFFIX), null, "an empty label resolved");
});

test("a host that does not carry the suffix names no workspace", () => {
  assert.equal(tenantLabelFromHost("acme.other.com", SUFFIX), null);
  assert.equal(tenantLabelFromHost("example.com.evil.test", SUFFIX), null, "the suffix was matched somewhere other than the end");
});

test("a hyphenated suffix keeps workspaces on first-level hostnames", () => {
  // The arrangement that avoids a wildcard certificate: `acme-team.example.com` is one
  // level down, which universal SSL already covers.
  assert.equal(tenantLabelFromHost("acme-team.example.com", "-team.example.com"), "acme");
  assert.equal(tenantLabelFromHost("acme.example.com", "-team.example.com"), null);
});

test("no suffix configured means no workspace, never a guess", () => {
  for (const s of ["", "   ", null, undefined]) {
    assert.equal(tenantLabelFromHost("acme.example.com", s), null);
  }
});

test("a malformed label is refused rather than repaired", () => {
  for (const bad of ["-acme", "acme-", "ac_me", "acme!", "AC ME", "x".repeat(64)]) {
    assert.equal(tenantLabelFromHost(`${bad}${SUFFIX}`, SUFFIX), null, `${bad} was accepted`);
  }
  assert.equal(tenantLabelFromHost(`${"x".repeat(63)}${SUFFIX}`, SUFFIX), "x".repeat(63), "63 characters is a legal DNS label");
});

test("an IPv6 literal has no label to take", () => {
  assert.equal(normalizeHost("[::1]:8787"), "[::1]");
  assert.equal(tenantLabelFromHost("[::1]:8787", SUFFIX), null);
});

// ── the reserved names ───────────────────────────────────────────────────────

test("A RESERVED NAME NEVER RESOLVES, WHATEVER IT LOOKS LIKE", () => {
  // Not tidiness. `login.example.com` answered by a stranger's workspace is a phishing
  // page with a real certificate that we serve; `www` and `mail` are records the domain
  // has to be able to have; `postmaster` is an address a certificate authority writes to.
  for (const name of ["www", "admin", "api", "mail", "login", "status", "postmaster", "abuse", "augur"]) {
    assert.equal(tenantLabelFromHost(`${name}${SUFFIX}`, SUFFIX), null, `${name} resolved to a workspace`);
  }
  assert.equal(tenantLabelFromHost(`WWW${SUFFIX}`, SUFFIX), null, "case got a reserved name through");
});

test("the reserved list is a list of legal labels, so every entry can actually be claimed", () => {
  // An entry that could never be a hostname is an entry defending nothing, and it hides
  // the fact that the real name is missing.
  const illegal = RESERVED_LABELS.filter((l) => !TENANT_LABEL_RE.test(l));
  assert.deepEqual(illegal, [], "reserved entries that are not valid DNS labels");
  assert.equal(new Set(RESERVED_LABELS).size, RESERVED_LABELS.length, "the reserved list has duplicates");
});

test("the reserved list cannot be added to at runtime", () => {
  // A frozen Set would not have this property — Object.freeze does not stop Set.add — and
  // a table that looks immutable and is not is worse than one that never claimed to be.
  assert.throws(() => { RESERVED_LABELS.push("acme"); }, TypeError);
  assert.equal(isReservedLabel("acme"), false);
});

// ── the resolver ─────────────────────────────────────────────────────────────

test("TWO HOSTNAMES RESOLVE TO TWO WORKSPACES, ON EVERY REQUEST", () => {
  // The VERIFY. Note the loop: the failure being designed out is a resolver that answers
  // correctly once and then memoises, which is exactly what the static branch does and
  // must not do here.
  const ns = namespace();
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: ns };
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(Promise.all([
      W.resolveTenant(req("tenant-a.example.com"), env),
      W.resolveTenant(req("tenant-b.example.com"), env),
    ]));
  }
  return Promise.all(ids).then((rounds) => {
    for (const [a, b] of rounds) {
      assert.equal(a.tenantId, "tenant-a");
      assert.equal(b.tenantId, "tenant-b");
      assert.notEqual(String(a.store.id), String(b.store.id), "two workspaces got one object");
      assert.equal(String(a.store.id), "id:tenant-a");
      assert.equal(String(b.store.id), "id:tenant-b");
    }
    assert.deepEqual(new Set(ns.asked), new Set(["tenant-a", "tenant-b"]),
      "the resolver derived an object for a name nobody asked about");
  });
});

test("the edge-case hostnames resolve to the SAME workspace as the plain one", async () => {
  const ns = namespace();
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: ns };
  for (const host of ["acme.example.com", "acme.example.com:8787", "ACME.EXAMPLE.COM", "acme.example.com."]) {
    const r = await W.resolveTenant(req(host), env);
    assert.equal(r.tenantId, "acme", `${host}`);
    assert.equal(String(r.store.id), "id:acme");
  }
});

test("A HOSTNAME NAMING NOBODY GETS NOBODY — never a default workspace", async () => {
  // The whole reason the dynamic branch does not fall through to the static one. A
  // fallback here would answer an unrecognised hostname with SOME workspace, and on a
  // deployment where hostname is identity that is somebody else's site.
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace() };
  for (const host of ["example.com", "www.example.com", "evil.acme.example.com", "acme.other.com", "admin.example.com"]) {
    const r = await W.resolveTenant(req(host), env);
    assert.equal(r.tenantId, null, `${host} resolved to ${r.tenantId}`);
    assert.equal(r.store, null, `${host} handed back an object`);
  }
});

test("and the worker REFUSES it, before it reads any config", async () => {
  // The refusal has to happen at the top of fetch(): every branch below assumes there is a
  // workspace, and a config load for a null one would either pick a default or throw. A
  // read attempt here is the bug, so the stub counts them.
  const { default: worker } = await import("../src/_worker.js");
  let reads = 0;
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: namespace(),
    ASSETS: { fetch: async () => { reads++; return new Response("{}", { headers: { "content-type": "application/json" } }); } },
  };
  const quiet = console.log; console.log = () => {};
  try {
    for (const host of ["www.example.com", "example.com", "evil.acme.example.com"]) {
      const res = await worker.fetch(new Request("https://x/", { headers: { host } }), env, {});
      assert.equal(res.status, 404, `${host} was served something`);
      assert.equal(await res.text(), "Not found\n");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    }
  } finally { console.log = quiet; }
  assert.equal(reads, 0, "config was read for a request that names no workspace");
});

test("a reserved name is refused in the same words as a malformed one", async () => {
  // A distinguishable refusal for a reserved name would be a free directory of which names
  // the operator kept. Nobody legitimate is on either path.
  const { default: worker } = await import("../src/_worker.js");
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace(), ASSETS: { fetch: async () => new Response("{}") } };
  const quiet = console.log; console.log = () => {};
  try {
    const reserved = await worker.fetch(new Request("https://x/", { headers: { host: "admin.example.com" } }), env, {});
    const deeper = await worker.fetch(new Request("https://x/", { headers: { host: "evil.acme.example.com" } }), env, {});
    assert.equal(reserved.status, deeper.status);
    assert.equal(await reserved.text(), await deeper.text());
  } finally { console.log = quiet; }
});

test("A NAME NOBODY HAS CLAIMED STILL RESOLVES — existence is not this layer's question", () => {
  // Worth pinning because it is surprising, and because the surprise is the design. The
  // resolver is pure string work by construction: asking "does this workspace exist" would
  // put a round trip in front of every request, and the answer lives inside the object it
  // would have to reach anyway. An unprovisioned workspace is an empty one, and what a
  // request gets from it is decided by the store, not here.
  return W.resolveTenant(req("nobody-has-this.example.com"), { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: namespace() })
    .then((r) => {
      assert.equal(r.tenantId, "nobody-has-this");
      assert.ok(r.store, "a resolvable name got no object");
    });
});

test("the static branch is untouched — no suffix, and it still answers the built id", async () => {
  // Every self-hosted instance is this branch, and it had better not have moved.
  W.__setTenantTestState({ memo: null });
  const env = {
    ASSETS: {
      fetch: async () => new Response(JSON.stringify({ tenantId: "delta-ish" }),
        { headers: { "content-type": "application/json" } }),
    },
  };
  const a = await W.resolveTenant(req("anything.at.all"), env);
  const b = await W.resolveTenant(req("something.else.entirely"), env);
  assert.equal(a.tenantId, "delta-ish");
  assert.equal(b.tenantId, "delta-ish", "the static branch started reading the Host header");
  assert.equal(a.store, null, "a deployment with no TENANTS binding handed back an object");
  W.__setTenantTestState({ memo: null });
});

test("an empty suffix is the static branch, not a broken dynamic one", async () => {
  // The config mistake this shape invites: `TENANT_HOST_SUFFIX = ""` reads as
  // multi-workspace to a person. It must not read as "every host is its own workspace",
  // and it must not read as "no host is". scripts/wrangler-preflight.mjs refuses it
  // outright; the resolver still has to be defined when it slips through.
  W.__setTenantTestState({ memo: null });
  const env = { TENANT_HOST_SUFFIX: "   ", ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) } };
  const r = await W.resolveTenant(req("acme.example.com"), env);
  assert.equal(r.tenantId, "default");
  W.__setTenantTestState({ memo: null });
});

test("no TENANTS binding means no object, and the resolve still succeeds", async () => {
  // A deployment can serve several workspaces from the store before any family has moved
  // into a DO. The stub being absent must not turn into a refusal.
  const r = await W.resolveTenant(req("acme.example.com"), { TENANT_HOST_SUFFIX: SUFFIX });
  assert.equal(r.tenantId, "acme");
  assert.equal(r.store, null);
});

test("tenantStub does no I/O, so it cannot be the slow or failing part of a resolve", () => {
  // idFromName is a hash and get() is a reference. If either ever becomes a round trip,
  // this runs on every request to every route including the ones that never read a store.
  const ns = namespace();
  const s = W.tenantStub({ TENANTS: ns }, "acme");
  assert.equal(String(s.id), "id:acme");
  assert.equal(W.tenantStub({}, "acme"), null);
  assert.equal(W.tenantStub({ TENANTS: ns }, null), null);
  assert.equal(W.tenantStub({ TENANTS: ns }, ""), null);
});
