// How a member is DISPLAYED when nobody typed it: a default name from the address, initials
// from the name, a colour from the address.
//
// One definition, imported by both writers of a `members` row. The admin invite in
// `src/_worker.js` has always stamped these onto an overlay entry; the workspace object's
// `applyProvisioning` writes the FIRST admin's row, and that row is served through the same
// `add` document every invite is — so it carries the same fields, derived the same way, or the
// first person a workspace ever has is the one whose chip is blank. Neither file may import
// the other (the worker imports the object), which is why this is a module rather than two
// copies of three functions. Pure string work: no env, no clock, nothing per-workspace.

/** "ada.lovelace@example.org" → "Ada Lovelace". Only a default; a person can type their own. */
export function nameFromEmail(email) {
  return String(email).split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || String(email);
}

export function initialsFor(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable per address, so a member's chip colour never changes under them.
export const ROSTER_COLORS = Object.freeze(["#4f46e5", "#0e7490", "#b45309", "#be123c", "#15803d", "#7c3aed", "#0369a1", "#a21caf"]);

export function colorFor(email) {
  let h = 0;
  const s = String(email == null ? "" : email).trim().toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ROSTER_COLORS[h % ROSTER_COLORS.length];
}
