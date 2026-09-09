// src/draft-chips-logic.mjs — what a gallery card's draft chip says (docs/drafts-that-land.md §5).
//
// The pure half of the chips: given the workspace's open-drafts index (`GET /__unit/drafts`)
// and a card's path, decide the chips the card wears. A chip names WHO has a draft here and
// whether they are at it now — a face per person, a green dot on a live one, the word
// `working` or the time of the last save; the tooltip is a heads-up to whoever might open a
// draft here too. Never a bare count, never the session label (the CLI's default is
// `session-<pid>`) — the one thing the label says is whether it was a terminal, and that
// becomes "Ada's agent" rather than "Ada". build.js inlines this file, minus `export`, into
// the chrome bundle beside the wiring that fetches and paints (DRAFTS_JS), the way
// src/sw-logic.mjs rides into sw.js; test/draft-chips-logic.test.mjs pins it.
//
// Keep it pure and old-browser plain: no DOM, no fetch, no Date.now, no arrow functions.
// `active` is the server's word (saved within ACTIVE_MS, src/unit-core.mjs), not re-derived.

/** Faces shown on one chip; everyone beyond is still named in the tooltip. */
export var MAX_FACES = 3;

/** `"saved 4 min ago"` — `""` for a date that is not one. Hours and days floor, never round up. */
export function ago(iso, nowMs, verb) {
  var ms = nowMs - Date.parse(iso || "");
  if (!(ms >= 0)) return "";
  var m = Math.round(ms / 60000);
  if (m < 1) return verb + " just now";
  if (m < 60) return verb + " " + m + " min ago";
  var h = Math.floor(m / 60);
  if (h < 48) return verb + " " + h + " h ago";
  return verb + " " + Math.floor(h / 24) + " d ago";
}

/** `"/projects/home-page/"` → `"home page"`: the unit's last segment, spoken. */
export function unitName(unit) {
  var s = String(unit || "").replace(/\/+$/, "");
  return s.slice(s.lastIndexOf("/") + 1).replace(/-+/g, " ");
}

function whenOf(d) { return d.lastSaveAt || d.openedAt || ""; }
function whenText(d, nowMs) { return ago(whenOf(d), nowMs, d.lastSaveAt ? "saved" : "opened"); }
function stamp(d) { return Date.parse(whenOf(d)) || 0; }
function faceOf(d, live) {
  return { owner: d.owner || "", name: d.name || null, initials: d.initials || "?", color: d.color || null, live: !!live };
}
/** A draft opened from a terminal is the person's agent at work; the browser's draft bar says "browser". */
function isAgent(d) { return !!d.session && d.session !== "browser"; }
function whoOf(d) { var n = d.name || "Someone"; return isAgent(d) ? n + "'s agent" : n; }
/**
 * One tooltip line, written for the OTHER person — the one deciding whether to open a draft
 * here too. `unit` names the prototype on a folder card; on the prototype's own card it is
 * "this", with a heads-up in front, because that is where a second draft would collide.
 */
function line(d, unit, nowMs) {
  var where = unit ? unitName(unit) : "this";
  var what = d.active ? " is working on " + where + " right now" : " has a draft open on " + where;
  return (unit ? "" : "Careful: ") + whoOf(d) + what + " · " + whenText(d, nowMs);
}
/** The same form src/unit-core.mjs `draftAddress` gives: `<unit without its slash>@<id>/`. */
function draftHref(unit, d) { return String(unit).replace(/\/$/, "") + "@" + d.id + "/"; }

/**
 * The chips for one card. `units` is `{"<unit>": [draft…]}` from the index, `cardPath` the
 * card's own path in the same spelling (leading and trailing slash).
 *
 * A PROTOTYPE card (its path is a unit in the index) wears one chip per draft, each a link
 * to that draft. A FOLDER card wears one chip for everything beneath it: the distinct
 * owners as faces (live first, then most recent), `working` — with `on N` when the drafts
 * span N prototypes — when any is live, else the most recent save; linking to the one
 * draft when there is exactly one, else to the folder, where each prototype shows its own.
 */
export function chipsFor(units, cardPath, nowMs) {
  if (!units || !cardPath) return [];
  var own = units[cardPath];
  if (own && own.length) {
    return own.map(function (d) {
      return { href: draftHref(cardPath, d), live: !!d.active, faces: [faceOf(d, d.active)], text: d.active ? "working" : whenText(d, nowMs), title: line(d, "", nowMs) };
    });
  }
  var rows = [];
  Object.keys(units).forEach(function (u) {
    if (u === cardPath || u.indexOf(cardPath) !== 0) return;
    (units[u] || []).forEach(function (d) { rows.push({ unit: u, d: d }); });
  });
  if (!rows.length) return [];
  rows.sort(function (a, b) { return (b.d.active ? 1 : 0) - (a.d.active ? 1 : 0) || stamp(b.d) - stamp(a.d); });
  var seen = {}, faces = [], unitsSeen = {};
  rows.forEach(function (r) {
    unitsSeen[r.unit] = 1;
    var k = r.d.owner || r.d.name || "?";
    if (seen[k]) return; // sorted live-first, so the first row for a person carries their liveness
    seen[k] = 1;
    faces.push(faceOf(r.d, r.d.active));
  });
  var n = Object.keys(unitsSeen).length;
  var live = !!rows[0].d.active;
  return [{
    href: rows.length === 1 ? draftHref(rows[0].unit, rows[0].d) : cardPath,
    live: live,
    faces: faces.slice(0, MAX_FACES),
    text: live ? "working" + (n > 1 ? " on " + n : "") : whenText(rows[0].d, nowMs),
    title: rows.map(function (r) { return line(r.d, r.unit, nowMs); }).join("\n"),
  }];
}
