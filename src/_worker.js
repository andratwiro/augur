// Source for dist/_worker.js — injected (USERS, RESTRICTED_BASES, PUBLIC_PREFIXES,
// VERSION_MAP, BUILD_ID) and copied by build.js into the deploy dir.
// Cloudflare Pages Advanced Mode: this Worker runs in front of every request.
//
// Gate model: PER-USER accounts (email + password). build.js injects USERS from
// src/identity.json; a login sets a cookie carrying "<email>.<token>" where token is
// derived from the user's effective password (admin-set KV override ?? seed) — see
// identify(). The internal surface (root index, per-opportunity indexes, galleries)
// is gated; direct prototype URLs, their DS assets, /pages, and /_build.json are
// public — see PUBLIC_PREFIXES / isPublicPath. Admin-only spaces' base paths
// (RESTRICTED_BASES) are sealed to admins. Legacy fallback: with no USERS injected
// but SITE_PASSWORD set, a single shared-password gate applies; with neither, the
// site is open (raw/local builds).
//
// Casual gate against link leakage — NOT Zero Trust.

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
const LASTSEEN_PREFIX = "users:lastseen:";  // KV per-user ISO stamp — admin list column

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
  // The build stamp ({builtAt, spaces:{<id>:{sha}}}). Space-repo collaborators can't
  // see this repo's CI, so this is their only way to verify "my commit is live" —
  // curl it and compare sha to git rev-parse HEAD. Public by design; contains nothing
  // but commit SHAs that those collaborators already have.
  if (pathname === "/_build.json") return true;
  // The dormant review overlay + its avatar asset — both embedded into public
  // prototypes, so both must bypass the gate (else the <img> gets the login page).
  if (pathname === "/__review/comments.js" || pathname === "/__review/aslam.png") return true;
  // The composition graph the overlay recurses (window.__GV_GRAPH) — embedded into
  // every public prototype before comments.js, so it must bypass the gate too.
  if (pathname === "/__review/graph.js") return true;
  // The shared infinite-canvas engine (canvas.js/.css) is embedded by absolute /__canvas/
  // path into canvas prototypes, so its assets must bypass the gate too (else the
  // <script>/<link> fetches the login page instead of the asset). RENDERED ASSET extensions
  // only — never a blanket prefix; the board DATA API (/__board) has its own public route below.
  if (pathname.startsWith("/__canvas/") &&
      /\.(css|js|mjs|json|map|svg|png|webp)$/i.test(pathname)) return true;
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
  // NOTE: the /skills and /pages doors above are DEFAULT-SPACE-ONLY (root paths). A
  // future non-default, non-adminOnly space needs base-aware equivalents
  // (/<id>/skills/…, /<id>/pages/…) or its public prototypes render unstyled to
  // signed-out visitors. Revisit when the first public second space mounts.
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname === p.slice(0, -1) || pathname.startsWith(p)
  );
}

// ADMIN-ONLY space base paths (e.g. "/go-vocal-2" — the 2.0 workspace). build.js
// replaces the array below with the base path of every space whose space.json sets
// "adminOnly": true, so it can never drift from what shipped. Everything under one
// of these prefixes requires an admin user — regular users (Irene, Tali) are bounced
// home, signed-out visitors get the login page. Left empty in a raw copy → no space
// is restricted (a local build with no identity gates nothing extra).
const RESTRICTED_BASES = [];

