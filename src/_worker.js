// Source for dist/_worker.js — copied verbatim by build.js into the deploy dir.
// Cloudflare Pages Advanced Mode: this Worker runs in front of every request.
//
// When the SITE_PASSWORD env var/secret is set on the Pages project, the INTERNAL
// site is gated behind a single custom password page (no username). A correct
// password sets a cookie whose value is SHA-256("gv:" + password) — so the raw
// password is never stored in the cookie — and the Worker checks that cookie on
// every request. If SITE_PASSWORD is unset (e.g. local builds), the site is open.
//
// Published prototypes (`/<opportunity>/<prototype>/…`) are PUBLIC even when the
// password is set — only the internal surface (root index, per-opportunity
// indexes, /pages, /components, /primitives, /playground, /skills) is gated. See
// PUBLIC_PREFIXES / isPublicPath below.
//
// Casual shared-password gate against link leakage — NOT Zero Trust.

const COOKIE = "gv_auth";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// ---- Users / identity -------------------------------------------------------
// Augur is a private internal tool — the only real risk is impersonation, and the
// real work happens through GitHub commits, so this is a casual identity layer, not
// auth hardening. USERS is the seed identity + DEFAULT password, injected by build.js
// from src/identity.json (committed). Empty in a raw copy → no users → the gate stays
// open (offline/local builds with no identity injected). Effective password =
// admin-set KV override (USER_SECRETS_KEY) ?? this default — so passwords are editable
// at runtime from the admin panel without redeploying. Each entry:
//   { email, name, pass, initials, color, role? }   role:"admin" → can edit passwords.
const USERS = [];
const USER_COOKIE = "gv_user";              // value: "<email>.<token>"
const USER_SECRETS_KEY = "users:secrets";   // KV {email: password} — admin overrides

// Build id for the live-reload poller. build.js replaces "dev" with this build's
// id; it's the FALLBACK version for any path not in VERSION_MAP (index/shell pages,
// assets). "dev" in a raw/local copy just means a stable id.
const BUILD_ID = "dev";

// Per-page live-reload versions: URL-prefix → token that changes only when that
// folder's content changes. build.js fills this in. Lets a tab reload only when ITS
// own prototype changed, so unrelated deploys (e.g. another agent's prototype) don't
// reload it. versionFor() returns the longest-prefix match, else BUILD_ID.
const VERSION_MAP = {};

function versionFor(pathname) {
  let best = null, bestLen = -1;
  for (const k in VERSION_MAP) {
    if ((pathname === k || pathname === k.slice(0, -1) || pathname.startsWith(k)) && k.length > bestLen) {
      best = VERSION_MAP[k];
      bestLen = k.length;
    }
  }
  return best == null ? BUILD_ID : best;
}

// PUBLIC prototype path-prefixes — served WITHOUT the password. build.js replaces
// the array below with the real list of `/<opportunity>/<prototype>/` prefixes at
// build time, so it can never drift from what actually ships. Left empty here so a
// raw/local copy of this file gates nothing differently (local builds have no
// password anyway).
const PUBLIC_PREFIXES = [];

// A request is public if it lands inside a published prototype folder (the index
// page or any asset it loads), or is the dormant review-overlay script that every
// prototype embeds. Everything else falls through to the password gate.
function isPublicPath(pathname) {
  // The dormant review overlay + its avatar asset — both embedded into public
  // prototypes, so both must bypass the gate (else the <img> gets the login page).
  if (pathname === "/__review/comments.js" || pathname === "/__review/aslam.png") return true;
  // The composition graph the overlay recurses (window.__GV_GRAPH) — embedded into
  // every public prototype before comments.js, so it must bypass the gate too.
  if (pathname === "/__review/graph.js") return true;
  // The cursor companion engine + self-hosted fonts are embedded into public
  // prototypes by absolute path, so they must bypass the gate too (else the
  // <script>/<link> fetches the login page instead of the asset).
  if (pathname === "/piti.js" || pathname.startsWith("/fonts/")) return true;
  // Shared canonical design-system assets. Linked prototypes (the default — INV-10)
  // reference these via /skills/govocal-ui/<asset>, so they must bypass the gate or a
  // public prototype renders unstyled for anyone without the password. Scope to RENDERED
  // ASSET extensions only — never a blanket prefix — so any doc that ships into this dir
  // (e.g. an img/.../MANIFEST.md, gallery.html) stays gated, not exposed.
  if (pathname.startsWith("/skills/govocal-ui/") &&
      /\.(css|js|mjs|woff2?|ttf|otf|svg|png|jpe?g|webp|gif|ico|json|map)$/i.test(pathname)) return true;
  // Composed OG/unfurl card for any page — always fetchable so link-preview bots
  // (Slack, iMessage, Twitter) can load the image even if its folder is gated.
  if (pathname.endsWith("/og.jpg")) return true;
  // The composed reference Pages (DS gallery, shipped under /pages/<slug>/) are
  // public so they can be shared without the password. They're self-contained and
  // load their assets from already-public paths (/skills/govocal-ui/, /fonts/), so
  // the whole subtree — index pages and any page-local assets — bypasses the gate.
  if (pathname === "/pages" || pathname.startsWith("/pages/")) return true;
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname === p.slice(0, -1) || pathname.startsWith(p)
  );
}

