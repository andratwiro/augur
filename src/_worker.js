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
  // The cursor companion engine + self-hosted fonts are embedded into public
  // prototypes by absolute path, so they must bypass the gate too (else the
  // <script>/<link> fetches the login page instead of the asset).
  if (pathname === "/piti.js" || pathname.startsWith("/fonts/")) return true;
  // Composed OG/unfurl card for any page — always fetchable so link-preview bots
  // (Slack, iMessage, Twitter) can load the image even if its folder is gated.
  if (pathname.endsWith("/og.jpg")) return true;
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

function loginPage(redirect, error) {
  const safeRedirect = String(redirect).replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Product Prototypes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    /* Matches the Linear-style site shell: near-white canvas, indigo accent, Inter,
       and the same faint indigo aurora behind the content. */
    :root {
      --bg: #fbfbfd; --card: #ffffff; --fg: #16171a; --muted: #5b626e; --faint: #6b7280;
      --line: rgba(16,17,26,0.09); --line-2: rgba(16,17,26,0.15);
      --accent: #5159c9; --accent-solid: #5e6ad2; --err: #b42318;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
      font: 15px/1.55 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      letter-spacing: -0.011em; background: var(--bg); color: var(--fg);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }
    body::before {
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background:
        radial-gradient(940px 440px at 14% -12%, rgba(94,106,210,0.12), transparent 60%),
        radial-gradient(700px 420px at 98% -6%, rgba(140,99,210,0.08), transparent 55%);
    }
    .card {
      position: relative; z-index: 1;
      background: var(--card); border: 1px solid var(--line); border-radius: 16px;
      padding: 34px 32px; max-width: 380px; width: 100%;
      box-shadow: 0 24px 60px -28px rgba(16,24,40,0.32), 0 1px 2px rgba(16,24,40,0.04);
    }
    .mark {
      width: 40px; height: 40px; border-radius: 11px; margin: 0 0 18px;
      background: linear-gradient(150deg, #828bf5, #5e6ad2 70%);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.25) inset, 0 4px 14px rgba(94,106,210,0.4);
      display: grid; place-items: center; color: #fff; font-size: 20px; font-weight: 700; letter-spacing: -0.02em;
    }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 5px; }
    p.sub { color: var(--muted); margin: 0 0 24px; font-size: 14.5px; }
    label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 7px; }
    input[type=password] {
      width: 100%; font: inherit; font-size: 15px; padding: 11px 13px; border-radius: 10px;
      border: 1px solid var(--line-2); background: #fff; color: var(--fg);
      transition: border-color .12s ease, box-shadow .12s ease;
    }
    input[type=password]:hover { border-color: rgba(16,17,26,0.28); }
    input[type=password]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
    button {
      width: 100%; margin-top: 18px; font: inherit; font-weight: 600; font-size: 15px; color: #fff;
      background: var(--accent-solid); border: 1px solid transparent; border-radius: 10px; padding: 12px;
      cursor: pointer; transition: background .12s ease;
    }
    button:hover { background: #525dc6; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* Error carries an icon + text, never colour alone (WCAG 1.4.1). */
    .error {
      display: ${error ? "flex" : "none"}; align-items: flex-start; gap: 7px;
      color: var(--err); font-size: 13.5px; font-weight: 500; margin: 14px 0 0;
    }
    .error svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
    .foot { position: relative; z-index: 1; margin-top: 20px; text-align: center; color: var(--faint); font-size: 12px; }
    /* Present in the DOM for password managers (Bitwarden pairs username+password),
       but visually hidden so the UI stays password-only. NOT display:none — managers
       skip removed/hidden fields. */
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    @media (max-width: 420px) { .card { padding: 28px 22px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <div>
    <main class="card">
      <div class="mark" aria-hidden="true">P</div>
      <form method="POST" action="/__auth">
        <input type="hidden" name="redirect" value="${safeRedirect}" />
        <input class="visually-hidden" type="text" name="username" value="govocal"
               autocomplete="username" tabindex="-1" aria-hidden="true" readonly />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
        <button type="submit">Enter</button>
        <p class="error" id="pw-err" role="alert">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
          <span>Incorrect password. Try again.</span>
        </p>
      </form>
    </main>
  </div>
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
function liveReloadSnippet(token) {
  return '<!--gv-reload-start--><script>(function(){if(window.top!==window.self)return;' +
    'var B=' + JSON.stringify(token) + ',last=0;' +
    '["pointerdown","keydown","input","scroll","touchstart"].forEach(function(e){' +
    'document.addEventListener(e,function(){last=Date.now()},{passive:true,capture:true})});' +
    'function c(){fetch("/__version?path="+encodeURIComponent(location.pathname),{cache:"no-store"})' +
    '.then(function(r){return r.ok?r.text():null})' +
    '.then(function(t){if(t&&t.trim()&&t.trim()!==B&&Date.now()-last>4000)location.reload()})' +
    '.catch(function(){})}' +
    'setInterval(function(){if(!document.hidden)c()},10000);' +
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
  return new HTMLRewriter()
    .on("body", { element(el) { el.append(liveReloadSnippet(versionFor(url.pathname)), { html: true }); } })
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
    threads.push({
      id: clamp(t.id, 64) || String(Date.now()),
      sel: clamp(t.sel, 600),
      fx: +t.fx || 0, fy: +t.fy || 0, px: +t.px || 0, py: +t.py || 0,
      view: clamp(t.view, 600) || null,
      screen: clamp(t.screen, 200) || null,
      resolved: false,
      annotation: !!t.annotation,
      messages: (Array.isArray(t.messages) ? t.messages : []).slice(0, 1).map(sanitizeMsg),
    });
    if (threads.length > 500) threads = threads.slice(-500);
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
  } else if (op.op === "delete") {
    threads = threads.filter((x) => x.id !== op.id);
  }
  return threads;
}

// GET/POST /__review/api?path=<page> — read or mutate one page's threads.
// Reads are open (public prototypes embed the overlay: annotations show always-on,
// comments show once a viewer presses Shift+C). Writes stay gated — see router.
async function reviewApi(request, url, env) {
  const kv = env.COMMENTS;
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
const VALID_STATUS = { "in-progress": 1, "dev-ready": 1, ignore: 1 };

async function statusApi(request, url, env) {
  const kv = env.COMMENTS;
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
  const kv = env.COMMENTS;
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

    const expected = env.SITE_PASSWORD;

    // Comments: reads are open so devs see annotations (always-on) and comments
    // (via Shift+C) on public prototypes; writes need the password cookie.
    if (url.pathname === "/__review/api") {
      if (expected && request.method !== "GET") {
        const token = await tokenFor(expected);
        const cookies = request.headers.get("Cookie") || "";
        const ok = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${token}`);
        if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
      }
      return reviewApi(request, url, env);
    }

    // Dev-status read/write: gated by the site password (cookie) when set.
    if (url.pathname === "/__status") {
      if (expected) {
        const token = await tokenFor(expected);
        const cookies = request.headers.get("Cookie") || "";
        const ok = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${token}`);
        if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
      }
      return statusApi(request, url, env);
    }

    if (!expected) return withAssetCache(withLiveReload(await env.ASSETS.fetch(request), url), url); // open when no password configured

    const expectedToken = await tokenFor(expected);

    // Login form submission.
    if (request.method === "POST" && url.pathname === "/__auth") {
      const form = await request.formData();
      const pass = (form.get("password") || "").toString();
      const requested = (form.get("redirect") || "/").toString();
      const redirect = requested.startsWith("/") ? requested : "/"; // avoid open redirect
      if (pass.length === expected.length && pass === expected) {
        return new Response(null, {
          status: 303,
          headers: {
            Location: redirect,
            "Set-Cookie": `${COOKIE}=${expectedToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
            "Cache-Control": "no-store",
          },
        });
      }
      return htmlResponse(loginPage(redirect, true), 401);
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

    // Already authenticated?
    const cookies = request.headers.get("Cookie") || "";
    const authed = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${expectedToken}`);
    if (authed) return withAssetCache(withLiveReload(await env.ASSETS.fetch(request), url), url);

    // Otherwise show the login page, remembering where they were headed.
    // 200 (not 401) so password managers treat it as a normal login page.
    return htmlResponse(loginPage(url.pathname + url.search, false), 200);
  },
};