// Does this path live inside an admin-only space? Matches the base ("/go-vocal-2"),
// its root ("/go-vocal-2/") and everything beneath it.
function isRestrictedPath(pathname) {
  return RESTRICTED_BASES.some(
    (b) => pathname === b || pathname.startsWith(b + "/")
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

// Record when a signed-in user was last seen ("last connection" in the admin list).
// Fired only from /__me (one call per page view, the profile chip's fetch) and from a
// successful login — never from asset requests. Throttled: while the stored stamp is
// fresh (<15 min) a browsing burst costs one KV read and zero writes (KV allows ~1
// write/sec/key). Fire-and-forget via ctx.waitUntil; telemetry must never break a
// request, hence the blanket catch.
async function touchLastSeen(env, u) {
  try {
    const kv = kvFor(env);
    if (!kv || !u) return;
    const key = LASTSEEN_PREFIX + u.email;
    const prev = await kv.get(key);
    if (prev && Date.now() - Date.parse(prev) < 15 * 60 * 1000) return;
    await kv.put(key, new Date().toISOString());
  } catch (e) {}
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

// Branded 404 — same shell language as loginPage (near-white canvas, indigo accent,
// Inter, the Augur mark). Shown when env.ASSETS.fetch returns a 404 for a request
// that is PAST the gate (authed user, admin page, or a public-prototype path). The
// signed-out fallthrough keeps returning the login page instead, so an unknown URL
// never reveals whether it exists to someone who hasn't logged in.
function notFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Not found · Augur</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    :root {
      --bg: #fbfbfd; --card: #ffffff; --fg: #16171a; --muted: #5b626e; --faint: #9aa0ab;
      --line: rgba(16,17,26,0.09); --line-2: rgba(16,17,26,0.15);
      --accent: #2c2150; --accent-solid: #2c2150;
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
      padding: 34px 32px 30px; max-width: 380px; width: 100%; text-align: center;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 10px 28px -22px rgba(16,24,40,0.22);
    }
    .logo { display: flex; justify-content: center; margin: 2px 0 20px; }
    .logo svg { width: 40px; height: 40px; display: block; }
    .code { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); margin: 0 0 6px; }
    h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 14px; color: var(--muted); margin: 0 0 22px; }
    a.home {
      display: inline-block; font-weight: 600; font-size: 14px; color: #fff;
      background: var(--accent-solid); border-radius: 9px; padding: 9px 18px;
      text-decoration: none; transition: background .12s ease;
    }
    a.home:hover { background: #38295e; }
    a.home:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 420px) { .card { padding: 28px 22px; } }
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
    <p class="code">404</p>
    <h1>Page not found</h1>
    <p>This URL doesn't match any page, prototype, or asset.</p>
    <a class="home" href="/">Back to Augur</a>
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

// Branded 404 for requests that are past the gate. no-store + noindex so it's never
// cached or crawled. Used wherever env.ASSETS.fetch returns a 404 for an authed/public path.
function notFoundResponse() {
  return new Response(notFoundPage(), {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
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
  // The infinite-canvas engine (canvas.js/.css/catalog.json) is loaded by absolute path
  // with no ?v= cache-buster and is actively iterated, so the default `max-age=0,
  // must-revalidate` lets a soft/bfcache navigation keep running a stale engine (new CSS,
  // old JS). no-store guarantees every canvas load fetches the current engine. Tiny files,
  // low-traffic tool → cost is nil. (Switch to versioned-immutable once it stabilises.)
  if (url.pathname.startsWith("/__canvas/") && /\.(js|css|json)$/i.test(url.pathname)) {
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-store");
    return out;
  }
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

// ---- Go Vocal MCP proxy (same-origin bridge) ---------------------------------
// GoVocal platforms send no CORS headers on /mcp or /oauth/token, so a browser
// prototype on this origin cannot call them directly. This route lets a page
// call /__mcp/<host>/<path> on ITS OWN origin and have the worker forward to
// https://<host>/<path>. Public (before the gate) — the platform's own OAuth
// Bearer token is the real auth; the proxy adds nothing, stores nothing, and
// never logs a token. Allowlist is tight: *.govocal.com hosts, and exactly the
// three paths the Project Builder flow needs.

const MCP_PROXY_PATHS = new Set(["/mcp", "/oauth/token", "/web_api/v1/app_configuration"]);

async function mcpProxy(request, url) {
  const rest = url.pathname.slice("/__mcp/".length); // "<host>/<path…>"
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.govocal\.com$/.test(host))
    return jsonResponse({ error: "host not allowed" }, 403);
  if (!MCP_PROXY_PATHS.has(path)) return jsonResponse({ error: "path not allowed" }, 403);
  if (request.method !== "POST" && request.method !== "GET")
    return jsonResponse({ error: "method not allowed" }, 405);
  const headers = new Headers();
  for (const h of ["content-type", "accept", "authorization", "mcp-protocol-version"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const upstream = await fetch(`https://${host}${path}`, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// ---- AI document summarizer ------------------------------------------------
// The Project Builder prototype drops a doc → this route reads its extracted
// text and returns a plain-language summary + structured drafting signals
// (archetype / method flags / tags), so the builder suggests a genuinely
// better-shaped project instead of keyword-guessing. Gated behind the login.
// Two backends, in order of preference (see aiSummarize):
//   1. AI_CLI_URL  — a local `claude -p` bridge (offline mode; the maintainer's
//      Claude login, NO API tokens). This is the normal path.
//   2. ANTHROPIC_API_KEY — the Anthropic Messages API (pay-as-you-go); a
//      dormant fallback for a deployed site that opts in by setting the key.
// Neither configured → 503, and the prototype falls back to its heuristic.
// The API-path model is a single constant. Opus 4.8 for the customer demo:
// richest read of a complex doc (sharpest summary, most reliable archetype/flags,
// least over-flagging) — its few extra seconds are covered by the client's narrated
// "thinking" stepper, which makes the analysis read as considered. ~a few cents per
// doc; trivial at demo volume. Drop to claude-sonnet-4-6 / claude-haiku-4-5 for
// faster/cheaper output if a call warrants it.

const AI_MODEL = "claude-opus-4-8";

const AI_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short working title for the project (≤ 64 chars), in the document's language." },
    summary: { type: "string", description: "2 plain sentences: what this consultation is about and what decision it feeds. Same language as the document. No preamble." },
    archetype: { type: "string", enum: ["inform", "agenda", "cocreate", "devolved", "community"], description: "inform=communicate a decision; agenda=what should we prioritise; cocreate=shape a plan/site; devolved=citizens vote/allocate budget; community=identity/celebration." },
    flags: {
      type: "object",
      additionalProperties: false,
      properties: {
        budget: { type: "boolean", description: "A participatory budget / money to allocate is in scope." },
        surveyLed: { type: "boolean", description: "Reach/breadth via a questionnaire fits better than open idea collection." },
        spatial: { type: "boolean", description: "The ask is about places, routes, or sites (a map would help)." },
        commonground: { type: "boolean", description: "The topic is divisive; finding agreement on statements is relevant." },
        proposals: { type: "boolean", description: "Petition / threshold-based citizen proposals are the mechanism." },
        volunteering: { type: "boolean", description: "Recruiting volunteers is part of the ask." },
      },
      required: ["budget", "surveyLed", "spatial", "commonground", "proposals", "volunteering"],
    },
    tags: { type: "array", items: { type: "string" }, description: "1–4 topic tags from: Consultatie, Stedelijke ontwikkeling, Mobiliteit, Milieu, Jongeren, Ouderen, Burgerbegroting, Financiën, Veiligheid, Cultuur." },
    plan: {
      type: "object",
      additionalProperties: false,
      description: "The participation project you would design FROM THIS DOCUMENT — its phases in order, and why. Grounded in the document's own structure, not a generic template.",
      properties: {
        rationale: { type: "string", description: "1–2 plain Dutch sentences: why THIS phase sequence fits THIS document (the participation logic — what is gathered, decided, fed back). Reference the document's own milestones where it has them. No invented statistics or score claims." },
        phases: {
          type: "array",
          description: "The project's phases (1–6), in chronological order. Each phase runs exactly ONE method. Design them from the document's actual milestones/campaigns; do not pad with generic phases the document doesn't warrant.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "Short, specific Dutch phase title tied to this document (e.g. 'Visie en waarden ophalen'), not a generic label." },
              method: { type: "string", enum: ["information", "collect", "proposals", "commonground", "survey", "voting", "volunteering"], description: "Go Vocal method. information=share info/results; collect=gather ideas & input (ideation); proposals=citizen proposals with a support threshold; commonground=find agreement on a divisive topic; survey=structured questionnaire for reach; voting=prioritise/choose between options (see votingType); volunteering=recruit volunteers." },
              purpose: { type: "string", description: "One Dutch sentence: what happens in this phase and what it produces. Becomes the phase description." },
              weeks: { type: "integer", description: "Phase length in weeks (1–16). Reflect the document's real horizon, not a fixed default." },
              votingType: { type: "string", enum: ["approval", "budgeting"], description: "ONLY when method=voting. approval=vote to prioritise/choose; budgeting=participatory budget (residents allocate money)." },
              budget: { type: "integer", description: "ONLY when method=voting AND votingType=budgeting: total euros residents allocate. Use the document's figure if it states one; otherwise a sensible round amount." },
              questions: {
                type: "array",
                description: "ONLY when method=survey: the actual questionnaire for this phase — 4 to 7 questions in order, grounded in what this phase's purpose says it needs to learn from the document. Omit entirely (or empty) for every non-survey method.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: { type: "string", enum: ["select", "multiselect", "linear_scale", "rating", "text", "multiline_text"], description: "Field type. select=one choice · multiselect=several choices · linear_scale=1–N agree/importance scale with end labels · rating=1–N star rating · text=one short line · multiline_text=open paragraph. Vary them; don't make every question open text." },
                    title: { type: "string", description: "The question itself, in Dutch (nl-NL)." },
                    required: { type: "boolean", description: "Whether an answer is mandatory. Keep most optional; require only the essentials." },
                    options: { type: "array", items: { type: "string" }, description: "ONLY for select/multiselect: the answer choices in Dutch (typically 3–6). Make them concrete and mutually clear; omit for all other types." },
                    scaleMax: { type: "integer", description: "ONLY for linear_scale/rating: top of the scale, 3–5 is usual (max 11)." },
                    minLabel: { type: "string", description: "ONLY for linear_scale: Dutch label for the low end (e.g. 'Zeer ontevreden')." },
                    maxLabel: { type: "string", description: "ONLY for linear_scale: Dutch label for the high end (e.g. 'Zeer tevreden')." },
                  },
                  required: ["type", "title", "required"],
                },
              },
            },
            required: ["title", "method", "purpose", "weeks"],
          },
        },
      },
      required: ["rationale", "phases"],
    },
    events: {
      type: "array",
      description: "Real-world moments this document describes or clearly implies — an info/consultation evening, a pop-up or market stand, a design workshop, a kick-off or closing meeting. Include 1–3 ONLY when the document genuinely implies people gathering in person or online. For a purely digital consultation with no gatherings, return an empty array — NEVER invent events.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Short, specific Dutch event title tied to the document (e.g. 'Inloopavond conceptplan')." },
          purpose: { type: "string", description: "One Dutch sentence: what happens at this event and who it is for. Becomes the event description." },
          format: { type: "string", enum: ["in_person", "online", "hybrid"], description: "in_person=a physical venue; online=a video call; hybrid=both." },
          location: { type: "string", description: "For in_person/hybrid: a Dutch venue or area name grounded in the document (e.g. 'Stadhuis, raadzaal' or 'Marktplein'). Omit for online." },
          phaseIndex: { type: "integer", description: "0-based index into plan.phases of the phase this event supports, so it can be scheduled inside that phase's window. Use the closest-fitting phase." },
          durationHours: { type: "integer", description: "Typical length in hours (1–4 is usual, max 8)." },
        },
        required: ["title", "purpose", "format"],
      },
    },
  },
  required: ["title", "summary", "archetype", "flags", "tags", "plan"],
};