async function tokenFor(secret) {
  const data = new TextEncoder().encode("gv:" + secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Identity helpers -------------------------------------------------------
function userByEmail(email) {
  const e = String(email == null ? "" : email).trim().toLowerCase();
  return USERS.find((u) => u.email.toLowerCase() === e) || null;
}

// Safe-to-expose view of a user — never includes the password.
function publicUser(u) {
  return u ? {
    email: u.email, name: u.name,
    initials: u.initials || "", color: u.color || "#4f46e5",
    avatar: u.avatar || null, admin: u.role === "admin",
  } : null;
}

// Effective password = admin-set KV override ?? the seeded default. One kv.get.
async function effectivePass(env, u) {
  if (!u) return "";
  try {
    const k = kvFor(env);
    const raw = k ? await k.get(USER_SECRETS_KEY) : null;
    const ov = raw ? JSON.parse(raw) : {};
    if (ov && typeof ov[u.email] === "string" && ov[u.email]) return ov[u.email];
  } catch (e) {}
  return u.pass || "";
}

// Cookie token binds the email to the (effective) password: SHA-256("gv:email:pass").
// Changing a password invalidates that user's existing cookies (token no longer
// matches) — a free "log everyone out on password change", which is what we want.
async function userToken(env, u) {
  return tokenFor(u.email + ":" + (await effectivePass(env, u)));
}

// Resolve the signed-in user from the gv_user cookie ("<email>.<token>"), verifying
// the token against that user's effective password. Stateless — no session store.
async function identify(request, env) {
  if (!USERS.length) return null;
  const cookies = request.headers.get("Cookie") || "";
  const c = cookies.split(/;\s*/).find((x) => x.startsWith(USER_COOKIE + "="));
  if (!c) return null;
  const val = c.slice(USER_COOKIE.length + 1);
  const dot = val.lastIndexOf(".");
  if (dot < 1) return null;
  const u = userByEmail(val.slice(0, dot));
  if (!u) return null;
  const token = val.slice(dot + 1);
  const expect = await userToken(env, u);
  return token.length === expect.length && token === expect ? u : null;
}

// ---- KV access: the binding, or a REST shim to the REAL (prod) namespace --------
// "Offline-live" mode: offline.mjs serves LOCAL assets (your working-tree prototypes)
// but injects GV_KV_TOKEN/_ACCOUNT/_NS so the overlay data (comments/pins/status/
// renames/etc.) reads & writes the PRODUCTION KV — the shared "offline Figma" layer.
// (wrangler's remote KV bindings 500 on every op, so we go straight to the KV REST
// API.) Active ONLY when GV_KV_TOKEN is present; in prod it's unset → the normal
// env.COMMENTS binding is returned and nothing changes. The shim mirrors the subset of
// the KV API the worker uses: get / put / list.
function kvFor(env) {
  if (!env || !env.GV_KV_TOKEN) return env && env.COMMENTS;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.GV_KV_ACCOUNT}/storage/kv/namespaces/${env.GV_KV_NS}`;
  const auth = { Authorization: `Bearer ${env.GV_KV_TOKEN}` };
  return {
    async get(key) {
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, { headers: auth });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`REST KV get ${r.status}`);
      return await r.text();
    },
    async put(key, value) {
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, { method: "PUT", headers: auth, body: value });
      if (!r.ok) throw new Error(`REST KV put ${r.status}`);
    },
    async delete(key) {
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, { method: "DELETE", headers: auth });
      if (!r.ok && r.status !== 404) throw new Error(`REST KV delete ${r.status}`);
    },
    async list(opts) {
      const u = new URL(`${base}/keys`);
      if (opts && opts.prefix) u.searchParams.set("prefix", opts.prefix);
      if (opts && opts.cursor) u.searchParams.set("cursor", opts.cursor);
      const r = await fetch(u.toString(), { headers: auth });
      if (!r.ok) throw new Error(`REST KV list ${r.status}`);
      const d = await r.json();
      const ri = d.result_info || {};
      return { keys: (d.result || []).map((k) => ({ name: k.name })), list_complete: !ri.cursor, cursor: ri.cursor || undefined };
    },
  };
}

function loginPage(redirect, error) {
  const safeRedirect = String(redirect).replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Augur</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    /* Same visual language as the site shell — near-white canvas, indigo accent,
       Inter — but deliberately quiet: no aurora, no gradient mark, no big drop
       shadow. A flat gate that reads as effortless rather than shiny. */
    :root {
      --bg: #fbfbfd; --card: #ffffff; --fg: #16171a; --muted: #5b626e; --faint: #9aa0ab;
      --line: rgba(16,17,26,0.09); --line-2: rgba(16,17,26,0.15);
      /* accent = the logo's almost-black (#2C2150), so button + focus match the mark */
      --accent: #2c2150; --accent-solid: #2c2150; --err: #b42318;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
      font: 15px/1.55 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      letter-spacing: -0.011em; background: var(--bg); color: var(--fg);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 14px;
      padding: 30px 30px 28px; max-width: 360px; width: 100%;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 10px 28px -22px rgba(16,24,40,0.22);
    }
    .logo { display: flex; justify-content: center; margin: 4px 0 24px; }
    .logo svg { width: 40px; height: 40px; display: block; }
    label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 7px; }
    input[type=password], input[type=email] {
      width: 100%; font: inherit; font-size: 15px; padding: 8px 13px; border-radius: 9px;
      border: 1px solid var(--line-2); background: #fff; color: var(--fg);
      transition: border-color .12s ease;
    }
    input[type=password]:hover, input[type=email]:hover { border-color: rgba(16,17,26,0.28); }
    input[type=password]:focus, input[type=email]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
    label + label, input + label { margin-top: 14px; }
    button {
      width: 100%; margin-top: 16px; font: inherit; font-weight: 600; font-size: 15px; color: #fff;
      background: var(--accent-solid); border: 1px solid transparent; border-radius: 9px; padding: 8px;
      cursor: pointer; transition: background .12s ease;
    }
    button:hover { background: #38295e; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* Error carries an icon + text, never colour alone (WCAG 1.4.1). */
    .error {
      display: ${error ? "flex" : "none"}; align-items: flex-start; gap: 7px;
      color: var(--err); font-size: 13.5px; font-weight: 500; margin: 14px 0 0;
    }
    .error svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
    /* Present in the DOM for password managers (Bitwarden pairs username+password),
       but visually hidden so the UI stays password-only. NOT display:none — managers
       skip removed/hidden fields. */
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    @media (max-width: 420px) { .card { padding: 26px 22px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">
      <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Augur">
        <g transform="translate(153.5 153.5) scale(1.115)" fill="#2C2150" fill-rule="evenodd"><path d="M303.668 0.501099C480.9 -9.31876 632.543 126.378 642.396 303.609C652.249 480.839 516.579 632.508 339.35 642.392C162.076 652.279 10.36 516.567 0.504883 339.291C-9.34912 162.015 126.39 10.3241 303.668 0.501099ZM321.31 58.589C313.993 78.2949 309.682 91.0001 300.003 110.42C256.894 196.544 185.761 265.436 98.3008 305.765C84.5568 312.054 73.3451 316.365 59.0391 321.205C166.492 358.562 254.54 437.345 303.567 540.001C306.201 545.441 320.11 580.712 320.888 581.447C329.254 559.649 338.869 536.27 350.55 515.916C397.544 434.024 469.471 370.244 555.57 331.86C563.577 328.29 574.85 323.736 583.145 321.47C472.786 278.754 383.1 203.746 334.938 93.8761C332.878 89.1732 321.885 59.2127 321.31 58.589Z"/></g>
      </svg>
    </div>
    <form method="POST" action="/__auth">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <button type="submit">Enter</button>
      <p class="error" id="pw-err" role="alert">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        <span>Incorrect email or password. Try again.</span>
      </p>
    </form>
  </main>
</body>
</html>`;
}

function htmlResponse(body, status) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---- Live-reload injection (global) -----------------------------------------
// Every HTML page served gets a tiny poller appended before </body>. It freezes
// THIS page's version (versionFor(path)) at load time, then polls
// /__version?path=<its own path>; when that page's version changes (i.e. ITS
// prototype was redeployed), it reloads — so an unrelated deploy never reloads it.
// Idle-gated: if the version changed while you're mid-interaction, it waits until
// you've paused (≈4s of no input) so it never yanks you out of a flow; the next
// tick reloads once idle. A reload is a full refresh (resets in-page JS state).
// Done in the edge (not baked per file) so it's one definition covering every
// current and future page. Skips:
//   • non-HTML responses, • preview iframes (parent reloads them),
//   • ?raw=1 fetches (the Download HTML button uses it to get a clean file).
// Marker-wrapped so the Download button's strip also removes it as a fallback.
// `fast` is set only for localhost requests (offline mode): poll every 1s and use a
// short idle gate so a local rebuild reloads the tab near-instantly. Live (deployed)
// requests keep the gentle 10s poll / 4s idle gate so they never hammer the worker.
function liveReloadSnippet(token, fast) {
  const interval = fast ? 1000 : 10000;
  const idle = fast ? 300 : 4000;
  return '<!--gv-reload-start--><script>(function(){if(window.top!==window.self)return;' +
    'var B=' + JSON.stringify(token) + ',last=0;' +
    '["pointerdown","keydown","input","scroll","touchstart"].forEach(function(e){' +
    'document.addEventListener(e,function(){last=Date.now()},{passive:true,capture:true})});' +
    'function c(){fetch("/__version?path="+encodeURIComponent(location.pathname),{cache:"no-store"})' +
    '.then(function(r){return r.ok?r.text():null})' +
    '.then(function(t){if(t&&t.trim()&&t.trim()!==B&&Date.now()-last>' + idle + ')location.reload()})' +
    '.catch(function(){})}' +
    'setInterval(function(){if(!document.hidden)c()},' + interval + ');' +
    'document.addEventListener("visibilitychange",function(){if(!document.hidden)c()});' +
    // bfcache restore (back/forward): re-check version immediately so a page restored
    // after a deploy refreshes, while normal restores stay instant.
    'addEventListener("pageshow",function(e){if(e.persisted)c()});})();</script><!--gv-reload-end-->';
}

// Long-cache versioned/static assets so repeat navigations cost zero revalidation.
// Cloudflare's default for assets is `max-age=0, must-revalidate` (a 304 round-trip
// every visit); we override to a year + immutable, but ONLY for assets whose URL
// changes when their content does — anything carrying a ?v= cache-buster, or fonts
// (served from versioned /fonts/ paths). HTML and un-versioned assets (posters,
// per-prototype CSS) are left on the default so they still revalidate via ETag/304.
function withAssetCache(res, url) {
  const versioned = url.searchParams.has("v") || /\.(woff2?|ttf|otf)$/.test(url.pathname);
  if (!versioned) return res;
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return out;
}

function withLiveReload(res, url) {
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("text/html") || url.searchParams.has("raw")) return res;
  // Offline mode (`npm run offline` → wrangler pages dev) is served from localhost;
  // there we poll fast so a rebuild reloads the tab in ~1s. Live stays on 10s.
  const fast = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "::1" || url.hostname.endsWith(".localhost");
  return new HTMLRewriter()
    .on("body", { element(el) { el.append(liveReloadSnippet(versionFor(url.pathname), fast), { html: true }); } })
    .transform(res);
}

