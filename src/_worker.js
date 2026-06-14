// Source for dist/_worker.js — copied verbatim by build.js into the deploy dir.
// Cloudflare Pages Advanced Mode: this Worker runs in front of every request.
//
// When the SITE_PASSWORD env var/secret is set on the Pages project, the whole
// site is gated behind a single custom password page (no username). A correct
// password sets a cookie whose value is SHA-256("gv:" + password) — so the raw
// password is never stored in the cookie — and the Worker checks that cookie on
// every request. If SITE_PASSWORD is unset (e.g. local builds), the site is open.
//
// Casual shared-password gate against link leakage — NOT Zero Trust.

const COOKIE = "gv_auth";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

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
  <title>GoVocal Prototypes</title>
  <style>
    :root {
      --bg: #fafafa; --fg: #1a1a1a; --muted: #6b7280;
      --line: #e5e7eb; --accent: #2563eb; --card: #ffffff; --err: #dc2626;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d0d0f; --fg: #f3f4f6; --muted: #9ca3af;
        --line: #26262b; --accent: #60a5fa; --card: #161619; --err: #f87171;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 16px;
      padding: 36px; max-width: 380px; width: calc(100% - 48px);
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    h1 { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 4px; }
    p.sub { color: var(--muted); margin: 0 0 24px; font-size: 14px; }
    label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 6px; }
    input[type=password] {
      width: 100%; font: inherit; padding: 11px 12px; border-radius: 10px;
      border: 1px solid var(--line); background: var(--bg); color: var(--fg);
    }
    input[type=password]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
    button {
      width: 100%; margin-top: 16px; font: inherit; font-weight: 500; color: #fff;
      background: var(--accent); border: 0; border-radius: 10px; padding: 12px;
      cursor: pointer; transition: filter 0.12s ease;
    }
    button:hover { filter: brightness(1.08); }
    .error { color: var(--err); font-size: 13px; margin: 12px 0 0; ${error ? "" : "display:none;"} }
    /* Present in the DOM for password managers (Bitwarden pairs username+password),
       but visually hidden so the UI stays password-only. NOT display:none — managers
       skip removed/hidden fields. */
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>GoVocal Prototypes</h1>
    <p class="sub">Enter the password to continue.</p>
    <form method="POST" action="/__auth">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
      <input class="visually-hidden" type="text" name="username" value="govocal"
             autocomplete="username" tabindex="-1" aria-hidden="true" readonly />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">Enter</button>
      <p class="error">Incorrect password. Try again.</p>
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
      resolved: false,
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
  } else if (op.op === "delete") {
    threads = threads.filter((x) => x.id !== op.id);
  }
  return threads;
}

// GET/POST /__review/api?path=<page> — read or mutate one page's threads.
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

// ---- Prototype status API (KV-backed) ---------------------------------------
// One KV value per prototype page path, key "s:<path>", value "in_progress" |
// "closed". An absent key means the default, "in_progress" — so "closed" is the
// only value ever stored, and re-opening just deletes the key.

const STATUSES = ["in_progress", "closed"];

async function allStatuses(kv) {
  const statuses = {};
  let cursor;
  do {
    const list = await kv.list({ prefix: "s:", cursor });
    for (const k of list.keys) {
      const v = await kv.get(k.name);
      if (v) statuses[k.name.slice(2)] = v;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return statuses;
}

// GET /__review/status                  — { statuses: { "<path>": "closed", … } }
// POST /__review/status?path=<page>     — body { status } ; persists one prototype.
async function statusApi(request, url, env) {
  const kv = env.COMMENTS;
  if (!kv) return jsonResponse({ statuses: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    return jsonResponse({ statuses: await allStatuses(kv) });
  }
  if (request.method === "POST") {
    const path = clamp(url.searchParams.get("path") || "", 600);
    if (!path) return jsonResponse({ error: "no-path" }, 400);
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const status = STATUSES.includes(body && body.status) ? body.status : "in_progress";
    const key = "s:" + path;
    if (status === "in_progress") {
      await kv.delete(key); // default = absence of a key
    } else {
      await kv.put(key, status);
    }
    return jsonResponse({ path, status });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// GET /__review/api/export?key=<REVIEW_EXPORT_KEY> — all threads + statuses.
// Secret-guarded so tooling can read review data WITHOUT the site password.
async function reviewExport(request, url, env) {
  const secret = env.REVIEW_EXPORT_KEY;
  if (!secret) return jsonResponse({ error: "export-disabled" }, 404);
  const given = url.searchParams.get("key") || request.headers.get("X-Review-Key") || "";
  if (given.length !== secret.length || given !== secret) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  const kv = env.COMMENTS;
  if (!kv) return jsonResponse({ pages: {}, statuses: {}, warning: "no-kv-binding" });
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
  return jsonResponse({ pages, statuses: await allStatuses(kv), generatedAt: new Date().toISOString() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Review export bypasses the password gate (its own secret guards it).
    if (url.pathname === "/__review/api/export") return reviewExport(request, url, env);

    const expected = env.SITE_PASSWORD;

    // Comment + status read/write: gated by the site password (cookie) when set.
    if (url.pathname === "/__review/api" || url.pathname === "/__review/status") {
      if (expected) {
        const token = await tokenFor(expected);
        const cookies = request.headers.get("Cookie") || "";
        const ok = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${token}`);
        if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
      }
      return url.pathname === "/__review/status"
        ? statusApi(request, url, env)
        : reviewApi(request, url, env);
    }

    if (!expected) return env.ASSETS.fetch(request); // open when no password configured

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

    // Already authenticated?
    const cookies = request.headers.get("Cookie") || "";
    const authed = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${expectedToken}`);
    if (authed) return env.ASSETS.fetch(request);

    // Otherwise show the login page, remembering where they were headed.
    // 200 (not 401) so password managers treat it as a normal login page.
    return htmlResponse(loginPage(url.pathname + url.search, false), 200);
  },
};