const AI_SYSTEM = [
  "You are a senior Go Vocal participation designer. You turn an uploaded planning/policy/engagement document into a concrete Go Vocal participation project for a Dutch municipality (Gemeente Gouda).",
  "Ground everything in what the document actually says — never invent a driver, budget, audience, or scope it doesn't state.",
  "Go Vocal model: a project is an ordered sequence of PHASES; each phase runs exactly ONE participation method. Design the phases FROM THE DOCUMENT'S OWN STRUCTURE — if it names milestones, stages, or campaigns (e.g. visioning → land-use/policy → draft review), mirror those as phases with specific titles. Do not force a generic template, and do not pad with phases the document doesn't warrant.",
  "Method meanings — pick the one that fits each phase's real purpose: collect (ideation: gather ideas/input and discuss openly) · survey (a structured questionnaire, chosen for reach/breadth over open ideation) · proposals (residents submit proposals that gather support to a threshold) · commonground (surface agreement/disagreement on a divisive topic, statement by statement) · voting (prioritise or choose between options; set votingType=approval, OR votingType=budgeting with a budget amount when residents allocate money — participatory budgeting) · volunteering (recruit volunteers) · information (share context or feed back results).",
  "Consult vs inform — do NOT confuse them. The `information` method is ONE-WAY (share context, or feed back final results). If a document stage asks residents to REVIEW, react to, or give feedback on a draft/concept/proposal, that is a CONSULTATION — use survey (structured feedback) or collect (open comments/ideas on the draft), never `information`. Never collapse a 'review the draft plan' milestone into a one-way information phase. A closing `information` phase (‘what we did with your input’) is a good final touch, but it comes AFTER any real review — it does not replace it.",
  "Sequencing heuristics (guidance, adapt to the document): a lone engagement phase is weak — feed results back. Co-creating a plan usually means broad input, then refine, then review of the draft, then a short results/close. Participatory budgeting is collect → voting(budgeting) → information. Only use voting/budget when the document really asks residents to choose between options or allocate money.",
  "Phases are the document's SEQUENTIAL milestones only. Do NOT promote a cross-cutting audience, channel, or component into its own milestone phase — e.g. youth/student engagement, targeted outreach to hard-to-reach groups, or an always-open online portal run ACROSS the whole process, not as a separate step between milestones. Reflect a continuously-open channel, if the document describes one, as a single background collect phase spanning the process; reflect targeted audiences inside the relevant phase's purpose, not as their own phase.",
  "Some documents describe or imply real-world moments — an info/consultation evening, a pop-up or market stand, a design workshop, a kick-off or closing meeting. When (and ONLY when) the document genuinely implies people gathering in person or online, propose 1–3 such events in `events`, each tied to the phase it supports (`phaseIndex`) and grounded in the document (a venue/area it actually names). For a purely digital consultation with no gatherings, return an empty `events` array — never invent them. All event text in Dutch.",
  "For EVERY phase whose method is `survey`, design its actual questionnaire in `questions`: 4–7 real questions that gather exactly what that phase's purpose says it needs from the document (satisfaction, priorities, constraints, willingness, context). Ground each question in the document — never generic filler. Open with a short context/demographic question (e.g. neighbourhood, or how often they use the thing) and mix field types deliberately: use select/multiselect (with concrete Dutch options) for categorical choices, linear_scale (with Dutch end labels) for satisfaction/agreement/importance, rating for a quality score, and a single multiline_text near the end for open remarks — do not make every question open text. Mark only the essentials required. Write every question and option in Dutch. Do NOT put a `questions` array on any non-survey phase.",
  "Set `weeks` to the document's REAL horizon, do not compress. A comprehensive/structural plan or a multi-campaign process typically runs many months (often 12–18); individual gathering or review phases are usually 4–8 weeks each. Off-platform tracks the document mentions (internal committees, stakeholder interviews, formal reporting) need not become phases — keep the resident-facing spine faithful, but you may note in the rationale what happens off-platform.",
  "ALL user-facing text you generate — title, summary, every phase title, every purpose, and the rationale — must be in Dutch (nl-NL), even when the source document is in another language. The tenant is Dutch; this is deliberate.",
  "The summary must read like a person wrote it: two short plain Dutch sentences, no 'Dit document…' preamble.",
  "Also set the coarse signals: pick the single best-fitting archetype, and set every flag false unless the document explicitly calls for that mechanism (when in doubt, false). These are a fallback; your `plan` is the real output.",
].join(" ");