// ---- Review comments API (KV-backed) ----------------------------------------
// Threads are stored one KV value per prototype page path, key "c:<path>".

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const clamp = (s, n) => String(s == null ? "" : s).slice(0, n);

function sanitizeMsg(m) {
  return {
    author: clamp(m && m.author, 80) || "Anonymous",
    body: clamp(m && m.body, 4000),
    at: clamp(m && m.at, 40) || new Date().toISOString(),
  };
}

// Apply a single review op to a thread array; returns the new array.
function applyOp(threads, op) {
  if (!op || typeof op !== "object") return threads;
  if (op.op === "add" && op.thread) {
    const t = op.thread;
    const id = clamp(t.id, 64) || String(Date.now());
    // Idempotent by id: re-adding the same thread is a no-op, never a duplicate. This
    // lets a second writer (e.g. the piti roast agent) safely re-assert its annotation
    // to heal it after a racing read-modify-write delete clobbered the shared key.
    if (!threads.some((x) => x.id === id)) {
      threads.push({
        id,
        sel: clamp(t.sel, 600),
        fx: +t.fx || 0, fy: +t.fy || 0, px: +t.px || 0, py: +t.py || 0,
        view: clamp(t.view, 600) || null,
        screen: clamp(t.screen, 200) || null,
        resolved: false,
        annotation: !!t.annotation,
        messages: (Array.isArray(t.messages) ? t.messages : []).slice(0, 1).map(sanitizeMsg),
      });
      if (threads.length > 500) threads = threads.slice(-500);
    }
  } else if (op.op === "move") {
    const t = threads.find((x) => x.id === op.id);
    if (t) {
      t.sel = clamp(op.sel, 600);
      t.fx = +op.fx || 0; t.fy = +op.fy || 0; t.px = +op.px || 0; t.py = +op.py || 0;
      if (op.view != null) t.view = clamp(op.view, 600) || null;
    }
  } else if (op.op === "reply" && op.message) {
    const t = threads.find((x) => x.id === op.id);
    if (t) t.messages = (t.messages || []).concat([sanitizeMsg(op.message)]).slice(0, 200);
  } else if (op.op === "resolve") {
    const t = threads.find((x) => x.id === op.id);
    if (t) t.resolved = !!op.resolved;
  } else if (op.op === "annotate") {
    const t = threads.find((x) => x.id === op.id);
    if (t) t.annotation = !!op.annotation;
  } else if (op.op === "delmsg") {
    // Delete one message by index. Deleting the root message (0) deletes the thread.
    const idx = +op.index;
    if (idx === 0) {
      threads = threads.filter((x) => x.id !== op.id);
    } else {
      const t = threads.find((x) => x.id === op.id);
      if (t && Array.isArray(t.messages)) t.messages = t.messages.filter((_, i) => i !== idx);
    }
  } else if (op.op === "delete") {
    threads = threads.filter((x) => x.id !== op.id);
  }
  return threads;
}

