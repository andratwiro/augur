// The page the invite flow makes for one member: a card with their name and one line their
// agent is asked to change. Self-contained, token-free, one file — nothing to build.
//
// WHY A MODULE OF ITS OWN. What the platform lands on somebody's behalf is content, and the
// worker is not where content is written twice. Keeping it pure — no store, no request, no
// workspace — is also what lets the shape of the page be checked without a manifest in
// sight, and what stops a second caller inventing a second welcome page later.
//
// ⚠️ NOTHING HERE MAY REACH OFF THE PAGE. It is landed at a real public URL on somebody
// else's workspace, so a font, a stylesheet or a script from anywhere but this string would
// be that workspace phoning a third party on every visit, from a page nobody chose to
// include. The style is inline and the page loads nothing at all.

/**
 * The folder name a member's page lives under. The local part of the address, lowercased,
 * with every run of anything else collapsed to a dash — so the path is one URL-safe segment
 * whatever an address holds. Never empty: an address that is nothing but punctuation still
 * has to name a folder, and a folder named "" is a path outside the unit.
 */
export function slugFor(email) {
  const local = String(email || "").split("@")[0].toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return local || "member";
}

// A name is the person's own text and it lands in a PUBLISHED page. It is escaped, never
// interpolated raw — the first member whose display name holds a tag would otherwise
// publish it.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * One member's welcome page, as a unit ready to land: the unit path, and the files under it.
 * `{ body, ct }` per file rather than hashed bytes, because hashing belongs with the store
 * write and this module has no store.
 */
export function welcomeUnitFor({ name, email } = {}) {
  const slug = slugFor(email);
  const unit = `/start-here/${slug}/`;
  const who = esc(name || slug);
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${who}'s first page</title>
<meta name="description" content="A first page, made for ${who} to change.">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 18px/1.5 system-ui, sans-serif; background: #f6f6f8; color: #16171a; }
  main { max-width: 34rem; padding: 2.5rem; border-radius: 16px; background: #fff; box-shadow: 0 10px 40px rgba(0,0,0,.08); }
  h1 { margin: 0 0 .5rem; font-size: 1.6rem; }
  p[data-line] { margin: 0; font-size: 1.15rem; }
  @media (prefers-color-scheme: dark) { body { background: #111216; color: #eee; } main { background: #1b1c22; } }
</style></head>
<body><main>
  <h1>Hello, ${who}.</h1>
  <p data-line="greeting">This line is waiting for your agent to change it.</p>
</main></body></html>
`;
  return { unit, files: { [`${unit}index.html`]: { body, ct: "text/html; charset=utf-8" } } };
}