async function aiSummarize(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "bad json" }, 400); }
  const text = String((body && body.text) || "").slice(0, 60000); // ~15k tokens cap
  if (text.trim().length < 40) return jsonResponse({ error: "text too short" }, 400);

  // Preferred path: a local CLI bridge (offline mode wires AI_CLI_URL to a
  // 127.0.0.1 server that shells out to `claude -p` — the maintainer's Claude
  // login, NO API tokens). The API-key path below is a dormant fallback for a
  // deployed site that has ANTHROPIC_API_KEY set; absent both → 503 → heuristic.
  if (env.AI_CLI_URL) {
    try {
      const r = await fetch(env.AI_CLI_URL.replace(/\/+$/, "") + "/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.summary) return jsonResponse(j);
      return jsonResponse({ error: "cli", status: r.status }, 502);
    } catch (e) {
      return jsonResponse({ error: "cli_unreachable", detail: String((e && e.message) || e) }, 502);
    }
  }

  const key = env.ANTHROPIC_API_KEY;
  if (!key) return jsonResponse({ error: "ai_not_configured" }, 503);

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // This caps OUTPUT, not input (the doc is sliced to 60k chars above). The output
        // is the project structure — bounded by the SCHEMA (≤6 phases, a few questions
        // per survey, ≤3-4 events, summary+rationale), NOT by document length: a 5-page
        // brief and a 200-page plan both collapse to that shape (~2k tokens even for a
        // rich comprehensive plan). 2048 truncated the JSON on rich docs (→ parse → 502
        // → silent heuristic fallback), so this is set far above the realistic max as
        // free insurance — only tokens actually generated are billed.
        model: AI_MODEL,
        max_tokens: 16384,
        system: AI_SYSTEM,
        output_config: { format: { type: "json_schema", schema: AI_SUMMARY_SCHEMA } },
        messages: [{ role: "user", content: "Document:\n\n" + text }],
      }),
    });
  } catch (e) {
    return jsonResponse({ error: "network", detail: String(e && e.message || e) }, 502);
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return jsonResponse({ error: "upstream", status: upstream.status, detail: detail.slice(0, 400) }, 502);
  }
  const data = await upstream.json().catch(() => null);
  const block = data && Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  if (!block) return jsonResponse({ error: "empty" }, 502);
  let out;
  try { out = JSON.parse(block.text); } catch { return jsonResponse({ error: "parse" }, 502); }
  return jsonResponse(out);
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
// edits on top. Values: in-progress | dev-ready | ignore | reviewed (components).
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