// GET/POST /__review/api?path=<page> — read or mutate one page's threads.
// Reads are open (public prototypes embed the overlay: annotations show always-on,
// comments show once a viewer presses Shift+C). Writes stay gated — see router.
async function reviewApi(request, url, env) {
  const kv = kvFor(env);
  const path = clamp(url.searchParams.get("path") || "/", 600);
  if (!kv) return jsonResponse({ threads: [], warning: "no-kv-binding" });
  const key = "c:" + path;

  if (request.method === "GET") {
    const raw = await kv.get(key);
    return jsonResponse({ threads: raw ? JSON.parse(raw) : [] });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const raw = await kv.get(key);
    let threads = raw ? JSON.parse(raw) : [];
    threads = applyOp(threads, op);
    await kv.put(key, JSON.stringify(threads));
    return jsonResponse({ threads });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Dev-status API (KV-backed, single key) ---------------------------------
// The ENTIRE status map lives under one key ("statuses"), so a page load is one
// kv.get and a click is one kv.put — NO kv.list (the small-bucket call that burned
// quota in the old badge system). Default status is "ignore"; the build-time chip
// baseline comes from the committed prototype-status.json, and this overlays live
// edits on top. Values: in-progress | dev-ready | ignore.
const STATUS_KEY = "statuses";
const VALID_STATUS = { "in-progress": 1, "dev-ready": 1, ignore: 1, reviewed: 1 };

async function statusApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    const raw = await kv.get(STATUS_KEY);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const key = clamp(op && op.key, 300);
    const status = clamp(op && op.status, 40);
    if (!key || !VALID_STATUS[status]) return jsonResponse({ error: "bad-input" }, 400);
    const raw = await kv.get(STATUS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[key] = status;
    await kv.put(STATUS_KEY, JSON.stringify(map));
    return jsonResponse({ map });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Pins API (KV-backed, single key) ---------------------------------------
// User-pinned prototypes/projects for the sidebar. Whole map under one key ("pins")
// — one kv.get per session, one kv.put per toggle (same frugal pattern as statuses).
// Value: { "<path>": { label, href } }. POST { key, label, href, pinned } toggles.
const PINS_KEY = "pins";

async function pinsApi(request, url, env, user) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });
  // Pins are per-user (key "pins:<email>"), independent across users; the global
  // "pins" key is only the fallback when nobody is signed in. Note: NO migration
  // from the global map — that seeded EVERY new user from one shared (effectively
  // Rob's) map, leaking pins across accounts. A new user starts empty.
  const key = user ? `${PINS_KEY}:${user.email}` : PINS_KEY;

  if (request.method === "GET") {
    const raw = await kv.get(key);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    // Authoritative full-state write. The client owns the complete pins map (add,
    // remove and reorder all just produce a new full map), so we store exactly what it
    // sends — NO server-side read-modify-write, which races under KV eventual
    // consistency: a stale/empty read could be written back and clobber everything
    // (that wiped a user's pins during rapid reorder). `set` is the {key:{label,href}} map.
    if (!op || typeof op.set !== "object" || op.set === null) {
      return jsonResponse({ error: "bad-input" }, 400);
    }
    const next = {};
    for (const k of Object.keys(op.set).slice(0, 200)) {
      const ck = clamp(k, 300);
      const v = op.set[k] || {};
      if (ck) next[ck] = { label: clamp(v.label, 120) || ck, href: clamp(v.href, 300) || ck };
    }
    // Safety net: never silently wipe to empty. An empty result is almost always a bug
    // (stale/poisoned client); only honour it when the client explicitly clears the
    // last pin (allowEmpty). Otherwise leave KV untouched and echo the stored map back.
    if (Object.keys(next).length === 0 && !(op && op.allowEmpty)) {
      const raw = await kv.get(key);
      return jsonResponse({ map: raw ? JSON.parse(raw) : {}, skipped: "empty-guard" });
    }
    await kv.put(key, JSON.stringify(next));
    return jsonResponse({ map: next });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Card display-name overrides (KV-backed, single key) --------------------
// Same shape & cost profile as the dev-status map: the whole {key: name} map
// lives under one KV key, so a card-list load is one kv.get and a rename is one
// kv.put — NO kv.list. These override ONLY the label shown on the index card;
// the prototype's folder, URL and content are unaffected (a true rename is a repo
// edit). An empty name clears the override (the card reverts to its build default).
const NAMES_KEY = "names";

async function nameApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    const raw = await kv.get(NAMES_KEY);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const key = clamp(op && op.key, 300);
    // Component descriptions (keys ending "#desc") are full sentences; names stay short.
    const name = clamp(op && op.name, key && key.endsWith("#desc") ? 280 : 80);
    if (!key) return jsonResponse({ error: "bad-input" }, 400);
    const raw = await kv.get(NAMES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (name) map[key] = name;
    else delete map[key]; // empty → revert to the build-time default
    await kv.put(NAMES_KEY, JSON.stringify(map));
    return jsonResponse({ map });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Admin: users + passwords (KV-backed overrides) -------------------------
// Admin-only. GET returns every user with their EFFECTIVE password (override ?? seed)
// so the admin can read them; POST { email, pass } sets an override in KV. Identity
// (name/email/role) stays in the committed identity.json — only passwords are mutable
// here. me is the already-resolved caller; the router guards the route, we re-check.
async function adminUsersApi(request, url, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);

  if (request.method === "GET") {
    const users = [];
    for (const u of USERS) {
      users.push({
        email: u.email, name: u.name, role: u.role || "user",
        initials: u.initials || "", color: u.color || "#4f46e5",
        pass: await effectivePass(env, u),
      });
    }
    return jsonResponse({ users });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const u = userByEmail(op && op.email);
    if (!u) return jsonResponse({ error: "unknown-user" }, 400);
    const pass = clamp(op && op.pass, 200);
    if (!pass) return jsonResponse({ error: "empty-pass" }, 400);
    if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
    const raw = await kv.get(USER_SECRETS_KEY);
    const ov = raw ? JSON.parse(raw) : {};
    ov[u.email] = pass;
    await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
    return jsonResponse({ ok: true, email: u.email });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// /__review/api/export?key=<REVIEW_EXPORT_KEY> — all comment threads.
// Secret-guarded so tooling can read review data WITHOUT the site password.
//   GET  → { pages, generatedAt }
//   POST → apply a moderation op ({ path, op:"resolve"|"delete", id, resolved })
//          to one page's threads and return that page's updated threads. This lets
//          CLI tooling resolve/close threads without the site password.
async function reviewExport(request, url, env) {
  const secret = env.REVIEW_EXPORT_KEY;
  if (!secret) return jsonResponse({ error: "export-disabled" }, 404);
  const given = url.searchParams.get("key") || request.headers.get("X-Review-Key") || "";
  if (given.length !== secret.length || given !== secret) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ pages: {}, warning: "no-kv-binding" });

  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const path = clamp(op && op.path, 600);
    if (!path) return jsonResponse({ error: "missing-path" }, 400);
    const key = "c:" + path;
    const raw = await kv.get(key);
    let threads = raw ? JSON.parse(raw) : [];
    threads = applyOp(threads, op);
    await kv.put(key, JSON.stringify(threads));
    return jsonResponse({ path, threads });
  }

  const pages = {};
  let cursor;
  do {
    const list = await kv.list({ prefix: "c:", cursor });
    for (const k of list.keys) {
      const raw = await kv.get(k.name);
      pages[k.name.slice(2)] = raw ? JSON.parse(raw) : [];
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return jsonResponse({ pages, generatedAt: new Date().toISOString() });
}

// ---- Piti live channel (KV) — the cursor companion's agent bridge ----------
// Self-contained easter egg (see pitis/). A terminal "piti" agent watches which
// prototype you're on and posts short UX/a11y remarks the on-screen cat delivers.
// Two single keys, same frugal one-get/one-put pattern as pins/status:
//   pt:view    -> { path, screen, w, h, ts }        (browser publishes what it's on)
//   pt:remarks -> [ { id, path, text, kind, sel, x, y, w, h, ts }, … ]  (agent → cat)
// Browser-facing ops are OPEN (public prototypes carry no cookie); the two agent
// ops — READ the view, WRITE a remark — reuse the REVIEW_EXPORT_KEY secret (so there
// is no new secret to provision). id = Date.now() so ids never repeat across agent
// sessions (a cleared queue can't collide with the client's last-seen id). Single
// writer (one agent) => the read-modify-write on pt:remarks can't race in practice;
// remarks older than 3 min are pruned on every write and the list is capped.
const PITI_VIEW_KEY = "pt:view";
const PITI_REMARKS_KEY = "pt:remarks";

async function pitiApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ warning: "no-kv-binding" });
  const secret = env.REVIEW_EXPORT_KEY;
  const given = url.searchParams.get("key") || request.headers.get("X-Review-Key") || "";
  const authed = !!secret && given.length === secret.length && given === secret;

  if (request.method === "GET") {
    // Agent reads what the user is looking at (secret-guarded — it's a peek at activity).
    if (url.searchParams.get("type") === "view") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      const raw = await kv.get(PITI_VIEW_KEY);
      return jsonResponse({ view: raw ? JSON.parse(raw) : null });
    }
    // Browser polls the quips queued for its page (open). since=<last id seen>.
    const path = clamp(url.searchParams.get("path") || "/", 600);
    const since = Number(url.searchParams.get("since")) || 0;
    const raw = await kv.get(PITI_REMARKS_KEY);
    const all = raw ? JSON.parse(raw) : [];
    return jsonResponse({ remarks: all.filter((r) => r.path === path && r.id > since) });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }

    // Browser publishes its current screen (open — a spoof just makes the cat comment
    // on a different path, harmless on a private easter egg).
    if (body && body.type === "view") {
      const view = {
        path: clamp(body.path, 600),
        screen: clamp(body.screen, 200),
        w: Math.max(0, Math.min(8000, Number(body.w) || 0)),
        h: Math.max(0, Math.min(8000, Number(body.h) || 0)),
        ts: Date.now(),
      };
      if (!view.path) return jsonResponse({ error: "bad-input" }, 400);
      await kv.put(PITI_VIEW_KEY, JSON.stringify(view));
      return jsonResponse({ ok: true });
    }

    // Agent posts a quip for the cat to deliver (secret-guarded so only the wingman,
    // never a random visitor, can put words in the cat's mouth).
    if (body && body.type === "remark") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      const path = clamp(body.path, 600);
      const text = clamp(body.text, 220);
      if (!path || !text) return jsonResponse({ error: "bad-input" }, 400);
      const raw = await kv.get(PITI_REMARKS_KEY);
      let all = raw ? JSON.parse(raw) : [];
      const cutoff = Date.now() - 3 * 60 * 1000;
      all = all.filter((r) => r.ts > cutoff); // prune stale before appending
      const num = (v, lo, hi) => (v == null || v === "" ? null : Math.max(lo, Math.min(hi, Number(v))));
      all.push({
        id: Date.now(),
        path,
        text,
        kind: clamp(body.kind, 24) || "ux",
        sel: clamp(body.sel, 400),
        x: num(body.x, 0, 20000),
        y: num(body.y, 0, 20000),
        w: num(body.w, 0, 8000),
        h: num(body.h, 0, 8000),
        ts: Date.now(),
      });
      if (all.length > 24) all = all.slice(-24);
      await kv.put(PITI_REMARKS_KEY, JSON.stringify(all));
      return jsonResponse({ ok: true, id: all[all.length - 1].id });
    }

    // Agent wipes the queue at the start of a fresh wingman session (secret-guarded).
    if (body && body.type === "clear") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      await kv.put(PITI_REMARKS_KEY, JSON.stringify([]));
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "bad-input" }, 400);
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Blanket "don't crawl anything" — the public prototypes are for link-sharing,
    // not search discovery, and the rest is password-gated. Served openly so robots
    // can actually read it (a gated robots.txt would just return the login page).
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Live-reload version probe — every page polls this with its own ?path=, and
    // gets back that path's version (versionFor); no ?path → BUILD_ID. Public (before
    // the gate) so public prototypes can poll it too; no-store so the id is never stale.
    if (url.pathname === "/__version") {
      const p = url.searchParams.get("path");
      return new Response(p ? versionFor(p) : BUILD_ID, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // Review export bypasses the password gate (its own secret guards it).
    if (url.pathname === "/__review/api/export") return reviewExport(request, url, env);

    // Piti live channel bypasses the gate too: the cat lives on PUBLIC prototypes
    // (no cookie), so browser reads/view-writes are open; agent ops self-guard with
    // the export secret. Same early-exit shape as /__version and the review export.
    if (url.pathname === "/__piti") return pitiApi(request, url, env);

    const expected = env.SITE_PASSWORD;
    const usersActive = USERS.length > 0;
    // Resolve identity once (identity mode); null in legacy/open mode.
    const me = usersActive ? await identify(request, env) : null;
    // Is this request past the gate? identity mode → a known user; legacy → the
    // shared-password cookie; neither configured → open (raw/local build, no gate).
    let authed;
    if (usersActive) authed = !!me;
    else if (expected) {
      const token = await tokenFor(expected);
      const cookies = request.headers.get("Cookie") || "";
      authed = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${token}`);
    } else authed = true;

    // Who am I — the sidebar profile chip and the comment overlay read this. Open
    // (returns {user:null} when signed out) so the chip can decide what to render.
    if (url.pathname === "/__me") return jsonResponse({ user: publicUser(me) });

    // Sign out — clear the identity cookie and bounce home.
    if (url.pathname === "/__logout") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${USER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Admin users/passwords API — admin-only (adminUsersApi re-checks me.role).
    if (url.pathname === "/__admin/users") return adminUsersApi(request, url, env, me);

    // Login form submission.
    if (request.method === "POST" && url.pathname === "/__auth") {
      const form = await request.formData();
      const requested = (form.get("redirect") || "/").toString();
      const redirect = requested.startsWith("/") ? requested : "/"; // avoid open redirect
      if (usersActive) {
        const u = userByEmail(form.get("email"));
        const pass = (form.get("password") || "").toString();
        const real = u ? await effectivePass(env, u) : "";
        if (u && real && pass.length === real.length && pass === real) {
          const token = await userToken(env, u);
          return new Response(null, {
            status: 303,
            headers: {
              Location: redirect,
              "Set-Cookie": `${USER_COOKIE}=${u.email}.${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
              "Cache-Control": "no-store",
            },
          });
        }
        return htmlResponse(loginPage(redirect, true), 401);
      }
      // Legacy shared-password mode (no identity injected).
      const pass = (form.get("password") || "").toString();
      if (expected && pass.length === expected.length && pass === expected) {
        const token = await tokenFor(expected);
        return new Response(null, {
          status: 303,
          headers: {
            Location: redirect,
            "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
            "Cache-Control": "no-store",
          },
        });
      }
      return htmlResponse(loginPage(redirect, true), 401);
    }

    // Comments: fully OPEN (reads and writes) so devs who only have the public
    // prototype link — no login — can leave feedback that syncs to KV. Obscure
    // share links, not public discovery; applyOp already clamps/caps every field.
    if (url.pathname === "/__review/api") return reviewApi(request, url, env);

    // Overlay APIs — gated by the same rule as the site (open in legacy no-gate mode
    // so raw/local builds keep working). Pins are scoped to the signed-in user.
    if (url.pathname === "/__status") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return statusApi(request, url, env);
    }
    if (url.pathname === "/__pins") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return pinsApi(request, url, env, me);
    }
    if (url.pathname === "/__name") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return nameApi(request, url, env);
    }

    // Published prototypes are public — never gated, regardless of the cookie.
    // The open door is for easy link-sharing, NOT public discovery, so tag every
    // public response as non-indexable (covers HTML and assets alike).
    if (isPublicPath(url.pathname)) {
      const res = withAssetCache(withLiveReload(await env.ASSETS.fetch(request), url), url);
      const out = new Response(res.body, res);
      out.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return out;
    }

    // Admin pages (/admin/…): require an admin user. A signed-out visitor gets the
    // login page; a signed-in non-admin is bounced home.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!authed) return htmlResponse(loginPage(url.pathname + url.search, false), 200);
      if (usersActive && (!me || me.role !== "admin")) return Response.redirect(new URL("/", url).toString(), 303);
      return withAssetCache(withLiveReload(await env.ASSETS.fetch(request), url), url);
    }

    // Past the gate (or nothing gates the site) → serve.
    if (authed) return withAssetCache(withLiveReload(await env.ASSETS.fetch(request), url), url);

    // Otherwise show the login page, remembering where they were headed.
    // 200 (not 401) so password managers treat it as a normal login page.
    return htmlResponse(loginPage(url.pathname + url.search, false), 200);
  },
};
