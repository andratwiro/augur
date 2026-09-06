// browser-lib.mjs — the pure pieces of "your browser": which verb is legal against which
// path, and how a fetched page becomes the plain text the scripted person reads. Kept apart
// from browser.mjs (which does the actual signed-in fetch) so they run under `node --test`
// with no network, no persona, no live workspace.

/** `--accept` only makes sense on an invite redemption link. */
export function canAccept(pathname) {
  return /^\/__invite\b/.test(String(pathname || ""));
}

/**
 * `--type` types a pairing code into a box. Two pages carry one: the terminal-connect
 * page, and the welcome flow's own approve form (both post to the same
 * `/__publish/_pair/approve` route) — everywhere else there is nothing to type into.
 */
export function canType(pathname) {
  return /\/__connect\b|\/__welcome\b/.test(String(pathname || ""));
}

/** A page or an API response as "read text" — scripts and styles stripped, tags gone. */
export function renderPageText(raw, contentType) {
  if (!/html/.test(String(contentType || ""))) return raw;
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // What a real browser does not show: templates, elements marked hidden or aria-hidden,
    // and the sign-in form's error block, which the page always renders and only reveals
    // on an error (7 Sep 2026: a text-only person read "Incorrect email or password" on a
    // page they had never typed into, and their agent called the page phishing).
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<(\w+)[^>]*\b(?:hidden|aria-hidden="true")[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<p[^>]*\bid="pw-err"[^>]*>[\s\S]*?<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What the welcome page's approve form says on a successful `--type`, by path. Both
 * `/__connect` and `/__welcome` post to the same `/__publish/_pair/approve` route (see
 * `canType`), but they are two different pages with two different next steps: `/__connect`
 * is a standalone page with nothing else to do (`connectPage` in src/_worker.js — "you can
 * close this tab"), while `/__welcome`'s own approve form (`renderWelcomePage` in
 * src/welcome-page.mjs) sits on a multi-step flow whose own Next button is what to press
 * next. Getting this backwards would tell an invitee stuck on `/__welcome` to close the
 * tab they still need.
 */
export function typeSuccessMessage(pathname) {
  return /\/__welcome\b/.test(String(pathname || ""))
    ? "Connected. Press Next."
    : "Connected. You can close this tab.";
}

/**
 * What the welcome page's "change" step would show, in the person's own words, for a given
 * `/__onboarding/me` reading — the pure half of `--next` (see browser.mjs, which first
 * ensures the unit exists via `/__onboarding/me/unit` before calling this). Mirrors
 * `renderWelcomePage`'s own `show()`/`go()`: the change step's instruction paragraph names
 * the unit once it exists, and its status line only ever says "It's live" once landed —
 * everything in between ("waiting for a terminal", "your agent is editing") is not
 * something the rig's person needs worded differently, so it is left to the one line below.
 */
export function meStateLine(j) {
  if (!j || !j.paired) return "Waiting for a terminal…";
  if (j.landed) return `It's live: ${j.url}. Press Next, then "Open the workspace".`;
  if (j.unit) {
    const id = String(j.unit).replace(/^\/|\/$/g, "");
    return `Your page is live at ${j.url}. Ask your assistant to open ${id} and change the line on it.`;
  }
  return "Waiting for your agent…";
}