// ---- Canvas board documents (KV-backed, one key per canvas URL) -------------
// Each canvas (a prototype that mounts the shared /__canvas/ engine) owns ONE board
// document — nodes + view + name — keyed by its URL path, the same per-URL rail comments
// use, so it isolates per-space for free. The client owns the whole document, so we store
// exactly what it POSTs (authoritative full-state write, like pins) — no server-side merge
// that could race under KV eventual consistency. GET returns { doc } (null if never saved).
const BOARD_PREFIX = "board:";
const BOARD_MAX_BYTES = 20 * 1024 * 1024; // under KV's 25MB per-value ceiling (inline images)

async function boardApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ doc: null, warning: "no-kv-binding" });
  const path = clamp(url.searchParams.get("path"), 600);
  if (!path) return jsonResponse({ error: "bad-input" }, 400);
  const key = BOARD_PREFIX + path;

  if (request.method === "GET") {
    const raw = await kv.get(key);
    return jsonResponse({ doc: raw ? JSON.parse(raw) : null });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.text();
    if (body.length > BOARD_MAX_BYTES) return jsonResponse({ error: "too-large" }, 413);
    let op;
    try { op = JSON.parse(body); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const doc = op && op.doc;
    if (typeof doc !== "object" || doc === null || !Array.isArray(doc.nodes)) return jsonResponse({ error: "bad-input" }, 400);
    await kv.put(key, JSON.stringify(doc));
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Canvas multiplayer proxy (/__rt → augur-realtime worker) ---------------
// The BoardRoom Durable Objects live in a SEPARATE worker (Pages can't define DO
// classes), deployed from realtime/ via `npm run deploy:realtime`. Proxying keeps the
// client same-origin (no hardcoded workers.dev URL in canvas.js, works offline too);
// fetch() with the Upgrade header intact returns the 101 + socket, passed through.
const RT_ORIGIN = "https://augur-realtime.rob-3d3.workers.dev";
function rtProxy(request, url) {
  if (request.headers.get("Upgrade") !== "websocket") return jsonResponse({ error: "expected-websocket" }, 426);
  return fetch(RT_ORIGIN + "/room" + url.search, request);
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
      let lastSeen = null;
      try { lastSeen = kv ? await kv.get(LASTSEEN_PREFIX + u.email) : null; } catch (e) {}
      users.push({
        email: u.email, name: u.name, role: u.role || "user",
        initials: u.initials || "", color: u.color || "#4f46e5",
        pass: await effectivePass(env, u),
        lastSeen,
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Demo vanity domain: wizard.demogouda.govocal.com is CNAME'd to this Pages
    // project + added as a custom domain, so the worker runs here. DNS can't
    // target a path, so land its root on the Project Builder prototype. Scoped
    // to that exact host — never affects pages.dev or any other domain.
    if (url.hostname === "wizard.demogouda.govocal.com" && (url.pathname === "/" || url.pathname === "")) {
      return Response.redirect("https://wizard.demogouda.govocal.com/playground/project-builder-v2/", 302);
    }

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

    // Go Vocal MCP proxy — public prototypes call the platform through their own
    // origin (the platform's Bearer token is the real auth; see mcpProxy).
    if (url.pathname.startsWith("/__mcp/")) return mcpProxy(request, url);

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

    // AI document summarizer — PUBLIC (not gated). The Project Builder prototype
    // that calls this ships to /playground/ and is publicly reachable (customer
    // demos, shared links — the viewer is never logged in), so gating this behind
    // the login left the doc-upload flow 401ing for everyone but a signed-in admin.
    // It spends Anthropic tokens, but the handler is self-limiting: POST-only, input
    // capped at 60k chars, output bounded by the schema. 503 when unconfigured →
    // the prototype falls back to its local heuristic.
    if (url.pathname === "/__ai/summarize") {
      return aiSummarize(request, env);
    }

    // Who am I — the sidebar profile chip and the comment overlay read this. Open
    // (returns {user:null} when signed out) so the chip can decide what to render.
    // Doubles as the "last seen" heartbeat: it fires once per page view.
    if (url.pathname === "/__me") {
      if (me && ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(env, me));
      return jsonResponse({ user: publicUser(me) });
    }

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
          if (ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(env, u));
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
    // Canvas board docs follow the COMMENTS model, not the status/pins model: a canvas is a
    // PUBLISHED prototype (public, obscure share link), so its board must load & save without a
    // login, exactly like /__review/api. Writes are full-state but size-capped in boardApi.
    if (url.pathname === "/__board") return boardApi(request, url, env);
    // Canvas multiplayer: same-origin WebSocket proxied to the augur-realtime worker (one
    // BoardRoom Durable Object per board path — cursors/presence/live ops). Public like
    // /__board: the board is the credential. The engine degrades to solo if this fails.
    if (url.pathname === "/__rt") return rtProxy(request, url);

    // Admin-only spaces (the 2.0 workspace): seal the whole base path BEFORE the
    // public-prototype door, so nothing under it — not even an og.jpg — leaks. Only
    // an admin (Rob) gets through; a signed-in non-admin (Irene, Tali) is bounced
    // home; a signed-out visitor gets the login page. Skipped in legacy/open mode
    // (no users injected), same as the /admin gate.
    if (usersActive && isRestrictedPath(url.pathname)) {
      if (!authed) return htmlResponse(loginPage(url.pathname + url.search, false), 200);
      if (!me || me.role !== "admin") return Response.redirect(new URL("/", url).toString(), 303);
    }

    // Published prototypes are public — never gated, regardless of the cookie.
    // The open door is for easy link-sharing, NOT public discovery, so tag every
    // public response as non-indexable (covers HTML and assets alike).
    if (isPublicPath(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status === 404) return notFoundResponse();
      const res = withAssetCache(withLiveReload(asset, url), url);
      const out = new Response(res.body, res);
      out.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return out;
    }

    // Admin pages (/admin/…): require an admin user. A signed-out visitor gets the
    // login page; a signed-in non-admin is bounced home.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!authed) return htmlResponse(loginPage(url.pathname + url.search, false), 200);
      if (usersActive && (!me || me.role !== "admin")) return Response.redirect(new URL("/", url).toString(), 303);
      const asset = await env.ASSETS.fetch(request);
      if (asset.status === 404) return notFoundResponse();
      return withAssetCache(withLiveReload(asset, url), url);
    }

    // Past the gate (or nothing gates the site) → serve.
    if (authed) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status === 404) return notFoundResponse();
      return withAssetCache(withLiveReload(asset, url), url);
    }

    // Otherwise show the login page, remembering where they were headed.
    // 200 (not 401) so password managers treat it as a normal login page.
    return htmlResponse(loginPage(url.pathname + url.search, false), 200);
  },
};
