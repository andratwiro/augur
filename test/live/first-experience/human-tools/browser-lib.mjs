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
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
