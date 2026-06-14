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
  </style>
</head>
<body>
  <main class="card">
    <h1>GoVocal Prototypes</h1>
    <p class="sub">Enter the password to continue.</p>
    <form method="POST" action="/__auth">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
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

export default {
  async fetch(request, env) {
    const expected = env.SITE_PASSWORD;
    if (!expected) return env.ASSETS.fetch(request); // open when no password configured

    const url = new URL(request.url);
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
    return htmlResponse(loginPage(url.pathname + url.search, false), 401);
  },
};
