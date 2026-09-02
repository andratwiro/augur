// Source for dist/_worker.js — copied VERBATIM by build.js into the deploy dir.
// Cloudflare Pages Advanced Mode: this Worker runs in front of every request.
//
// RUNTIME CONFIG: everything deployment- or build-specific (the roster, PUBLIC_PREFIXES,
// RESTRICTED_BASES, VERSION_MAP, BUILD_ID, deploy knobs) is DATA, not code. It loads
// from /__config/{instance,routing}.json — emitted by build.js next to the assets —
// at request time via loadTenantContext(), cached per isolate for ~1.5s. It loads config
// FOR the workspace resolveTenant() named and hands it back as one value; the bindings
// below are a mirror of that value until the read sites take it as a parameter. They
// start at their empty defaults, which is exactly the raw-copy behavior: no config
// emitted → no users → open gate, nothing public, nothing restricted.
// /__config/* is rejected for external requests in fetch() before any asset serving.
//
// Gate model: PER-USER accounts (email + password). instance.json carries the users;
// a login sets a cookie carrying "<email>.<token>" where token is derived from the
// user's effective password (admin-set KV override ?? seed) — see identify(). The
// internal surface (root index, per-opportunity indexes, galleries) is gated; direct
// prototype URLs, their DS assets, /pages, /_build.json, and created canvas boards
// are public — see PUBLIC_PREFIXES / isPublicPath / virtualCanvas. Admin-only spaces'
// base paths (RESTRICTED_BASES) are sealed to admins. Legacy fallback: with no users
// configured but SITE_PASSWORD set, a single shared-password gate applies; with
// neither, the site is open (raw/local builds).
//
// Casual gate against link leakage — NOT Zero Trust.

// The page-level chrome renderer, shared with build.js (which bakes it). At serve time
// composeChrome() re-renders it from the CURRENT engine so a deploy updates every stored
// page's rail without a re-bake (runtime-chrome). build.js copies this module next to the
// worker (dist/chrome/appchrome.mjs) so the relative import resolves at the edge. Pure,
// side-effect-free at import — keeps this file importable by test/worker.test.mjs.
import { renderAppChrome, renderSpaceContextScript } from "./chrome/appchrome.mjs";

// The per-request config VALUE that replaced this file's module-scope config globals. Same
// deal as the chrome renderer: build.js copies this module next to the worker
// (dist/tenant-context.mjs) so the relative import resolves at the edge. Pure and
// side-effect-free at import; it performs no I/O and owns no state.
import {
  emptyTenantContext, instanceFields, routingFields, withTenantFields,
  LEGACY_MCP_PATH_FLOOR,
} from "./tenant-context.mjs";

// The one constructor this file may use to keep anything across requests. Its handle has
// no way to reach a value without naming a workspace and no way to enumerate the
// container at all, so "a cache the whole isolate shares" — the shape of every leak this
// engine has closed — is not something the code below can express. Same deal as the two
// modules above: build.js copies it next to the worker (dist/tenant-cache.mjs).
import { tenantCache } from "./tenant-cache.mjs";

// Which workspace a hostname names, as pure string work. Same deal as the modules above:
// build.js copies it next to the worker (dist/tenant-host.mjs). It holds the reserved-label
// list too, because the control plane's name GENERATOR has to read the same one — a
// generator that emits `admin` and a resolver that refuses it are one list disagreeing.
import { tenantLabelFromHost, normalizeHost, isReservedLabel, parseReservedLabels, TENANT_LABEL_RE } from "./tenant-host.mjs";

// The mail transport. Same deal again: build.js copies it next to the worker
// (dist/mail.mjs) so the relative import resolves at the edge. It reads its provider,
// endpoint, key and sending address from the runtime env and holds no state, so a
// deployment that configures none of that gets exactly the behaviour that predates it —
// a link, and a verdict saying no mail was sent. See src/mail.mjs.
import { sendMail, mailNotice } from "./mail.mjs";

// The checks an instance runs on ITSELF, from its own cron. Same deal again: build.js
// copies it next to the worker so the relative import resolves at the edge. Pure — a
// function of a build stamp, a clock and at most one outbound fetch — which is what keeps
// the `scheduled` handler below short enough to read. See src/health-cron.mjs for what it
// deliberately does NOT check, and why a worker must never probe its own front door.
import { runHealth } from "./health-cron.mjs";

// What is current in a workspace and what has been left behind. Same deal again: build.js
// copies it next to the worker so the relative import resolves at the edge. Pure — manifest
// stamps and a status map in, rows out — and it stores NOTHING: staleness is derived from
// the per-file `editedAt` the commit handler already records, never from a second field
// somebody would have to maintain. See src/currency.mjs.
import {
  STALE_AFTER_DAYS, STATUS_LABELS, currencyRows, parseSince,
  freshness, whenWords, unitKey, unitProvenance,
} from "./currency.mjs";

// KV's identity documents translated into the workspace object's rows. Same deal again:
// build.js copies it next to the worker so the relative import resolves at the edge. Pure
// and stateless — the mapping is where a copy silently loses somebody, so it is a function
// with fixtures rather than a loop inside a handler. See src/kv-identity.mjs.
import { identityFromKv } from "./kv-identity.mjs";

// How a KV value is written into a backup document. Same deal again: build.js copies it
// next to the worker (dist/kv-codec.mjs) so the relative import resolves at the edge.
// Pure, side-effect-free, holds no state. See src/kv-codec.mjs — a KV value is BYTES, and
// reading it as text destroys every value that is not UTF-8.
import { KV_BACKUP_FORMAT, encodeKvValue } from "./kv-codec.mjs";

// The account of what an instance stores and where each family goes. Imported rather than
// restated: the export below walks it, so the list of what a backup covers and the list of
// what exists cannot be two lists. build.js copies it next to the worker.
import { STATE_INVENTORY } from "./state-inventory.mjs";
// Redaction, shared with the workspace object — see src/purge.mjs for why it is not local.
import { PURGED_AUTHOR, purgeThreads, idCollisions } from "./purge.mjs";
// The unit vocabulary and the composer, shared VERBATIM with the CLI — see resolveStaleBase.
import { authoredUnits, unitOfPath, unitPaths } from "./publish-units.mjs";
import { composePublish } from "./publish-compose.mjs";
// `F-fork-verb`. Fork as a deliberate verb — one unit aliased to a new path, zero bytes
// moved — plus the rule that keeps a fork's lineage and owner alive across every later
// publish. Both are pure, and both are the CLI's too if it ever needs them.
import { composeFork, carriedLineage, assertedLineage } from "./publish-fork.mjs";
// The board document's KV key, shared VERBATIM with the room that mirrors into it
// (src/board-room.mjs). Two writers, one spelling — see the module header.
import { BOARD_PREFIX, boardKvKey, RT_WORKSPACE_HEADER } from "./board-key.mjs";
import { signRoomTicket } from "./room-ticket.mjs";

const COOKIE = "gv_auth";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// ---- Users / identity -------------------------------------------------------
// Augur is a private internal tool — the only real risk is impersonation, and the
// real work happens through git commits, so this is a casual identity layer, not
// auth hardening. `ctx.USERS` is the ROSTER — who exists, not what they know — read
// from instance.json for the workspace this request is for (loadTenantContext). Empty
// in a raw copy → no users → the gate stays open (offline/local builds with no identity
// configured). Each entry:
//   { email, name, initials, color, role?, passHash? }
// role:"admin" gates the admin API and admin-only spaces; admins can NOT set or read
// passwords, only reset a user (which revokes and mints an invite link). `passHash` is a
// seed consulted only when users:secrets has no key for that email — it exists so a NEW
// instance's first admin can log in, since there is nobody to invite them.
// Credentials live in KV, never here — see effectiveSecret for the exact precedence.
// `ctx.CONFIG_USERS` is what instance.json named; `ctx.USERS` is that list with the KV
// roster overlay applied (people the admin panel invited or removed since). Everything
// that resolves a person reads `ctx.USERS`.
//
// ⚠️ Neither is a module binding any more, and neither may become one again. A roster
// in module scope is the whole leak this phase closes: an isolate that resolved a second
// workspace would answer it with the first workspace's people, i.e. with the first
// workspace's admins. Every function that resolves a person therefore takes the list as
// a REQUIRED parameter — no default — so a call site that forgot which workspace it is
// answering for is a crash here, not a cross-tenant answer in production.
// ⚠️ The gate's own knobs used to sit here — PUBLIC_SKILL_PREFIXES and VANITY_REDIRECTS,
// alongside BUILD_ID, VERSION_MAP, PUBLIC_PREFIXES and RESTRICTED_BASES further down.
// They are fields of the tenant context now and must not come back: which paths skip the
// password is the single most workspace-specific answer the worker gives, and a module
// binding hands the isolate's last-loaded workspace's exemptions to the next request.
//
// ⚠️ So does the /__mcp/ proxy's allowlist — MCP_HOST_SUFFIXES and MCP_HOST_ALLOWLIST_URL
// from instance.json, MCP_HOST_ALLOWLIST and MCP_PATH_ALLOWLIST from the union of the
// {"hosts":[…], "paths":[…]} documents the spaces declare via space.json "mcpAllowlists"
// (see build.js), plus the mcpStaticHosts Set derived from the host union. All five are
// context fields, and the reason is the same one with sharper teeth: that allowlist
// decides which third-party hosts this origin will forward a browser's Authorization
// header to, so a module binding lets whichever workspace loaded last widen the proxy for
// the next request, whoever it belongs to.

// The session cookie: value "<email>.<token>". `__Host-` is a name PREFIX the browser
// enforces — it stores a cookie under such a name only when it is Secure, has Path=/,
// and carries NO Domain attribute. That last rule is the point: several workspaces share
// one apex, so a page published on one of them can otherwise set `Domain=.<apex>` and
// have the browser send that cookie to a sibling workspace too. It could never FORGE a
// session (the token HMACs on SESSION_SECRET plus the user's effective secret), but it
// could SHADOW the real cookie and break login on the sibling — identify() reads the
// first match. Under the prefixed name the browser refuses to store the tossed cookie at
// all. Every issue site already set Path=/, HttpOnly and Secure with no Domain, so this
// is a name, not a redesign — and it stays a name: never issue this cookie without all
// three, or the browser will silently drop every session the deployment hands out.
const USER_COOKIE = "__Host-augur_user";
// ⏳ MIGRATION WINDOW — the names this cookie used to be issued under, oldest last. They
// are OPAQUE WIRE STRINGS, not identity: a live browser is holding one right now, so the
// engine must keep answering to it or that person is signed out mid-sentence. They are
// READ by identify() (after USER_COOKIE, never before it) and CLEARED by /__logout, and
// NEVER issued — every login from here on lands on USER_COOKIE, so each old name drains
// away as the sessions holding it expire (MAX_AGE, one week).
//
// WHAT DELETES EACH ENTRY — an entry goes one week after the LAST instance still issuing
// it has taken an engine that no longer does, which is a fact about deployed pins, not
// about this repo:
//   "__Host-gv_user"  the name every instance issued before this rename. It stops being
//                     issued the moment an instance takes this engine, so it can go a
//                     week after the slowest live pin has moved past this commit.
//   "gv_user"         the pre-`__Host-` name. An instance whose engine pin is frozen can
//                     still be ISSUING it — a frozen pin means old sessions keep being
//                     minted, so this entry's week does not even START until that pin
//                     moves. Check what a live instance actually sets before removing it;
//                     a local build proves nothing about it.
// Removing one is: drop it from this list, drop its ⏳ case from
// test/host-cookie-prefix.test.mjs. The read fallback in identify() and the clear loop in
// /__logout are written over the list, so they need no edit until it is empty — at which
// point delete the constant and the two ⏳ sites that name it. Nothing else refers to it.
const LEGACY_USER_COOKIES = Object.freeze(["__Host-gv_user", "gv_user"]);
// KV {email: "pbkdf2$…"} — the credential store, written only by a user redeeming an
// invite. A key PRESENT holding null/"" is a REVOCATION TOMBSTONE (admin reset): it
// means "no secret", and must never fall through to the roster's seed. Only an ABSENT
// key falls back. Anything here that is not a `pbkdf2$…` string verifies against
// nothing — verifyPassword accepts hashes only.
// The last report the cron wrote. DERIVED, never authored: every field is recomputed from
// the build stamp on the next run, so it is `to: "drop"` in the state inventory and no
// backup carries it. A restored copy of this key would be a health report describing a
// moment that has passed, which is worse than none.
const HEALTH_REPORT_KEY = "health:report";
const USER_SECRETS_KEY = "users:secrets";
const LASTSEEN_PREFIX = "users:lastseen:";  // KV per-user ISO stamp — admin list column
const USER_INVITES_KEY = "users:invites";   // KV {token: {email, expires}}
// KV {add: {email: {email,name,role,initials,color,addedAt}}, remove: [email…]} — the
// runtime layer over the config roster, written only by the admin panel's invite/remove
// actions. It exists so adding or dropping a teammate is a click, not a config commit;
// the config file stays the source of truth for everyone it names (a config entry wins
// over an add of the same address). A removal of a CONFIG user is recorded in `remove`;
// removing an invited one just drops its `add` entry. See mergeRoster.
const USER_ROSTER_KEY = "users:roster";
// KV {email: {k, at, mime}} — the INDEX of self-set profile photos, one entry per
// person, written only by that person from the profile menu. Deliberately an index of
// content-hash keys rather than the images themselves: this document is re-read on
// every config tick (~1.5s per isolate), so the photos live one indirection away under
// AVATAR_BLOB_PREFIX + k and are fetched only when a browser actually asks for one.
const USER_AVATARS_KEY = "users:avatars";
const AVATAR_BLOB_PREFIX = "avatar:";       // KV <prefix><hash> → the data: URI, verbatim
// A self-set photo is served at /__avatar/u/<hash> — the "u/" tells the route to read
// KV instead of scanning the roster for a config-baked data URI (see the /__avatar/
// handler). The hash is of the content, so a new photo is a new URL and the immutable
// caching downstream stays honest.
const AVATAR_KV_PREFIX = "u/";
// The client crops and re-encodes to 320px before it posts (3x the 96px the settings
// modal draws, so the face stays sharp on a retina screen), which lands around 20KB of
// data: URI. This ceiling leaves headroom above that and is small enough that neither
// the KV value nor the ungated response is a lever. The client steps its own quality
// down until it fits rather than posting something this would reject. Chars, not bytes.
const AVATAR_MAX_CHARS = 64 * 1024;
// KV {email: {name, at}} — self-set display names, the same shape and the same rules as
// the photo index above: written only by that person, overriding the config roster's
// `name` for them alone. Names are small and read on every config tick, so unlike the
// photos they live in the document itself with no blob indirection.
const USER_NAMES_KEY = "users:names";
// Role overlay — see applyRoles. Separate from users:roster because the roster
// overlay CANNOT express a change to a config user: mergeRoster lets identity.json
// win over an `add` of the same address, deliberately, so the file stays the durable
// record. Roles need the opposite precedence (an admin's change must take effect on
// the next request, not on the next deploy), which is the same shape users:names and
// users:avatars already use for the same reason.
const USER_ROLES_KEY = "users:roles";
// KV {email: {spaceId: role}} — WHICH spaces someone belongs to, and their role in
// each. Same overlay shape and the same precedence as users:roles above.
//
// An ABSENT entry means "every space, at the global role". That default is what makes
// this invisible to an instance that has never set a membership, and it is the only
// safe direction: membership can narrow access below the one-login-opens-every-space
// baseline, never widen it past that. An entry that is present but EMPTY is a member of
// nothing — "all" and "none" must never share a spelling, or a deliberate removal reads
// as a grant of everything.
//
// This layers ABOVE the adminOnly/RESTRICTED_BASES seal rather than replacing it: that
// seal is the hard gate and stays the hard gate. A KV failure here returns the old
// baseline, which is why readSpaces swallows errors into {} the way its siblings do.
const USER_SPACES_KEY = "users:spaces";
// KV {spaceId: {k, mime, at}} — a workspace's own icon, set by an admin of THAT
// workspace from its settings. Exactly the shape and the same bargain as
// users:avatars: the space repo's /space-icon.png is the SEED, shown until someone
// changes it and restored if they remove it. Blob lives one indirection away under
// SPACE_ICON_BLOB_PREFIX so this document stays small enough to re-read every config
// tick. Served at /__space-icon/<hash>, content-addressed so a new icon is a new URL
// and the immutable caching downstream stays honest.
// The index itself (`SPACE_ICONS`) and the hashes it vouches for (`SPACE_ICON_KEYS`)
// are fields of the tenant context, not module bindings: both are read out of ONE
// workspace's KV, and a shared hash allowlist would let any workspace's icon be fetched
// through any other workspace's serve route.
const SPACE_ICONS_KEY = "spaces:icons";
const SPACE_ICON_BLOB_PREFIX = "spaceicon:";
// The three roles, and the one rule that turns a stored value into one of them.
//
// `user` is the legacy spelling of `editor` — it was the only non-admin value the
// panel could produce, so every existing roster and identity.json is full of it.
// Read-through, never a flag day: a stored `user` IS an editor, and so is an absent
// role. Anything unrecognised also lands on editor, because the alternative is an
// account that silently loses or gains privileges on a typo.
// Frozen, like every fixed table in this file: a write throws in the module's strict
// mode instead of quietly becoming per-isolate state under a table's name.
const ROLES = Object.freeze(["admin", "editor", "viewer"]);
const roleOf = (u) => {
  const r = u && u.role;
  return r === "admin" || r === "viewer" ? r : "editor";
};
const NAME_MAX_CHARS = 60;
// Raster formats only, and each one is checked against its magic bytes before storage:
// /__avatar/ is ungated and echoes this mime back, so "trust the label" would let a
// signed-in user park arbitrary bytes behind an image content-type.
const AVATAR_MIMES = Object.freeze({
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
});
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // links get pasted into chat — expire them

// Serve-time chrome composition (runtime-chrome) is per workspace, on the context:
// `tctx.CHROME_POINTER` is the CURRENT engine's chrome bundle names + UI version
// (routing.chrome), and `tctx.RUNTIME_CHROME` gates composeChrome. Both default inert, so
// a raw/local copy (and every test import) stays side-effect-free and served HTML is
// untouched — the worker fills them from routing.json as it loads a workspace's config.

// Per-page live-reload versions: `tctx.VERSION_MAP` is a URL-prefix → token map that
// changes only when that folder's content changes (routing.json). Lets a tab reload only
// when ITS own prototype changed, so unrelated deploys (e.g. another agent's prototype)
// don't reload it. versionFor() returns the longest-prefix match, else `tctx.BUILD_ID` —
// the workspace's whole-build id, the FALLBACK version for any path the map does not
// name (index/shell pages, assets). "dev" in a raw/local copy just means a stable id.
//
// The context comes FIRST and is not optional. These three predicates decide who gets
// past the gate, so a default would let a call site that forgot to pass a workspace's
// config keep working — answering from whichever workspace the isolate looked at last,
// which is the whole bug. Missing it is a TypeError instead.
function versionFor(tctx, pathname) {
  let best = null, bestLen = -1;
  for (const k in tctx.VERSION_MAP) {
    if ((pathname === k || pathname === k.slice(0, -1) || pathname.startsWith(k)) && k.length > bestLen) {
      best = tctx.VERSION_MAP[k];
      bestLen = k.length;
    }
  }
  return best == null ? tctx.BUILD_ID : best;
}

// PUBLIC prototype path-prefixes — served WITHOUT the password. `tctx.PUBLIC_PREFIXES`
// is the workspace's real list of `/<opportunity>/<prototype>/` prefixes, derived from
// the same build that shipped them, so it can never drift from what actually ships. The
// context's empty default is what makes a raw/local copy gate nothing differently (local
// builds have no password anyway).
//
// A request is public if it lands inside a published prototype folder (the index
// page or any asset it loads), or is the dormant review-overlay script that every
// prototype embeds. Everything else falls through to the password gate.
function isPublicPath(tctx, pathname) {
  // The build stamp ({builtAt, spaces:{<id>:{sha}}}). Space-repo collaborators can't
  // see this repo's CI, so this is their only way to verify "my commit is live" —
  // curl it and compare sha to git rev-parse HEAD. Public by design; contains nothing
  // but commit SHAs that those collaborators already have.
  if (pathname === "/_build.json") return true;
  // NOTE: /__invite is deliberately NOT listed here. Its route in fetch() intercepts
  // every request for that path long before isPublicPath is consulted, so an entry
  // would be unreachable code that reads as a safety net it is not.
  // The dormant review overlay + its avatar asset — both embedded into public
  // prototypes, so both must bypass the gate (else the <img> gets the login page).
  if (pathname === "/__review/comments.js" || pathname === "/__review/cat.png") return true;
  // …and the cursor it paints while you place a comment. A gated cursor image does not
  // fail loudly — the browser silently falls back to the keyword after it (crosshair),
  // so review mode on a public prototype just quietly stops looking like review mode.
  if (pathname === "/__review/comment-cursor.svg") return true;
  // The composition graph the overlay recurses (window.__GV_GRAPH) — embedded into
  // every public prototype before comments.js, so it must bypass the gate too.
  if (pathname === "/__review/graph.js") return true;
  // The default space's icon — the mark on the gate and invite pages, which are shown
  // to signed-out visitors by definition. Gating it would serve the login HTML into
  // that <img> and the front door would render mark-less (see brandMark()).
  if (pathname === "/space-icon.png") return true;
  // The shared infinite-canvas engine (canvas.js/.css) is embedded by absolute /__canvas/
  // path into canvas prototypes, so its assets must bypass the gate too (else the
  // <script>/<link> fetches the login page instead of the asset). RENDERED ASSET extensions
  // only — never a blanket prefix; the board DATA API (/__board) has its own public route below.
  if (pathname.startsWith("/__canvas/") &&
      /\.(css|js|mjs|json|map|svg|png|webp|woff2?)$/i.test(pathname)) return true;
  // Canvas session music is NOT here on purpose. A tracks/ folder is somebody's music
  // library, and serving it publicly would republish audio nobody licensed us to hand out
  // — so it is admin-only (isTrackPath, enforced in fetch) rather than public. A public
  // board plays no music for a signed-out viewer; that is the correct trade.
  // The cursor companion engine + self-hosted fonts are embedded into public
  // prototypes by absolute path, so they must bypass the gate too (else the
  // <script>/<link> fetches the login page instead of the asset).
  if (pathname === "/piti.js" || pathname.startsWith("/fonts/")) return true;
  // The shared chrome bundle (P1) and the service worker (P0) are generic engine
  // code, embedded by absolute path into every page and registered at root scope;
  // they must bypass the gate too (the SW update check fetches /sw.js with no cookie).
  if (pathname === "/sw.js" || pathname.startsWith("/_chrome.")) return true;
  // Shared canonical design-system assets. Linked prototypes (the default — INV-10)
  // reference these via the space's public skill dir (injected at build from the
  // detected UI skill), so they must bypass the gate or a public prototype renders
  // unstyled for anyone without the password. Scope to RENDERED ASSET extensions only
  // — never a blanket prefix — so any doc that ships into this dir (e.g. an
  // img/.../MANIFEST.md, gallery.html) stays gated, not exposed.
  if (tctx.PUBLIC_SKILL_PREFIXES.some((p) => pathname.startsWith(p)) &&
      /\.(css|js|mjs|woff2?|ttf|otf|svg|png|jpe?g|webp|gif|ico|json|map)$/i.test(pathname)) return true;
  // Composed OG/unfurl card for any page — always fetchable so link-preview bots
  // can load the image even if its folder is gated.
  if (pathname.endsWith("/og.jpg")) return true;
  // The composed reference Pages (DS gallery, shipped under /pages/<slug>/) are
  // public so they can be shared without the password. They're self-contained and
  // load their assets from already-public paths (the public skill dir, /fonts/), so
  // the whole subtree — index pages and any page-local assets — bypasses the gate.
  if (pathname === "/pages" || pathname.startsWith("/pages/")) return true;
  return tctx.PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname === p.slice(0, -1) || pathname.startsWith(p)
  );
}

// Canvas session music: the one workspace's tracks/ folder, at the root. AUDIO
// EXTENSIONS ONLY — a README or a stray export that lands in the same folder is gated by
// the ordinary rules, not by this one. Only an instance ADMIN may fetch these: the build
// already refuses to publish a tracks/ folder unless the space claims the right to
// distribute it ("publishTracks"), and this is the second half of that promise —
// published audio still never reaches the open web. The leading optional "/<space>/"
// mount group was retired with the path-mount tier: no space mounts under "/<id>/", so
// tracks only ever live at the root now.
const TRACK_PATH = /^\/tracks\/[^?]+\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i;
function isTrackPath(pathname) { return TRACK_PATH.test(pathname); }

// Does this path live inside an admin-only space? Matches the base ("/space-2"), its
// root ("/space-2/") and everything beneath it.
//
// RETIRED WITH THE PATH-MOUNT TIER, and kept as an always-false read rather than ripped
// out. An adminOnly space only ever sealed a NON-DEFAULT "/<id>/" mount, and no such
// mount exists any more, so neither derivation puts anything in the list: bundle mode
// hands back an empty one, and assets mode still reads a routing.restrictedBases field
// defensively although the build no longer emits one. It is a FIELD OF THE CONTEXT, not
// a module binding — an empty seal is still a seal, and one workspace must never be able
// to answer for another's even while the answer is "nothing".
function isRestrictedPath(tctx, pathname) {
  return tctx.RESTRICTED_BASES.some(
    (b) => pathname === b || pathname.startsWith(b + "/")
  );
}

// ---- Crypto helpers (Web Crypto — available in workers AND node ≥18) ---------
const encodeUtf8 = (s) => new TextEncoder().encode(s);
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
function toB64(buf) { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); }
function fromB64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

// Constant-time-ish string compare — never short-circuits on content (length leak
// is fine; both operands here are fixed-length digests or clamped inputs).
function safeEqual(a, b) {
  a = String(a == null ? "" : a); b = String(b == null ? "" : b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Password hashing (PBKDF2-SHA-256) ---------------------------------------
// Stored format — ONE string: "pbkdf2$<iterations>$<saltB64>$<hashB64>".
// ⚠️ 100_000 is a RUNTIME CEILING, not a preference — do NOT raise it. Workers' WebCrypto
// refuses PBKDF2 above 100k iterations: deriveBits THROWS, so a higher count breaks every
// password write (hashPassword) and every verify of a hash carrying it. Measured on
// production: 100_000 verifies, 100_001 already throws. OWASP asks for more, and Node's
// crypto happily does 600k — which is exactly the trap, since the tests run on Node and
// pass while the deployed worker cannot hash at all. Raising this once made every invite
// link in flight die on redemption (the 500 below burned the token on the way out).
// More work per password needs a KDF Workers actually supports, not a bigger number here.
const PBKDF2_ITERATIONS = 100000;
const PASS_HASH_PREFIX = "pbkdf2$";

async function pbkdf2Bits(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encodeUtf8(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, keyMaterial, 256);
}

function isPassHash(s) { return typeof s === "string" && s.startsWith(PASS_HASH_PREFIX); }

async function hashPassword(password, iterations = PBKDF2_ITERATIONS, salt) {
  if (!salt) salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(password, salt, iterations);
  return `${PASS_HASH_PREFIX}${iterations}$${toB64(salt)}$${toB64(bits)}`;
}

// Verify a candidate password against a stored secret.
async function verifyPassword(password, stored) {
  if (typeof password !== "string" || !password) return false;
  if (typeof stored !== "string" || !stored) return false;
  if (isPassHash(stored)) {
    const parts = stored.split("$"); // ["pbkdf2", iterations, saltB64, hashB64]
    if (parts.length !== 4) return false;
    const iterations = Math.max(1, Math.min(1 << 22, Number(parts[1]) || 0));
    let salt;
    try { salt = fromB64(parts[2]); } catch (e) { return false; }
    let bits;
    try { bits = await pbkdf2Bits(password, salt, iterations); } catch (e) { return false; }
    return safeEqual(toB64(bits), parts[3]);
  }
  return false;
}

// ---- Runtime config loader --------------------------------------------------
// Builds a workspace's config from /__config/{instance,routing}.json — the two documents
// build.js emits next to the assets — as ONE value (loadTenantContext) handed to the
// request that asked for it. Cached per workspace for ~1.5s: fast enough that a fresh
// deploy (or an offline rebuild) flips the gate's view of the world almost immediately,
// cheap enough to run on the hot path (between refreshes the call is a sync timestamp
// check). A missing or unreadable document leaves the current values in place — so a raw
// copy (no config emitted) keeps its empty defaults, and a transient read failure never
// wipes a working gate.
//
// The instance knobs this loader fills are fields of that context, not bindings here:
//   tctx.MIN_CLIENT_PROTOCOL   the oldest publish protocol this workspace accepts a
//                              commit from (deploy.config.json "minClientProtocol").
//                              0 = accept anything, the default and the right one for a
//                              single-operator workspace: a floor nobody set should never
//                              be the reason a publish fails.
//   tctx.LOGIN_HINT            optional one-liner rendered on the login page
//                              (deploy.config.json "loginHint") — how a demo workspace
//                              surfaces its test credentials without opening the gate.
//   tctx.LOGIN_PREFILL_EMAIL   optional email/password baked into the login form's value=
//   tctx.LOGIN_PREFILL_PASSWORD  attributes (deploy.config.json "loginPrefill") — a demo
//                              workspace's way of making its throwaway account a one-click
//                              login instead of a copy-paste. Empty by default, so an
//                              ordinary workspace's form renders with no values.
// The release feed the update nudge falls back to when a workspace names none. The
// version it compares against and the feed it prefers are both per-workspace
// (`tctx.INSTANCE_ENGINE_VERSION`, `tctx.UPDATE_FEED`); only this fallback is fixed.
const DEFAULT_UPDATE_FEED = "https://api.github.com/repos/andratwiro/augur/releases/latest";
// How long a workspace may keep being served from a config this isolate can no longer
// refresh. Below the ceiling a transient store blip costs nothing — the gate, the roster
// and the public prefixes that were working keep working. Above it, "the last config that
// worked" has stopped being a description of the workspace and become a photograph of it,
// and a photograph is exactly what must not decide who may sign in or which paths are
// public. So the isolate stops answering for that workspace instead. The trade is
// deliberate and it is availability for correctness: a store outage longer than this
// takes the site down rather than serving a minute-old picture of it.
const CONFIG_STALE_CEILING_MS = 60_000;
let cfgAt = 0;
// When a config load for TENANT_CTX's workspace last SUCCEEDED — not when one was last
// attempted, which is what cfgAt records. The two differ only while reads are failing,
// which is the entire window this stamp exists to measure. 0 = this isolate has never
// had a good config for the workspace in the slot, so there is nothing to keep.
let cfgGoodAt = 0;
// The context this isolate is currently serving from — a workspace's whole config as ONE
// value. It is the keep-last-good half of the cache above, expressed as a reference: a
// tick that reads nothing usable returns this same object, so "keep the last good config"
// is "do not swap the reference" rather than "do not overwrite a field at a time".
// Single-slot, so it would answer a second workspace with the first one's config; the
// per-tenant cache in src/tenant-context.mjs is what replaces it when the resolver stops
// answering with one static id.
let TENANT_CTX = emptyTenantContext(null);
// Test seam: the request path builds the identity fields as a value (instanceFields), and
// the gate, publish and admin baselines drive this to seed a workspace from an instance
// document. test/tenant-context.test.mjs pins the two to the same coercions, so a change
// to either without the other is a red test.
//
// It seeds and RETURNS the context — the only thing a caller can read the seeded config
// back out of, since no read site reaches for module scope any more.
function applyInstance(inst) {
  TENANT_CTX = withTenantFields(TENANT_CTX, instanceFields(inst));
  // ⚠️ `CONFIG_LOADED` is NOT set here, and must never be set anywhere but
  // `instanceFields`. It answers "has an instance document actually parsed for THIS
  // workspace", which is what lets the gate tell "genuinely no identity" (raw build →
  // open by design) from "config has not loaded yet in this cold isolate" (deployment →
  // fail closed). Its default is FALSE and it lives on the context, so a second
  // workspace starts un-loaded rather than inheriting the first one's answer. A copy in
  // module scope would hand every workspace the first one's verdict — which, on the
  // cold-isolate path, is the verdict that opens the gate.
  // The seeded CONTEXT, for the same reason applyDerivedRouting hands one back: a caller
  // that has to give a threaded function a workspace gets one from the seed it already
  // wrote, instead of reaching into module scope for it.
  return TENANT_CTX;
}
// ONE config load for ONE workspace: read whichever documents this serving mode keeps
// config in, and RETURN the context they describe. It does the I/O and nothing else —
// no global is written here, which is what lets the same function answer for a second
// workspace without the first one's answer being in the way.
//
// KEEP-LAST-GOOD is the whole reason it takes `prev` and returns rather than assigns.
// Every field starts at the previous context's value and is replaced only by a document
// that actually parsed, so a document that is not there contributes nothing instead of
// clearing what it owns. Returning `prev` itself (the `!env.ASSETS` exit, or an unchanged
// bundle read) tells the caller "nothing to swap".
//
// ⚠️ ABSENT AND FAILED ARE DIFFERENT, and telling them apart is this function's job.
// They used to collapse into the same `null`, which is what made a broken read
// indistinguishable from a raw build: both produced the empty-array/empty-string
// defaults, and the empty defaults are the open gate.
//
//   ABSENT — a 404, a store key that is not there, a 200 whose body is not JSON (a
//   deployment whose asset host answers a missing file with its own HTML page). Nothing
//   was said about this workspace, so nothing changes: the field keeps `prev`'s value, or
//   its factory default on a cold isolate. `CONFIG_LOADED` stays false and the gate shuts
//   on its own — a genuinely raw build with no config source at all never gets here,
//   because `!env.ASSETS` (and bundle mode's absent bindings) returned already.
//
//   FAILED — the read THREW, or the asset host answered with something other than a 404
//   it could not serve. The store could not tell us what this workspace is, which is not
//   the same as telling us it is empty. It propagates, and `loadConfig` decides whether
//   there is a last-good context recent enough to keep serving or whether the request
//   must be refused.
//
// Bundle mode is ALL-OR-NOTHING per tick for the same reason: an instance document that
// parsed is discarded along with the routing derivation that then threw, rather than
// leaving one half of a tick applied on top of the other half's stale values.
// Deployment-wide auth defaults. ACCOUNT_ORIGIN and SESSION_KEYS are PLATFORM settings,
// not per-tenant preferences: on a shared hosted worker (one Worker, many workspaces) a
// single Worker env value turns passwordless sign-in on for EVERY workspace at once —
// including ones that have no config document of their own — so onboarding a workspace, or
// flipping the platform's auth model, never means a per-workspace config write. A
// workspace's OWN config still wins when it sets either field: a self-hosted single
// instance carries these in its instance.json and sets no env var, so it is byte-for-byte
// unchanged (the patch is empty and no field is touched). Env vars are strings, hence the
// literal "true" test rather than a boolean — the same shape TENANT_HOST_SUFFIX et al use.
function withEnvAuthDefaults(ctx, env) {
  if (!env) return ctx;
  const patch = {};
  if (!ctx.ACCOUNT_ORIGIN && env.ACCOUNT_ORIGIN) patch.ACCOUNT_ORIGIN = String(env.ACCOUNT_ORIGIN);
  if (!ctx.SESSION_KEYS && env.SESSION_KEYS === "true") patch.SESSION_KEYS = true;
  return Object.keys(patch).length ? withTenantFields(ctx, patch) : ctx;
}

async function loadTenantContext(tenantId, env, { prev = null } = {}) {
  let next = prev && prev.tenantId === tenantId ? prev : emptyTenantContext(tenantId);
  // Bundle mode: instance config lives in the store (pushed via /__publish/
  // _instance/config) and routing derives from the live manifests.
  if (bundleMode(env)) {
    const [instObj, manifests] = await Promise.all([
      bundlesFor(env, tenantId).get("config/instance.json"),
      loadManifests(tenantId, env, true),
    ]);
    // An absent instance document is a store that has never been pushed one — ABSENT.
    // A present one that will not parse is a FAILED read, and throws from here.
    if (instObj) next = withTenantFields(next, instanceFields(JSON.parse(await instObj.text())));
    next = withEnvAuthDefaults(next, env);
    next = withTenantFields(next, derivedRoutingFields(manifests, next.SPACE_ICONS));
    return withTenantFields(next, await rosterFields(next, env));
  }
  if (!env.ASSETS) return next;
  const grab = async (name) => {
    // A throw from the binding is a FAILED read and propagates — deliberately not caught.
    const r = await env.ASSETS.fetch("https://config/__config/" + name);
    if (r.status === 404) return null; // ABSENT: this build shipped no such document
    if (!r.ok) throw new Error(`config read failed: ${name} answered ${r.status}`);
    // A 200 that is not JSON is the asset host's own fallback page, not config. Treated
    // as ABSENT rather than FAILED: it is what a build with no config document looks like
    // on a host that answers misses with a page instead of a 404.
    try { return await r.json(); } catch (e) { return null; }
  };
  const [inst, routing] = await Promise.all([grab("instance.json"), grab("routing.json")]);
  if (inst) next = withTenantFields(next, instanceFields(inst));
  next = withEnvAuthDefaults(next, env);
  // Assets mode gets the two canvas aggregates pre-merged by the build that shipped them
  // (there is only ever one whole-site build in this mode, so the file is authoritative).
  // Same fields, same serving route as bundle mode.
  if (routing) next = withTenantFields(next, routingFields(routing));
  return withTenantFields(next, await rosterFields(next, env));
}

// A loaded context is now the ONLY place a workspace's config lives. There is no mirror
// left to write: every read site takes the context as a parameter, so nothing in module
// scope can answer a config question, and therefore nothing in module scope can answer it
// for the wrong workspace. `scripts/no-tenant-globals.mjs` is what keeps that true — its
// allowlist holds no config field at all now, so re-declaring one fails the build.

// The caller: one tick of the clock, then the swap. It owns the three properties the
// cache has to keep, and all three are here rather than inside loadTenantContext because
// the CALLER is what decides what a failed read is worth:
//
//   STAMP-FIRST — the tick is stamped BEFORE the read, so a config document that is
//   broken costs one attempt per 1.5s tick instead of one per concurrent request. It is
//   stamped before the failure is classified too: a store that is refusing every read
//   must not get one attempt per request just because the answers are useless.
//   KEEP-LAST-GOOD — the swap happens only when the load handed back a different context.
//   A read that produced nothing returns the reference it was given, and the gate keeps
//   serving the last config that worked. A read that FAILED keeps it too, but only for
//   as long as CONFIG_STALE_CEILING_MS.
//   FAIL-CLOSED — a failed read for a workspace this isolate has no recent good config
//   for produces NO context at all. The caller refuses the request; it does not serve one
//   built from the empty defaults, because the empty defaults are indistinguishable from
//   a raw build and a raw build's gate is open by design.
//
// It RETURNS the context it settled on, or `null` for "this request cannot be answered".
// The exits that do no work still return one: "the clock says this workspace's config is
// fresh" and "nothing parsed" both mean the caller should serve from the context already
// in hand.
//
// Everything is scoped to the workspace ASKED FOR, never to whatever the isolate looked
// at last. `TENANT_CTX` is one slot (see the note on its declaration), so a second
// workspace has no last-good here at all — and the answer for a workspace with no
// last-good is to reload, or to refuse, never to borrow the neighbour's.
async function loadConfig(tenantId, env) {
  // Is the context in the slot this workspace's? If not, this workspace is cold: no
  // fresh clock to ride, no last-good to keep, nothing to hand back on a failure.
  const mine = TENANT_CTX.tenantId === tenantId;
  // No config source bound at all — an offline shell or a raw engine build. There is
  // nothing to read and therefore nothing that can fail; this is the case that is open
  // BY DESIGN, and it must never become a refusal.
  if (!env) return mine ? TENANT_CTX : emptyTenantContext(tenantId);
  if (mine && Date.now() - cfgAt < 1500) return TENANT_CTX;
  cfgAt = Date.now(); // stamp first — a failed load retries next tick, never stampedes
  let next;
  try {
    next = await loadTenantContext(tenantId, env, { prev: mine ? TENANT_CTX : null });
  } catch (e) {
    // The store could not say what this workspace is. Keep serving the last config that
    // worked while it is still young enough to be worth trusting; past that, and on a
    // cold isolate that has no last config at all, refuse.
    if (mine && cfgGoodAt && Date.now() - cfgGoodAt < CONFIG_STALE_CEILING_MS) return TENANT_CTX;
    return null;
  }
  cfgGoodAt = Date.now();
  if (next === TENANT_CTX) return TENANT_CTX;
  TENANT_CTX = next;
  return TENANT_CTX;
}

// What a request gets when its workspace's config cannot be read and this isolate has no
// recent good copy of it. Deliberately NOT the login page: the login page is an answer
// about who may see this site, and answering it requires the very config that is missing.
// A 503 says the opposite of what an empty context would say — "ask again", not "there is
// nothing here to protect".
function configUnavailableResponse() {
  return new Response("Configuration unavailable — try again shortly.\n", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

// What an EXTERNAL request to /__config/* gets. That path is the channel the worker reads
// its own config over (`env.ASSETS.fetch("https://config/__config/…")`, which never enters
// this fetch handler), so no page links to it, no human navigates to it, and any request
// that arrives here is a probe or a mistake.
//
// It takes NO context, and that is the point. The refusal predates the resolve on purpose
// — the answer is the same for every workspace and costs no read, so making it wait on a
// config load would only add a way for a broken store to turn a sealed path into a 503 —
// and a response written before the resolve has no workspace to be branded FOR. It used to
// render the branded 404 from the module slot instead: the last context this isolate
// happened to load, which on a multi-workspace isolate is a neighbour's. What actually
// leaked was one bit (the branded page emits a favicon link only when the context has a
// default space, and the href is relative, so it resolves against the requesting host) —
// small enough that the branding was never worth arguing about, and beside the point. The
// point is that "every response this router builds comes from the workspace resolved for
// THIS request" was a rule with exactly one exception, the exception sat on an ungated
// path, and a rule with an exception is the thing the next reader copies. Unbranded, the
// rule has none, and the module slot has no reader left in the request path at all.
//
// Plain text rather than a stripped-down HTML page: a machine-facing path should answer
// like one, and there is no styling here to drift back into branding.
function configSealedResponse() {
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

// No workspace claims this hostname. Only a multi-workspace deployment can reach this —
// a single-workspace one has a workspace whatever the Host says.
//
// Context-free for the same reason as the refusal above, and one reason more: there IS no
// context to build. Reaching for one would mean picking a workspace to answer as, and on a
// deployment where hostname is identity that is picking somebody at random.
//
// 404 rather than 400, and the same body whether the name is unprovisioned, malformed or
// reserved. A distinguishable refusal for a reserved name would be a free directory of
// which names the operator kept, and one for an unprovisioned name would let a stranger
// enumerate which workspaces exist. Nobody legitimate is here: a workspace's own links all
// carry its own hostname.
function unknownHostResponse() {
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

// ---- The tenant resolver seam -----------------------------------------------
// ONE function answers "which workspace is this request for", and fetch() calls it
// ONCE, before any config is read. Everything downstream takes the answer as a
// parameter, so there is a single line here to change instead of a hunt through the
// read sites.
//
// THERE ARE NOW TWO BODIES, AND THE DEPLOYMENT PICKS ONE BY ITS SHAPE.
//
//   STATIC (`TENANT_HOST_SUFFIX` unset) — a deployment serves exactly one workspace,
//   so the answer is the identity the build stamped into instance.json (`tenantId`),
//   read once per isolate. This is what every self-hosted instance is, and nothing
//   about the path below changed when the dynamic branch landed above it.
//
//   DYNAMIC (`TENANT_HOST_SUFFIX` set) — several workspaces behind one deployment,
//   told apart by the first label of the Host header. No read, no memo, no clock:
//   the answer is a function of one header and one env var, which is what makes it
//   safe to run before anything else and on every request.
//
// The two cannot be confused, because the suffix is a runtime var a deployment either
// has or does not, and the dynamic branch never falls back to the static one. That
// matters more than it looks: a fallback here would answer an unrecognised hostname
// with SOME workspace, and on a multi-workspace deployment "some workspace" is
// somebody else's. An unrecognised hostname gets a refusal instead — see
// unknownHostResponse, which fetch() serves before a single config read.
//
// The static fallback carries more weight than its happy path. Every instance built
// before the field existed carries no `tenantId`, and a raw or offline build has no
// config document at all — all of them answer DEFAULT_TENANT_ID, which is precisely
// what the single-workspace world has been doing all along under another name: one
// identity, one config cache, one gate. Nothing about a live deployment changes when
// it takes this engine; it starts naming out loud the tenant it already was.
const DEFAULT_TENANT_ID = "default";
const TENANT_MEMO_TTL_MS = 1500;
// This isolate's static answer: `{at, tenantId}`, or null before the first attempt. A
// RESOLVED id is kept for the life of the isolate — a deployment's identity does not
// change without a new deploy, and re-reading it would put a second config read on
// every request. A FAILED attempt is stamped rather than pinned, so it retries on the
// next tick instead of every concurrent request queueing behind a broken read: the
// same stamp-first shape loadConfig uses, for the same reason.
let tenantMemo = null;

// instance.json's `tenantId`, or null if the document is absent, unreadable, or was
// written by a build that did not emit the field. Reads the same document loadConfig
// does, in both serving modes; the duplicate read is once per isolate and disappears
// when the config load itself becomes tenant-scoped.
async function readInstanceTenantId(env) {
  try {
    let doc = null;
    if (bundleMode(env)) {
      // ⚠️ DELIBERATELY UNPREFIXED, and it is the one read that must stay so. This is the
      // STATIC resolver discovering which workspace this deployment is, so it has no
      // workspace to key by — asking for `t/<workspace>/config/instance.json` here is
      // asking the answer to name itself. It is also correct: a deployment that reaches
      // this line has no `TENANT_HOST_SUFFIX`, serves exactly one workspace, and writes
      // no segment anywhere. The dynamic branch returns before this is ever called.
      const obj = await env.BUNDLES.get("config/instance.json");
      if (obj) doc = JSON.parse(await obj.text());
    } else if (env && env.ASSETS) {
      const r = await env.ASSETS.fetch("https://config/__config/instance.json");
      if (r.ok) doc = await r.json();
    }
    const id = doc && typeof doc.tenantId === "string" ? doc.tenantId.trim() : "";
    return id || null;
  } catch (e) { return null; }
}

// The namespace every workspace object on this deployment is addressed through, or null
// on a deployment that binds none.
//
// ⚠️ A JURISDICTION IS PART OF THE ADDRESS, NOT A SETTING ON THE BINDING. There is no
// config file entry for it anywhere: `ns.idFromName(x)` and
// `ns.jurisdiction("eu").idFromName(x)` produce two DIFFERENT ids, which are two different
// objects, held in two different sets of locations. A Durable Object's storage belongs to
// its id, so an object created on one side of that line cannot be moved to the other
// afterwards — it can only be exported and replayed into a new one. That makes this the
// rare piece of configuration that has to be right BEFORE the first workspace exists, and
// it makes it something anything else addressing the same workspaces has to be told, not
// something it can discover. Measured against a live namespace for the name `acme`:
// `7c2aaffc…21a9` unrestricted against `61395e58…51d9` under `eu`.
//
// UNSET OR BLANK MEANS NO JURISDICTION. That is what every deployment in existence does
// today and what this function did before the variable existed, and it is a real answer
// rather than a missing one: a self-hoster picks where their own data lives, and an engine
// that defaulted to somebody's regulatory preference would be choosing for them.
//
// A VALUE THE PLATFORM DOES NOT ACCEPT THROWS — and it throws from the platform, not from
// a list kept here. Deliberate: a copy of the accepted set in the request path would be a
// second authority, and a second authority is wrong in one of two directions forever —
// refusing a jurisdiction added after this line was written, or accepting a typo the
// platform then refuses anyway. The place a list belongs is the deploy gate, where it
// catches the typo before a single request reaches this code and where whoever hits a
// stale entry can edit it: `scripts/wrangler-preflight.mjs`.
//
// What must never happen is the third option — an unrecognised value quietly falling back
// to an unrestricted address. That reads as success everywhere, addresses an object nobody
// else is addressing, and is invisible until a workspace answers as though it were empty.
function tenantNamespace(env) {
  const ns = env && env.TENANTS;
  if (!ns) return null; // nothing to address; the variable is moot and never consulted
  const j = env && typeof env.TENANT_JURISDICTION === "string" ? env.TENANT_JURISDICTION.trim() : "";
  if (!j) return ns;
  if (typeof ns.jurisdiction !== "function") {
    throw new Error(`TENANT_JURISDICTION is "${j}", but the TENANTS binding cannot be restricted to a jurisdiction. `
      + "Addressing without it would reach a different object, so this refuses instead: unset the variable, or fix the binding.");
  }
  try {
    return ns.jurisdiction(j);
  } catch (e) {
    throw new Error(`TENANT_JURISDICTION = "${j}" is not a jurisdiction this platform accepts (${(e && e.message) || e}). `
      + "Falling back to an unrestricted address would put every workspace somewhere nothing else is looking, so this refuses instead.");
  }
}

// The workspace's own Durable Object, or null on a deployment that binds none.
//
// `idFromName` is a hash, not a lookup: it does no I/O, it cannot fail, and the same name
// gives the same object in every isolate and every colo. So this is free to do on every
// request, and there is nothing to cache — caching a stub keyed on nothing is how an
// isolate ends up handing one workspace another's object.
//
// It is deliberately NOT an existence check. Whether a workspace has been provisioned is a
// question with an answer inside the object, and asking it here would put a round trip in
// front of every request including the ones that never touch the store.
//
// ⚠️ EVERY WORKSPACE ADDRESS IN THIS ENGINE IS COMPUTED HERE, AND THAT IS THE PROPERTY,
// not a tidiness. A second `TENANTS.idFromName` anywhere is a second answer to "which
// object is this workspace", and on a deployment with no jurisdiction set the two agree —
// so the duplicate is invisible until the day one is set, at which point half the engine
// is talking to objects the other half cannot see. `test/tenant-resolver-host.test.mjs`
// reads the source and fails on a second site.
function tenantStub(env, tenantId) {
  const ns = tenantNamespace(env);
  if (!ns || !tenantId) return null;
  return ns.get(ns.idFromName(tenantId));
}

// ── The alias table: hostnames the literal resolver refuses, resolved by lookup ──────
//
// `B-claim-platform-subdomain`, the resolver half. A claimed hostname — `demo.<suffix>`, a
// label the RESERVED list refuses on the self-service path — is an alias row an OPERATOR
// wrote (the claim verb on the workspace object; nothing else writes this family), keyed by
// the FULL normalized hostname. It is consulted ONLY when `tenantLabelFromHost` answers
// null, so a request the literal resolver can answer never pays for a lookup — and the two
// tables are disjoint by construction, because the claim verb refuses any hostname the
// literal resolver resolves. Keying on the full hostname rather than the label is what lets
// a customer's own hostname (no suffix at all) land in the SAME table later
// (`B-custom-hostname-alias`): one lookup, not two.
//
// A miss stays a miss: the bare 404 an unknown hostname has always had, before any config
// read. An unreadable store also stays a miss — an alias is an ADDITION to the namespace,
// and a KV blip must not widen what a hostname resolves to; the claimed hostname going
// dark for a tick while the generated one keeps serving is the cheap side of that trade.
//
// NO PER-ISOLATE MEMO, deliberately. The one keyed-cache shape this repo trusts is keyed
// by tenantId (scripts/no-tenant-globals.mjs), and this lookup is keyed by HOSTNAME —
// which is also what a stranger controls, so a memo here is a table strangers grow. The
// platform's own KV read cache (~60s per key) already absorbs the hot claimed hostname,
// and the literal path above never reaches this line at all.
async function aliasTenantId(env, hostHeader) {
  const kv = kvForRaw(env);
  if (!kv) return null;
  const host = normalizeHost(hostHeader);
  if (!host || host.startsWith("[")) return null;
  let row = null;
  try {
    row = JSON.parse((await kv.get(`host:alias:${host}`)) || "null");
  } catch (e) {
    return null; // a miss, never a wider namespace
  }
  const label = row && typeof row.workspace === "string" ? row.workspace : "";
  // The alias must name a workspace the literal resolver COULD have resolved: a legal,
  // unreserved label. A row naming anything else is a corrupt row, and resolving it would
  // hand the reserved namespace back out through the side door.
  if (!TENANT_LABEL_RE.test(label) || isReservedLabel(label, deploymentReservedLabels(env))) return null;
  return label;
}

/** The deployment's own reserved labels (RESERVED_LABELS_EXTRA), parsed per call — a
 *  string split, and the one memo shape this repo trusts is keyed by tenantId, not env. */
function deploymentReservedLabels(env) {
  return parseReservedLabels(env && typeof env.RESERVED_LABELS_EXTRA === "string" ? env.RESERVED_LABELS_EXTRA : "");
}

async function resolveTenant(request, env) {
  // DYNAMIC — several workspaces, one deployment, told apart by Host. A null answer here
  // is a refusal, never a fall-through to the static branch: see the seam header.
  const suffix = env && typeof env.TENANT_HOST_SUFFIX === "string" ? env.TENANT_HOST_SUFFIX : "";
  if (suffix.trim()) {
    const host = request && request.headers ? request.headers.get("host") : "";
    const tenantId = tenantLabelFromHost(host, suffix, deploymentReservedLabels(env));
    if (tenantId) return { tenantId, store: tenantStub(env, tenantId) };
    // The literal label names nobody. One alias lookup — a claimed hostname resolves to
    // its workspace; anything else keeps the refusal it has always had.
    const aliased = await aliasTenantId(env, host);
    if (aliased) return { tenantId: aliased, store: tenantStub(env, aliased) };
    return { tenantId: null, store: null };
  }
  // STATIC — one workspace, named by the build. Unchanged.
  if (tenantMemo) {
    if (tenantMemo.tenantId) return { tenantId: tenantMemo.tenantId, store: tenantStub(env, tenantMemo.tenantId) };
    if (Date.now() - tenantMemo.at < TENANT_MEMO_TTL_MS) return { tenantId: DEFAULT_TENANT_ID, store: tenantStub(env, DEFAULT_TENANT_ID) };
  }
  tenantMemo = { at: Date.now(), tenantId: null }; // stamp first, then read
  const tenantId = await readInstanceTenantId(env);
  if (tenantId) tenantMemo = { at: Date.now(), tenantId };
  const id = tenantId || DEFAULT_TENANT_ID;
  return { tenantId: id, store: tenantStub(env, id) };
}

// Test hook: the memo is per-isolate, so a suite driving two deployments through one
// module has to clear it between them. Nothing in the request path calls this.
function __setTenantTestState({ memo = null } = {}) { tenantMemo = memo; }

// Legacy token derivation — SHA-256("gv:" + secret). Still ACCEPTED during migration
// (see identify) and used as the fallback when SESSION_SECRET is unset, but new
// tokens are always issued by hmacToken().
async function tokenFor(secret) {
  return toHex(await crypto.subtle.digest("SHA-256", encodeUtf8("gv:" + secret)));
}

/**
 * How an invite token is keyed in the workspace object.
 *
 * `B-kv-to-do-migration-tool`. KV keys `users:invites` by the RAW token, so it can look one
 * up directly; the object's `invites` table stores only a hash, so a read of that storage —
 * a backup, an export, an operator looking — cannot redeem anybody's invitation.
 *
 * ⚠️ IT LIVES HERE, ONCE, BECAUSE TWO PLACES HAVE TO AGREE. The copy hashes an outstanding
 * token on the way in and `B-kv-read-cutover`'s redemption path hashes a presented one on
 * the way back; spelled differently, every invite link already in somebody's inbox stops
 * working on the day the reads move, and nothing before that day would notice. The `inv:`
 * prefix mirrors the `pub:` a publish token carries, so the two can never collide.
 */
async function inviteHash(token) {
  return tokenFor("inv:" + token);
}

async function hmacToken(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encodeUtf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encodeUtf8(message)));
}

// ---- Runtime roster overlay -------------------------------------------------
// The config roster names who the deploy shell knows about; this layer records who the
// admin panel has invited or removed since, so neither takes a commit + redeploy.
//
// ⚠️ The overlay is a CONVENIENCE, never the security boundary. A KV read that fails
// leaves `ctx.USERS` as the config list, which would resurrect a removed CONFIG user in
// the list — so `remove` ALSO writes the users:secrets tombstone that reset writes. That
// tombstone fails closed on a KV error (see effectiveSecret) and identify() refuses any
// user without an effective secret, so a removed person cannot sign in even if this
// overlay is momentarily unreadable. Never "simplify" removal down to the list alone.
const lcEmail = (e) => String(e == null ? "" : e).trim().toLowerCase();
// A FRESH object every time, never a shared constant: the write ops mutate what this
// returns before putting it back, so handing out one shared empty would let the first
// invite scribble on every later read.
const emptyRoster = () => ({ add: {}, remove: [] });

async function readRoster(env, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv) return emptyRoster();
  try {
    const doc = JSON.parse((await kv.get(USER_ROSTER_KEY)) || "null");
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return emptyRoster();
    const add = doc.add && typeof doc.add === "object" && !Array.isArray(doc.add) ? doc.add : {};
    const remove = Array.isArray(doc.remove) ? doc.remove : [];
    return { add, remove };
  } catch (e) { return emptyRoster(); }
}

// Config first, overlay second: an address the config names can never be shadowed by an
// `add` entry (the file wins on name, role and avatar), and `remove` hides it from both.
function mergeRoster(configUsers, roster) {
  const gone = new Set((roster.remove || []).map(lcEmail));
  const out = (configUsers || []).filter((u) => !gone.has(lcEmail(u.email)));
  const seen = new Set(out.map((u) => lcEmail(u.email)));
  for (const rec of Object.values(roster.add || {})) {
    const e = lcEmail(rec && rec.email);
    if (!e || gone.has(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(rec);
  }
  return out;
}

// The overlay reads ride their OWN clock, slower than the 1.5s config tick. Six KV
// reads per tick was the site's dominant KV consumer (~4 reads/s under sustained
// browsing ≈ 350k/day) and exhausted the free-tier daily get() budget, after which
// every KV-touching route threw for the rest of the day (2026-08-20). The APPLY
// still runs every tick — instanceFields resets `USERS` to the config list and counts
// on the overlay landing on top — only the KV reads are cached.
//
// KEYED BY WORKSPACE, and the key is an AUTHORIZATION boundary, not a tidiness one. The
// six documents in an entry are one workspace's roster overlay: who has been invited or
// removed since the config was built, what role each person holds, which workspaces they
// are a member of, the photo hashes `/__avatar/` will serve ungated, and the icon hashes
// `/__space-icon/` will. A single slot hands all six to the SECOND workspace to load
// inside the TTL, which was reproduced end to end through the real fetch(): beta's
// ungated `/__people` naming an alpha person to a signed-out stranger, `/__avatar/u/…`
// answering 200 with alpha's photo bytes from beta, and — the one that makes this an
// authorization leak rather than a disclosure — a person who is a VIEWER in beta's own
// config, with no users:roles document in beta's KV at all, coming back ADMIN out of
// alpha's role overlay. Bounded and evicted like the manifest cache and the board
// registry: an evicted workspace re-reads its own six documents, which costs six KV gets
// and can never answer with a neighbour's.
//
// FRESHNESS IS KEYED TOO. Every handler that writes one of the six busts the entry for
// the workspace it wrote in (`bustRosterOverlay`), so the write is live on that
// workspace's next request; other isolates converge within ROSTER_TTL_MS. There is
// deliberately no blanket bust: `cfgAt = 0` reached every workspace's read at once, which
// is the coarse shape this cache is being moved away from.
//
// None of this touches auth: identify() resolves users:secrets per request, so a removal
// or reset still bites immediately — the tombstone, not this overlay, is the boundary.
const ROSTER_TTL_MS = 60_000;
const ROSTER_CACHE_MAX = 256;
// tenantId -> { at, docs }. Bounded and recency-ordered by the constructor; there is no
// access to it that does not name a workspace.
const ROSTER_OVERLAY = tenantCache("roster-overlay", { max: ROSTER_CACHE_MAX });

// A roster write making itself visible on the very next request, for ITS workspace only.
// The last-read documents are KEPT: this asks for a re-read, it does not blank what the
// workspace is serving in the meantime.
function bustRosterOverlay(tenantId) {
  ROSTER_OVERLAY.bust(tenantId);
}
// Test hooks: the cadence above is timing state a test can't reach otherwise.
function __setConfigTestState({ cfgAt: c, cfgGoodAt: g, roster, mcpHostAllowlist: m, manifests, storage, canvasRegistry, pitiRemarks, suspension } = {}) {
  if (c !== undefined) cfgAt = c;
  // The last-good stamp is set INDEPENDENTLY of the tick stamp, because ageing one past
  // the other is the whole staleness-ceiling story: `{cfgAt: 0}` means "a new tick", and
  // only `{cfgGoodAt: …}` means "and the last config that worked is this old".
  if (g !== undefined) cfgGoodAt = g;
  // The roster overlay, keyed by workspace like the four below. Falsy clears the whole
  // map (a case that leaves it warm is asserting about the previous case's KV);
  // `{tenantId, at}` ages ONE workspace's entry, which is how a case reaches the TTL
  // without reaching a neighbour's documents.
  if (roster !== undefined) {
    if (!roster) ROSTER_OVERLAY.clear();
    else {
      const e = ROSTER_OVERLAY.get(roster.tenantId);
      if (e) e.at = roster.at;
    }
  }
  // The proxy's derived host lists, back to cold. Falsy clears; the Map is keyed by
  // workspace, so a case that does not clear it is asserting about whatever the previous
  // case resolved.
  if (m !== undefined && !m) mcpHostAllowlist.clear();
  // The two bundle-store caches, same rule: both are keyed by workspace, so a case that
  // leaves them warm is asserting about the previous case's store.
  if (manifests !== undefined && !manifests) MANIFESTS.clear();
  if (storage !== undefined && !storage) STORAGE_CACHE.clear();
  // The two KV documents the ungated routes poll — the board registry and the remark
  // queue. Keyed by workspace like the pair above, and cleared the same way: a case that
  // leaves one warm is asserting about the previous case's KV.
  if (canvasRegistry !== undefined && !canvasRegistry) CANVAS_REGISTRY.clear();
  if (pitiRemarks !== undefined && !pitiRemarks) PITI_REMARKS.clear();
  // The suspension/claimed-hostname read behind /__admin/custom-domain, keyed by
  // workspace like the caches above and cleared the same way.
  if (suspension !== undefined && !suspension) SUSPENSION_STATE.clear();
}
// The roster this isolate last loaded, out of the context rather than out of a module
// binding — the cadence tests need to see what the config tick settled on, and there is
// no global left to read it from.
const __usersNow = () => TENANT_CTX.USERS;

/**
 * The six documents `rosterFields` runs on, from whichever store holds each of them.
 *
 * `B-kv-read-cutover`. FOUR of the six come from the workspace object in ONE round trip
 * once `KV_CUTOVER.roster` is on, and they come back spelled exactly as KV spells them —
 * so `mergeRoster`/`applyRoles`/`applyNames`/`applyAvatars` below are one pipeline fed from
 * two possible stores rather than two pipelines that have to be kept in agreement. That is
 * what makes "bound and unbound answer the same" a property of the shape rather than a
 * thing a test hopes for.
 *
 * ⚠️ AN OBJECT THAT HAS NEVER BEEN GIVEN THIS FAMILY IS NOT AN EMPTY ONE. A workspace
 * copied off KV and a workspace whose copy has not run yet both have no rows, and answering
 * the second from the object would silently UN-REMOVE everybody `users:roster.remove` names.
 * So the object reports whether it has been seeded and an unseeded one defers to KV — the
 * same "object first, KV as the fallback" rule an outstanding invite link relies on. A
 * workspace provisioned on the object was never on KV and is seeded from birth.
 *
 * ⚠️ AND A STORE ERROR IS NOT AN ANSWER EITHER. It throws, which `rosterFields` catches into
 * the config roster — the deliberate fail-OPEN this layer has always had, because the
 * `users:secrets` tombstone and not this overlay is the security boundary. Falling through
 * to KV instead would be a fail-open too, one document at a time and much harder to see.
 *
 * The last two stay on KV and the constant says why: `users:spaces` is inventoried as
 * DROPPED rather than migrated, and `spaces:icons` has no copy into `settings` yet.
 */
async function readRosterDocs(ctx, env) {
  const ident = identityFor(env, ctx, "roster");
  if (ident) {
    const [docs, spaces, icons] = await Promise.all([
      ident.rosterRead(), readSpaces(env, ctx), readSpaceIcons(env, ctx),
    ]);
    if (docs && docs.seeded) {
      return [docs.roster, docs.avatars, docs.names, docs.roles, spaces, icons];
    }
    // Unseeded: KV still holds this workspace's overlay, and it is the answer.
    const [roster, avatars, names, roles] = await Promise.all([
      readRoster(env, ctx), readAvatars(env, ctx), readNames(env, ctx), readRoles(env, ctx),
    ]);
    return [roster, avatars, names, roles, spaces, icons];
  }
  return Promise.all([
    readRoster(env, ctx), readAvatars(env, ctx), readNames(env, ctx), readRoles(env, ctx),
    readSpaces(env, ctx), readSpaceIcons(env, ctx),
  ]);
}

/**
 * Mirror the roster documents a KV write just produced into the workspace object.
 *
 * ⚠️ THE WRITES GO TO BOTH STORES AND THAT IS WHAT MAKES THE FLAG A REVERT. Flipping
 * `KV_CUTOVER.roster` back has to restore the KV answer with nothing lost, which is only
 * true if KV kept receiving every change while the object was the read. The reverse mirror
 * — object-only writes — would make the revert a rollback to whenever the cut happened.
 *
 * It takes the DOCUMENTS the handler already computed rather than re-reading them: a mirror
 * that re-read would race the write it is mirroring, and on the KV backing that race is
 * exactly the read-modify-write the content overlay moved off for.
 *
 * Best-effort and never fatal: the KV write has already landed and is still the fallback.
 *
 * ⚠️ `configUsers` IS THE CONFIG BEING WRITTEN, NOT THE ONE THIS REQUEST WAS LOADED WITH,
 * AND THE DIFFERENCE DELETED PEOPLE. It defaults to the request's context because for every
 * caller but one the config is not moving. The exception is the config PUSH itself, which is
 * the documented way an overlay member becomes a durable one: the file now names them, so
 * the drain takes them out of `add` — and `rosterWrite` decides `source` from THIS list
 * before its orphan clause tombstones every `source = 'overlay'` row that `add` no longer
 * carries. Handed the OLD config, that pass does not name the person being promoted, their
 * row stays `'overlay'`, and the ordinary invite → commit → deploy loop tombstones them
 * permanently: the un-tombstone clause revives only `'config'` rows, and the drain that
 * would re-run it fires off a KV read that the object's tombstone cannot reach. So the
 * caller that changes the config passes the new one, and the two passes run in the order
 * the promotion needs.
 */
async function mirrorRosterDocs(tctx, env, docs, configUsers) {
  const ident = identityFor(env, tctx, "roster");
  if (!ident) return;
  // Resolved AFTER the binding check, not as a default parameter: a deployment with no
  // workspace object does no work here at all, which is the shape the whole cut-over keeps.
  const list = configUsers === undefined ? tctx.CONFIG_USERS : configUsers;
  try {
    await ident.rosterWrite({
      // The durable half travels too, so an overlay entry naming somebody this object has
      // no row for can be seeded from the record rather than from a guess. Only the fields
      // `members` has columns for — a config user's `passHash` has no business here and
      // `identityFromKv` does not carry one either.
      configUsers: (Array.isArray(list) ? list : []).filter((u) => u && u.email).map((u) => ({
        email: u.email, name: u.name || null, role: u.role || null,
        initials: u.initials || null, color: u.color || null,
      })),
      ...docs,
    });
  } catch (e) { /* KV has it, and KV is still the fallback */ }
}
// The overlay as a VALUE: it reads KV and returns the three fields the overlay owns, on
// top of the context the config documents just produced. Nothing is written here, so a
// throw anywhere in the chain reaches the caller having changed nothing — and the answer
// then is the config roster alone, which is the one thing that must never be an overlay's
// to decide (the tombstone, not this, is the security boundary — see the note above).
async function rosterFields(ctx, env) {
  try {
    // Insert BEFORE the await, so two concurrent requests for one workspace fill one
    // entry rather than racing two into the map. The stamp goes up before the read for
    // the same reason loadConfig stamps first: a store refusing every read must not get
    // six gets per request just because the answers are useless.
    const cur = ROSTER_OVERLAY.entry(ctx.tenantId, () => ({ at: 0, docs: null }));
    if (!cur.docs || Date.now() - cur.at >= ROSTER_TTL_MS) {
      cur.at = Date.now();
      cur.docs = await readRosterDocs(ctx, env);
    }
    const [roster, avatars, names, roles, spaces, icons] = cur.docs;
    // The photo pass hands back the users AND the hashes it stamped — see applyAvatars —
    // so the rest of the pipeline runs on its users while the Set travels to the context
    // rather than to a module binding.
    const faces = applyAvatars(applyNames(mergeRoster(ctx.CONFIG_USERS, roster), names), avatars);
    return {
      SPACE_ICONS: icons,
      // SPACES + SPACE_ICON_KEYS, together — see applySpaceIcons.
      ...applySpaceIcons(ctx.SPACES, icons),
      AVATAR_KEYS: faces.AVATAR_KEYS,
      USERS: applySpaces(applyRoles(faces.USERS, roles), spaces),
    };
  } catch (e) { return { USERS: ctx.CONFIG_USERS }; }
}

// ---- Self-set display names -------------------------------------------------
// Same bargain as the photo below: who you are is a deploy decision, what you are
// CALLED is yours. A config-baked name is the seed someone sees until they change it.
async function readNames(env, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv) return {};
  try {
    const doc = JSON.parse((await kv.get(USER_NAMES_KEY)) || "null");
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch (e) { return {}; }
}

// Trim, collapse runs of whitespace, drop control characters, clamp. Returns null for
// anything that isn't a usable name — the caller turns that into a 400 rather than
// storing a blank that would render as an empty chip.
function cleanName(s) {
  if (typeof s !== "string") return null;
  // Control characters and the bidi overrides go first: a name is rendered as text in
  // the chip, the admin table and on comments, and RLO/LRO in particular can reorder
  // everything drawn after it. Then collapse whitespace runs and trim.
  const out = s.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  return out && out.length <= NAME_MAX_CHARS ? out : null;
}

// Copies, never in-place mutation — same reason as applyAvatars.
//
// The override also DROPS a config-set `initials`. Initials are a stand-in for the
// name (they show wherever there's no photo), so keeping "RA" against a name changed
// to "Bee" would make one person read as two. Dropping it lets initialsFor derive
// from the new name; publicUser and peopleApi already fall back that way.
async function readRoles(env, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv) return {};
  try {
    const doc = JSON.parse((await kv.get(USER_ROLES_KEY)) || "null");
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch (e) { return {}; }
}

// Overlay an admin's role changes onto the merged roster. Only recognised roles are
// applied — a corrupt or hand-edited overlay entry must not be able to invent a fourth
// role, nor to blank someone's existing one.
function applyRoles(users, index) {
  return (users || []).map((u) => {
    const want = index && index[lcEmail(u.email)];
    if (!ROLES.includes(want)) return u;
    return { ...u, role: want };
  });
}

// Drop someone's overlay entry, so identity.json's role takes over again. Called when
// the file has caught up (the change drains itself, exactly like the roster overlay)
// and when an address is removed — a re-invited address must not inherit the last
// person's role, least of all `admin`.
async function clearRole(tctx, env, email) {
  const kv = kvFor(env, tctx);
  if (!kv) return;
  try {
    const index = await readRoles(env, tctx);
    if (!(lcEmail(email) in index)) return;
    delete index[lcEmail(email)];
    await kv.put(USER_ROLES_KEY, JSON.stringify(index));
    await mirrorRosterDocs(tctx, env, { roles: index });
  } catch (e) {}
}

// ---- Per-space membership ---------------------------------------------------
// See USER_SPACES_KEY for the absent-vs-empty rule these all turn on.
async function readSpaces(env, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv) return {};
  try {
    const doc = JSON.parse((await kv.get(USER_SPACES_KEY)) || "null");
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch (e) { return {}; }
}

// Stamp the membership map onto each user. A non-object entry is DROPPED rather than
// coerced to {}: a corrupt or hand-edited overlay must not be able to lock someone out
// of everything. Copies, never in-place mutation — same reason as applyAvatars.
function applySpaces(users, index) {
  return (users || []).map((u) => {
    const want = index && index[lcEmail(u.email)];
    if (!want || typeof want !== "object" || Array.isArray(want)) return u;
    return { ...u, spaces: { ...want } };
  });
}

// null = "every space". Callers MUST branch on null and must never treat it as an
// empty map; that conflation is the one bug this whole cluster is shaped to prevent.
const membershipOf = (u) => {
  const m = u && u.spaces;
  return m && typeof m === "object" && !Array.isArray(m) ? m : null;
};

const isMemberOf = (u, spaceId) => {
  const m = membershipOf(u);
  return m ? Object.prototype.hasOwnProperty.call(m, spaceId) : true;
};

// A role is only meaningful where you are a member. A non-member reads as `editor` —
// the floor — and never as their global role: otherwise a global admin would carry
// admin rights straight into a space they were deliberately kept out of.
const roleIn = (u, spaceId) => {
  const m = membershipOf(u);
  if (!m) return roleOf(u);
  if (!Object.prototype.hasOwnProperty.call(m, spaceId)) return "editor";
  return roleOf({ role: m[spaceId] });
};

const spacesFor = (u, spaces) => (spaces || []).filter((s) => isMemberOf(u, s.id));

// A viewer can look around; it cannot change what everyone else sees. Returns a 403
// Response for a write a viewer may not make, or null to let the request through.
// GETs always pass — reading a status or a name is looking, not changing.
//
// The role is resolved against the space that owns the TARGET path (?path=), so this
// stays correct once one person can hold different roles in different workspaces. An
// unowned or missing path falls back to the global role rather than failing open.
function viewerWriteRefusal(request, url, me, what, spaces) {
  if (!me || request.method === "GET" || request.method === "HEAD") return null;
  const target = url.searchParams.get("path") || url.pathname;
  const sid = spaceIdForPath(target, spaces);
  const role = sid ? roleIn(me, sid) : roleOf(me);
  if (role !== "viewer") return null;
  return jsonResponse({
    error: "viewer-role",
    message: {
      name: "This account can look around but not rename prototypes.",
      status: "This account can look around but not change a prototype's status.",
      canvas: "This account can look around but not create canvases.",
      asset: "This account can look around but not upload images.",
    }[what] || "This account can look around but not change things.",
  }, 403);
}

// ---- Workspace icons --------------------------------------------------------
async function readSpaceIcons(env, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv) return {};
  try {
    const doc = JSON.parse((await kv.get(SPACE_ICONS_KEY)) || "null");
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch (e) { return {}; }
}

// Stamp each space's icon URL and derive the hash allowlist the serve route checks.
// Same copy-never-mutate rule as applyAvatars: SPACES entries come from the live
// manifests, so writing onto them would outlive the overlay.
//
// Returns a context PATCH — both fields it owns — rather than the stamped list plus a
// module-scope side effect. The two have to move together: the allowlist is exactly the
// hashes THIS list was stamped with, and a shared Set would have let a hash one
// workspace vouched for open the icon route of every other one.
function applySpaceIcons(spaces, index) {
  const keys = new Set();
  const out = (spaces || []).map((s) => {
    const rec = index && index[s.id];
    const k = rec && typeof rec.k === "string" ? rec.k : null;
    if (!k) return s;
    keys.add(k);
    return { ...s, icon: "/__space-icon/" + k };
  });
  return { SPACES: out, SPACE_ICON_KEYS: keys };
}

// Serve a workspace icon. The allowlist check comes FIRST for the same reason it does
// on /__avatar/: an ungated route must not become a KV read amplifier for anyone
// typing hashes at it. It is asked of the CALLING workspace's context, so a hash is
// only ever served by the workspace whose index vouches for it.
async function serveSpaceIcon(tctx, env, k) {
  if (!tctx.SPACE_ICON_KEYS.has(k)) return new Response("Not found", { status: 404 });
  const kv = kvFor(env, tctx);
  const raw = kv ? await kv.get(SPACE_ICON_BLOB_PREFIX + k) : null;
  const parsed = raw && parseAvatarDataUri(raw);
  if (!parsed) return new Response("Not found", { status: 404 });
  return new Response(parsed.bytes, {
    headers: {
      "Content-Type": parsed.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// POST {space, icon: "data:image/…"} sets it; DELETE {space} restores the repo's seed.
// Admin of THAT workspace only — the same authority that edits its people.
//
// `tenantId` is carried for the roster overlay's cache and nothing else: the KV keys are
// the instance's, but which workspace's icon index this isolate is holding is not
// something the binding can answer.
async function spaceIconApi(tenantId, request, env, me, spaces, tctx) {
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  const kv = kvFor(env, tctx);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  const sid = String((body && body.space) || "");
  // `spaces` is the CALLER's workspace list and has no default: with no list there is no
  // workspace to be an admin of, so the answer is "unknown space", never a fall-through
  // to whatever list some other request left in module scope.
  if (!(spaces || []).some((s) => s.id === sid)) return jsonResponse({ error: "unknown-space" }, 400);
  if (roleIn(me, sid) !== "admin") return jsonResponse({ error: "forbidden" }, 403);

  if (request.method === "DELETE") {
    const index = await readSpaceIcons(env, tctx);
    if (sid in index) { delete index[sid]; await kv.put(SPACE_ICONS_KEY, JSON.stringify(index)); }
    bustRosterOverlay(tenantId); cfgAt = 0;
    return jsonResponse({ ok: true, icon: null });
  }
  if (request.method === "POST") {
    const parsed = parseAvatarDataUri(body && body.icon);
    if (!parsed) return jsonResponse({ error: "bad-image" }, 400);
    const k = await avatarHash(body.icon);
    // Blob first: an index entry pointing at a missing blob serves a broken icon,
    // whereas a blob no index names is just an orphan.
    await kv.put(SPACE_ICON_BLOB_PREFIX + k, body.icon);
    const index = await readSpaceIcons(env, tctx);
    index[sid] = { k, mime: parsed.mime, at: new Date().toISOString() };
    await kv.put(SPACE_ICONS_KEY, JSON.stringify(index));
    bustRosterOverlay(tenantId); cfgAt = 0;
    return jsonResponse({ ok: true, icon: "/__space-icon/" + k });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// The switcher's payload. Deliberately NOT folded into publicUser: that object is
// embedded in PUBLIC prototypes for the comment overlay, and a space list there would
// hand the whole site's structure to anyone holding a prototype link — the same reason
// /__people refuses to enumerate the roster.
// Which space serves this path. A single-workspace instance mounts exactly one space
// (the default) at the root, so every owned path resolves to it and `pathname` no longer
// discriminates — the "/<id>/" path-mount tier that once picked one of several spaces is
// retired. With no default space configured an unowned path belongs to NOBODY (null)
// rather than falling to an arbitrary space — the caller then leaves it alone rather than
// gating it on a guess. That null-when-no-space contract is load-bearing and KEPT.
function spaceIdForPath(pathname, spaces) {
  const only = (spaces || []).find((s) => s.default);
  return only ? only.id : null;
}

// Does this person administer ANY space? The /admin door asks this rather than the
// global role: with per-space roles, the admin of one space is an ordinary member
// elsewhere, and the page itself scopes to a space they actually administer.
//
// With NO space list known — a raw engine build, or any request that lands before
// routing.json has loaded — the question degenerates to the global role. That is the
// check this replaced, so an instance with no spaces configured behaves exactly as it
// did. Returning false there would lock every admin out of the admin API with no way
// back in, which is the one failure mode this whole file is careful about.
const administersAny = (u, spaces) =>
  (spaces || []).length ? spaces.some((s) => roleIn(u, s.id) === "admin") : roleOf(u) === "admin";

// The per-space twin of the instance-wide last-admin guard: a space with no admin
// cannot be recovered from inside the product, exactly like an instance with none.
// Asks roleIn rather than reading the overlay directly, so a global admin with no
// membership recorded correctly counts as an admin of every space.
function lastAdminOf(users, spaceId, email) {
  const me = lcEmail(email);
  return !(users || []).some((u) => lcEmail(u.email) !== me && roleIn(u, spaceId) === "admin");
}

// A password reset hands over the ACCOUNT, not one space — so it is only offered when
// every space the target belongs to is one the actor already administers. Otherwise
// resetting is a route into a space the actor was never given, which is exactly the
// boundary per-space roles exist to draw. A target with no membership recorded belongs
// to every space, so only someone who administers all of them may reset it.
function mayResetPassword(users, actorEmail, targetEmail, spaces) {
  const actor = (users || []).find((u) => lcEmail(u.email) === lcEmail(actorEmail));
  const target = (users || []).find((u) => lcEmail(u.email) === lcEmail(targetEmail));
  if (!actor || !target) return false;
  return spacesFor(target, spaces).every((s) => roleIn(actor, s.id) === "admin");
}

const meSpaces = (u, spaces) =>
  spacesFor(u, spaces).map((s) => ({
    id: s.id, name: s.name, base: s.base || "", role: roleIn(u, s.id),
    // Absent when the workspace has never set one — the rail then keeps the space
    // repo's /space-icon.png seed it already rendered.
    ...(s.icon ? { icon: s.icon } : {}),
  }));

// Drop someone's membership entry. Called when an address is removed, for the same
// reason clearRole and clearName are: a re-invited address must not inherit the last
// person's spaces, least of all one they administered.
async function clearSpaces(env, email, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv) return;
  try {
    const index = await readSpaces(env, tctx);
    if (!(lcEmail(email) in index)) return;
    delete index[lcEmail(email)];
    await kv.put(USER_SPACES_KEY, JSON.stringify(index));
  } catch (e) {}
}

function applyNames(users, index) {
  return (users || []).map((u) => {
    const rec = index && index[lcEmail(u.email)];
    const name = rec && typeof rec.name === "string" ? rec.name : null;
    if (!name) return u;
    const { initials, ...rest } = u;
    return { ...rest, name };
  });
}

// Drop someone's chosen name, so the config roster's own name takes over again. Called
// when an admin removes them: a re-invited address must not inherit the last person's
// chosen name, and there is no UI for clearing it yourself.
async function clearName(tctx, env, email) {
  const kv = kvFor(env, tctx);
  if (!kv) return false;
  const index = await readNames(env, tctx);
  const key = lcEmail(email);
  if (!index[key]) return false;
  delete index[key];
  await kv.put(USER_NAMES_KEY, JSON.stringify(index));
  await mirrorRosterDocs(tctx, env, { names: index });
  return true;
}

// POST /__me/name {name} — set MY display name. Signed-in users only, and only ever
// their own row: there is no email parameter, the same rule the photo route follows.
// A rename propagates everywhere a name is read (chip, admin table, comment authors),
// because comments store a person id, never a name snapshot.
//
// `tenantId` is carried for the roster overlay's cache — see spaceIconApi.
async function meNameApi(tenantId, request, env, me, tctx) {
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
  const kv = kvFor(env, tctx);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  const name = cleanName(body && body.name);
  if (!name) return jsonResponse({ error: "bad-name" }, 400);
  const index = await readNames(env, tctx);
  index[lcEmail(me.email)] = { name, at: new Date().toISOString() };
  await kv.put(USER_NAMES_KEY, JSON.stringify(index));
  await mirrorRosterDocs(tctx, env, { names: index });
  // This workspace re-reads on the next request; other isolates within ROSTER_TTL_MS.
  bustRosterOverlay(tenantId); cfgAt = 0;
  return jsonResponse({ ok: true, name, initials: initialsFor(name) });
}

// ---- Self-set profile photos ------------------------------------------------
// The one place the config file does NOT win. Everything else about a person is a
// deploy decision (who they are, what they may do); their face is theirs, so a photo
// set from the profile menu overrides a data URI baked into the identity file. A
// config-baked photo therefore acts as a SEED — the value someone sees until they
// change it — which is what lets an instance carrying baked photos take this feature
// by pin bump with nothing to migrate.

async function readAvatars(env, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv) return {};
  try {
    const doc = JSON.parse((await kv.get(USER_AVATARS_KEY)) || "null");
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch (e) { return {}; }
}

// Copies, never in-place mutation: roster entries are the very objects instance.json
// produced, so stamping `avatar` onto them would outlive the overlay — a photo removed
// from KV would keep serving until the next config reload replaced `CONFIG_USERS`.
//
// Returns the stamped users AND the hashes it stamped, together, for the same reason
// applySpaceIcons does: the Set is what the ungated /__avatar/ route checks before it
// reads KV, so it belongs to the workspace whose roster produced it. Assigning it to a
// module binding gave the whole isolate whichever workspace loaded config last — its own
// photos then 404 for everyone else, and, where two workspaces share a KV namespace, a
// neighbour's photo serves at this workspace's URL to anyone who knows the hash.
function applyAvatars(users, index) {
  const keys = new Set();
  const out = (users || []).map((u) => {
    const rec = index && index[lcEmail(u.email)];
    const k = rec && typeof rec.k === "string" ? rec.k : null;
    if (!k) return u;
    keys.add(k);
    return { ...u, avatar: "/__avatar/" + AVATAR_KV_PREFIX + k };
  });
  return { USERS: out, AVATAR_KEYS: keys };
}

// Validate a posted photo: the declared mime must be one we serve, the payload must
// decode, and its magic bytes must match the label. Returns the decoded bytes, or null.
function parseAvatarDataUri(s) {
  if (typeof s !== "string" || s.length > AVATAR_MAX_CHARS) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m) return null;
  let bin;
  try { bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch (e) { return null; }
  if (bin.length < 16 || !AVATAR_MIMES[m[1]](bin)) return null;
  return { mime: m[1], bytes: bin };
}

async function avatarHash(dataUri) {
  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(dataUri));
  return toHex(digest).slice(0, 24);
}

// Drop someone's photo from the index. Blobs are deliberately left behind: two people
// may share a hash, and an orphan is a few KB — the same trade the bundle store makes.
async function clearAvatar(tctx, env, email) {
  const kv = kvFor(env, tctx);
  if (!kv) return false;
  const index = await readAvatars(env, tctx);
  const key = lcEmail(email);
  if (!index[key]) return false;
  delete index[key];
  await kv.put(USER_AVATARS_KEY, JSON.stringify(index));
  await mirrorRosterDocs(tctx, env, { avatars: index });
  return true;
}

// POST /__me/avatar {avatar: "data:image/jpeg;base64,…"} — set MY photo.
// DELETE /__me/avatar — drop it (falling back to a config-baked seed, or initials).
// Signed-in users only, and only ever their own row: there is no email parameter.
//
// NOTE: nothing in the shell calls DELETE any more — the account settings modal
// deliberately ships no "remove photo" affordance. The route stays live and tested
// on purpose (a later UI, or a script, still needs it); it is not dead code.
//
// `tenantId` is carried for the roster overlay's cache — see spaceIconApi.
// ---- The instance-wide image switch -----------------------------------------------
//
// `userImages: false` in deploy.config.json turns OFF every route that accepts user
// supplied image BYTES: profile photos (/__me/avatar) and canvas images (/__asset).
//
// WHY IT IS AN INSTANCE SWITCH AND NOT A ROLE RULE. The exposure it exists for is one
// workspace: the public demo, whose password is printed on its own login page and shared
// by strangers who have agreed to nothing. The risk there is not abuse of our data, it is
// our domain hosting somebody else's illegal image at a stable URL under our name. But
// "viewers cannot have a face" would be plainly wrong on a private instance, where a
// viewer is an invited stakeholder looking at their own project. So the axis is the
// INSTANCE, not the role.
//
// It also closes an asymmetry that had nothing to do with roles. /__asset already refused
// viewers; /__me/avatar checked only that you were signed in, so anyone who could read the
// password off the demo's login page could store a raster and get a stable, ungated
// /__avatar/<hash> back. Keying the switch on the instance means a future role change
// cannot silently reopen either path.
//
// IT REFUSES OUT LOUD. A silent no-op on an upload is the worst version of this: the
// person sees their photo, reloads, and it is gone, with nothing saying why. 403 plus a
// reason the UI can render.
const IMAGES_OFF = Object.freeze({
  error: "images-disabled",
  reason: "This workspace does not accept uploaded images.",
});
function imagesDisabledRefusal(tctx) {
  return tctx && tctx.USER_IMAGES === false ? jsonResponse(IMAGES_OFF, 403) : null;
}

async function meAvatarApi(tenantId, request, env, me, tctx) {
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  // POST only: clearing a photo must keep working on an instance that has switched
  // uploads off, or somebody who set one before the switch can never take it down.
  if (request.method === "POST") {
    const off = imagesDisabledRefusal(tctx);
    if (off) return off;
  }
  const kv = kvFor(env, tctx);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);

  if (request.method === "DELETE") {
    await clearAvatar(tctx, env, me.email);
    // This workspace re-reads next request; other isolates within ROSTER_TTL_MS.
    bustRosterOverlay(tenantId); cfgAt = 0;
    return jsonResponse({ ok: true, avatar: null });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const parsed = parseAvatarDataUri(body && body.avatar);
    if (!parsed) return jsonResponse({ error: "bad-image" }, 400);
    const k = await avatarHash(body.avatar);
    // Blob first: an index entry pointing at a missing blob would serve a broken face,
    // whereas a blob no index names is just an orphan.
    await kv.put(AVATAR_BLOB_PREFIX + k, body.avatar);
    const index = await readAvatars(env, tctx);
    index[lcEmail(me.email)] = { k, mime: parsed.mime, at: new Date().toISOString() };
    await kv.put(USER_AVATARS_KEY, JSON.stringify(index));
    await mirrorRosterDocs(tctx, env, { avatars: index });
    bustRosterOverlay(tenantId); cfgAt = 0;
    return jsonResponse({ ok: true, avatar: "/__avatar/" + AVATAR_KV_PREFIX + k });
  }

  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// GET /__me/workspaces — the cross-workspace switcher's dropdown data
// (`B-cross-workspace-signin`). Signed-in users only, and always the CALLER'S OWN
// email — there is no email parameter, the same rule /__me/name and /__me/avatar
// follow. Proxies `POST ${ACCOUNT_ORIGIN}/__account/workspaces` (the control plane's
// enumeration guard: it answers with only the workspaces that email actually belongs
// to) using THIS workspace's own accountKey, the same bearer `/__enter` and
// `noteMembershipUpstream` authenticate with.
//
// Best-effort and inert like both of those: no accountKey, no ACCOUNT_ORIGIN, or the
// account store erroring/throwing/answering something malformed all fall through to
// `{workspaces: []}` rather than an error — a deployment that has not wired central
// sign-in must never have this route betray the seam, and the dropdown simply degrades
// to showing the current workspace only.
//
// Task 11 adds `href` per row: `${ACCOUNT_ORIGIN}/enter?workspace=<id>` (the control
// plane's own entry point, Task 9 — not this workspace's `/__enter`, which REDEEMS a
// hand-off rather than starting one) for every NON-current row. The current row gets
// no href — it names where you already are, not a link to click. Built here, not on
// the client, because only the SERVER knows `ACCOUNT_ORIGIN`; the chrome must not.
async function meWorkspacesApi(tctx, request, env, me) {
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  if (request.method !== "GET") return jsonResponse({ error: "method-not-allowed" }, 405);
  const origin = tctx.ACCOUNT_ORIGIN;
  const key = origin ? await tenantAccountKey(tctx.tenantId, env) : null;
  if (!key || !origin) return jsonResponse({ workspaces: [] });
  let list = [];
  try {
    const res = await fetch(`${origin}/__account/workspaces`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: me.email }),
    });
    if (res.ok) {
      const body = await res.json();
      if (body && Array.isArray(body.workspaces)) list = body.workspaces;
    }
  } catch (e) { /* best-effort: the account store's own failure must never surface here */ }
  const workspaces = list
    .filter((w) => w && typeof w.workspace === "string" && w.workspace)
    .map((w) => {
      const current = w.workspace === tctx.tenantId;
      const row = {
        workspace: w.workspace,
        label: typeof w.label === "string" && w.label ? w.label : w.workspace,
        current,
      };
      if (!current) row.href = `${origin}/enter?workspace=${encodeURIComponent(w.workspace)}`;
      return row;
    });
  return jsonResponse({ workspaces });
}

// Serve a self-set photo. The index-backed AVATAR_KEYS check comes FIRST so an ungated
// route can't be turned into a KV read amplifier by anyone typing hashes at it. It is
// asked of the CALLING workspace's context, so a hash is only ever served by the
// workspace whose index vouches for it — same rule as serveSpaceIcon.
async function serveKvAvatar(tctx, env, k) {
  if (!tctx.AVATAR_KEYS.has(k)) return new Response("Not found", { status: 404 });
  const kv = kvFor(env, tctx);
  const raw = kv ? await kv.get(AVATAR_BLOB_PREFIX + k) : null;
  const parsed = raw && parseAvatarDataUri(raw);
  if (!parsed) return new Response("Not found", { status: 404 });
  return new Response(parsed.bytes, {
    headers: {
      "Content-Type": parsed.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// An admin can invite, but not flood: the overlay is one KV document, read on every
// config refresh. Config rosters are unaffected by this ceiling.
const ROSTER_ADD_MAX = 500;
const isEmailish = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
// "ada.lovelace@example.org" → "Ada Lovelace". Only a default; the admin can type one.
function nameFromEmail(email) {
  return String(email).split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || String(email);
}
function initialsFor(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
// Stable per address, so an invitee's chip colour never changes under them.
const ROSTER_COLORS = Object.freeze(["#4f46e5", "#0e7490", "#b45309", "#be123c", "#15803d", "#7c3aed", "#0369a1", "#a21caf"]);
function colorFor(email) {
  let h = 0;
  const s = lcEmail(email);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ROSTER_COLORS[h % ROSTER_COLORS.length];
}

// A stable, one-way id for a person, used to attribute comments to a face without
// putting an address in KV or on the wire. Deliberately NOT avatarKey(): that hashes
// email + photo length so a changed photo yields a fresh immutable URL, which would
// orphan every past comment. This is a display-resolution key, never a credential.
function personId(email) {
  const s = lcEmail(email);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Revoke a credential: write the TOMBSTONE, never delete the key. effectiveSecret falls
// back to the config roster's legacy `pass` only when the key is ABSENT, so deleting
// here would put an old password back in service. A present-but-null entry reads as
// "no secret", which identify() refuses — that is what ends the session.
async function revokeSecret(env, email, tctx) {
  const kv = kvFor(env);
  if (!kv) throw new Error("no-kv-binding");
  const raw = await kv.get(USER_SECRETS_KEY);
  const ov = raw ? JSON.parse(raw) : {};
  ov[email] = null;
  await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
  // ⚠️ AND THE SESSION KEY, or this reset stops ending sessions the day SESSION_KEYS is
  // turned on. A stored key WINS over the credential in sessionBinding, so a tombstone
  // alone would leave every cookie this person holds still verifying. The tombstone is
  // still what identify() refuses on — this is the belt beside that brace.
  await clearSessionKey(env, email, tctx);
}

// Drop every outstanding invite for one address (mintInvite does this for the address it
// is issuing; removal needs it without minting anything).
async function revokeInvitesFor(tctx, env, email) {
  // Both stores, for consume's reason: a revocation that missed one would leave the link
  // live on the fallback, which is the opposite of what a removal is for.
  //
  // ⚠️ A FAILURE HERE THROWS AND IS NOT SWALLOWED. Removal writes the `users:secrets`
  // tombstone first, and redeeming an invite calls `setUserSecret`, which REPLACES a
  // tombstone with a working credential — so an outstanding link that survives a removal is
  // a way back in for the person who was just removed. The KV half has always failed loudly
  // for the same reason (its `put` propagates); the object half must too, or the object
  // being the read would make a caught error into a live link.
  const ident = identityFor(env, tctx, "invites");
  if (ident) await ident.inviteRevoke(email);
  const kv = kvFor(env, tctx);
  if (!kv) return;
  const map = await readInvites(kv);
  let hit = false;
  for (const [tok, rec] of Object.entries(map)) {
    if (rec && lcEmail(rec.email) === lcEmail(email)) { delete map[tok]; hit = true; }
  }
  if (hit) await kv.put(USER_INVITES_KEY, JSON.stringify(map));
}

// Publish tokens minted by `augur login` are labelled with the user's email and never
// expire. Removing or resetting a user must drop theirs, or a departed teammate keeps
// write access to the live content store. Best-effort (a KV blip just leaves the token).
//
// ⚠️ BOTH STORES, for `revokeInvitesFor`'s reason: the read comes from the object and KV is
// the fallback, so a revocation that dropped only one of them would leave the credential
// live on the other the moment anything flipped. Each half is attempted independently —
// one store being unreachable must not stop the other being cleaned.
async function revokePublishTokens(tctx, env, email) {
  try {
    const ident = identityFor(env, tctx, "publishTokens");
    if (ident) await ident.tokenRevoke({ label: email });
  } catch (e) {}
  const kv = kvFor(env, tctx);
  if (!kv) return;
  try {
    const raw = await kv.get(PUBLISH_TOKENS_KEY);
    if (!raw) return;
    const map = JSON.parse(raw);
    let hit = false;
    for (const h in map) {
      if (map[h] && lcEmail(map[h].label) === lcEmail(email)) { delete map[h]; hit = true; }
    }
    if (hit) await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
  } catch (e) {}
}

// ---- Login throttle ---------------------------------------------------------
// Best-effort brute-force + enumeration brake on the two credential endpoints
// (/__auth and /__publish/_login/token). KV has no atomic increment, so this is a
// soft counter, not a hard lock — enough to turn an online dictionary run into a
// non-starter and to blunt the timing/enumeration oracle's throughput. Keyed on both
// the email and the caller IP so neither a single target nor a single source runs free.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
// How long an attempt against a hammered EMAIL is held before it is answered. A brake,
// not a lockout — see loginSlowed.
const LOGIN_SLOW_MS = 1500;
const RL_IP_PREFIX = "rl:login:ip:";
const RL_EM_PREFIX = "rl:login:em:";
function loginRlIds(request, email) {
  const ip = (request.headers.get("CF-Connecting-IP") || "").trim();
  const ids = [];
  if (email) ids.push(RL_EM_PREFIX + lcEmail(email));
  if (ip) ids.push(RL_IP_PREFIX + ip);
  return ids;
}
async function overCeiling(env, ids) {
  const kv = kvFor(env);
  if (!kv || !ids.length) return false;
  const now = Date.now();
  for (const id of ids) {
    try {
      const rec = JSON.parse((await kv.get(id)) || "null");
      if (rec && rec.until > now && rec.n >= LOGIN_MAX_FAILS) return true;
    } catch (e) {}
  }
  return false;
}
// HARD BLOCK, on the IP counter only: one source hammering the gate is never legitimate.
async function loginThrottled(env, ids) {
  return overCeiling(env, ids.filter((id) => id.startsWith(RL_IP_PREFIX)));
}
// SLOW DOWN, on the email counter. Hard-blocking this one handed ANYONE an
// account-lockout button: ten wrong guesses at a known address barred that person from
// every IP for fifteen minutes, renewably — and the gate already tells a stranger which
// addresses exist (the reset notice). A delay still turns a distributed dictionary run
// against one address into a non-starter, on top of the 600k-iteration derivation every
// attempt already pays, without letting an attacker deny a teammate their own account.
async function loginSlowed(env, ids) {
  return overCeiling(env, ids.filter((id) => id.startsWith(RL_EM_PREFIX)));
}
async function loginFail(env, ids) {
  const kv = kvFor(env);
  if (!kv || !ids.length) return;
  const now = Date.now();
  await Promise.all(ids.map(async (id) => {
    try {
      const rec = JSON.parse((await kv.get(id)) || "null");
      const n = (rec && rec.until > now ? rec.n : 0) + 1;
      await kv.put(id, JSON.stringify({ n, until: now + LOGIN_WINDOW_MS }),
        { expirationTtl: Math.ceil(LOGIN_WINDOW_MS / 1000) + 60 });
    } catch (e) {}
  }));
}
// A fixed, valid pbkdf2 string verified when NO user matches, so an unknown email pays
// the same single PBKDF2 pass as a real one — closing the timing oracle that enumerated
// the roster. STATIC (not computed per isolate): a lazy hashPassword() here meant a cold
// isolate did the dummy hash AND the verify — two full-cost passes in one request — which
// blew the Worker CPU budget and 500'd every unknown-email login. Its bytes are
// meaningless; only that verifyPassword runs one derivation against it matters.
// Its iteration count must track PBKDF2_ITERATIONS (a test asserts it), so that the
// unknown-email path costs exactly what the real one does — that IS the timing defence.
const DUMMY_HASH = "pbkdf2$100000$5aALUzhjxbNTCTcgJHalAQ==$Wgd6/GtQGV9mmS44yPIBL52yDryksKrR7piP+96LYW0=";

// ---- Identity helpers -------------------------------------------------------
// `users` is REQUIRED. It used to default to the module roster, and that default is
// exactly what a cross-workspace answer would have hidden: a call site that forgot to
// say which workspace it was resolving for still got an answer, and in a single-tenant
// era that answer was always right. Without the default the same omission is a
// TypeError on the first request instead.
function userByEmail(email, users) {
  const e = String(email == null ? "" : email).trim().toLowerCase();
  return users.find((u) => u.email.toLowerCase() === e) || null;
}
// A roster user by one of their OTHER addresses (`emails`: the git-attribution aliases a
// person accumulates, and their previous primary after a swap). Deliberately not folded
// into userByEmail: sign-in and invites resolve a primary address, and an alias is an
// attribution fact, not a credential — only the publish-token holder check consults it.
function userByAliasEmail(email, users) {
  const e = String(email == null ? "" : email).trim().toLowerCase();
  if (!e) return null;
  return users.find((u) => Array.isArray(u.emails) && u.emails.some((a) => String(a || "").toLowerCase() === e)) || null;
}

// Safe-to-expose view of a user — never includes the password.
// initials/color use the EXACT same fallbacks as peopleApi below — the two must
// agree. The client seeds its people cache from /__me (loadMe() sets PEOPLE[ME.id])
// and then deliberately never re-fetches its own id via /__people (loadPeople()
// skips ids already in PEOPLE), so a roster user configured without initials/color
// (only admin-panel invites populate them) would otherwise see "?" on default
// indigo for their OWN pin/hover-card/reply-bar all session, while every other
// viewer — who resolves that same person through /__people — sees the derived
// initials and colour. See initialsFor/colorFor above.
function publicUser(u) {
  return u ? {
    id: personId(u.email),
    email: u.email, name: u.name,
    initials: u.initials || initialsFor(u.name || nameFromEmail(u.email)),
    color: u.color || colorFor(u.email),
    avatar: avatarUrl(u), admin: roleOf(u) === "admin", role: roleOf(u),
  } : null;
}

// GET /__people?ids=a,b&names=Ana,Ben — resolve comment authors to a face.
//
// Answers ONLY what it is asked for. There is deliberately no "list everyone" mode:
// the overlay is embedded in PUBLIC prototypes, so an enumerable roster here would
// hand the team list to anyone with a prototype link. Ids are one-way hashes, so they
// cannot be reversed to an address or guessed from one. `names` exists for comments
// written before messages carried `by`; stampAuthor guarantees a verified message's
// name belongs to a real account, so an exact-name lookup is safe for those.
//
// Ungated for the same reason /__avatar/ is: a gated fetch from a public prototype
// would return the login page instead of the data.
const PEOPLE_LOOKUP_MAX = 50;
function peopleApi(url, users) {
  const csv = (k) => (url.searchParams.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = csv("ids"), names = csv("names");
  if (ids.length + names.length > PEOPLE_LOOKUP_MAX) {
    return jsonResponse({ error: "too-many" }, 400);
  }
  const wantId = new Set(ids), wantName = new Set(names);
  const people = users
    .filter((u) => wantId.has(personId(u.email)) || wantName.has(u.name))
    .map((u) => ({
      id: personId(u.email),
      name: u.name,
      initials: u.initials || initialsFor(u.name || nameFromEmail(u.email)),
      color: u.color || colorFor(u.email),
      avatar: avatarUrl(u),
    }));
  return jsonResponse({ people }, 200, {
    // Long enough to spare a fetch per navigation, short enough that an admin-panel
    // photo swap lands within the minute.
    "Cache-Control": "private, max-age=60",
  });
}

// A data-URI avatar in the user list is SERVED at a stable /__avatar/ URL rather than
// inlined everywhere: the canvas multiplayer join carries the URL to peers, and inline
// data: images in overlay UI are a known trap. The key hashes email + content length, so
// a changed photo changes the URL and immutable caching stays safe.
function avatarKey(u) {
  const s = u.email + ":" + u.avatar.length;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function avatarUrl(u) {
  if (!u || !u.avatar) return null;
  return u.avatar.startsWith("data:") ? "/__avatar/" + avatarKey(u) : u.avatar;
}

// Effective secret = admin-set KV override ?? the roster value. One kv.get.
// The value is a `pbkdf2$…` hash string. A non-hash value (a hand-written plaintext
// `pass`) still RESOLVES here — so the account reads as active rather than pending —
// but verifyPassword rejects it, so the account cannot be logged into at all.
async function effectiveSecret(env, u) {
  if (!u) return "";
  const kv = kvFor(env);
  // NO KV BINDING AT ALL — offline and raw engine builds have no KV and legitimately
  // depend on the roster being the whole story. Not a failure, so not fail-closed.
  if (!kv) return u.passHash || u.pass || "";
  let ov;
  try {
    const raw = await kv.get(USER_SECRETS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // A value that isn't a map is corrupt, not empty — same treatment as a bad read.
    // Array.isArray is NOT redundant: typeof [] === "object", so an array sails
    // through the typeof check, hasOwnProperty then misses every email and EVERY
    // user falls through to their roster password at once — the exact fail-open
    // this guard exists to prevent.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    ov = parsed;
  } catch (e) {
    // KV IS bound but the read or the parse failed. FAIL CLOSED. Falling through to
    // the roster here would make every revocation tombstone evaporate simultaneously
    // on one transient KV blip and put every leaked roster password back in service.
    // No secret means no login and no session — recoverable; a resurrected credential
    // is not.
    return "";
  }
  // A key PRESENT in the override map is authoritative even when its value is
  // falsy: an admin "reset" revokes by writing {email: null}/{email: ""} over
  // the entry, and that must yield "" (no secret at all) — never fall through
  // to the roster password, which for a revoked user is exactly the leaked
  // password the reset exists to invalidate. Only an ABSENT key falls back.
  if (Object.prototype.hasOwnProperty.call(ov, u.email)) return ov[u.email] || "";
  return u.passHash || u.pass || "";
}

// ---- The session binding, which used to be the same value as the credential ----------
//
// ⚠️ READ THIS BEFORE CHANGING ANYTHING BELOW IT.
//
// `effectiveSecret` above does TWO jobs, and until this seam existed they were the same
// value:
//
//   1. THE AUTHENTICATOR — what `verifyPassword` checks a typed password against. Three
//      call sites, all on a login path.
//   2. THE SESSION BINDING — what `userToken` HMACs, so that changing or clearing a
//      credential invalidates that person's cookies "for free".
//
// Job 2 is the one nobody notices until it is gone. Any passwordless design removes the
// hash, and with it the value the cookie was bound to — after which the obvious fix, binding
// to the address alone, collapses `userToken` to the publicly computable
// `tokenFor("<email>:")`. That is precisely the forgery the guard in identify() exists to
// stop. So the two jobs get separated FIRST, while passwords still exist and the change can
// be proved to do nothing.
//
// ⚠️ WITH SESSION_KEYS OFF — every instance today — THIS RETURNS THE AUTHENTICATOR AND
// READS NOTHING. Not "behaves similarly": the same value, no extra KV read, no new failure
// surface. That is what makes this landable without a flag day.
//
// ⚠️ IT FAILS CLOSED, and it has to, for the same reason effectiveSecret does. An empty
// return here is refused by identify(); anything else would let a transient KV error
// collapse the derivation. "No binding" must mean "no session", never "bind to nothing".
//
// ⚠️ A STORED KEY WINS OVER THE AUTHENTICATOR, so once one exists, changing the password
// no longer ends that person's sessions by itself. That is not a regression as long as
// every credential change ALSO rotates the key — which is why `clearSessionKey` is called
// beside every write to users:secrets, and why a test asserts a reset still ends a session.
const SESSION_KEYS_KEY = "users:sessionkeys";

async function readSessionKeys(kv) {
  try {
    const raw = await kv.get(SESSION_KEYS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // Same shape guard, same reason as effectiveSecret: an array passes `typeof === object`
    // and would then miss every address, silently sending everyone to the fallback at once.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null; // the caller turns this into a refusal, never into a fallback
  }
}

async function sessionBinding(env, u, authenticator, enabled, tctx) {
  if (!u) return "";
  // OFF: today's derivation exactly, and no read.
  if (!enabled) return authenticator;
  const kv = kvFor(env, tctx);
  // No binding at all is the offline/raw-build case, as it is for effectiveSecret: there
  // is no store to hold a key, so the authenticator is the whole story. Not a failure.
  if (!kv) return authenticator;
  const keys = await readSessionKeys(kv);
  if (keys === null) return ""; // bound but unreadable — FAIL CLOSED
  // Present-and-falsy is a revocation, exactly as in users:secrets: "signed out
  // everywhere, and not yet signed back in" must not fall through to the credential.
  if (Object.prototype.hasOwnProperty.call(keys, u.email)) return keys[u.email] || "";
  return authenticator;
}

/**
 * End every session this person holds, without touching their credential.
 *
 * This is the verb the split buys. Today a session ends only as a side effect of the
 * credential hash changing, which means enrolling a device, redeeming a recovery link and
 * "sign me out everywhere" all end nothing. Writing a fresh key here ends all of them.
 *
 * Best-effort by design: it is called beside credential writes that have already
 * succeeded, and a failure to rotate must not undo one. It says so rather than throwing.
 */
async function rotateSessionKey(env, email, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv || !email) return { ok: false, why: "no store" };
  const keys = (await readSessionKeys(kv)) || {};
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  keys[email] = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  // The success verdict carries the key just written. A caller issuing a cookie on the
  // spot (invite redemption) binds to THIS value rather than re-reading the store — a
  // read-after-write through KV can answer with the previous map for up to a minute of
  // edge cache, and a cookie minted on the stale key dies on its very first request.
  try { await kv.put(SESSION_KEYS_KEY, JSON.stringify(keys)); return { ok: true, key: keys[email] }; }
  catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 120) }; }
}

/**
 * Forget this person's session key, so their binding falls back to their credential again.
 *
 * Called beside every write to users:secrets. With a key stored, a credential change would
 * otherwise leave old cookies working — the one regression this seam could introduce.
 * Clearing rather than rotating is deliberate: the credential just changed, so the
 * authenticator it falls back to is already a value nobody's old cookie was built on.
 */
async function clearSessionKey(env, email, tctx) {
  const kv = kvFor(env, tctx);
  if (!kv || !email) return;
  try {
    const keys = await readSessionKeys(kv);
    if (!keys || !Object.prototype.hasOwnProperty.call(keys, email)) return;
    delete keys[email];
    await kv.put(SESSION_KEYS_KEY, JSON.stringify(keys));
  } catch (e) { /* see rotateSessionKey: this must never undo a credential write */ }
}

// ---- The first-run surface ---------------------------------------------------
// The landing destination after invite redemption, before any workspace content — shown
// ONCE per person, ever. THE DELIVERABLE IS THE SLOT, NOT THE COPY: the routing here is
// meant to outlive every rewrite of the page, so the words live in FIRST_RUN_COPY and
// nothing below reads them.
//
// THE RECORD IS THE WORKSPACE'S, NEVER THE BROWSER'S. "Already seen" is a map in the
// workspace's own store (`users:firstrun`, segmented per workspace like every identity
// document), so a second device, a fresh cookie jar and a sign-out-and-back-in all agree
// about it. A cookie would forget on the first new device, the page would show again,
// and everyone would learn to click past it — the exact failure once-only exists to avoid.
//
// IT FAILS TOWARD "/" IN EVERY DEGRADED CASE — flag off, no store, unreadable store,
// failed write. Two reasons, in order: this surface must never cost anybody a sign-in,
// and once-only is the property that matters, so nothing is SHOWN that could not first be
// RECORDED. Shown-but-unrecorded re-shows on the next device; recorded-but-unshown costs
// one placeholder page nobody has read yet. The write therefore lands before the
// redirect is issued, the same rotate-before-consume ordering redemption already uses.
const FIRST_RUN_KEY = "users:firstrun"; // KV {email: ISO stamp of the first landing}
const FIRST_RUN_PATH = "/__welcome";

async function readFirstRunSeen(kv) {
  try {
    const raw = await kv.get(FIRST_RUN_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // Same shape guard as readSessionKeys: an array passes `typeof === "object"` and
    // would then miss every address at once.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null; // the caller lands on "/" — never re-show, never block
  }
}

/**
 * Where a just-completed redemption lands: FIRST_RUN_PATH the first time ever for this
 * person, "/" every time after — and "/" in every case where the answer is uncertain.
 *
 * ⚠️ CALL THIS ONLY AFTER THE REDEMPTION HAS SUCCEEDED. It writes the once-only record,
 * and a landing computed before the consume would mark a person seen on a redemption
 * that then refused.
 */
async function firstRunLanding(tctx, env, email) {
  if (!tctx || !tctx.FIRST_RUN || !email) return "/";
  const kv = kvFor(env, tctx);
  if (!kv) return "/";
  const seen = await readFirstRunSeen(kv);
  if (seen === null) return "/"; // bound but unreadable — do not risk a second showing
  // Case-insensitive, like every other address comparison here: a roster entry whose
  // case changed must not make the same person "new" again.
  const addr = lcEmail(email);
  if (Object.keys(seen).some((k) => lcEmail(k) === addr)) return "/";
  seen[email] = new Date().toISOString();
  try { await kv.put(FIRST_RUN_KEY, JSON.stringify(seen)); } catch (e) { return "/"; }
  return FIRST_RUN_PATH;
}

/**
 * Forget one address's first-run record, case-insensitively.
 *
 * Called when a person is REMOVED (a re-invited address is a new person to the
 * workspace, so they get the surface again — the reason clearRole and clearName run
 * there) and by purgeUser (the map keys an ADDRESS, so an erasure must take it).
 * Best-effort, like clearSessionKey: it runs beside acts that already succeeded.
 */
async function clearFirstRunSeen(kv, email) {
  const addr = lcEmail(email);
  if (!kv || !addr) return;
  try {
    const seen = await readFirstRunSeen(kv);
    if (!seen) return;
    const hits = Object.keys(seen).filter((k) => lcEmail(k) === addr);
    if (!hits.length) return;
    for (const k of hits) delete seen[k];
    await kv.put(FIRST_RUN_KEY, JSON.stringify(seen));
  } catch (e) { /* the removal or erasure beside this already took effect */ }
}

// ---- Invite / reset tokens ---------------------------------------------------
// One mechanism serves account setup and password recovery — they differ only in
// wording. A token is single-use (consumed when a password is set), expires on its
// own, and minting a new one for a user drops any outstanding token for that user.

async function readInvites(kv) {
  try {
    const raw = kv ? await kv.get(USER_INVITES_KEY) : null;
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === "object" ? map : {};
  } catch (e) {
    return {};
  }
}

// Drop expired entries on every write — the map stays small without a sweeper.
function pruneInvites(map, nowMs) {
  const out = {};
  for (const [tok, rec] of Object.entries(map)) {
    if (rec && typeof rec.expires === "number" && rec.expires > nowMs) out[tok] = rec;
  }
  return out;
}

// ⚠️ WRITES GO TO BOTH STORES WHILE `KV_CUTOVER.invites` IS ON. See that constant: the
// object is where the read comes from, and KV is what makes flipping the word back a
// revert instead of a data loss. A KV blip does not fail the mint once the object has it —
// the link the admin is handed already works.
async function mintInvite(tctx, env, email, nowMs = Date.now()) {
  const kv = kvFor(env, tctx);
  const ident = identityFor(env, tctx, "invites");
  if (!kv && !ident) throw new Error("no-kv-binding");
  const token = toB64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (ident) {
    // The object drops this address's outstanding invites itself — same rule, one act,
    // and no read-modify-write for two concurrent mints to lose each other in.
    await ident.inviteMint({
      tokenHash: await inviteHash(token),
      email: lcEmail(email),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + INVITE_TTL_MS).toISOString(),
    }, nowMs);
  }
  if (kv) {
    try {
      const map = pruneInvites(await readInvites(kv), nowMs);
      // Issuing invalidates this user's outstanding links, so there is never more than one.
      // Case-insensitive, like every other email match — an exact compare let a reset (which
      // mints under the roster's canonical case) miss an invite minted under the lowercased
      // address, leaving two live links for one person.
      for (const [tok, rec] of Object.entries(map)) if (rec && lcEmail(rec.email) === lcEmail(email)) delete map[tok];
      map[token] = { email, expires: nowMs + INVITE_TTL_MS };
      await kv.put(USER_INVITES_KEY, JSON.stringify(map));
    } catch (e) {
      if (!ident) throw e;
    }
  }
  return token;
}

// The object first, KV as the fallback — and the fallback is not tidiness. A link minted
// before the reads moved, or one the copy did not carry, exists only in KV; asking the
// object alone would answer "no longer valid" to somebody holding a live invitation, and
// nothing would say so.
//
// ⚠️ AN UNREADABLE STORE IS A REFUSAL, AND THE KV FALLBACK IS NOT REACHED. The two "the
// object had nothing" cases look identical from here and are not: an ANSWER of "no such
// invite" is a fact, and an ERROR is an absence of one. Falling through on the second would
// make a broken workspace store fail OPEN onto KV — the exact shape the item warns about,
// where the obvious fix is the one that admits people. `/__invite` is a session ISSUER, so
// the cost of being wrong the other way is somebody clicking again in five minutes.
async function readInvite(tctx, env, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token) return null;
  const ident = identityFor(env, tctx, "invites");
  if (ident) {
    let email;
    try { email = await ident.inviteRead(await inviteHash(token), nowMs); }
    catch (e) { return null; }
    if (email) return email;
  }
  const kv = kvFor(env, tctx);
  if (!kv) return null;
  const rec = (await readInvites(kv))[token];
  if (!rec || typeof rec.expires !== "number" || rec.expires <= nowMs) return null;
  return rec.email;
}

// Single-get consume: resolves and deletes the token from the SAME read of the
// map, instead of one kv.get to check it (readInvite) and a second to delete it.
// That two-read shape widened the window for two concurrent redemptions to both
// pass the check before either write landed, double-consuming one token.
// KV has no compare-and-swap, so even this narrows the race rather than closing
// it — two concurrent consumeInvite calls can still both read before either
// writes. Accepted: an attacker racing a redemption must already hold the token,
// so double-redemption grants no access they didn't already have; the last write
// wins and the user ends up with one password, same as a plain double-submit.
//
// ⚠️ BOTH STORES ARE BURNED, whichever answered. A consume that only deleted the row it
// resolved would leave the other copy live, and the second click would then be answered by
// the fallback — a single-use link used twice, which is the one thing this function is for.
// The object's answer wins the RETURN and the KV delete runs regardless.
async function consumeInvite(tctx, env, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token) return null;
  const ident = identityFor(env, tctx, "invites");
  const kv = kvFor(env, tctx);
  let email = null;
  if (ident) {
    // On the object this is ONE act: single-threaded storage means the read and the delete
    // cannot interleave, so the second of two concurrent redemptions gets null rather than
    // the same address. KV could only ever narrow that window — see the note above.
    //
    // An ERROR refuses outright and never reaches KV, for readInvite's reason: burning a
    // link out of the fallback while the store that was supposed to burn it is unreachable
    // would leave the object's row live and the link redeemable a second time.
    try { email = await ident.inviteConsume(await inviteHash(token), nowMs); }
    catch (e) { return null; }
  }
  if (kv) {
    try {
      const map = pruneInvites(await readInvites(kv), nowMs);
      const rec = map[token];
      if (rec && typeof rec.expires === "number" && rec.expires > nowMs) {
        if (!email) email = rec.email;
        delete map[token];
        await kv.put(USER_INVITES_KEY, JSON.stringify(map));
      }
    } catch (e) {
      if (!ident) throw e;
    }
  }
  return email;
}

const MIN_PASSWORD_LENGTH = 10;

// Shown when a roster user has no effective secret — reset, or never redeemed. Kept as
// one string so the web gate and the CLI say the same thing.
const RESET_NOTICE = "This account was reset. Ask for a new invite link — your old password no longer exists.";

async function setUserSecret(env, email, hash, tctx) {
  const kv = kvFor(env);
  if (!kv) throw new Error("no-kv-binding");
  const raw = await kv.get(USER_SECRETS_KEY);
  const ov = raw ? JSON.parse(raw) : {};
  ov[email] = hash;
  await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
  // Same reason as revokeSecret: with a key stored, changing the credential would not end
  // the old sessions by itself. Clearing rather than rotating is deliberate — the
  // credential just changed, so the value the binding falls back to is already one no old
  // cookie was built on.
  await clearSessionKey(env, email, tctx);
}

// The engine's own mark — the fallback brand on the front-door pages, and the mark the
// in-product 404 always wears (that page sits next to the rail, which is Augur's).
const AUGUR_MARK_SVG = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Augur">
        <g transform="translate(153.5 153.5) scale(1.115)" fill="#2C2150" fill-rule="evenodd"><path d="M303.668 0.501099C480.9 -9.31876 632.543 126.378 642.396 303.609C652.249 480.839 516.579 632.508 339.35 642.392C162.076 652.279 10.36 516.567 0.504883 339.291C-9.34912 162.015 126.39 10.3241 303.668 0.501099ZM321.31 58.589C313.993 78.2949 309.682 91.0001 300.003 110.42C256.894 196.544 185.761 265.436 98.3008 305.765C84.5568 312.054 73.3451 316.365 59.0391 321.205C166.492 358.562 254.54 437.345 303.567 540.001C306.201 545.441 320.11 580.712 320.888 581.447C329.254 559.649 338.869 536.27 350.55 515.916C397.544 434.024 469.471 370.244 555.57 331.86C563.577 328.29 574.85 323.736 583.145 321.47C472.786 278.754 383.1 203.746 334.938 93.8761C332.878 89.1732 321.885 59.2127 321.31 58.589Z"/></g>
      </svg>`;

// The mark on the front-door pages (the gate and the invite form). A deployment's front
// door wears the DEPLOYMENT's brand, not the engine's, and specifically the SAME icon the
// rail's space switcher shows a signed-in member — so the mark that greets you signed out
// is the one you already know. That is the admin-set workspace icon when one exists
// (`SPACES[].icon` = `/__space-icon/<hash>`, stamped by applySpaceIcons from the same KV
// override the switcher reads), falling back to the baked `/space-icon.png` seed. build.js
// copies that seed from the DEFAULT space's repo root, or the engine's own mark when the
// space ships none — so a hosted workspace with no repo-baked icon and no override still
// wears the engine mark, and setting an icon in Settings is what gives it its own face
// here with no deploy. No default space at all keeps the engine's SVG mark. Clipped to a
// circle by CSS so a square icon still reads as a front-door avatar.
// ⚠️ Both `/space-icon.png` and `/__space-icon/<hash>` are ungated (isPublicPath / the
// pre-gate serveSpaceIcon route): these pages are for signed-out visitors, so a gated icon
// would fetch the login HTML into the <img>.
function brandMark(tctx) {
  const def = tctx.SPACES.find((s) => s.default);
  if (!def) return AUGUR_MARK_SVG;
  return `<img src="${def.icon || "/space-icon.png"}" alt="" width="40" height="40" />`;
}

// The engine's own one-line description, taken from the public repo's summary. The
// default space's space.json "description" replaces it per instance (build.js carries
// the field on the space entry, so it rides routing.json and published manifests alike).
const ENGINE_TAGLINE = "Real, clickable prototypes and the design system they are built from, on one site with login, comments and live boards on top.";

// <head> block for the gate: the <title> plus the meta an unfurl bot reads (a link
// bookmark, a chat card). A gated instance's only public HTML is the gate,
// so this IS the instance's link preview: the default space's name and description,
// and the same public workspace icon brandMark() wears — the admin-set /__space-icon
// override when there is one, else the baked /space-icon.png — so an icon changed from
// the admin panel updates the unfurl with no deploy. requestUrl
// makes og:url/og:image absolute (unfurl bots require absolute image URLs); callers
// without one simply get no og:url/og:image. robots stays noindex in the pages that
// carry this: unfurlers read the meta regardless, search engines stay out.
function previewHead(tctx, requestUrl) {
  const def = tctx.SPACES.find((s) => s.default);
  const name = (def && typeof def.name === "string" ? def.name : "").trim();
  const desc = (def && typeof def.description === "string" ? def.description : "").trim() || ENGINE_TAGLINE;
  let page = null;
  try { page = new URL(requestUrl); } catch {}
  const iconHref = def ? (def.icon || "/space-icon.png") : null;
  const lines = [
    `<title>${escapeHtml(name ? `${name} · Augur` : "Augur")}</title>`,
    `<meta name="description" content="${escapeHtml(desc)}" />`,
  ];
  if (def) lines.push(`<link rel="icon" href="${escapeHtml(iconHref)}" />`);
  lines.push(
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Augur" />`,
    `<meta property="og:title" content="${escapeHtml(name || "Augur")}" />`,
    `<meta property="og:description" content="${escapeHtml(desc)}" />`,
  );
  if (page) {
    lines.push(`<meta property="og:url" content="${escapeHtml(page.origin + page.pathname)}" />`);
    if (def) lines.push(`<meta property="og:image" content="${escapeHtml(page.origin + iconHref)}" />`);
  }
  lines.push(
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(name || "Augur")}" />`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
  );
  return lines.join("\n  ");
}

// GET /__invite?t=… — the redemption page. Deliberately says nothing about whether
// the token is valid beyond "this link is no longer valid": no user enumeration.
//
// TWO MODES, decided by the deployment's SESSION_KEYS flag, never by the request.
// Off (the default): the set-password form this page has always been. On: redeeming
// establishes a session directly and no password exists at any point, so the form is a
// single Continue button. In BOTH modes the GET only shows the page and the POST is what
// redeems — that is load-bearing, not ceremony: corporate mail scanners follow links
// with a GET, so a GET that consumed the token would burn every scanned invite unread,
// and a GET that signed in would establish sessions inside the scanner's sandbox.
function invitePage(tctx, token, error, email, passwordless = false) {
  const t = escapeHtml(token || "");
  const em = escapeHtml(email || "");
  // Text only — the .error block below supplies the icon and wrapper, matching loginPage.
  const msg = error ? escapeHtml(error) : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${passwordless ? "You're invited" : "Set your password"} — Augur</title>
  <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <style>
    /* Self-hosted Inter — KEEP IN SYNC with loginPage(); no external font request. */
    @font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/fonts/inter-latin-wght-normal.woff2") format("woff2"); }
    /* KEEP IN SYNC with loginPage() — same tokens, same card, same mark. A user meets
       this page and the gate back to back, so any drift between them reads as a
       phishing page rather than a redesign. */
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
    .logo svg, .logo img { width: 40px; height: 40px; display: block; }
    .logo img { border-radius: 8px; object-fit: cover; }
    h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.015em; margin: 0 0 6px; }
    h1 + form { margin-top: 20px; }
    /* Live length hint. Reserves its own line so the card doesn't jump as it changes,
       and goes quiet the moment the password is long enough. */
    .hint { font-size: 12.5px; color: var(--faint); margin: 7px 0 0; min-height: 1.2em; }
    .hint[data-ok="1"] { color: var(--muted); }
    button[disabled] { opacity: .45; cursor: not-allowed; }
    button[disabled]:hover { background: var(--accent-solid); }
    label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 7px; }
    input[type=password] {
      width: 100%; font: inherit; font-size: 15px; padding: 8px 13px; border-radius: 9px;
      border: 1px solid var(--line-2); background: #fff; color: var(--fg);
      transition: border-color .12s ease;
    }
    input[type=password]:hover { border-color: rgba(16,17,26,0.28); }
    input[type=password]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
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
      color: var(--err); font-size: 13.5px; font-weight: 500; margin: 0 0 16px;
    }
    .error svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
    @media (max-width: 420px) { .card { padding: 26px 22px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">
      ${brandMark(tctx)}
    </div>
    <h1>${passwordless ? "You&rsquo;re invited" : "Set your password"}</h1>
    <p class="error" role="alert">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      <span>${msg}</span>
    </p>
    ${passwordless ? (t ? `<form method="POST" action="/__invite">
      <input type="hidden" name="token" value="${t}" />
      ${em ? `<label for="acct-email">You are signing in as</label>
      <input id="acct-email" type="email" value="${em}" readonly aria-readonly="true" tabindex="-1"
             style="width:100%; font:inherit; font-size:15px; padding:8px 13px; border-radius:9px;
                    border:1px solid var(--line-2); margin-bottom:16px; background:#f4f4f6;
                    color:#5b626e; cursor:default;" />` : ""}
      <p class="hint" style="margin:0">One click and you&rsquo;re in — no password to set.</p>
      <button type="submit" autofocus>Continue</button>
    </form>` : "") : `<form method="POST" action="/__invite">
      <input type="hidden" name="token" value="${t}" />
      ${em ? `<label for="acct-email">You are setting the password for</label>
      <input id="acct-email" type="email" value="${em}" readonly aria-readonly="true" tabindex="-1"
             style="width:100%; font:inherit; font-size:15px; padding:8px 13px; border-radius:9px;
                    border:1px solid var(--line-2); margin-bottom:16px; background:#f4f4f6;
                    color:#5b626e; cursor:default;" />` : ""}
      <label for="password">New password</label>
      <input id="password" name="password" type="password" autocomplete="new-password"
             minlength="${MIN_PASSWORD_LENGTH}" required autofocus
             aria-describedby="pw-hint" ${error ? 'aria-invalid="true"' : ""} />
      <p class="hint" id="pw-hint" aria-live="polite">${MIN_PASSWORD_LENGTH} characters minimum</p>
      <button type="submit" disabled>Set password</button>
    </form>`}
  </main>
  ${passwordless ? "" : `<script>
    // Live length check. The server enforces the same minimum (a disabled button is a
    // convenience, not a control), and minlength="" already covers the no-JS case —
    // this just tells you where you are while typing instead of after submitting.
    (function () {
      var MIN = ${MIN_PASSWORD_LENGTH};
      var pw = document.getElementById("password");
      var hint = document.getElementById("pw-hint");
      var btn = document.querySelector("button[type=submit]");
      if (!pw || !hint || !btn) return;
      function sync() {
        var n = pw.value.length;
        var ok = n >= MIN;
        btn.disabled = !ok;
        hint.dataset.ok = ok ? "1" : "0";
        hint.textContent = ok
          ? "Long enough."
          : n === 0
            ? MIN + " characters minimum"
            : (MIN - n) + (MIN - n === 1 ? " more character" : " more characters");
      }
      pw.addEventListener("input", sync);
      sync();
    })();
  </script>`}
</body></html>`;
}

// ⚠️ THE FIRST-RUN COPY LIVES HERE AND ONLY HERE. Iterating on what the page says means
// editing these strings — the flag, the route and the once-only record neither read them
// nor care. The content is DELIBERATELY PLACEHOLDER and the page says so out loud, so
// nobody mistakes the slot for the welcome it will eventually hold.
const FIRST_RUN_COPY = Object.freeze({
  badge: "Placeholder",
  title: "Welcome",
  intro: "You&rsquo;re in — your account is set up, and everything here is yours to explore.",
  placeholder: "This first-run page is a placeholder: the real welcome hasn&rsquo;t been written yet. It appears once, right after your invite is redeemed, and you won&rsquo;t see it again.",
  cta: "Continue",
});

// GET FIRST_RUN_PATH — the first-run surface. Same card, same tokens, same mark as
// loginPage and invitePage: a person meets the gate, the redemption page and this one
// back to back, so drift between them reads as a phishing page rather than a redesign.
function firstRunPage(tctx) {
  const C = FIRST_RUN_COPY;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${C.title} — Augur</title>
  <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <style>
    /* Self-hosted Inter — KEEP IN SYNC with loginPage(); no external font request. */
    @font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/fonts/inter-latin-wght-normal.woff2") format("woff2"); }
    /* KEEP IN SYNC with loginPage() / invitePage() — same tokens, same card. */
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
      padding: 30px 30px 28px; max-width: 360px; width: 100%;
      box-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 10px 28px -22px rgba(16,24,40,0.22);
    }
    .logo { display: flex; justify-content: center; margin: 4px 0 24px; }
    .logo svg, .logo img { width: 40px; height: 40px; display: block; }
    .logo img { border-radius: 8px; object-fit: cover; }
    /* The placeholder badge: text, never colour alone, so the page's provisional nature
       survives every rendering. */
    .badge {
      display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted); border: 1px dashed var(--line-2);
      border-radius: 999px; padding: 2px 9px; margin: 0 0 12px;
    }
    h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.015em; margin: 0 0 6px; }
    p { font-size: 13.5px; color: var(--muted); margin: 0 0 10px; }
    p.placeholder { color: var(--faint); font-style: italic; }
    a.cta {
      display: block; text-align: center; margin-top: 16px; font: inherit; font-weight: 600;
      font-size: 15px; color: #fff; background: var(--accent-solid); text-decoration: none;
      border: 1px solid transparent; border-radius: 9px; padding: 8px; cursor: pointer;
      transition: background .12s ease;
    }
    a.cta:hover { background: #38295e; }
    a.cta:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 420px) { .card { padding: 26px 22px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">
      ${brandMark(tctx)}
    </div>
    <span class="badge">${C.badge}</span>
    <h1>${C.title}</h1>
    <p>${C.intro}</p>
    <p class="placeholder">${C.placeholder}</p>
    <a class="cta" href="/" autofocus>${C.cta}</a>
  </main>
</body></html>`;
}

async function inviteGet(tctx, url, env) {
  const token = url.searchParams.get("t") || "";
  const email = await readInvite(tctx, env, token);
  if (!email) return htmlResponse(invitePage(tctx, "", "This link is no longer valid. Ask for a new one.", undefined, tctx.SESSION_KEYS), 400);
  // Show WHOSE account this link admits — a wrong recipient sees an address that isn't
  // theirs and stops, and no one can quietly claim a different identity (it's read-only).
  return htmlResponse(invitePage(tctx, token, "", email, tctx.SESSION_KEYS), 200);
}

// Redeeming an invite WITH SESSION_KEYS ON: the link ends in a session, not in "set a
// password". No credential is created, read or prompted for at any point — the session
// binds to a fresh per-person session key (the seam `sessionBinding` provides), which is
// what stops the removal of the password from collapsing the cookie derivation to the
// publicly computable tokenFor("<email>:").
//
// Every refusal here is the SAME page with the SAME words as an expired link — a caller
// cannot tell "already used" from "expired", on purpose (no oracle on someone else's link).
async function inviteRedeemSession(tctx, token, env, users) {
  const invalid = () => htmlResponse(invitePage(tctx, "", "This link is no longer valid. Ask for a new one.", undefined, true), 400);
  const email = await readInvite(tctx, env, token);
  if (!email) return invalid();
  const u = userByEmail(email, users);
  if (!u) return invalid();
  // Rotate BEFORE consuming, for the reason the password path hashes before consuming:
  // the token is the only way back in, so nothing that can fail may run after it is
  // burned. The rotate is the step that talks to the store; if it fails, the link
  // survives and re-clicking works the moment the cause is fixed. A rotate left behind
  // by a consume that then refuses ends no session anybody holds — this person's secret
  // was revoked when the link was minted.
  const rot = await rotateSessionKey(env, u.email, tctx);
  if (!rot.ok || !rot.key) {
    console.error("invite: rotateSessionKey failed", rot.why || "");
    return htmlResponse(invitePage(tctx, token, "Something went wrong signing you in. Try again.", email, true), 500);
  }
  const consumed = await consumeInvite(tctx, env, token);
  if (!consumed) return invalid();
  // Bind to the key JUST WRITTEN, never to a re-read: a read-after-write through KV can
  // answer with the previous map for up to a minute of edge cache, and a cookie minted
  // on the stale value dies on its very first request — with nothing saying why.
  const token2 = await userToken(env, u, rot.key, true, tctx);
  // Where a SUCCESSFUL redemption lands. After the consume on purpose: the landing
  // records the once-only first-run showing, and a refused redemption must record
  // nothing. "/" whenever the first-run flag is off or the surface has been seen.
  const landing = await firstRunLanding(tctx, env, u.email);
  return new Response(null, {
    status: 303,
    headers: {
      Location: landing,
      "Set-Cookie": `${USER_COOKIE}=${u.email}.${token2}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
      "Cache-Control": "no-store",
    },
  });
}

async function invitePost(tctx, request, url, env, users = tctx.USERS) {
  const form = await request.formData();
  const token = (form.get("token") || "").toString();
  // The deployment's flag decides where redemption lands, never anything in the request:
  // with SESSION_KEYS on the POST establishes a session directly and any submitted
  // password field is ignored unread. With it off — every deployment that has not opted
  // in — everything below this line is byte-for-byte the behaviour that predates the flag.
  if (tctx.SESSION_KEYS) return inviteRedeemSession(tctx, token, env, users);
  const password = (form.get("password") || "").toString();

  // Validate the password BEFORE consuming the token, so a typo doesn't burn the link.
  const email = await readInvite(tctx, env, token);
  if (!email) return htmlResponse(invitePage(tctx, "", "This link is no longer valid. Ask for a new one."), 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return htmlResponse(invitePage(tctx, token, `Use at least ${MIN_PASSWORD_LENGTH} characters.`, email), 400);
  }
  const u = userByEmail(email, users);
  if (!u) return htmlResponse(invitePage(tctx, "", "This link is no longer valid. Ask for a new one."), 400);

  // Hash BEFORE consuming, for the same reason the length check comes first: the token is
  // the only way back in, so nothing that can fail may run after it is burned. Hashing is
  // the step most likely to fail (it is the one that talks to WebCrypto), and when it did,
  // consume-then-hash turned a broken deploy into ten permanently dead links — the retry
  // the error message asks for hit "no longer valid" instead. The link now survives it,
  // so re-clicking works the moment the cause is fixed.
  let hash;
  try {
    hash = await hashPassword(password);
  } catch (e) {
    console.error("invite: hashPassword failed", e && e.stack || e);
    return htmlResponse(invitePage(tctx, token, "Something went wrong setting your password. Try again.", email), 500);
  }

  const consumed = await consumeInvite(tctx, env, token);
  if (!consumed) return htmlResponse(invitePage(tctx, "", "This link is no longer valid. Ask for a new one."), 400);

  // From here on the token is already burned — a thrown error must not escape as
  // an unhandled exception (dead link, no explanation) but fail cleanly instead.
  try {
    await setUserSecret(env, u.email, hash, tctx);
    // ⚠️ THE FLAG MUST REACH EVERY ISSUER. A cookie minted without it binds to the
    // credential while identify() checks against the session key, and the person is
    // signed out on their very next request — with nothing saying why.
    const token2 = await userToken(env, u, undefined, tctx.SESSION_KEYS, tctx);
    // Same landing decision as inviteRedeemSession, for the same reason and in the same
    // place: after the redemption has succeeded, never before.
    const landing = await firstRunLanding(tctx, env, u.email);
    return new Response(null, {
      status: 303,
      headers: {
        Location: landing,
        "Set-Cookie": `${USER_COOKIE}=${u.email}.${token2}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("invite: setUserSecret failed", e && e.stack || e);
    return htmlResponse(invitePage(tctx, "", "Something went wrong setting your password. Ask for a new link."), 500);
  }
}

// GET /__enter?handoff=<token> — the cross-workspace switcher's landing point
// (`B-cross-workspace-signin`). The control plane proves WHO: it hands over an email it
// has already authenticated itself, redeemed from a one-time hand-off it minted. This
// workspace decides WHAT: whether that email is on ITS OWN roster. A hand-off is never
// sufficient by itself — a valid hand-off for an email this workspace does not carry gets
// the exact same answer a stranger with no hand-off at all gets, `unknownHostResponse()`.
// No membership oracle: every non-success below is that one response, byte-identical, so
// nobody can learn "that email exists, just not here" from the reply.
//
// Matches the control plane's own spelling of the path.
const WORKSPACE_ENTER_PATH = "/__enter";

async function enterHandoff(tctx, request, url, env) {
  // No key delivered yet (or no TENANTS binding at all) → this route is inert on this
  // deployment. The refusal is the same one a stranger gets everywhere else on this path,
  // so a probe here learns nothing about whether central sign-in is even wired up.
  const key = await tenantAccountKey(tctx.tenantId, env);
  if (!key) return unknownHostResponse();
  const handoff = url.searchParams.get("handoff") || "";
  if (!handoff) return unknownHostResponse();
  // Unset → inert, same refusal as no key: a deployment that names no central sign-in
  // origin cannot reach one, and answering differently from "no key" would tell a caller
  // WHICH half of the wiring is missing.
  const origin = tctx.ACCOUNT_ORIGIN;
  if (!origin) return unknownHostResponse();
  let email = "";
  try {
    const res = await fetch(`${origin}/__account/handoff`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: handoff }),
    });
    // Non-200 (expired, already redeemed, unknown token, the account store refusing this
    // workspace's bearer) is the same refusal as every other failure on this path — a
    // caller must not learn which kind of "no" it got.
    if (res.ok) {
      const body = await res.json();
      if (body && typeof body.email === "string" && body.email) email = body.email;
    }
  } catch (e) { /* a network error to the account store is a "no" like any other */ }
  if (!email) return unknownHostResponse();
  // THE membership check, and the whole point of this route. The control plane proved
  // WHO; this workspace's OWN roster decides WHAT. A non-member is byte-identical to a
  // stranger — there is no answer here that distinguishes "that email exists elsewhere"
  // from "no such email at all".
  const u = userByEmail(email, tctx.USERS);
  if (!u) return unknownHostResponse();
  // From here `u` is a PROVEN member, and the hand-off is already spent — the account
  // store redeemed it inside the POST above, unlike an invite link (which THIS workspace
  // consumes, and only after rotating). So a rotate failure below cannot un-spend
  // anything; it is a member hitting an internal hiccup, never a stranger's probe, and it
  // must say so rather than answering the same silent 404 a stranger gets. Re-clicking
  // the switcher mints a fresh hand-off, because their account-side session is untouched.
  const rot = await rotateSessionKey(env, u.email, tctx);
  if (!rot.ok || !rot.key) {
    console.error("__enter: rotateSessionKey failed", rot.why || "");
    return new Response("Something went wrong signing you in. Try again.\n", {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  }
  // Mint the session exactly as inviteRedeemSession does: bind to the key JUST WRITTEN,
  // never a re-read — a read-after-write through KV can answer stale for up to a minute
  // of edge cache, and a cookie minted on that value would die on its first request.
  const token2 = await userToken(env, u, rot.key, true, tctx);
  const landing = await firstRunLanding(tctx, env, u.email);
  return new Response(null, {
    status: 303,
    headers: {
      Location: landing,
      "Set-Cookie": `${USER_COOKIE}=${u.email}.${token2}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
      "Cache-Control": "no-store",
    },
  });
}

// ── The space's own passwordless login (`B-passwordless-space-sign-in`) ──────────────
//
// A hosted space renders `loginPage` in passwordless mode ("Sign in with email") whenever it
// has a central account store (ACCOUNT_ORIGIN). These two POSTs run the whole flow FROM the
// space, in the space's skin: the send side asks the control plane to mail a code + link for
// THIS workspace over this workspace's own account-store bearer, and the code side verifies it
// and bounces the browser to `/enter-by-code`, which opens the account session and hands off
// back here. Both are inert (fall through to the ordinary gate) when the store or the key is
// missing — the same "no central store" degradation `/__enter` has.
const SIGNIN_FROM_SPACE_PATH = "/__signin";
const SIGNIN_CODE_PATH = "/__signin/code";

/** POST /__signin {email} — mail a code + link for this workspace, render the code screen. */
async function signinFromSpace(tctx, request, env) {
  const form = await request.formData();
  const email = (form.get("email") || "").toString();
  const key = await tenantAccountKey(tctx.tenantId, env);
  const origin = tctx.ACCOUNT_ORIGIN;
  if (key && origin) {
    // Neutral and fire-and-report: the code screen renders whatever the control plane says, so
    // nothing here tells the visitor whether the address is a member. A dead control plane
    // costs the mail, not the screen.
    try {
      await fetch(`${origin}/__account/signin-link`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch (e) { /* the code screen still renders; the person just gets no mail */ }
  }
  return htmlResponse(loginPage(tctx, "/", false, request.url, { code: true, email }), 200);
}

/** POST /__signin/code {email, code} — verify the code, bounce to /enter-by-code on success. */
async function signinCodeSubmit(tctx, request, env) {
  const form = await request.formData();
  const email = (form.get("email") || "").toString();
  const code = (form.get("code") || "").toString();
  const key = await tenantAccountKey(tctx.tenantId, env);
  const origin = tctx.ACCOUNT_ORIGIN;
  if (key && origin) {
    try {
      const res = await fetch(`${origin}/__account/verify-code`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.ok && body.ticket) {
          return new Response(null, {
            status: 303,
            headers: {
              Location: `${origin}/enter-by-code?ticket=${encodeURIComponent(body.ticket)}`,
              "Cache-Control": "no-store",
            },
          });
        }
      }
    } catch (e) { /* fall through to the error re-render */ }
  }
  return htmlResponse(loginPage(tctx, "/", true, request.url, { code: true, email }), 401);
}

// Session cookie token: HMAC-SHA-256(SESSION_SECRET, "email:effectiveSecret").
// SESSION_SECRET is a runtime env var — NEVER baked into the bundle — so a cookie
// cannot be forged from repo-visible data. Binding to the effective secret means
// changing or clearing a password invalidates that user's cookies for free.
// `resolved` is an OPTIONAL pre-resolved effective secret. identify() passes the one
// value it guarded on so the guard and the derivation cannot disagree; every other
// caller omits it and this resolves its own, unchanged.
/**
 * ⚠️ `resolved` IS THE SESSION BINDING, not the credential.
 *
 * With SESSION_KEYS off the two are the same value and this is unchanged in every respect.
 * With it on, the binding is a per-person key and the credential is not part of the
 * derivation at all — which is the point of the split, and the reason this parameter's
 * meaning is stated here rather than inferred from the one call site that passes it.
 *
 * The resolve-once discipline is unchanged and still load-bearing: identify() resolves the
 * binding ONCE and hands it here. Re-resolving inside this function would not be atomic
 * with identify()'s guard — a truthy first read passing the guard and an empty second read
 * reaching this line collapses the derivation to a publicly computable digest.
 */
async function userToken(env, u, resolved, enabled, tctx) {
  const secret = resolved === undefined
    ? await sessionBinding(env, u, await effectiveSecret(env, u), enabled, tctx)
    : resolved;
  const sessionSecret = env && env.SESSION_SECRET;
  if (sessionSecret) return hmacToken(sessionSecret, u.email + ":" + secret);
  return tokenFor(u.email + ":" + secret);
}

// The value of one named cookie out of a Cookie header, or null when it is absent.
// First match wins, as it always has.
function cookieValue(cookies, name) {
  const c = cookies.split(/;\s*/).find((x) => x.startsWith(name + "="));
  return c === undefined ? null : c.slice(name.length + 1);
}

// Resolve the signed-in user from the session cookie ("<email>.<token>"). Stateless —
// no session store.
//
// ⚠️ `users` is REQUIRED — the roster of the workspace this request is for. It used to
// default to the module roster, and of every default dropped in this sweep this is the
// one that mattered: "which people may this cookie name" IS the auth boundary, so a
// caller that omitted the workspace would, the day an isolate serves two, resolve a
// cookie against a NEIGHBOUR's roster — matching a stranger's admin by address. No
// default means such a caller cannot exist.
async function identify(request, env, users, { sessionKeys = false, tctx } = {}) {
  if (!users.length) return null;
  const cookies = request.headers.get("Cookie") || "";
  // ⏳ MIGRATION WINDOW — the current name first, then each older name in turn, so a
  // session that predates a rename keeps working and a re-login upgrades it in place.
  // Order is the whole point: an older name is consulted only when the current one is
  // ABSENT, so a cookie tossed under a legacy name can never shadow a live session.
  // Delete the second half of this expression with LEGACY_USER_COOKIES.
  let val = cookieValue(cookies, USER_COOKIE);
  for (const name of LEGACY_USER_COOKIES) {
    if (val !== null) break;
    val = cookieValue(cookies, name);
  }
  if (val === null) return null;
  const dot = val.lastIndexOf(".");
  if (dot < 1) return null;
  const u = userByEmail(val.slice(0, dot), users);
  if (!u) return null;
  // A user with no effective secret (pending invite, or just reset) can have no valid
  // session. Without this guard userToken's own no-SESSION_SECRET fallback reduces to
  // a publicly computable SHA-256("gv:<email>:"), letting anyone who knows an email
  // forge a cookie for that account. NOT a migration path — this must survive the
  // finish step. It signs no legitimate user out: the only two issuers of this cookie
  // are /__auth, which requires a truthy secret, and invitePost, which issues only
  // after writing the hash. (/__publish/_login/token mints a publish token, not a
  // session — it never sets a cookie.)
  //
  // Resolved ONCE and passed down. Two independent reads (guard, userToken) are not
  // atomic: a truthy first read passes the guard while a later read returns "" —
  // mid-request reset, or KV's own eventual consistency — and the derivation then
  // reduces to the publicly computable tokenFor("<email>:"), accepting a forged cookie
  // the guard was there to stop. Binding the guarded value to the derived value also
  // cuts 2 KV reads per cookie-bearing request to one.
  const secret = await effectiveSecret(env, u);
  // ⚠️ WITH SESSION_KEYS OFF THIS CREDENTIAL GUARD IS THE GUARD, unchanged in every
  // respect: no effective secret ⇒ no session, before any derivation. With it ON the
  // guard moves to the BINDING below — and that is not a weakening, it is the same
  // invariant asked of the right value. A person signed in by invite link holds no
  // credential at all; what their cookie is bound to is their stored session key, and
  // `sessionBinding` fails closed exactly as `effectiveSecret` does: no stored key falls
  // back to the (empty) credential and is refused, an unreadable store is refused, a
  // present-and-falsy entry is a revocation and is refused. In NO combination does an
  // empty value reach the derivation — that is the forgery-stopping invariant, and it
  // must survive any future refactor in both modes.
  if (!sessionKeys && !secret) return null;
  // THE SECOND RESOLVE, and it is a DIFFERENT value rather than a re-read of the first.
  // The guard above is on the credential — "no effective secret ⇒ no session" — and this
  // one is on what the cookie is actually bound to. Both are resolved exactly once and
  // both must be truthy: a binding that could not be read is a refusal, never a fallback,
  // because an empty binding reduces the derivation below to a publicly computable digest.
  // With SESSION_KEYS off this returns `secret` itself and costs nothing.
  const binding = await sessionBinding(env, u, secret, sessionKeys, tctx);
  if (!binding) return null;
  const token = val.slice(dot + 1);
  if (safeEqual(token, await userToken(env, u, binding, sessionKeys, tctx))) return u;
  return null;
}

// Record when a signed-in user was last seen ("last connection" in the admin list).
// Fired only from /__me (one call per page view, the profile chip's fetch) and from a
// successful login — never from asset requests. Throttled: while the stored stamp is
// fresh (<15 min) a browsing burst costs one KV read and zero writes (KV allows ~1
// write/sec/key). Fire-and-forget via ctx.waitUntil; telemetry must never break a
// request, hence the blanket catch.
//
// ⚠️ ON THE OBJECT THE THROTTLE IS THE OBJECT'S, AND THAT IS WHAT MAKES THE MIRROR FREE.
// KV needs a get and then a put, with a race between them; the object answers "did it
// write" in one call. So when the object decides, the KV copy is written from ITS verdict
// and never re-read — a browsing burst costs zero KV gets rather than one per page view,
// and the mirror stays within the same fifteen minutes it always was. The mirror is what
// makes flipping `KV_CUTOVER.lastseen` back a revert; see that constant.
async function touchLastSeen(tctx, env, u) {
  try {
    if (!u) return;
    const kv = kvFor(env, tctx);
    const ident = identityFor(env, tctx, "lastseen");
    if (ident) {
      let out = null;
      try { out = await ident.lastseenTouch(u.email); } catch (e) { /* telemetry, never a failure */ }
      if (out) {
        if (out.wrote && kv) await kv.put(LASTSEEN_PREFIX + u.email, out.at);
        return;
      }
    }
    if (!kv) return;
    const key = LASTSEEN_PREFIX + u.email;
    const prev = await kv.get(key);
    if (prev && Date.now() - Date.parse(prev) < 15 * 60 * 1000) return;
    await kv.put(key, new Date().toISOString());
  } catch (e) {}
}

// ---- KV access: the binding, or a REST shim to the REAL (prod) namespace --------
// "Offline-live" mode: offline.mjs serves LOCAL assets (your working-tree prototypes)
// but injects GV_KV_TOKEN/_ACCOUNT/_NS so the overlay data (comments/pins/status/
// renames/etc.) reads & writes the PRODUCTION KV — the shared live-overlay layer.
// (wrangler's remote KV bindings 500 on every op, so we go straight to the KV REST
// API.) Active ONLY when GV_KV_TOKEN is present; in prod it's unset → the normal
// env.COMMENTS binding is returned and nothing changes. The shim mirrors the subset of
// the KV API the worker uses: get / put / list.
//
// ⚠️ `tctx` IS THE SECOND ARGUMENT AND IT IS OPTIONAL. Passing it asks for THIS
// WORKSPACE's view of the namespace — see `identityKvView`, which segments the identity
// documents and leaves every other key exactly where it was. Omitting it returns the raw
// namespace, which is what every non-identity caller wants and what this has always
// returned. On a deployment that resolves no workspace from the Host the two are the same
// object, so the argument costs nothing there.
function kvFor(env, tctx) {
  const raw = kvForRaw(env);
  return tctx === undefined ? raw : identityKvView(env, raw, tctx);
}

function kvForRaw(env) {
  if (!env || !env.GV_KV_TOKEN) return env && env.COMMENTS;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.GV_KV_ACCOUNT}/storage/kv/namespaces/${env.GV_KV_NS}`;
  const auth = { Authorization: `Bearer ${env.GV_KV_TOKEN}` };
  return {
    async get(key, opts) {
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, { headers: auth });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`REST KV get ${r.status}`);
      return opts && opts.type === "arrayBuffer" ? await r.arrayBuffer() : await r.text();
    },
    // binding-compatible getWithMetadata — the REST API keeps metadata on a separate
    // endpoint, so this costs two calls (offline-only; the real binding does it in one)
    async getWithMetadata(key, opts) {
      const value = await this.get(key, opts);
      if (value === null) return { value: null, metadata: null };
      let metadata = null;
      try {
        const m = await fetch(`${base}/metadata/${encodeURIComponent(key)}`, { headers: auth });
        if (m.ok) metadata = (await m.json()).result || null;
      } catch (e) {}
      return { value, metadata };
    },
    async put(key, value, opts) {
      let init;
      if (opts && opts.metadata) {
        // metadata rides a multipart form on the REST rail (a plain body PUT drops it)
        const fd = new FormData();
        fd.append("value", value instanceof ArrayBuffer ? new Blob([value]) : value);
        fd.append("metadata", JSON.stringify(opts.metadata));
        init = { method: "PUT", headers: auth, body: fd };
      } else {
        init = { method: "PUT", headers: auth, body: value };
      }
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, init);
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

// ---- The workspace segment on an identity KV key ----------------------------
//
// `B-identity-kv-write-segmentation`. FOUND BY DOING IT, ON A LIVE WORKSPACE. The content
// half was closed by `BUNDLE_TENANCY` and the identity READS were moved to the workspace
// object by `KV_CUTOVER` — and the identity WRITES still landed in one deployment-wide KV
// document each. `augur restore --state` into a second workspace therefore overwrote the
// first one's `publish:tokens`, roster, roles, names, avatars and icons, and the first
// workspace's publish token started answering 403 with nothing at all having gone wrong
// with it. Any ordinary rename, role change or token mint did the same thing more quietly,
// and a nightly reset that CLEARS those families cleared them for every workspace at once.
//
// THE ASYMMETRY NAMED THE FIX. `board:<workspace>:<path>` already carried the workspace
// (src/board-key.mjs); these did not. So they take the same treatment, in the same shape
// the bundle store took: a segment on the key, applied on the way in and stripped on the
// way out, with the deployment's own shape deciding whether there is a segment at all.
//
// ⚠️ WHY THIS IS THE WHOLE LIST AND NOT A SUBSET OF IT. `src/state-inventory.mjs` is the
// authority on what belongs to one workspace, and its `to: "workspace"` entries are the
// set that must not be deployment-wide. Most of them are ALREADY not: `statuses`, `names`,
// `canvases`, `pins`, `c:`, `board:`, `pt:*` and `basset-meta:` all go through
// `overlayFor`, which on a deployment holding a `TENANTS` binding is the workspace's own
// Durable Object and never touches KV at all. What is left is exactly the families below —
// the ones reached through a raw namespace handle rather than through the overlay — and
// they are enumerated here rather than derived, because a family that grows a KV write
// later must be added on purpose. `test/identity-kv-tenancy.test.mjs` asserts this list
// against the inventory in both directions, so an inventory entry with no home here fails.
//
// ⛔ `users:secrets` IS NOT HERE AND MUST NOT BE. A credential is account-level — one
// address, one password, several workspaces — and it is `to: "account"` in the inventory
// for that reason. It moves with `B-cross-workspace-signin`, never with this.
//
// ⛔ `rl:*`, `freeze`, `marks`, `pair:`, `rebake:sent:`, `engine:update-check` and
// `health:report` are NOT here either, and they are `to: "drop"`: instance-global or
// transient. Segmenting a rate-limit counter would give every workspace its own allowance
// of somebody else's failed logins, and segmenting the freeze would make a deployment-wide
// pause invisible to all but one workspace.
const IDENTITY_TENANT_PREFIX = "t/";

// The KV documents each family owns. A name ending in `:` is a PREFIX (one document per
// address or per hash); everything else is one document. Longest match wins, so
// `users:roster` and `users:roles` cannot be confused with each other.
const IDENTITY_KV_FAMILIES = Object.freeze({
  // The four documents the roster pipeline reads as one. They move together because
  // `mergeRoster`/`applyRoles`/`applyNames`/`applyAvatars` is one pipeline and a workspace
  // holding three of the four is a workspace whose gate disagrees with its own admin list.
  roster: Object.freeze(["users:roster", "users:roles", "users:names", "users:avatars"]),
  // A role per address PER SPACE. Inventoried `to: "drop"` and still written by the admin
  // membership route, so it is segmented rather than left shared: dropping it is
  // `A-retire-space-tier`'s to do, and until then a shared copy hands one workspace's
  // membership decisions to another.
  spaces: Object.freeze(["users:spaces"]),
  invites: Object.freeze(["users:invites"]),
  lastseen: Object.freeze(["users:lastseen:"]),
  // The one whose sharing was a live cross-workspace credential: a `*`-scope token minted
  // anywhere authenticated at every hostname on the deployment.
  publishTokens: Object.freeze(["publish:tokens"]),
  // ⚠️ THE BLOBS ARE SEGMENTED AND THE R2 ONES ARE NOT, AND THAT IS NOT AN INCONSISTENCY.
  // `blobs/<sha256>` in R2 is left shared because the digest is verified against the key,
  // so a workspace can only write bytes that hash to the name it used. These two are the
  // same in that respect — and different in one that decides it: a RESET clears them by
  // PREFIX (`kv.list({prefix: "avatar:"})`, which is what the demo's nightly job runs), so
  // one workspace's housekeeping would delete every workspace's photos. A prefix sweep is
  // the destruction a content-addressed key cannot protect against.
  avatars: Object.freeze(["avatar:"]),
  icons: Object.freeze(["spaces:icons", "spaceicon:"]),
  // Per-person session-binding keys. Inert on a deployment that has not turned
  // `SESSION_KEYS` on — `sessionBinding` reads nothing at all there.
  sessionkeys: Object.freeze(["users:sessionkeys"]),
  // The once-per-person first-run record. Segmented for the same reason lastseen is: a
  // person joining a SECOND workspace is new to that one, and one workspace's welcome
  // must not mark them seen in another.
  firstrun: Object.freeze([FIRST_RUN_KEY]),
  // Addresses a provider told us to stop mailing. `to: "workspace"` in the inventory, and
  // it is a promise not to mail somebody again rather than a cache.
  mail: Object.freeze(["mail:suppressed"]),
});

// Which families take the segment. One word each, and flipping one back is the revert for
// that family alone — the shape `KV_CUTOVER` and `BUNDLE_TENANCY` both use, for the reason
// all three share: the reads for several of these families already answer from the
// workspace object, so a write that changes shape without a revert path is a login gate
// nobody can put back.
const IDENTITY_TENANCY = Object.freeze({
  roster: true,
  spaces: true,
  invites: true,
  lastseen: true,
  publishTokens: true,
  avatars: true,
  icons: true,
  sessionkeys: true,
  firstrun: true,
  mail: true,
});

/** Which identity family a KV key belongs to, or "" for a key this scheme does not name. */
function identityFamily(key) {
  const k = String(key || "");
  let best = "";
  let bestLen = -1;
  for (const [family, docs] of Object.entries(IDENTITY_KV_FAMILIES)) {
    for (const doc of docs) {
      const hit = doc.endsWith(":") ? k.startsWith(doc) : k === doc;
      if (hit && doc.length > bestLen) { best = family; bestLen = doc.length; }
    }
  }
  return best;
}

/**
 * The physical KV key for a logical one.
 *
 * `workspace` is the second argument and it DEFAULTS TO NONE, which is the whole of the
 * straddle: a deployment that serves one workspace passes nothing and gets back the string
 * it has always got back, byte for byte.
 */
function identityKey(key, workspace = "") {
  if (!workspace) return key;
  const family = identityFamily(key);
  if (!family || !IDENTITY_TENANCY[family]) return key;
  return IDENTITY_TENANT_PREFIX + workspace + "/" + key;
}

/**
 * Which workspace segment this request's identity keys carry.
 *
 * ⚠️ TIED TO `TENANT_HOST_SUFFIX`, exactly as `bundleWorkspaceSegment` is, and for the
 * same reason: that variable is the only thing that says "more than one workspace shares
 * this namespace". Unset — every self-hosted instance, and every instance running today —
 * an unsegmented key is unambiguously this deployment's one workspace's, and this returns
 * no segment at all.
 *
 * `legacyIsOurs` is the second half. An unsegmented key predates the segment, so it
 * belongs to whichever workspace this deployment served at the time — a question with an
 * answer only where a deployment serves ONE. Where the workspace comes from the Host there
 * is no read-through and there must not be one: it would hand one workspace a roster,
 * or a publish token, that may be another's. That is what makes the move a PREREQUISITE on
 * a host-resolved deployment rather than an optimisation — see `rekeyIdentityToSegment`.
 */
function identityWorkspaceSegment(env, tenantId) {
  const hostResolved = !!(env && typeof env.TENANT_HOST_SUFFIX === "string" && env.TENANT_HOST_SUFFIX.trim());
  return {
    workspace: hostResolved ? (tenantId || DEFAULT_TENANT_ID) : "",
    legacyIsOurs: !hostResolved,
  };
}

/**
 * The namespace as ONE workspace sees it: the same verbs over LOGICAL keys, with the
 * segment applied on the way in and stripped on the way out.
 *
 * ⚠️ WITH NO SEGMENT THIS IS THE BINDING ITSELF — not a wrapper around it, the object.
 * Deliberate, and the same property `bundleStore` has: with no segment this function is
 * the identity, so a deployment that never asked for a segment has no new code at all
 * between it and KV and nothing to get subtly wrong. That is the claim
 * `test/identity-kv-tenancy.test.mjs` proves by identity comparison rather than by
 * argument, and the rehearsal proves again on real workerd by counting the keys written.
 */
function identityKvView(env, kv, tctx) {
  const workspace = identityWorkspaceSegment(env, tctx && tctx.tenantId).workspace;
  if (!kv || !workspace) return kv || null;
  const seg = IDENTITY_TENANT_PREFIX + workspace + "/";
  const K = (k) => identityKey(k, workspace);
  const un = (k) => (String(k).startsWith(seg) ? String(k).slice(seg.length) : String(k));
  // ⚠️ A WRITE GOES TO THE SEGMENTED KEY AND NOWHERE ELSE — the same rule `bundleStore`
  // keeps, for the same reason. This view used to write the unsegmented key too, a straddle
  // meant to keep the per-family flag a revert rather than a rollback, and on the one kind
  // of deployment that has a segment at all it was never that: where the namespace is
  // shared an unsegmented key is unattributable, the deployment's own rule
  // (`legacyIsOurs: false`) already refuses to READ one, and a flag flipped back there
  // reads whatever was last written under the bare key by whichever workspace wrote it
  // last — the collision this scheme exists to close, not yesterday. What the second write
  // did buy was the finding: `augur restore --state` into one workspace overwrote the
  // shared namespace's bare `publish:tokens` and `users:roster` and created bare roles,
  // avatars, avatar blobs and last-seen stamps beside them — one workspace's identity
  // documents where every workspace shares.
  //
  // ⚠️ DELETES NEVER REACHED THE UNSEGMENTED KEY EITHER, and that still holds. Removing one
  // is removing a document that may be a neighbour's, and it is the whole of why a nightly
  // reset that clears `users:roster` for workspace A does not clear it for workspace B.
  // What predates the segment is left exactly where and as it was.
  return {
    get: (k, opts) => (opts === undefined ? kv.get(K(k)) : kv.get(K(k), opts)),
    getWithMetadata: (k, opts) => (opts === undefined ? kv.getWithMetadata(K(k)) : kv.getWithMetadata(K(k), opts)),
    put: (k, v, opts) => (opts === undefined ? kv.put(K(k), v) : kv.put(K(k), v, opts)),
    delete: (k) => kv.delete(K(k)),
    list: async (opts = {}) => {
      // ⚠️ A LISTING IS THE OTHER HALF OF THE PREFIX SWEEP, AND IT HAS TO BE SEGMENTED OR
      // THE SWEEP IS DEPLOYMENT-WIDE AGAIN. `kv.list({prefix: "avatar:"})` from workspace A
      // must enumerate A's photos and no one else's, so the prefix takes the segment and
      // the names come back unsegmented — which is what lets every existing caller hand a
      // returned name straight to `get` or `delete` without double-prefixing it.
      const prefix = String(opts.prefix || "");
      const family = identityFamily(prefix);
      // A prefix that names a segmented family takes the segment. Anything else — a
      // family this scheme does not name, or a bare listing of the whole namespace —
      // is left alone: it is not this view's to narrow, and narrowing it would hide
      // keys from an export that walks the namespace looking for what it holds.
      const scoped = family && IDENTITY_TENANCY[family] ? seg + prefix : prefix;
      const page = await kv.list({ ...opts, prefix: scoped });
      return { ...page, keys: (page.keys || []).map((x) => ({ ...x, name: un(x.name) })) };
    },
  };
}

// ---- Bundle store: direct-publish serving + publish API ---------------------
// Optional second asset source. When GV_ASSET_SOURCE="r2" AND the BUNDLES R2
// binding exists, assets serve from content-addressed blobs (blobs/<sha256>)
// resolved through per-space manifests (spaces/<id>/manifest.json) that
// `augur publish` commits over /__publish/* — no git relay, no site rebuild,
// and a publish is atomic: immutable blobs first, then ONE manifest PUT.
// Rollback = re-commit a prior versions/<n>.json. Site routing (public prefixes,
// version map, restricted bases, space list) is DERIVED from the live manifests
// on every config refresh — never stored, so it can't go stale or partial.
// Without the flag/binding none of this runs and assets come from Pages' ASSETS
// exactly as before. Publishing (the API below) needs only the binding, so a
// store can be seeded before serving is flipped.
const bundleMode = (env) => !!(env && env.GV_ASSET_SOURCE === "r2" && env.BUNDLES);

// ---- The workspace segment on a bundle-store key ----------------------------
//
// `B-bundle-store-tenancy`. Not one key above carries a workspace: `config/instance.json`
// is one document for the whole bucket, `spaces/<id>/…` names a SPACE, and one deployment
// serving several workspaces therefore has them all writing the same keys. Two workspaces
// publishing a space under the same id write the same object, so the commit CAS, the
// unpublish guard and the stale-base check all evaluate against a stranger's document —
// and a route-level gate cannot un-collide a key. So the key gains the segment.
//
// THE SHAPE, decided rather than discovered (`DECISION-bundle-store-tenancy.md`, option 1):
// a tenant PREFIX in the one bucket. `t/<workspace>/spaces/…`,
// `t/<workspace>/config/instance.json`, `t/<workspace>/assets/…`.
//
// ⚠️ TWO FAMILIES STAY GLOBAL AND SHARED, DELIBERATELY. Both exceptions are written out
// below rather than left to fall out of the change, because falling out of a change is
// exactly how they would be got wrong.
//
//   `blobs/<sha256>` — published bytes. Every write verifies the digest against the key
//   before storing, so a workspace can only ever write bytes that hash to the name it
//   used: an overwrite is a no-op by construction and there is nothing to poison. Dedup
//   across workspaces is load-bearing (a migration's frozen pass uploaded 0 blobs of 854
//   already present), and `blobGc` is written FOR a shared namespace — it reads every
//   remaining manifest before deleting anything, because only the sweep can tell an
//   orphan from a blob another workspace is serving. Prefixing them would break that
//   design and buy nothing: a SHA-256 is not enumerable, so the disclosure door is the
//   INDEX, not the bytes — and the index is `spaces/`, which is prefixed.
//
//   `spaces/_engine/` — the engine chrome. ONE worker build serves every workspace on a
//   deployment, so one chrome bundle is correct rather than a leak. Prefix it by accident
//   and every workspace loses its chrome on the deploy that does it.
const BUNDLE_TENANT_PREFIX = "t/";
const ENGINE_SPACE_ID = "_engine";
// Which families take the segment. One word each, and flipping one back is the revert for
// that family alone — the shape `KV_CUTOVER` uses, for the same reason: a change that has
// to be reverted as a unit is a change nobody wants to make on a live instance.
const BUNDLE_TENANCY = Object.freeze({
  spaces: true,   // spaces/<id>/manifest.json + spaces/<id>/versions/<n>.json
  config: true,   // config/instance.json
  assets: true,   // assets/<sha256[0:40]> — canvas image bytes
  // blobs: NOT HERE, AND NOT AN OMISSION. See the header above.
});

/** Which family a bundle-store key belongs to, or "" for one this scheme does not name. */
function bundleFamily(key) {
  const k = String(key || "");
  if (k.startsWith("blobs/")) return "blobs";
  if (k.startsWith("assets/")) return "assets";
  if (k.startsWith("config/")) return "config";
  if (k.startsWith("spaces/")) return "spaces";
  return "";
}

/**
 * The physical store key for a logical one.
 *
 * `workspace` is the second argument and it DEFAULTS TO NONE, which is the whole of the
 * straddle: a deployment that serves one workspace passes nothing and gets back the string
 * it has always got back, byte for byte. Only a prefixing deployment passes a segment —
 * see `bundleWorkspaceSegment`.
 */
function bundleKey(key, workspace = "") {
  if (!workspace) return key;
  const family = bundleFamily(key);
  if (!family || !BUNDLE_TENANCY[family]) return key;
  // ⚠️ THE ENGINE EXCEPTION, WRITTEN OUT. `spaces/_engine/…` is the chrome one worker
  // build serves to every workspace on this deployment. It is not this workspace's to
  // hold and it is not another's to be kept from.
  if (family === "spaces" && key.startsWith(`spaces/${ENGINE_SPACE_ID}/`)) return key;
  return BUNDLE_TENANT_PREFIX + workspace + "/" + key;
}

/**
 * Which workspace segment this request's bundle-store keys carry, and whether an
 * UNPREFIXED key in this bucket can be read as this workspace's.
 *
 * ⚠️ TIED TO `TENANT_HOST_SUFFIX`, WHICH IS THE ONLY THING THAT SAYS "MORE THAN ONE
 * WORKSPACE SHARES THIS BUCKET". Unset — every self-hosted instance, and every instance
 * running today — the deployment serves the one workspace its build named, an unprefixed
 * key is unambiguously that workspace's, and this returns no segment at all. Set, the
 * workspace is the first Host label and the bucket holds several. `wrangler-preflight.mjs`
 * refuses the halves, so a deployment with the suffix set has a `TENANTS` binding too:
 * the discriminator is one fact about the deployment, not two that could disagree.
 *
 * `legacyIsOurs` is the second half and it guards the other mistake. An unprefixed key
 * predates the segment, so it belongs to whichever workspace this deployment served at
 * the time — a question with an answer only where a deployment serves ONE. Where the
 * workspace comes from the Host header there is no read-through fallback and there must
 * not be one: it would hand one workspace content that may be another's. That is what
 * makes the migration a PREREQUISITE on a host-resolved deployment rather than an
 * optimisation — see `scripts/bundle-rekey.mjs`.
 */
function bundleWorkspaceSegment(env, tenantId) {
  const hostResolved = !!(env && typeof env.TENANT_HOST_SUFFIX === "string" && env.TENANT_HOST_SUFFIX.trim());
  return {
    workspace: hostResolved ? (tenantId || DEFAULT_TENANT_ID) : "",
    legacyIsOurs: !hostResolved,
  };
}

/**
 * The bundle store as ONE workspace sees it: the same five verbs over LOGICAL keys, with
 * the segment applied on the way in and stripped on the way out.
 *
 * ⚠️ WITH NO SEGMENT THIS IS THE BINDING ITSELF — not a wrapper around it, the object.
 * That is deliberate, and it is what makes the change additive for every instance running
 * today: with no segment this function is the identity, so there is no new code at all
 * between the worker and R2 and nothing to get subtly wrong on a deployment that never
 * asked for a segment.
 *
 * Stripping on the way out is what lets every caller keep the key it already had: a
 * listing hands back `spaces/x/versions/3.json`, and handing that straight back to `get`
 * or `delete` re-applies the segment rather than double-prefixing it.
 */
function bundleStore(env, workspace = "") {
  const r2 = env && env.BUNDLES;
  if (!r2 || !workspace) return r2 || null;
  const seg = BUNDLE_TENANT_PREFIX + workspace + "/";
  const K = (k) => bundleKey(k, workspace);
  const un = (k) => (String(k).startsWith(seg) ? String(k).slice(seg.length) : String(k));
  // ⚠️ A WRITE GOES TO THE SEGMENTED KEY AND NOWHERE ELSE. This view used to write the
  // unprefixed key too, as a straddle meant to keep the per-family flag a revert rather
  // than a rollback — and on the one kind of deployment that has a segment at all, it was
  // never that. Where the bucket is shared an unprefixed key is unattributable: the
  // deployment's own rule (`legacyIsOurs: false`) already refuses to READ one, and flipping
  // a family's flag back there reads whatever was last written under the bare key by
  // whichever workspace wrote it last — the collision this scheme exists to close, not
  // yesterday. So the second write bought no revert, and it cost a real thing: every
  // workspace's `config/instance.json` — its roster — and every manifest — its blob index,
  // the disclosure door the header above names — copied to where every workspace shares.
  // Found on a live shared deployment, attributed by content, the same second as the
  // segmented write.
  //
  // Deletes never touched the unprefixed key either, for the same reason in the other
  // direction: removing one is removing an object that may be a neighbour's. That still
  // holds, so what predates the segment is left exactly where and as it was.
  const store = {
    get: (k, opts) => (opts === undefined ? r2.get(K(k)) : r2.get(K(k), opts)),
    put: (k, v, opts) => (opts === undefined ? r2.put(K(k), v) : r2.put(K(k), v, opts)),
    list: async (opts = {}) => {
      const page = await r2.list({ ...opts, prefix: K(opts.prefix || "") });
      return {
        ...page,
        objects: (page.objects || []).map((o) => ({ ...o, key: un(o.key) })),
        delimitedPrefixes: (page.delimitedPrefixes || []).map(un),
      };
    },
  };
  if (typeof r2.head === "function") store.head = (k) => r2.head(K(k));
  if (typeof r2.delete === "function") store.delete = (k) => r2.delete(K(k));
  return store;
}

/** The store this request's workspace sees. The one accessor every call site below uses. */
function bundlesFor(env, tenantId) {
  return bundleStore(env, bundleWorkspaceSegment(env, tenantId).workspace);
}

// ---- Device pairing: a publish token without a password in a terminal -----------------
//
// `C-cli-connect-device-flow`. Today an agent gets a token by being handed an email and a
// password (`augur login`), which puts a human credential in a terminal, a shell history
// and quite possibly a transcript. Pairing replaces that: the CLI asks for a code, the
// person types it into a browser they are ALREADY signed in to, and the CLI collects the
// token that approval minted.
//
// ⛔ OFF BY DEFAULT (`devicePairing: true` in deploy.config.json). Everything here ends in
// a publish token and `start` is reachable without credentials, so an instance opts in
// rather than discovers it. All three routes answer as if they do not exist when off —
// not 403, which would tell a stranger the instance has a pairing flow to come back for.
//
// THE THREE SECRETS, and which one does what, because conflating them is how these flows
// break:
//   code           SHORT, because a person types it. Names the pairing to the APPROVER.
//                  Guessing one lets an attacker approve a pairing they cannot collect.
//   deviceSecret   LONG, never leaves the CLI's process except to claim. It is what
//                  authorises COLLECTION. Only its hash is stored, so a KV read cannot
//                  claim anybody's token.
//   the token      minted at approval, bound to the approving user, handed over once and
//                  then deleted with the record.
//
// ⚠️ THE RESIDUAL RISK IS PHISHING, and no code length fixes it: an attacker starts a
// pairing and talks somebody into approving THEIR code. That is why the approval page says
// in plain words where a legitimate code comes from, why the window is five minutes, and
// why the code is typed rather than carried in a link somebody can be sent.
const PAIR_PREFIX = "pair:";
const PAIR_TTL_MS = 5 * 60 * 1000;
// Unambiguous alphabet: no O/0, no I/1/l. A code is read off one screen and typed into
// another, and a transcription failure looks exactly like an attack to whoever is watching.
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIR_CODE_LEN = 8;
// The minted token's own life comes from tctx.PUBLISH_TOKEN_TTL_DAYS — see
// publishTokenTtlMs below. It used to be a constant here, and only this door read it.

const randomFrom = (alphabet, n) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  // Rejection-free and unbiased enough: 256 % 31 != 0 skews by <2%, which costs a
  // fraction of a bit against a 40-bit code that lives five minutes.
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
};
const randomHex = (n) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
// Codes are matched case-insensitively and with separators stripped: somebody typing
// "abcd-efgh" for "ABCDEFGH" has not made a security decision.
const normalizePairCode = (raw) => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * How long a publish token minted for a PERSON lives, in ms. 0 means it does not expire.
 *
 * ONE NUMBER FOR BOTH HUMAN DOORS. `augur login` (a password) and `augur connect` (a
 * browser approval) hand out the same credential; two lifetimes for it would be a
 * difference nobody chose, and the shorter one would look like a bug in the other flow.
 *
 * NOT FOR MACHINE TOKENS. A token an admin mints by hand at /__admin/tokens — "ci",
 * "backup", "uptime-probe" — has no login to re-run, so an expiry there is an outage at
 * 4am with nobody to fix it. Those are revoked deliberately or not at all, which is the
 * honest arrangement: a machine credential's control is the revoke list, not a clock.
 */
function publishTokenTtlMs(tctx) {
  const days = tctx && Number.isFinite(tctx.PUBLISH_TOKEN_TTL_DAYS) ? tctx.PUBLISH_TOKEN_TTL_DAYS : 30;
  return days > 0 ? days * 24 * 60 * 60 * 1000 : 0;
}

/**
 * Mint a publish token for a user. THE one place a person's token is written — both human
 * doors call this, so an expiry, a label rule or a scope rule cannot land on one and miss
 * the other.
 */
// ⚠️ WRITES GO TO BOTH STORES WHILE `KV_CUTOVER.publishTokens` IS ON — see that constant.
// The object is where the read comes from and KV is what makes flipping the word back a
// revert rather than a data loss, so a token minted after the cut has to exist on both
// sides of it. `env` is optional because two tests mint without one; without it this is
// exactly the KV-only function it has always been.
async function mintPublishToken(kv, tctx, u, { label = null, env = null } = {}) {
  const space = roleOf(u) === "admin" ? "*" : (tctx.SPACES.find((s) => s.default) || { id: null }).id;
  if (!space) return null;
  const token = randomHex(32);
  const raw = await kv.get(PUBLISH_TOKENS_KEY);
  const map = raw ? JSON.parse(raw) : {};
  const rec = { space, label: label || u.email, createdAt: new Date().toISOString() };
  const ttlMs = publishTokenTtlMs(tctx);
  if (ttlMs) rec.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const hash = await tokenFor("pub:" + token);
  map[hash] = rec;
  await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
  // The object second and not first: this function's contract is that the token it RETURNS
  // works, and KV is still the fallback the read falls through to. A throw here would hand
  // back nothing while a usable credential was already in the store.
  const ident = env && identityFor(env, tctx, "publishTokens");
  if (ident) {
    // `space` verbatim into `scope`. `*` stays `*`, a space id stays that space id — the
    // whole reason the column exists.
    try { await ident.tokenMint({ tokenHash: hash, space, label: rec.label, createdAt: rec.createdAt, expiresAt: rec.expiresAt || null }); }
    catch (e) { /* the token is live in KV, which the read still falls back to */ }
  }
  return { token, space, expiresAt: rec.expiresAt || null };
}

/**
 * The approval page. This is the ONE surface a person judges the request on, so it says
 * plainly where a legitimate code comes from — the phishing residual is somebody being
 * talked into approving a code that is not theirs, and no code length fixes that.
 *
 * The code is TYPED, never carried in the link. A URL that approves on click is a URL
 * somebody can be sent.
 *
 * Self-contained, like the login and 404 pages beside it: this must render for somebody
 * whose terminal is already waiting, so it depends on no chrome bundle and no space.
 */
function connectPage(tctx, me) {
  const body = roleOf(me) === "viewer"
    ? `<h1>Connect a terminal</h1>
       <p>This account can look around but not publish, so it cannot approve a terminal.</p>
       <a class="home" href="/">Back to Augur</a>`
    : `<h1>Connect a terminal</h1>
       <p>Type the code your terminal is showing. Approving it lets that terminal publish as
          <strong>${escapeHtml(me.email)}</strong>.</p>
       <p class="warn">Only approve a code you are reading off your own screen right now.
          Nobody legitimate will ever send you one.</p>
       <form id="pairf">
         <input id="pairc" autocomplete="off" autocapitalize="characters" spellcheck="false"
                placeholder="ABCD-EFGH" aria-label="Pairing code" />
         <button type="submit">Approve</button>
       </form>
       <p id="pairm" role="status"></p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Connect a terminal · Augur</title>
  <style>
    :root { --bg:#fbfbfd; --card:#fff; --fg:#16171a; --muted:#5b626e;
            --line-2:rgba(16,17,26,0.15); --accent:#2c2150; color-scheme:light; }
    * { box-sizing:border-box }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg);
           color:var(--fg); font:15px/1.55 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    main { background:var(--card); border:1px solid var(--line-2); border-radius:14px;
           padding:34px 32px; max-width:34rem; margin:24px; }
    h1 { font-size:19px; margin:0 0 14px }
    p { color:var(--muted); font-size:14px; margin:0 0 12px }
    p.warn { color:var(--fg); font-weight:600 }
    form { display:flex; gap:8px; align-items:center; margin:18px 0 12px }
    input { font:600 16px ui-monospace,Menlo,monospace; letter-spacing:.12em; padding:10px 12px;
            border:1px solid var(--line-2); border-radius:8px; width:11em }
    button { font:600 14px inherit; color:#fff; background:var(--accent); border:0;
             border-radius:9px; padding:11px 18px; cursor:pointer }
    a.home { display:inline-block; margin-top:10px; color:var(--accent) }
    @media (prefers-reduced-motion: reduce) { * { transition:none !important } }
  </style>
</head>
<body>
  <main>${body}</main>
  <script>
  (function(){
    var f=document.getElementById('pairf'); if(!f) return;
    var i=document.getElementById('pairc'), m=document.getElementById('pairm');
    f.addEventListener('submit',function(e){
      e.preventDefault(); m.textContent='Approving\u2026';
      fetch('/__publish/_pair/approve',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({code:i.value})})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(d){
        if(r.ok&&d.ok){ m.textContent='Approved. Your terminal has it \u2014 you can close this.'; i.value=''; return; }
        if(r.status===404){ m.textContent='That code is not valid. Check it, or start again in your terminal.'; return; }
        if(r.status===429){ m.textContent='Too many attempts. Wait a few minutes.'; return; }
        m.textContent=(d&&d.message)||'Could not approve that code.';
      });})
      .catch(function(){ m.textContent='Could not reach the site. Try again.'; });
    });
  })();
  </script>
</body>
</html>`;
}

async function pairApi(tctx, request, url, env, me) {
  // Answer as though the routes are not here. A 403 would advertise the flow.
  if (!tctx.DEVICE_PAIRING) return null;
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  if (request.method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
  const op = url.pathname.slice("/__publish/_pair/".length);

  if (op === "start") {
    // Unauthenticated on purpose — the whole point is that the terminal holds no
    // credential. Rate-limited on the caller's address so it cannot be used to fill KV.
    const ids = loginRlIds(request, null);
    if (await loginThrottled(env, ids)) return jsonResponse({ error: "rate-limited" }, 429);
    const code = randomFrom(PAIR_ALPHABET, PAIR_CODE_LEN);
    const deviceSecret = randomHex(32);
    await kv.put(PAIR_PREFIX + code, JSON.stringify({
      deviceHash: await tokenFor("pair:" + deviceSecret),
      status: "pending",
      createdAt: new Date().toISOString(),
    }), { expirationTtl: Math.ceil(PAIR_TTL_MS / 1000) });
    return jsonResponse({
      code, deviceSecret,
      approveUrl: `${url.origin}/__connect`,
      expiresInMs: PAIR_TTL_MS,
    });
  }

  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  const code = normalizePairCode(body && body.code);
  if (!code) return jsonResponse({ error: "bad-input" }, 400);

  if (op === "approve") {
    // The ONE authenticated step, and the only one that mints. A browser session is the
    // credential; no password is re-entered and none is typed anywhere else.
    if (!me) return jsonResponse({ error: "unauthorized" }, 401);
    // The same rule the password path enforces: an account whose password is public
    // knowledge (a demo instance's login hint) can look around and can never publish.
    if (roleOf(me) === "viewer") {
      return jsonResponse({ error: "viewer-role", message: "This account can look around but not publish." }, 403);
    }
    // A signed-in attacker must not be able to walk the code space. Counted on the IP.
    const ids = loginRlIds(request, null);
    if (await loginThrottled(env, ids)) return jsonResponse({ error: "rate-limited" }, 429);
    let rec;
    try { rec = JSON.parse((await kv.get(PAIR_PREFIX + code)) || "null"); } catch (e) { rec = null; }
    if (!rec || rec.status !== "pending") {
      await loginFail(env, ids);
      return jsonResponse({ error: "no-such-code" }, 404);
    }
    const minted = await mintPublishToken(kv, tctx, me, { env });
    if (!minted) return jsonResponse({ error: "no-default-space" }, 500);
    await kv.put(PAIR_PREFIX + code, JSON.stringify({
      ...rec, status: "approved", token: minted.token, space: minted.space,
      expiresAt: minted.expiresAt, approvedBy: me.email,
    }), { expirationTtl: Math.ceil(PAIR_TTL_MS / 1000) });
    return jsonResponse({ ok: true, space: minted.space });
  }

  if (op === "claim") {
    // Unauthenticated, and authorised by the deviceSecret rather than by the code: a
    // guessed code cannot collect a token, which is what makes a short code survivable.
    const secret = String((body && body.deviceSecret) || "");
    if (!secret) return jsonResponse({ error: "bad-input" }, 400);
    let rec;
    try { rec = JSON.parse((await kv.get(PAIR_PREFIX + code)) || "null"); } catch (e) { rec = null; }
    if (!rec) return jsonResponse({ error: "no-such-code" }, 404);
    if (!safeEqual(rec.deviceHash, await tokenFor("pair:" + secret))) {
      return jsonResponse({ error: "no-such-code" }, 404);
    }
    if (rec.status !== "approved") return jsonResponse({ status: "pending" }, 202);
    // ONE-SHOT. Delete before answering, so a replayed claim finds nothing even if the
    // response never reaches the caller. Losing a token to a dropped response is a
    // re-run of `augur connect`; a replayable claim is a second copy in somebody's logs.
    await kv.delete(PAIR_PREFIX + code);
    return jsonResponse({ status: "approved", token: rec.token, space: rec.space, expiresAt: rec.expiresAt || null });
  }

  return jsonResponse({ error: "not-found" }, 404);
}

const PUBLISH_TOKENS_KEY = "publish:tokens"; // KV {sha256("pub:"+token): {space,label,createdAt,expiresAt?}}
const BLOB_MAX_BYTES = 25 * 1024 * 1024;
// Inline-commit caps: enough for a typical few-file edit in one round trip,
// small enough to keep a commit's R2 subrequests inside the free-plan budget.
const INLINE_MAX_BLOBS = 16;
const INLINE_MAX_BYTES = 1_000_000;
// Publish-protocol version, echoed in check responses so a CLI can detect skew
// against the deployed worker. History: 1 = check/blob/commit; 2 = + inline-blob
// commits, filesUnchanged/liveSource on check; 3 = revert guard (baseVersion);
// 4 = client-side safe adoption (authored-bytes peel, internal files preserved);
// 5 = composed publish (live manifest is the base; per-unit fast-forwards only,
// no adoption, no tree writes, manifest-only forks). Echoing it makes every older
// client's next publish attempt a self-update nudge even without a hard floor.
const PUBLISH_PROTOCOL = 5;

// The live content manifests, per workspace.
//
// ⚠️ KEYED BY WORKSPACE, and of every cache in this file this is the one whose value IS
// a workspace's published content: the file table every served byte is resolved through,
// and the routing fragment the gate is derived from. A single slot with one `at` stamp
// answers the first workspace to warm it and then hands that answer to every workspace
// behind it for the rest of the tick — a neighbour's pages at this workspace's URLs, and
// a neighbour's public prefixes deciding this workspace's gate. Nothing in an era with
// one workspace can observe that, because the one answer is simply correct.
//
// The etag shortcut inside the value has the same shape one level down. It is keyed by
// SPACE id, and two workspaces may each publish a space under the same id, so a shared
// entry would let one workspace's parsed manifest be handed to the other on an etag
// match. Keying the container by workspace closes both at once: `cur` below is this
// workspace's own previous view and nothing else's.
//
// BOUNDED like the tenant context cache and the proxy allowlist, for the same reason and
// with the same safe direction: an isolate serving many workspaces would otherwise hold
// every manifest it ever parsed, and an evicted workspace re-lists and re-parses its own
// store. Eviction costs a read; it can never answer with someone else's content.
const MANIFEST_CACHE_MAX = 256;
// tenantId -> { at, spaces, etags }. Bounded and recency-ordered by the constructor;
// there is no access to it that does not name a workspace.
const MANIFESTS = tenantCache("manifests", { max: MANIFEST_CACHE_MAX });

// A write handler making its own publish visible on the very next request, for ITS
// workspace. The parsed view is KEPT: busting asks for a re-read, it does not blank what
// this workspace is serving in the meantime.
function bustManifests(tenantId) {
  MANIFESTS.bust(tenantId);
}

async function loadManifests(tenantId, env, force) {
  const cur = MANIFESTS.get(tenantId) || { at: 0, spaces: {}, etags: {}, filled: false };
  if (!force && Date.now() - cur.at < 1500) {
    // ⚠️ A TICK STAMPED BY A LOAD THAT HAS NOT COME BACK YET IS NOT A VIEW. Stamp-first
    // (below) carries the previous manifests forward so a concurrent reader keeps being
    // served while the refresh runs — and on a COLD isolate the previous manifests are
    // nothing at all. Handing that placeholder out answers every published page with a
    // 404 and /_build.json with an empty site, for up to a tick, to whichever requests
    // arrive alongside the first one. That is the "gone reads as locked" failure: the
    // gate answers a now-unknown path with the login page, so a burst at a cold isolate
    // looks like the content was unpublished. Wait for the load already in flight
    // instead — one store read, and everyone behind it gets the answer.
    //
    // ONLY when there is nothing else to serve. A workspace that has a view keeps
    // answering from it without waiting, which is the whole point of the stamp.
    if (cur.inflight && !cur.filled) return cur.inflight;
    return cur.spaces;
  }
  // Stamp FIRST, and carry the last good view forward on the new entry: a failing read
  // retries on the next tick rather than stampeding the store, and a concurrent request
  // reading mid-load still gets this workspace's previous manifests.
  const entry = MANIFESTS.put(tenantId, {
    at: Date.now(), spaces: cur.spaces, etags: cur.etags, filled: cur.filled,
  });
  // The promise every reader in this tick can wait on, published on the entry BEFORE the
  // first await so a request that arrives one microtask later can find it.
  let settle;
  entry.inflight = new Promise((r) => { settle = r; });
  try {
    const store = bundlesFor(env, tenantId);
    const list = await store.list({ prefix: "spaces/", delimiter: "/" });
    const ids = (list.delimitedPrefixes || []).map((p) => p.slice("spaces/".length, -1));
    // ⚠️ THE ENGINE CHROME IS OUTSIDE THIS WORKSPACE'S PREFIX AND SO OUTSIDE THIS LISTING.
    // On a prefixing deployment the list above returns this workspace's spaces and nothing
    // else, which is the whole point — but `_engine` is the one space that is every
    // workspace's, and `derivedRoutingFields` reads the chrome pointer, the service worker
    // and the runtime-chrome switch off it. Leaving it to the listing would take the chrome
    // off every workspace on the deploy that shipped this. `bundleKey` keeps its key
    // global; this keeps it in the set.
    if (!ids.includes(ENGINE_SPACE_ID) && bundleWorkspaceSegment(env, tenantId).workspace) {
      ids.push(ENGINE_SPACE_ID);
    }
    const out = {}, etags = {};
    // Parse cost must not ride the request path: JSON.parse of a multi-MB manifest
    // on the refresh tick is what blew the CPU budget when the 2026-08-22 cascade
    // doubled a live instance's manifest (error 1102). head+etag per manifest is
    // metadata-only — the body is fetched and parsed ONLY when the etag moved, i.e.
    // once per publish rather than once per tick. `force` (the publish API's own
    // callers) still bypasses the parse skip via the etag change it just caused.
    await Promise.all(ids.map(async (id) => {
      const key = `spaces/${id}/manifest.json`;
      const head = store.head ? await store.head(key) : null;
      const etag = head && (head.etag || head.httpEtag);
      if (etag && cur.etags[id] === etag && cur.spaces[id]) {
        out[id] = cur.spaces[id];
        etags[id] = etag;
        return;
      }
      const obj = await store.get(key);
      if (!obj) return;
      out[id] = JSON.parse(await obj.text());
      etags[id] = etag || (obj.etag || obj.httpEtag) || "";
    }));
    // ── _engine chrome: the worker's OWN assets win when they are the newer build ──────
    // The shared chrome (`spaces/_engine/…` in R2) was republished by per-instance CI on
    // every engine bump; the shared-worker migration removed that CI, so R2 chrome can now
    // lag the deployed worker — /_build.json reads the last CHROME publish, not the running
    // code, and a switcher shipped in the worker stays invisible until a manual refresh
    // (D-chrome-auto-on-deploy). engine/dist — what wrangler uploads in lockstep with the
    // worker, reachable through the ASSETS binding — carries the same _engine chrome, so
    // preferring it means chrome can never lag. R2 still WINS when a chrome-refresh
    // (D-chrome-refresh-fanout) published it AFTER this worker shipped: compared by wall
    // clock, the assets manifest carries `builtAt` (stamped at build), the R2 one carries
    // `publishedAt` (stamped at publish), newer wins.
    //
    // Safe against the etag skip above: any real R2 chrome change moves the manifest's
    // etag and forces a fresh read here, so the assets copy we may have cached in
    // `out._engine` last tick can never mask a newer R2 publish — a swap only ever happened
    // because assets was already ≥ R2, and that ordering holds until R2 actually changes.
    //
    // An assets manifest with no `builtAt` is an engine built before this landed: it never
    // wins, so a deployment keeps byte-for-byte its old behaviour until the worker is
    // redeployed. Gated on bundle mode so assets mode (augur dev/offline/raw build) is
    // untouched, and the fetch is a local ASSETS read (no network), done only on the
    // refresh tick loadManifests already throttles to.
    if (bundleMode(env) && env.ASSETS) {
      try {
        const res = await env.ASSETS.fetch("https://config/__manifests/_engine.json");
        const am = res && res.status === 200 ? JSON.parse(await res.text()) : null;
        if (am && am.id === ENGINE_SPACE_ID && am.builtAt) {
          const asAt = Date.parse(am.builtAt) || 0;
          const r2 = out[ENGINE_SPACE_ID];
          const r2At = r2 && r2.publishedAt ? (Date.parse(r2.publishedAt) || 0) : 0;
          if (!r2 || asAt >= r2At) out[ENGINE_SPACE_ID] = { ...am, __fromAssets: true };
        }
      } catch (e) {} // no assets _engine manifest, or an unreadable one ⇒ keep R2's, as before
    }
    entry.spaces = out;
    entry.etags = etags;
    // A store that answered — even with nothing published — IS a view. `filled` is what
    // tells a reader "this entry is an answer, not a placeholder"; a read that THREW
    // leaves it as it was, so the waiters above keep waiting for a real one next tick.
    entry.filled = true;
  } catch (e) {} // a transient list/get failure keeps serving the last good view
  // Release the waiters, and stop being the in-flight load. Both happen however this
  // returned: a rejected read that left `inflight` in place would strand every request
  // in the next tick on a promise nothing will ever settle.
  entry.inflight = null;
  settle(entry.spaces);
  return entry.spaces;
}

// Site routing from the live manifests (the bundle-mode replacement for
// routing.json): merge every space's fragment, fold per-space shell signatures
// into one buildId, and read the chrome pieces off the _engine manifest.
// Derive routing from the live manifests, as a VALUE. Pure: it reads the manifests and
// the icon index and returns the fields it derived, touching no module state — which is
// what lets the same derivation fill a per-tenant context instead of one isolate's
// globals. `applyDerivedRouting` below is the transitional caller that still writes the
// globals; the threading sweep retires it cluster by cluster.
//
// One deliberate difference from the version that assigned inline: derivation is now
// ALL-OR-NOTHING. The old code set the chrome pointer during the loop and the rest after
// it, so a manifest that threw midway left the pointer moved and everything else stale —
// a half-applied routing table nothing could detect. Returning a value means a throw
// reaches loadConfig's catch with nothing written, which is the keep-last-good behaviour
// the cache was always trying to have.
function derivedRoutingFields(manifests, spaceIcons) {
  const vmap = {}, prefixes = [], mcp = new Set(), mcpPaths = new Set(), spacesList = [];
  const sigs = [];
  const catalog = [], tracks = [];
  let skillPrefixes = [], loaderExtras = "";
  let chromePointer = null, runtimeChrome = false;
  for (const id of Object.keys(manifests).sort()) {
    const m = manifests[id];
    if (id === "_engine") {
      loaderExtras = (m.routing && m.routing.canvasLoaderExtras) || "";
      // Serve-time chrome composition (runtime-chrome): the pointer + switch ride the
      // _engine fragment in bundle mode, mirroring routing.json in assets mode.
      chromePointer = (m.routing && m.routing.chrome) || null;
      runtimeChrome = !!(m.routing && m.routing.runtimeChrome);
      continue;
    }
    const r = m.routing || {};
    const sp = m.space || { id };
    prefixes.push(...(r.publicPrefixes || []));
    Object.assign(vmap, r.versionMap || {});
    // Each space's slice of the two aggregates, concatenated in the same sorted-id
    // order every time so the merge is stable. A space that has never published simply
    // contributes nothing, rather than erasing the others. With the path-mount tier
    // retired there is one workspace and no whole-instance admin seal (RESTRICTED_BASES
    // is permanently empty — see below), so the workspace always contributes its catalog:
    // /__canvas/catalog.json is served before the gate, exactly as the default space's
    // catalog always was.
    catalog.push(...(r.canvasCatalog || []));
    // Music: the track list answers ADMINS only (canvasAggregate) and the audio itself is
    // admin-only too (isTrackPath), so the workspace's tracks merge for an admin to see.
    tracks.push(...(r.canvasTracks || []));
    for (const h of r.mcpAllowlist || []) mcp.add(h);
    // ⏳ MIGRATION WINDOW — a fragment with NO `mcpPaths` key was published by a clone
    // older than path declarations, so it gets the floor that engine had; a fragment
    // carrying `[]` declared "no extra paths" and gets nothing. Absent and empty are
    // different on purpose: a manifest cannot be re-published from here, and a vintage one
    // would otherwise lose an endpoint it was serving the moment its pin moved. Keyed on
    // the manifest, never on who published it. Delete both lines with
    // LEGACY_MCP_PATH_FLOOR — see the constant for the condition that allows it.
    if (!Array.isArray(r.mcpPaths)) for (const p of LEGACY_MCP_PATH_FLOOR) mcpPaths.add(p);
    for (const p of r.mcpPaths || []) mcpPaths.add(p);
    if (r.publicSkillPrefixes) skillPrefixes = r.publicSkillPrefixes;
    spacesList.push(sp);
    sigs.push(`${id}:${r.shellSig || m.version || 0}`);
  }
  let h = 5381;
  const s = sigs.sort().join("\n");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  const allowlist = [...mcp].sort();
  const spaces = spacesList.sort((a, b) => (b.default === true) - (a.default === true) || String(a.id).localeCompare(String(b.id)));
  return {
    BUILD_ID: h.toString(36),
    VERSION_MAP: vmap,
    PUBLIC_PREFIXES: prefixes,
    PUBLIC_SKILL_PREFIXES: skillPrefixes,
    // The path-mount tier is retired: an adminOnly space only ever sealed a NON-DEFAULT
    // "/<id>/" mount, and no such mount exists any more, so the bundle derivation never
    // seals anything. RESTRICTED_BASES is permanently empty here. (Assets mode still reads
    // a routing.restrictedBases field defensively, but the build no longer emits one.)
    RESTRICTED_BASES: [],
    CANVAS_LOADER_EXTRAS: loaderExtras,
    CANVAS_CATALOG: catalog,
    CANVAS_TRACKS: tracks,
    MCP_HOST_ALLOWLIST: allowlist,
    mcpStaticHosts: new Set(allowlist),
    MCP_PATH_ALLOWLIST: [...mcpPaths].sort(),
    // SPACES + SPACE_ICON_KEYS, together — see applySpaceIcons.
    ...applySpaceIcons(spaces, spaceIcons),
    CHROME_POINTER: chromePointer,
    RUNTIME_CHROME: runtimeChrome,
  };
}

// Test seam: seed a routing table from a set of manifests. The request path does not call
// this — loadTenantContext takes the same value and puts it on a context — but the gate,
// board and link-preview baselines drive it directly to build a workspace to ask
// questions of.
function applyDerivedRouting(manifests) {
  const f = derivedRoutingFields(manifests, TENANT_CTX.SPACE_ICONS);
  TENANT_CTX = withTenantFields(TENANT_CTX, f);
  // Returns the CONTEXT, not the bare field patch. It is a superset — every field of the
  // patch is a field of the context — so a caller reading `f.MCP_PATH_ALLOWLIST` reads the
  // same value, and a caller that has to hand a context to a predicate has one without
  // seeding anything twice.
  return TENANT_CTX;
}

// Does a path (or routing prefix) belong to a publishable workspace? This keeps a publish
// token off shared engine assets: engine internals (/__*, the admin panel) belong to NO
// space and can never be written by a space token. With the path-mount tier retired the
// remaining rule is simply "not engine chrome, not reserved /__" → the one workspace owns
// it. Pure + exported for tests.
// The shared chrome a space may never write. Every one of these is loaded by
// absolute URL from pages in EVERY space, so a space able to write one could run
// code in another space's prototypes — which is what this guard is for.
// Mirrors ENGINE_CHROME in build.js; keep the two in step.
const ENGINE_CHROME_PATHS = Object.freeze([
  "/fonts/", "/pitis/", "/__review/", "/__canvas/", "/admin", "/changelog",
  "/piti.js", "/404.html", "/manifest.webmanifest", "/sw.js",
  "/augur-eye.svg", "/augur-icon-192.png", "/augur-icon-512.png", "/augur-mark.png",
]);
const isEngineChrome = (key) =>
  // The content-hashed shared chrome bundle: /_chrome.<ver>.<hash>.{js,css}.
  key.startsWith("/_chrome.") ||
  ENGINE_CHROME_PATHS.some((p) =>
    p.endsWith("/") ? key.startsWith(p) : key === p || key.startsWith(p + "/"));

// A publisher-declared PUBLIC PREFIX — a path the gate will open to anonymous visitors.
// Held to the same ownership rule as a file, normalizing a trailing slash so "/x" and
// "/x/" both check as "/x/", plus one extra rule the file rule cannot express: "/" is
// genuinely owned by the default space, but isPublicPath matches by startsWith, so a
// root prefix opens EVERY gated path on the site. A prefix must name a real subtree.
function isPublishablePublicPrefix(p, spaceId, spaces) {
  const norm = String(p == null ? "" : p).replace(/\/?$/, "/");
  return norm !== "/" && pathOwnedBySpace(norm, spaceId, spaces);
}

// A publicPrefixes entry only counts as LIVE if some file in the manifest
// actually serves under it. build.js only ever pushes a prefix alongside the
// files that back it — one loop, over the same folder, for every opportunity
// and playground prototype — so a legitimate build can never produce a prefix
// without files behind it. A prefix with nothing behind it is DEAD: content
// renamed or removed out from under a routing fragment that never got
// re-derived, a reconcile patch that copied a live routing entry without its
// files, or some other bug that let the two drift apart. Either way, nothing
// is being served there right now — it already 404s for every visitor — so it
// is not "live" in the sense the unpublish guard exists to protect.
//
// Decodes both sides before comparing: routing prefixes are
// encodeURIComponent'd per build.js's S(), manifest.files keys are the literal
// disk-relative paths walkDist wrote. Same tolerant decode, same reasoning, as
// scripts/lib/publish-conflict.mjs's unitPaths — the CLI's equivalent notion
// of "does this unit have files" — kept in step by hand since this file ships
// standalone (no shared import) and unitPaths runs in Node only.
function decUrlPath(s) { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } }
function isPrefixBacked(manifest, prefix) {
  const norm = decUrlPath(prefix).replace(/\/?$/, "/");
  const files = (manifest && manifest.files) || {};
  for (const p in files) if (decUrlPath(p).startsWith(norm)) return true;
  return false;
}
// The subset of a manifest's declared publicPrefixes that are genuinely live
// right now (backed by at least one file). Every reader of "what's live" for
// the unpublish guard's purposes — the guard below, /check's advisory
// livePrefixes, and the pruning at commit — goes through this one function so
// the three can never drift into disagreeing about what counts as dead.
function backedPublicPrefixes(manifest) {
  const list = ((manifest && manifest.routing) || {}).publicPrefixes || [];
  return list.filter((p) => isPrefixBacked(manifest, p));
}

// Which public URLs would this incoming manifest take off the site? Compares the
// live routing fragment against the incoming one — nothing else, because
// publicPrefixes IS the set of pages anyone can open without a password, and a
// prefix disappearing is exactly a shareable link going dark. Order-insensitive
// and duplicate-tolerant: only membership means anything here. A space with no
// live manifest yet (first publish) removes nothing by definition.
//
// "had" is the LIVE side's GENUINELY-live prefixes (backedPublicPrefixes), not
// its raw routing list: a dead/orphaned entry already serves nothing, so a
// publish that fails to re-declare it isn't taking anything down — it's just
// not carrying forward damage an earlier commit already did. Blocking on a
// dead entry would only ever punish whoever happens to publish next, forever,
// for a page they never touched. A prefix that IS actually serving content
// still counts, exactly as before — this narrows what "live" means, it does
// not weaken the guard over anything really live.
function removedPublicPrefixes(live, next) {
  const keep = new Set(((next && next.routing) || {}).publicPrefixes || []);
  const had = backedPublicPrefixes(live);
  return [...new Set(had)].filter((p) => !keep.has(p));
}

function pathOwnedBySpace(key, spaceId, spaces) {
  if (typeof key !== "string" || !key.startsWith("/")) return false;
  if (isEngineChrome(key)) return false;
  // Everything else under /__ stays reserved for the engine. The one exception is
  // a space's own search index: the default space serves its at the root, so it
  // lands on /__search.json — and a blanket /__ ban refused it, which stopped the
  // default space publishing at all. (That ban was also too loose in the other
  // direction: /piti.js and /fonts/* are injected into every prototype and it let
  // those through. The chrome list above closes both ends.)
  if (key.startsWith("/__") && !/^\/__search\.json$/.test(key)) return false;
  // With the path-mount tier retired there is one workspace, so ownership no longer
  // discriminates by space: anything that is not engine chrome and not reserved /__
  // belongs to the one workspace. The `spaceId`/`spaces` arguments are kept for the
  // callers' shape (and for the sweep that later threads a context) but no longer
  // select among several "/<id>/" subtrees — that plurality is gone.
  return true;
}

// Path → manifest entry. Manifest keys are the built files' real (decoded) paths.
// DETERMINISTIC resolution: spaces first (sorted), _engine last, so a path can never
// resolve to a different owner depending on which manifest read completed first. Commit
// now forbids cross-space path collisions, so at most one space owns any given path;
// the _engine-last order keeps engine chrome (/admin, /__…) resolving to _engine.
function lookupBundleFile(manifests, pathname) {
  const ids = Object.keys(manifests)
    .sort((a, b) => (a === "_engine") - (b === "_engine") || a.localeCompare(b));
  for (const id of ids) {
    const f = manifests[id].files && manifests[id].files[pathname];
    if (f) return { f, id };
  }
  return null;
}
// What an un-versioned store asset is served with. Not a tuning knob: see the
// assetFetch() header below for why the empty string this replaces was a bug.
//
// ⚠️ On Cloudflare you will NOT see this on the wire. A zone's Browser Cache TTL
// defaults to 4 hours and rewrites the downstream header, so `curl -I` reports
// `public, max-age=14400` no matter what is set here — which reads exactly like the
// bug still being present. It is not: the rewrite is downstream-only, the EDGE obeys
// the `no-cache` it was given and revalidates, so a publish reaches every visitor at
// once. What survives is a returning browser holding its own copy for up to the zone
// TTL. Closing that last gap is a zone setting, not a code change: set Browser Cache
// TTL to "Respect Existing Headers" (per zone — Caching → Configuration). Do not
// chase it from here by reaching for `no-store`; that is honoured, but it also
// forbids storage outright and throws away the ETag/304 economy this relies on.
const ASSET_REVALIDATE = "public, no-cache";

function resolveBundlePath(manifests, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { return { miss: true }; }
  const direct = lookupBundleFile(manifests, p) ||
    (p.endsWith("/") ? lookupBundleFile(manifests, p + "index.html") : null);
  // `id` rides along so a caller can tell WHICH space owns the resolved path — assetFetch
  // uses it to serve _engine chrome from the worker's own assets when those are the newer
  // build (see the __fromAssets branch there and loadManifests). It is authoritative
  // because _engine sorts LAST in lookupBundleFile, so a space owning the same path shadows
  // it and this reports the space, never _engine.
  if (direct) return { f: direct.f, id: direct.id };
  if (!p.endsWith("/") && lookupBundleFile(manifests, p + "/index.html")) return { redirect: p + "/" };
  return { miss: true };
}

// The env.ASSETS.fetch drop-in: identical contract (a plain 404 Response means
// "not found" — callers brand it / try virtual canvases), plus ETag/304 and
// byte ranges (audio scrubbing) in bundle mode.
//
// ⚠️ Every response here MUST carry an explicit Cache-Control, and it must be one
// that revalidates. Sending none does NOT mean "not cached": a response with no
// cache header gets the CDN's own default TTL, which is keyed on the file
// EXTENSION and is four hours for the static ones (.png/.svg/.js/.css/…). Bundle
// mode is exactly where that bites, because these bytes never pass through the
// assets platform whose `max-age=0, must-revalidate` default withAssetCache()
// below was written against — the worker answers from R2 directly, so "the
// default" is the CDN's, not that one.
//
// The symptom is silent and lopsided, which is why it survived: HTML is not in
// the default extension list, so a republished page went live instantly while the
// un-versioned image/script/stylesheet it loads served the PREVIOUS publish's
// bytes for up to four hours. New markup against old assets, with no way to bust
// it — the URLs carry no version — and `augur publish` reporting success the
// whole time. A space icon changed in settings had the same four-hour lie.
//
// `no-cache` is "store it, but revalidate before every use", not "do not store":
// the ETag above is the content hash, so a repeat visit costs one conditional
// request answered by the 304 a few lines down, and a publish is visible at once.
// Versioned URLs (?v=, /fonts/) are promoted back to a year + immutable by
// withAssetCache(), which runs downstream of this — so the hot path keeps its
// zero-revalidation caching and only the un-versioned ones pay.
// `tenantId` is which workspace's published content this path is to be resolved
// against. It is the first argument for the same reason `loadTenantContext` takes it
// first: everything below reads one workspace's store, and a function that had to guess
// would resolve a path against whatever the isolate happened to hold.
async function assetFetch(tenantId, env, request) {
  if (!bundleMode(env)) return env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const manifests = await loadManifests(tenantId, env);
  const r = resolveBundlePath(manifests, url.pathname);
  if (r.redirect) return Response.redirect(new URL(r.redirect + url.search, url).toString(), 308);
  if (r.miss) return new Response("Not Found", { status: 404 });
  // _engine chrome served from the worker's OWN assets (engine/dist) when loadManifests
  // chose them over R2 — see the __fromAssets swap there (D-chrome-auto-on-deploy). Those
  // bytes ship in lockstep with the worker code, so chrome cannot lag a deploy; the file
  // is served by PATH through the ASSETS binding, and the R2 blob is never consulted for
  // it (the manifest's hashes are the assets copy's, not R2 keys). Only _engine takes this
  // branch — a space's own content always resolves to a real R2 blob below.
  if (r.id === "_engine" && env.ASSETS && manifests._engine && manifests._engine.__fromAssets) {
    return env.ASSETS.fetch(request);
  }
  const f = r.f;
  const inm = request.headers.get("If-None-Match");
  if (inm && inm.replace(/W\/|"/g, "") === f.h) {
    // The 304 carries it too: it is what refreshes the client's freshness record,
    // so omitting it here lets a previously-cached copy age back into staleness.
    return new Response(null, { status: 304, headers: { ETag: `"${f.h}"`, "Cache-Control": ASSET_REVALIDATE } });
  }
  const headers = {
    "Content-Type": f.ct, ETag: `"${f.h}"`, "Accept-Ranges": "bytes",
    "Cache-Control": ASSET_REVALIDATE,
  };
  const rm = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (rm && (rm[1] || rm[2])) {
    let start = rm[1] ? parseInt(rm[1], 10) : Math.max(0, f.s - parseInt(rm[2], 10));
    let end = rm[1] && rm[2] ? Math.min(parseInt(rm[2], 10), f.s - 1) : f.s - 1;
    if (start > end || start >= f.s) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${f.s}` } });
    }
    const obj = await env.BUNDLES.get("blobs/" + f.h, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response("Not Found", { status: 404 });
    headers["Content-Range"] = `bytes ${start}-${end}/${f.s}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(obj.body, { status: 206, headers });
  }
  const obj = await env.BUNDLES.get("blobs/" + f.h);
  if (!obj) return new Response("Not Found", { status: 404 });
  headers["Content-Length"] = String(f.s);
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

// Existence probe (no body) — the canvas shadow-check's cheap path.
async function assetPathExists(tenantId, env, url) {
  if (!bundleMode(env)) {
    const asset = await env.ASSETS.fetch(new Request(url.toString()));
    return asset.status !== 404;
  }
  const r = resolveBundlePath(await loadManifests(tenantId, env), url.pathname);
  return !r.miss;
}

// The /_build.json contract, synthesized from the manifests.
//
// In bundle mode this is the ONE answer to "what is live?", and it means exactly
// one thing: the last thing PUBLISHED. Nothing else can change what a visitor sees
// — a CI rebuild ships chrome and worker code, never space content — so there is no
// second number to reconcile it against. Per space:
//   sha / dirty   the space repo commit it was built from, and whether the working
//                 tree was dirty at publish time (see below)
//   version       the store's monotonic publish counter, and the argument to a
//                 rollback
//   publishedAt   when that publish committed
//   publishedBy   the label on the publish token that committed it
// `dirty` is the one that matters and the one nobody was looking at: a publish from
// an uncommitted tree serves bytes that exist in NO repository, so it is both the
// only unreproducible state and invisible unless something surfaces it. It is
// surfaced in three places now — here, the admin panel's Live content table, and
// the deploy canary once it outlives its grace window.
//
// Shape is additive: `builtAt`, `engine.sha` and `spaces.<id>.sha`/`dirty` keep
// their exact previous meaning, so existing checks keep working.
/**
 * A publish token's label, as a name rather than an address.
 *
 * Used wherever a `publishedBy` crosses a boundary: `/_build.json` is served BEFORE the
 * gate, and the workspace status payload is read by an operator-facing isolate. Both want
 * to say who published; neither may say it with somebody's address.
 */
function publisherDisplayName(tctx, label) {
  if (!label) return "";
  const u = userByEmail(label, tctx.USERS);
  return u ? u.name : String(label).split("@")[0];
}

// ---- Server-side fork-on-conflict --------------------------------------------------
//
// `C-fork-on-conflict`. A publish carries `baseVersion` — the live version its delta was
// computed against — and a mismatch means somebody published in between. Today that is a
// flat 409 and the CLI recomposes and retries, which works because the CLI has GIT: it can
// prove which units it edited.
//
// ⚠️ A HOSTED WORKSPACE MAY HAVE NO REPO AT ALL. "Repo-less multi-editor at v1, not phase
// two" is a settled decision, and a repo-less editor has no evidence to recompose FROM. For
// that publisher a 409 is not a retry, it is a dead end — so the server has to be able to
// answer, and this is that answer.
//
// ⚠️ IT IS OPT-IN (`forkOnConflict: true` on the commit body), and that is not timidity. The
// commit handler is the live publish path of every instance; a publisher that does not ask
// gets byte-for-byte today's behaviour, including today's 409, so nothing that works now can
// start resolving conflicts differently because a server moved underneath it.
//
// ⚠️ IT RUNS THE CLIENT'S OWN COMPOSITION, not a second implementation. `composePublish` is
// the same module `publish.mjs` calls; what the server substitutes is the EVIDENCE. Git says
// "which units did I edit"; the BASE MANIFEST says the same thing in bytes:
//
//     editedUnits = units whose files differ between the incoming manifest and the base
//     ffUnits     = units whose files are IDENTICAL between live and the base
//                   (nobody else touched them, so mine fast-forwards)
//
// A unit in both sets is a genuine concurrent edit and forks. A unit in neither is untouched
// and keeps live's bytes. Two implementations of that decision would disagree on exactly the
// publishes a conflict is about, which is why the unit vocabulary moved to
// src/publish-units.mjs and this calls the same composer.
//
// ⚠️ A CHANGE OUTSIDE EVERY UNIT ON BOTH SIDES IS STILL A HARD 409. A design-system file, a
// shared token sheet, `space.json` — those are not safe to resolve mechanically, and the CLI
// aborts the merge for a human for the same reason. Forking them would put two versions of a
// stylesheet on the site and let the fork's copy win somewhere.

/** Which units this manifest's file map differs on, against another manifest. */
function unitsDiffering(a, b, units) {
  const out = new Set();
  const filesOf = (m, u) => {
    const map = {};
    for (const p of unitPaths(m, u)) map[p] = ((m.files || {})[p] || {}).h || "";
    return JSON.stringify(Object.keys(map).sort().map((k) => [k, map[k]]));
  };
  for (const u of units) if (filesOf(a, u) !== filesOf(b, u)) out.add(u);
  return out;
}

/** Paths belonging to no unit, as a path→hash map — the "not safe to resolve" surface. */
function looseFiles(m, units) {
  const out = {};
  for (const [p, f] of Object.entries((m || {}).files || {})) {
    if (!unitOfPath(p, units)) out[p] = (f || {}).h || "";
  }
  return out;
}

async function resolveStaleBase(env, tctx, spaceId, mine, live, baseVersion, label) {
  // The base has to exist to diff against. Versions are never pruned, so a miss means a
  // client claiming a version this store never had — which is not a conflict to resolve.
  let base = null;
  try {
    const obj = await bundlesFor(env, tctx && tctx.tenantId).get(`spaces/${spaceId}/versions/${baseVersion}.json`);
    base = obj ? JSON.parse(await obj.text()) : null;
  } catch (e) { base = null; }
  if (!base) return null;

  const units = new Set([
    ...authoredUnits(base), ...authoredUnits(live), ...authoredUnits(mine),
  ]);

  // Outside every unit, changed on BOTH sides: not safe to resolve mechanically.
  const looseBase = looseFiles(base, units);
  const looseMine = looseFiles(mine, units);
  const looseLive = looseFiles(live, units);
  const contested = [];
  for (const p of new Set([...Object.keys(looseMine), ...Object.keys(looseLive)])) {
    const b = looseBase[p], a = looseMine[p], l = looseLive[p];
    if (a !== b && l !== b && a !== l) contested.push(p);
  }
  if (contested.length) {
    return { error: "conflict-outside-prototype", paths: contested.slice(0, 50), count: contested.length };
  }

  const editedUnits = unitsDiffering(mine, base, units);
  const ffUnits = new Set([...units].filter((u) => !unitsDiffering(live, base, new Set([u])).size));

  const composed = await composePublish({
    mine, live, who: publisherDisplayName(tctx, label) || "someone",
    evidence: { editedUnits, dirtyUnits: new Set(), deletedUnits: new Set(), editedPaths: new Set() },
    ffUnits,
    // The blobs of a forked unit are already stored — the fork is new manifest KEYS pointing
    // at hashes this store already has, so nothing is re-uploaded.
    sha256: async (bytes) => toHex(await crypto.subtle.digest("SHA-256", bytes)),
  });

  return {
    manifest: composed.manifest,
    forks: composed.summary.forked,
    extraBlobs: composed.extraBlobs,
  };
}

function synthBuildStamp(tctx, manifests) {
  const spaces = {}, engine = { sha: null };
  if (tctx.INSTANCE_ENGINE_VERSION) engine.version = tctx.INSTANCE_ENGINE_VERSION;
  let builtAt = null;
  // /_build.json is served BEFORE the gate, so publishedBy must not leak the raw email
  // the publish token is labelled with. Map it to the roster display name when known,
  // else the local-part — enough to say who published, without publishing addresses.
  const byName = (label) => publisherDisplayName(tctx, label);
  const provenance = (m) => ({
    ...(m.version ? { version: m.version } : {}),
    ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
    ...(m.publishedBy ? { publishedBy: byName(m.publishedBy) } : {}),
    // The engine that COMPOSED these pages, which is not the engine now deployed.
    // Page-level chrome is baked in at build time, so a space that has not republished
    // keeps serving whatever the engine looked like when it last did — while the
    // top-level `engine.sha` below reports the current chrome deploy and looks fine.
    // Publishing both is what lets anyone see the gap.
    ...(m.builtWith && m.builtWith.engine ? { builtWithEngine: m.builtWith.engine } : {}),
  });
  for (const id in manifests) {
    const m = manifests[id];
    if (m.publishedAt && (!builtAt || m.publishedAt > builtAt)) builtAt = m.publishedAt;
    const src = m.source || {};
    if (id === "_engine") {
      // `source.sha` is the git provenance a PUBLISH stamps; the assets copy of the chrome
      // (served when it is the newer build — D-chrome-auto-on-deploy) was never published,
      // so it carries none. Fall back to `builtWith.engine`, which build.js stamps from the
      // engine's own HEAD — for _engine the same commit — so /_build.json reports the
      // DEPLOYED worker's sha rather than null the moment chrome comes from assets.
      engine.sha = src.sha || (m.builtWith && m.builtWith.engine) || null;
      if (src.dirty) engine.dirty = true;
      Object.assign(engine, provenance(m));
      continue;
    }
    spaces[id] = { sha: src.sha || null, ...(src.dirty ? { dirty: true } : {}), ...provenance(m) };
  }
  return { builtAt: builtAt || new Date().toISOString(), engine, spaces };
}

// ---- Publish API (/__publish/<space>/{check,blob/<h>,commit,rollback}) ------
// Bearer-token authed (per-space tokens minted in the admin panel, hashed in
// KV; "*" = every space). PUBLISH_BOOTSTRAP_TOKEN is a local-dev binding for
// wrangler dev only — never configure it on a deployed instance.
// `tctx` is here for the two role re-checks below: a token's label is an email, and an
// email only means a person relative to ONE workspace's roster. Resolving it against a
// module roster would let a neighbour's admin vouch for a token scoped to this
// workspace's content.
// A publish token's LABEL, re-resolved against THIS workspace's live roster, on every
// publish. Returns a reason string when the token may not publish, or null when it may.
//
// WHAT THIS REPLACES AND WHY IT WAS NOT ENOUGH. The re-check used to be two conditions
// shaped `if (u && …) return null` — refuse when the resolved user is no longer an admin,
// refuse when they are a viewer. Both silently PASSED when `u` was undefined, and `u` is
// undefined in exactly one case: the person was REMOVED rather than demoted. So the check
// caught the smaller failure and waved through the larger one. Removal does revoke tokens
// today; the point of a re-check is that it holds when the revoke does not run — a
// hand-edited identity file, a config push that lands before the revoke, a removal verb
// somebody writes next year that forgets the call.
//
// THE DISCRIMINATOR IS THE `@`, and it has to be something. `augur login` and `augur
// connect` label a token with the holder's address, so a label with an `@` in it NAMES A
// PERSON and that person must still be a member here. A label an admin typed — "ci",
// "backup", "uptime-probe" — names no person, answers to no roster, and is unaffected;
// asking a roster about it would refuse every machine token on the instance.
//
// It resolves against `tctx.USERS`, the roster of the workspace the request is FOR. An
// address means a person only relative to one roster: the same token, the same label,
// resolved next door, can legitimately answer differently.
function tokenActorRefusal(tctx, e) {
  const label = e && e.label ? String(e.label).trim() : "";
  if (!label) return null;                 // an unlabelled token names nobody to re-check
  if (!label.includes("@")) return null;   // an admin typed this; there is no person behind it
  // The label is the address the token was minted under. A person's PRIMARY address can
  // change (the roster carries the old one in `emails` from then on, for attribution), and
  // a token they minted last month still names the old one — that is the same person,
  // not a stranger. Primary first, then the aliases; the roster is the only thing consulted.
  const u = userByEmail(label, tctx.USERS) || userByAliasEmail(label, tctx.USERS);
  // The case the `u && …` short-circuit used to skip: the address is gone from the roster.
  if (!u) return "not-a-member";
  const role = roleOf(u);
  // A viewer may hold no publish token at all, however it was minted — the role exists for
  // accounts whose password is public knowledge.
  if (role === "viewer") return "viewer-role";
  // A star-scope token is admin-equivalent: it pushes instance config, i.e. the user list
  // itself. Still an editor is still not that.
  if (e.space === "*" && role !== "admin") return "not-an-admin";
  return null;
}

/**
 * The one resolve, with its reason. `{entry}` when the token may publish here, `{refusal}`
 * — one of no-token, unknown-token, token-expired, not-a-member, viewer-role,
 * not-an-admin, wrong-space — when it may not.
 *
 * The reason exists so an EXPIRED token can say so. A publish token now runs out (30 days
 * by default), and a CLI that answers "403 forbidden" to the one failure every holder will
 * eventually hit sends them looking for a permissions problem they do not have. Nothing
 * here is an oracle: a reason is only ever reached by a token that is IN the map, i.e. by
 * the person holding it. A token nobody minted gets `unknown-token` and learns nothing.
 */
async function publishAuthDetailed(tctx, request, env, spaceId, anySpace) {
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m) return { entry: null, refusal: "no-token" };
  const token = m[1].trim();
  // THE BOOTSTRAP TOKEN IS DEAD ON A DEPLOYED INSTANCE, whatever its environment says.
  //
  // What it is: a plaintext string compared with `===`, answering with `space: "*"` —
  // every workspace's published content, overwritable, with no KV read, no roster check
  // and no expiry. It exists so `wrangler dev` can publish into a local store before any
  // real token has been minted. The comment above this function has always said "never
  // configure it on a deployed instance", and a comment is not a guard.
  //
  // Bundle mode is the engine's own name for "this is a real deployment": a live instance
  // serves published content from the store, and assets mode is the local path (augur dev,
  // npm run offline, a raw engine build). So the bypass is refused exactly where it would
  // matter, and refusing costs local development nothing.
  //
  // It logs an ALARM rather than failing quietly. A correct bearer token arriving at a
  // deployed instance means the variable is set somewhere it should not be, or someone is
  // guessing at it; either way it is the one event here worth waking someone for. The line
  // carries no token, not even a prefix — the alarm is that an attempt happened.
  if (env.PUBLISH_BOOTSTRAP_TOKEN && token === env.PUBLISH_BOOTSTRAP_TOKEN) {
    if (bundleMode(env)) {
      try {
        console.log(JSON.stringify({
          level: "alarm",
          event: "bootstrap-token-refused",
          tenant: (tctx && tctx.tenantId) || "-",
          detail: "PUBLISH_BOOTSTRAP_TOKEN is set on a deployed instance and a request presented it. It grants star-scope publish with no KV read. Unset it on this worker and rotate anything that has been published since.",
        }));
      } catch { /* an alarm may never break the refusal it is announcing */ }
      return { entry: null, refusal: "unknown-token" };
    }
    return { entry: { space: "*", label: "bootstrap" }, refusal: null };
  }
  const kv = kvFor(env, tctx);
  const ident = identityFor(env, tctx, "publishTokens");
  if (!kv && !ident) return { entry: null, refusal: "no-store" };
  try {
    const h = await tokenFor("pub:" + token);
    // ⚠️ THE OBJECT FIRST, KV AS THE FALLBACK — and the fallback is what carries a token
    // somebody's CI is already holding across the cut. Three things read as "the object has
    // nothing": no row, a row a pre-`scope` copy wrote, and a copy that has not run at all.
    // All three fall through to KV, because a token that exists and whose SCOPE this object
    // cannot state is a token no answer can be invented for — `*` would widen it to
    // admin-equivalent and a space id would refuse a star one.
    //
    // An ERROR is different and does NOT fall through: `identityFor` throwing is an absence
    // of an answer rather than an answer, and falling through on it would make a broken
    // workspace store fail OPEN onto KV. `no-store` is what a publisher then sees, which is
    // a retry rather than an admission.
    let e = null;
    if (ident) {
      try { e = await ident.tokenRead(h); }
      catch (err) { return { entry: null, refusal: "no-store" }; }
    }
    if (!e && kv) {
      const raw = await kv.get(PUBLISH_TOKENS_KEY);
      const map = raw ? JSON.parse(raw) : {};
      e = map[h];
    }
    if (!e) return { entry: null, refusal: "unknown-token" };
    // An EXPIRED token is no token. Strictly additive: only a record that carries an
    // `expiresAt` can fail this, and every token minted before device pairing existed has
    // none — so this cannot retire a credential somebody is still using. The pairing flow
    // is the first path here that sets one.
    if (e.expiresAt && Date.parse(e.expiresAt) <= Date.now()) {
      return { entry: null, refusal: "token-expired" };
    }
    // A star-scope token is admin-equivalent — it pushes instance config, i.e. the user
    // list itself. `augur login` labels the token it mints with the holder's email, so if
    // that address is still on the roster but is no longer an admin, the token has
    // outlived the role that justified it. (Reset and remove revoke tokens outright; a
    // demotion is the one transition that left one live.) Labels an admin typed by hand
    // — "ci", "backup" — match no roster user and are unaffected.
    const refusal = tokenActorRefusal(tctx, e);
    if (refusal) {
      // Worth a line, because it is a SIGNAL and not just a refusal: a live token whose
      // holder is no longer entitled to it means something removed or demoted a person
      // without revoking their tokens, and nothing else would ever say so. The label is an
      // address, so it is not in the line — the reason and the scope are enough to go
      // looking, and the admin panel's token list has the rest.
      try {
        console.log(JSON.stringify({
          level: "notice",
          event: "publish-token-stale-actor",
          tenant: (tctx && tctx.tenantId) || "-",
          reason: refusal,
          scope: e.space === "*" ? "*" : "space",
        }));
      } catch { /* a log line may never break the refusal it is announcing */ }
      return { entry: null, refusal };
    }
    if (!anySpace && e.space !== "*" && e.space !== spaceId) {
      return { entry: null, refusal: "wrong-space" };
    }
    return { entry: e, refusal: null };
  } catch (err) { return { entry: null, refusal: "no-store" }; }
}

/**
 * The verdict alone. Every caller that only needs "may this token publish here" uses this,
 * so the reason above is opt-in rather than something three call sites have to unpack.
 */
async function publishAuth(tctx, request, env, spaceId, anySpace) {
  return (await publishAuthDetailed(tctx, request, env, spaceId, anySpace)).entry;
}

/**
 * The body a refusal answers with.
 *
 * `error` stays `forbidden` for every reason but one, so nothing that already branches on
 * it has to change. The exception is EXPIRY, which gets its own code because it is the one
 * refusal a legitimate holder will certainly hit one day and the one with a fix they can
 * run themselves — and a CLI that prints "403 forbidden" for it sends them looking for a
 * permissions problem they do not have.
 *
 * The other reasons carry a `message` and no new code. Saying "this account is no longer a
 * member here" to somebody holding a token labelled with their own address tells them
 * nothing they could not work out, and saves an afternoon.
 */
function publishRefusalBody(refusal) {
  if (refusal === "token-expired") {
    return { error: "token-expired", message: "This publish token has expired. Run `augur login` again." };
  }
  const message = {
    "not-a-member": "This token's account is no longer a member of this workspace.",
    "viewer-role": "This account can look around but not publish.",
    "not-an-admin": "This token was minted for an admin and this account is no longer one. Run `augur login` again for a token scoped to what it may still publish.",
  }[refusal];
  return message ? { error: "forbidden", message } : { error: "forbidden" };
}

// ---- The publish counter --------------------------------------------------
// Three places mint a new version — commit, rollback, and the purge that removes a URL
// prefix — and all three did the same read-compute-write against R2: read
// `manifest.json`, add one, PUT `versions/<n>.json`. R2 has no compare-and-swap, so two
// of those landing together both compute the same number and the second PUT overwrites
// the first's version file. Both publishes report success; the history quietly loses a
// point that recovery depends on.
//
// A Durable Object is single-threaded, so ONE object issuing the number cannot interleave.
// R2 keeps the payloads; the DO keeps nothing but the counter.
//
// IT FAILS CLOSED, and that is the decision worth reading twice. A deployment that binds
// TENANTS has said the DO is the issuer; falling back to the old arithmetic when the
// object is briefly unreachable would mean the guarantee is "usually atomic", which is not
// a guarantee — and the failure it would let through is silent history loss. A refused
// commit is loud and the publisher re-runs one command. So: no binding → today's
// behaviour, unchanged, on every instance that exists right now; binding present and
// unreachable → refuse.
async function nextPublishVersion(env, tctx, spaceId, cur) {
  const floor = (cur && cur.version) || 0;
  const store = tenantStub(env, tctx && tctx.tenantId);
  if (!store) return { version: floor + 1 };
  try {
    const res = await store.fetch("https://workspace/publish-version", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: spaceId, floor, workspaceId: tctx.tenantId }),
    });
    const body = res.ok ? await res.json() : null;
    // `> floor` rather than merely an integer: a counter that answered with something at
    // or below what the store already holds would name an existing version file, which is
    // the one answer that must never be acted on.
    if (body && Number.isInteger(body.version) && body.version > floor) return { version: body.version };
    throw new Error(`workspace store answered ${res.status}`);
  } catch (err) {
    try {
      console.log(JSON.stringify({
        level: "alarm",
        event: "publish-version-unavailable",
        tenant: (tctx && tctx.tenantId) || "-",
        space: spaceId,
        detail: "the workspace store could not issue a publish version, so the commit was refused rather than computed from the store's own copy — which would risk overwriting an existing version file.",
      }));
    } catch { /* an alarm may never break the refusal it is announcing */ }
    return { error: "version-unavailable" };
  }
}

// ── Manifest ceilings: refuse instead of degrade. ─────────────────────────
// An oversized manifest is not merely rude — every request on the instance pays for it (the
// refresh tick re-parses it; 1102s on live within hours of the 2026-08-22 cascade doubling
// one manifest), which multi-tenant means one space degrading everyone. And a manifest
// sprouting -conflict- prefixes is the signature of that cascade itself: protocol-5 clients
// cannot produce one (the litter filter), so arrival here means an old, patched, or hostile
// client — the write is refused, the litter never goes live. Ceilings sit ~4-8x above the
// reference instance's real size (3.8k files, 142 prefixes, 0.7MB manifest, 0 conflict
// prefixes at v499): headroom for growth, a wall against runaway. `limit` names the failing
// one so a legitimate giant space raises it deliberately, in code, not by quiet erosion.
//
// ⚠️ EVERY PATH THAT WRITES A LIVE MANIFEST GOES THROUGH THIS, not just `commit`. `fork`
// aliases a whole unit into the manifest without uploading a byte, so it is the cheapest way
// there has ever been to double a manifest's size — a ceiling it did not have to clear would
// be a ceiling with a door beside it.
function manifestCeiling(m) {
  const files = Object.keys((m && m.files) || {}).length;
  if (files > 30000) return { limit: "files", value: files, max: 30000 };
  const prefixes = (((m || {}).routing || {}).publicPrefixes || []);
  if (prefixes.length > 1000) return { limit: "prefixes", value: prefixes.length, max: 1000 };
  const litter = prefixes.filter((p) => /-conflict-[a-z0-9][a-z0-9-]*\/?$/.test(String(p))).length;
  if (litter > 20) return { limit: "conflict-prefixes", value: litter, max: 20 };
  const bytes = JSON.stringify(m).length;
  if (bytes > 8_000_000) return { limit: "manifest-bytes", value: bytes, max: 8_000_000 };
  return null;
}

// `bytesReferenced` — what a person means by "my site is this big", DEDUPLICATED BY HASH,
// which is the part that carries meaning: two URLs serving the same blob cost one blob. That
// is also what makes a fork visible as free — aliasing a hundred files adds a hundred
// manifest keys and does not move this number by a byte.
//
// ⚠️ IT IS NOT WHAT COSTS MONEY, and the gap is not small: measured on a live instance, the
// tree references 1.94 MB across 54 blobs while the bucket holds 124 MB across 1371 objects,
// because versions are never pruned and blobs are never collected. So roughly nine tenths of
// a mature workspace's footprint is rollback history. A storage ceiling has to be defined
// against RETAINED bytes or it will never fire. Hence the name: `bytesReferenced`, never
// `size`. It is computed once, at write, rather than on every read of it — a status handler
// re-parsing manifests to sum them would reproduce the CPU failure the etag guard in
// loadManifests exists because of, with the whole fleet as the multiplier.
function bytesReferencedOf(m) {
  const byHash = {};
  for (const f of Object.values((m && m.files) || {})) if (f && f.h) byHash[f.h] = Number(f.s) || 0;
  return Object.values(byHash).reduce((n, b) => n + b, 0);
}

/** The refusal a caller returns when the counter could not answer. */
const versionUnavailable = () => jsonResponse({
  error: "version-unavailable",
  message: "This workspace's store could not issue a publish version. Nothing was published. Run the same command again.",
}, 503);

/**
 * A CAPABILITY-RESTRICTED TOKEN, and the reason one has to exist.
 *
 * The purge job has to reach `/__publish/_state/delete`, which needs star scope — and star
 * scope can publish over every workspace's content, which is the boundary
 * `test/isolation.test.mjs` exists to keep. A control plane holding one would be a control
 * plane that could overwrite every tenant's site. "Hold it carefully" is not an answer.
 *
 * So a token record may carry `caps`, and the rule is deny-by-default:
 *
 *   · NO `caps` field        → unrestricted. Every token that exists today, unchanged.
 *   · `caps: ["purge"]`      → may do ONLY what `purge` names below, and nothing else.
 *   · `caps: []`             → may do nothing. An empty list is not "no restriction".
 *   · `caps: ["anything"]`   → may do nothing, because an unknown name grants nothing.
 *
 * That last one is the shape that matters: a capability added later, or a typo, must fail
 * shut. A denylist would have to be updated in step with every new route, and the step
 * somebody forgets is the one that opens something.
 */
const CAP_ROUTES = Object.freeze({
  // Erase a workspace whose own object agrees it is past its purge date, and sweep the
  // blobs nothing references any more. Not "delete anything" — `deleteWorkspace` asks the
  // workspace object for a second opinion, so this capability alone erases nothing live.
  purge: Object.freeze([["_state", "delete"], ["_state", "blob-gc"]]),
  // Update the ONE shared chrome bundle (`spaces/_engine/…`) — the rail, the switcher, the
  // admin screens, `/sw.js`, `404.html` — that one worker build serves to every workspace.
  // The ops an `--engine` publish performs: the write/preflight trio, plus the manifest and
  // version reads its base-version CAS needs. NOT `rollback` (it bypasses the downgrade guard
  // — nobody re-arms a superseded chrome for the whole deployment), NOT any real space, NOT
  // `_state`, and NOT `_instance/config` — which is what keeps this credential off the roster.
  // A token carrying this capability is minted ONLY by the control plane's `chrome` operator
  // verb; see `sharedChromeRefusal`.
  chrome: Object.freeze([
    ["_engine", "check"], ["_engine", "blob"], ["_engine", "commit"],
    ["_engine", "manifest"], ["_engine", "versions"], ["_engine", "version"],
  ]),
});

function capabilityRefusal(entry, spaceId, op) {
  const caps = entry && entry.caps;
  // Absent, or not a list at all — unrestricted, exactly as before this existed. A
  // malformed value is treated as absent rather than as empty on purpose: a corrupt record
  // must not silently disable a working credential, and it cannot GRANT anything either,
  // because grants come only from names that match below.
  if (!Array.isArray(caps)) return null;
  for (const c of caps) {
    for (const [s, o] of (CAP_ROUTES[c] || [])) {
      if (s === spaceId && o === op) return null;
    }
  }
  return "capability-not-granted";
}

/**
 * THE PUBLISH OPS ON A SPACE THAT ONLY READ IT, as a map from op to the method that reads.
 *
 * These five are the whole backup surface — what `augur export` walks with a publish token
 * and no account credentials. Everything else a space takes (`check`, `blob` PUT, `commit`,
 * `fork`, `rollback`) ends in bytes the next request serves.
 *
 * ⚠️ IT NAMES THE READS, NOT THE WRITES, and that direction is the whole of why it is
 * trustworthy. A denylist of writes has to be widened in step with every publishing verb
 * added later, and the step somebody forgets is the one that opens something — the same
 * argument `CAP_ROUTES` above is written on. `blob` is in both sets and is told apart by
 * METHOD, which is why this is a map and not a list of names.
 */
const PUBLISH_READ_OPS = Object.freeze({
  manifest: "GET", versions: "GET", version: "GET", blob: "GET", currency: "GET",
});

/**
 * ⚠️ THE SHARED CHROME IS NOT ANY ONE WORKSPACE'S TO WRITE.
 *
 * `spaces/_engine/…` is the one key `bundleKey` deliberately leaves global on a prefixing
 * deployment: one worker build serves every workspace, so one chrome bundle is correct
 * rather than a leak. The credential that can write it is not shared in the same way — it is
 * minted per workspace, at that workspace's own Settings panel, against that workspace's own
 * roster. So the authority was scoped to one workspace while its effect was scoped to the
 * deployment, and any hosted workspace's admin could rewrite `/admin/index.html` and
 * `/sw.js` for every other customer on it.
 *
 * ⚠️ THE DISCRIMINATOR IS `bundleWorkspaceSegment(...).workspace`, WHICH IS THE FACT THE
 * SHARING ITSELF DEPENDS ON — one fact about the deployment, not two that could disagree.
 * The tempting one is `env.TENANTS`, and it is wrong: `wrangler-preflight.mjs` refuses a
 * suffix with no binding and does NOT refuse a binding with no suffix, which is a legal,
 * real shape — an instance using the workspace object as its identity store while still
 * serving the one workspace its build named. There `bundleKey` writes no segment, the chrome
 * is shared with nobody, and refusing that operator's own chrome publish would be this
 * function inventing a cross-tenant problem their deployment does not have.
 *
 * ⚠️ THERE IS NOW EXACTLY ONE CAPABILITY THAT SATISFIES IT, and it is minted only by the
 * control plane's `chrome` operator verb. `CAP_ROUTES.chrome` names the write/preflight trio
 * plus the manifest and version reads its base-version CAS needs — nothing else, and NOT
 * `rollback`. A workspace's own star-scope token carries no `caps` at all and is still
 * refused here: `capabilityGrantsRoute` is a positive check, and absence of `caps` is not a
 * grant, which is the exact inverse of how `capabilityRefusal` treats the same field.
 *
 * ⚠️ `rollback` IS A WRITE HERE. It republishes an old manifest under a NEW version and
 * bypasses the engine-downgrade guard by design, so it is the one path that can put a
 * superseded chrome back on every workspace at once — including one somebody pushed while
 * this door was open. With `commit` refused there is nothing legitimate left for it to undo,
 * so closing it costs the deployment nothing and leaving it open costs it the whole gate.
 */

/**
 * Does this credential's capability list EXPLICITLY name this route? A positive check, and
 * the exact inverse of `capabilityRefusal`'s "absent caps ⇒ unrestricted": here absence is
 * NOT a grant. Only a credential whose `caps` name this (space, op) may pass the shared-chrome
 * gate — for `_engine` writes that is the `chrome` capability and nothing else, so a plain star
 * token (no `caps`) is not admitted, which is the whole of VERIFY clause 2.
 */
function capabilityGrantsRoute(entry, spaceId, op) {
  const caps = entry && entry.caps;
  if (!Array.isArray(caps)) return false;
  return caps.some((c) => (CAP_ROUTES[c] || []).some(([s, o]) => s === spaceId && o === op));
}

function sharedChromeRefusal(env, tctx, who, spaceId, op, method) {
  if (spaceId !== ENGINE_SPACE_ID) return null;
  if (!bundleWorkspaceSegment(env, tctx && tctx.tenantId).workspace) return null;
  if (PUBLISH_READ_OPS[op] === method) return null;
  // The one narrow key: a credential explicitly granted this route by a capability may write
  // the shared chrome. The `chrome` capability is minted only by the operator verb; a star
  // token carries no capability and is still refused here.
  if (capabilityGrantsRoute(who, spaceId, op)) return null;
  return "chrome-not-writable-here";
}

async function publishApi(tctx, request, url, env) {
  const [spaceId, op, arg] = url.pathname.slice("/__publish/".length).split("/");
  if (!spaceId || !op || !/^[a-z0-9_][a-z0-9-]*$/.test(spaceId)) return jsonResponse({ error: "bad-path" }, 400);

  // ── working marks (`F-presence-marks`) ─────────────────────────────────────
  //
  // AHEAD OF THE BUNDLE-STORE GUARD, deliberately: a mark is not published content and
  // holds nothing the store knows about, so an instance serving from ASSETS — `augur dev`,
  // `npm run offline`, a raw engine build — is exactly where two agents most need to stay
  // out of each other's way, and 501 there would be an accident of where the check sits.
  //
  // ANY VALID PUBLISH TOKEN, whatever its scope. A mark names a path, not a space, and a
  // space-scoped token holder is precisely the person whose work-start is worth announcing.
  // The capability gate still applies, so a restricted credential (the control plane's
  // purge token) reaches this no more than it reaches anything else.
  if (spaceId === "_marks") {
    const a = await publishAuthDetailed(tctx, request, env, spaceId, true);
    if (!a.entry) return jsonResponse(publishRefusalBody(a.refusal), 403);
    if (capabilityRefusal(a.entry, spaceId, op)) {
      return jsonResponse({ error: "forbidden", reason: "capability-not-granted" }, 403);
    }
    // WHO, from the credential and never from the body. `augur login` labels a token with
    // the holder's address; a token an admin minted by hand carries whatever they typed,
    // which hashes to a stable id that resolves to no roster face — honest, and better
    // than letting the caller name itself.
    const who = { personId: personId(a.entry.label || "") };
    if (op === "list" && request.method === "GET") {
      return jsonResponse({ ...(await readMarks(tctx, env)), ttlMs: MARK_TTL_MS, maxTtlMs: MARK_TTL_MAX_MS });
    }
    let body = null;
    if (request.method === "POST") {
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    }
    if (op === "set" && request.method === "POST") {
      const out = await writeMark(tctx, env, who, { path: body && body.path, ttl: body && body.ttl });
      return out.error ? jsonResponse(out, out.error === "bad-input" ? 400 : 503) : jsonResponse(out);
    }
    if (op === "clear" && request.method === "POST") {
      const out = await clearMark(tctx, env, who, { path: body && body.path });
      return out.error ? jsonResponse(out, out.error === "bad-input" ? 400 : 503) : jsonResponse(out);
    }
    return jsonResponse({ error: "unknown-op" }, 400);
  }

  if (!env.BUNDLES) return jsonResponse({ error: "bundle-store-not-configured" }, 501);
  // This workspace's view of the store. `blobs/` is content-addressed and shared, so the
  // three `blobs/…` operations below deliberately keep using the binding directly — the
  // key is the digest and the digest means the same thing to every workspace.
  const bundles = bundlesFor(env, tctx && tctx.tenantId);

  // Self-serve token exchange: trade an existing web login for a publish token
  // (no admin distribution step — `augur login` calls this once and saves it).
  // Admins get every space; everyone else gets the default space. Same
  // credential check as /__auth; the response carries the token exactly once.
  if (spaceId === "_login" && op === "token" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const email = body && body.email;
    const rlIds = loginRlIds(request, email);
    if (await loginThrottled(env, rlIds)) {
      return jsonResponse({ error: "rate-limited", message: "Too many attempts. Wait a few minutes." }, 429);
    }
    if (await loginSlowed(env, rlIds)) await new Promise((r) => setTimeout(r, LOGIN_SLOW_MS));
    const u = userByEmail(email, tctx.USERS);
    const pass = String((body && body.password) || "");
    // Resolve through effectiveSecret even when no user matched (a throwaway address),
    // so an unknown email pays the SAME users:secrets KV read as a known one — without
    // this the KV read is a residual timing oracle after the dummy-hash equalizes PBKDF2.
    const real = await effectiveSecret(env, u || { email: "\x00nouser" });
    // Always run PBKDF2 (real or dummy) so an unknown email can't be told apart by timing.
    const ok = await verifyPassword(pass, real || DUMMY_HASH);
    // Same distinction the web gate makes: a roster user with no secret was reset, and
    // telling them "bad credentials" sends them looking for a typo in a password that
    // no longer exists. `augur login` surfaces `message` when present.
    if (u && !real) {
      await loginFail(env, rlIds);
      return jsonResponse({ error: "password-reset", message: RESET_NOTICE }, 403);
    }
    if (!u || !ok) {
      await loginFail(env, rlIds);
      return jsonResponse({ error: "bad-credentials" }, 403);
    }
    const kv = kvFor(env, tctx);
    if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
    // A viewer signs in, comments and drives boards like anyone else, but can never
    // hold a publish token — the role for accounts whose password is public knowledge
    // (a demo instance's loginHint). Checked after credential verification so an
    // unknown email and a viewer stay indistinguishable in timing.
    if (roleOf(u) === "viewer") {
      return jsonResponse({ error: "viewer-role", message: "This account can look around but not publish." }, 403);
    }
    // The SAME mint the pairing flow uses. It was a second copy of this code until the
    // token grew an expiry, at which point the copy was a door that would have kept
    // handing out credentials that live forever while the other one stopped.
    const minted = await mintPublishToken(kv, tctx, u, { env });
    if (!minted) return jsonResponse({ error: "no-default-space" }, 500);
    // `expiresAt` is in the response so the CLI can say when, rather than the holder
    // finding out from a 403 on the day it matters.
    return jsonResponse({ token: minted.token, space: minted.space, expiresAt: minted.expiresAt });
  }

  // Sanitized contributor profiles for identity-less builds (any valid publish
  // token): name/initials/color/avatar URL + email aliases — exactly what the
  // build needs to keep editor chips on cards, and nothing secret. The avatar
  // URLs resolve at runtime against the instance's real identity, so a build
  // from a bare space clone renders the same faces an identity-file build does.
  if (spaceId === "_instance" && op === "profiles" && request.method === "GET") {
    const anyAuth = await publishAuthDetailed(tctx, request, env, spaceId, true);
    if (!anyAuth.entry) return jsonResponse(publishRefusalBody(anyAuth.refusal), 403);
    // This route resolves auth on its own, ahead of the shared check below, so it needs
    // its own capability gate — and it needs one badly: it answers with every roster
    // member's address and aliases, which a purge credential has no business reading.
    if (capabilityRefusal(anyAuth.entry, spaceId, op)) {
      return jsonResponse({ error: "forbidden", reason: "capability-not-granted" }, 403);
    }
    // No `role` here: any valid publish token (including a non-admin default-space one)
    // can read this, and it only needs the fields that render editor faces — leaking
    // who the admins are is gratuitous.
    const profiles = tctx.USERS.map((u) => ({
      id: personId(u.email),
      email: u.email, emails: u.emails || [],
      name: u.name, initials: u.initials || "", color: u.color || "#4f46e5",
      avatar: avatarUrl(u),
    }));
    return jsonResponse({ profiles });
  }

  const auth = await publishAuthDetailed(tctx, request, env, spaceId);
  if (!auth.entry) return jsonResponse(publishRefusalBody(auth.refusal), 403);
  const who = auth.entry;
  // ONE PLACE, BEFORE EVERY BRANCH. A restricted token is refused here rather than at each
  // route it must not reach, so a route added later is closed to it by default instead of
  // by somebody remembering. This is the check that makes a purge credential safe to hand
  // to the control plane: it is the reason it cannot publish.
  if (capabilityRefusal(who, spaceId, op)) {
    return jsonResponse({ error: "forbidden", reason: "capability-not-granted" }, 403);
  }
  // AND THE SAME CHOKEPOINT ASKS THE OTHER QUESTION, one line later. The check above is
  // about the CREDENTIAL — what this token was granted. This one is about the OBJECT — the
  // chrome bundle is every workspace's, so no workspace's own token may write it however
  // wide its scope. Two refusals rather than one because they fail for different reasons and
  // a holder has to be able to tell them apart. See `sharedChromeRefusal`.
  const chromeRefusal = sharedChromeRefusal(env, tctx, who, spaceId, op, request.method);
  if (chromeRefusal) {
    return jsonResponse({
      error: "forbidden",
      reason: chromeRefusal,
      message: "The page chrome on this deployment is one build shared by every workspace, "
        + "so no workspace's own publish token may write it. Reading it is unaffected.",
    }, 403);
  }

  // Instance config push (star-scope tokens only): the deploy shell's identity +
  // knobs become config/instance.json — the bundle-mode source loadConfig reads.
  // ── every state family, for export and for a restore ───────────────────────
  //
  // `MIG-export-endpoints`. The publish routes above cover the BUNDLE STORE — the manifests,
  // the versions, the blobs — and `augur export` walks them. Nothing covered the rest: the
  // roster, the invites, the publish tokens, the statuses, the card names, the boards, the
  // comment threads, the pins. A backup of a workspace was a backup of what it had
  // published and nothing about who could publish it or what anybody had said about it.
  //
  // IT IS DRIVEN BY THE INVENTORY, not by a list written here. `scripts/lib/state-inventory.mjs`
  // is the checked-and-gated account of what exists; walking it means a family added there
  // is exported without anybody remembering to add it twice, and a family NOT there fails
  // the build rather than quietly missing a backup.
  //
  // ⛔ THE CREDENTIAL IS EXCLUDED BY CONSTRUCTION, not by a filter. This walks entries whose
  // destination is the WORKSPACE; `users:secrets` is destined for the account store, so it
  // is not reachable from here at all. That is worth more than a denylist: a denylist has to
  // be remembered, and the thing it would protect is every password on the instance.
  if (spaceId === "_state") {
    // Star scope only. This answers with the roster, the invites and the publish-token
    // hashes — everything a space-scoped token holder has no business reading.
    if (who.space !== "*") return jsonResponse({ error: "forbidden" }, 403);

    if (op === "export" && request.method === "GET") {
      const out = await exportState(tctx, env);
      return jsonResponse({ workspace: tctx.tenantId, generatedAt: new Date().toISOString(), ...out });
    }
    if (op === "asset" && request.method === "GET") {
      // The bytes the `assets` rows point at. Mirrors `/__publish/<space>/blob/<hash>`,
      // which walks `blobs/` and would never see these.
      if (!/^[0-9a-f]{40}$/.test(arg || "")) return jsonResponse({ error: "bad-input" }, 400);
      const obj = bundles ? await bundles.get(ASSET_R2_PREFIX + arg) : null;
      if (obj) {
        return new Response(obj.body, {
          headers: {
            "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream",
            "cache-control": "no-store",
          },
        });
      }
      // The same R2-then-KV fallback the serving path uses, for the same reason: an image
      // pasted before canvas bytes moved to R2 is still a `basset:<hash>` value, and a
      // backup that could not read it would be a backup missing every image on every
      // instance that has been running for a while.
      //
      // ⚠️ AND FOR THE SAME REASON IT IS OFF WHERE THE WORKSPACE COMES FROM THE HOST.
      // `basset:<hash>` is one flat KV namespace with no segment in it, so on a deployment
      // holding several workspaces that key is unattributable — reading it would let any
      // workspace's backup take bytes another workspace pasted. `legacyIsOurs` is the same
      // judgement the KV overlay makes about the same kind of key.
      const kvStore = bundleWorkspaceSegment(env, tctx && tctx.tenantId).legacyIsOurs ? kvFor(env) : null;
      const legacy = kvStore ? await kvStore.getWithMetadata(ASSET_PREFIX + arg, { type: "arrayBuffer" }) : null;
      if (!legacy || !legacy.value) return jsonResponse({ error: "not-found" }, 404);
      return new Response(legacy.value, {
        headers: {
          "content-type": (legacy.metadata && legacy.metadata.ct) || "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    }
    if (op === "asset" && request.method === "PUT") {
      if (!/^[0-9a-f]{40}$/.test(arg || "")) return jsonResponse({ error: "bad-input" }, 400);
      if (!env.BUNDLES) return jsonResponse({ error: "bundle-store-not-configured" }, 501);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > ASSET_MAX_BYTES) return jsonResponse({ error: "too-large" }, 413);
      // ⛔ THE HASH IS CHECKED AGAINST THE BYTES. A restore is a write path that takes a
      // key from the caller, and content addressing is only a guarantee while the content
      // matches the address — a copy that was corrupted on its way to disk would otherwise
      // be written back under a name that says it is fine, which is the exact failure the
      // canvas-image backup work was about.
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
      if (hash !== arg) return jsonResponse({ error: "hash-mismatch", expected: arg, got: hash }, 409);
      const ct = (request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
      await bundles.put(ASSET_R2_PREFIX + hash, buf, {
        httpMetadata: { contentType: /^image\//.test(ct) ? ct : "image/jpeg" },
      });
      return jsonResponse({ ok: true, hash });
    }
    if (op === "delete" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* a dry run needs no body */ }
      return jsonResponse(await deleteWorkspace(tctx, env, {
        confirm: body && body.confirm,
        dryRun: !(body && body.confirm),
      }));
    }
    // The one-way move onto the workspace segment. Same shape as `delete` and `blob-gc`
    // above, and for the same structural reason: only something holding `BUNDLES` can
    // rewrite an R2 key, and the only things holding it are this worker and whoever has the
    // account credential. This route needs no account credential at all — it is addressed
    // at the workspace's own hostname with the star token that workspace's admin already
    // has. See `rekeyToSegment`.
    if (op === "rekey" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* a dry run needs no body */ }
      return jsonResponse(await rekeyToSegment(tctx, env, {
        confirm: body && body.confirm,
        families: body && body.families,
        limit: body && body.limit,
        dryRun: !(body && body.confirm),
      }));
    }
    // The identity half of the same move. A SEPARATE op rather than a family on the one
    // above, because the two answer different questions of a deployment — one is "is my
    // published content where I read it", the other is "is my roster" — and an operator
    // running a content move must not silently move the login gate's documents too.
    if (op === "identity-rekey" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* a dry run needs no body */ }
      return jsonResponse(await rekeyIdentityToSegment(tctx, env, {
        confirm: body && body.confirm,
        families: body && body.families,
        limit: body && body.limit,
        dryRun: !(body && body.confirm),
      }));
    }
    if (op === "blob-gc" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* a dry run needs no body */ }
      return jsonResponse(await blobGc(env, { dryRun: !(body && body.confirm === "reclaim") }));
    }
    if (op === "freeze") {
      if (request.method === "GET") return jsonResponse({ freeze: await readFreeze(tctx, env) });
      let body = null;
      try { body = await request.json(); } catch (e) { /* an empty body means freeze */ }
      return jsonResponse(await setFreeze(tctx, env, {
        on: !(body && body.thaw === true),
        reason: body && body.reason,
        by: who.label || "",
      }));
    }
    if (op === "status" && request.method === "GET") {
      return jsonResponse(await workspaceStatus(tctx, env));
    }
    if (op === "import" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
      return jsonResponse(await importState(tctx, env, body));
    }
    return jsonResponse({ error: "unknown-op" }, 400);
  }

  if (spaceId === "_instance" && op === "config" && request.method === "POST") {
    if (who.space !== "*") return jsonResponse({ error: "forbidden" }, 403);
    const body = await request.text();
    let cfg;
    try { cfg = JSON.parse(body); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    // Same downgrade rule one level up: a stale clone's `--all` would POST its
    // old instance.json (engineVersion, knobs, the user roster) over the live
    // one. When live carries an engineVersion, an older or absent incoming one
    // is a stale tree — refuse; the shell's next deploy pushes a current config.
    try {
      const liveObj = await bundles.get("config/instance.json");
      const live = liveObj ? JSON.parse(await liveObj.text()) : null;
      if (live && live.engineVersion) {
        const incoming = cfg.engineVersion || "";
        if (!incoming || semverBehind(incoming, live.engineVersion)) {
          return jsonResponse({ error: "engine-downgrade", live: live.engineVersion, publishing: incoming || null }, 409);
        }
      }
    } catch (e) {}
    await bundles.put("config/instance.json", body);
    cfgAt = 0;
    // The deploy that ships an updated identity file also retires the roster
    // overlay entries it supersedes: an `add` the config now names is a duplicate
    // record (invites flow back into the file via roster-update), and a `remove`
    // for someone the config no longer names has finished its job. The
    // users:secrets tombstones are NOT touched — they are the security boundary;
    // this is only the roster list converging back to one record.
    try {
      const kv = kvFor(env, tctx);
      if (kv) {
        const named = new Set((cfg.users || []).map((u) => String((u && u.email) || "").toLowerCase()).filter(Boolean));
        const roster = await readRoster(env, tctx);
        const add = Object.fromEntries(Object.entries(roster.add).filter(([e]) => !named.has(String(e).toLowerCase())));
        const remove = roster.remove.filter((e) => named.has(String(e).toLowerCase()));
        if (Object.keys(add).length !== Object.keys(roster.add).length || remove.length !== roster.remove.length) {
          const drained = { ...roster, add, remove };
          await kv.put(USER_ROSTER_KEY, JSON.stringify(drained));
          // ⚠️ `cfg.users`, NOT `tctx.CONFIG_USERS`. This request loaded its context from the
          // config this push REPLACES, and the whole point of the drain is that the new file
          // now names somebody the overlay was carrying. The workspace object decides
          // `source` from the list it is handed and then tombstones the overlay rows the
          // drained `add` no longer carries, so passing the old list deletes exactly the
          // people this push exists to promote. See mirrorRosterDocs.
          await mirrorRosterDocs(tctx, env, { roster: drained }, cfg.users || []);
          bustRosterOverlay(tctx.tenantId);
        }
      }
    } catch (e) {}
    return jsonResponse({ ok: true });
  }

  if (op === "check" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const files = (body && body.files) || {};
    // A blob already referenced by ANY live manifest exists in the store —
    // content addressing means cross-space and engine duplicates never re-upload.
    //
    // ⚠️ A PUBLISH IS A CONVERSATION WITH THE STORE, AND THE SERVED VIEW IS NOT IT. The view
    // swaps `_engine` for the worker's own assets copy when that is the newer build
    // (D-chrome-auto-on-deploy), and that copy carries no version, no publish provenance, and
    // hashes that are not R2 keys. Answered from it, `liveVersion` was 0 while the commit's
    // compare-and-swap compared against the store's real version — every `publish.mjs
    // --engine` after a worker deploy looped on `stale-base` until it gave up — and blobs
    // only the assets copy holds were reported present, so the client skipped uploading them
    // and the commit refused `blobs-missing` (both measured 2026-09-02: v174 in the store, 0
    // in the answer). So when the served `_engine` is the assets one, the check swaps the
    // store's own document back in before anything is counted or reported. Unreadable ⇒ no
    // store document, exactly as before.
    const all = { ...(await loadManifests(tctx.tenantId, env, true)) };
    if (all[ENGINE_SPACE_ID] && all[ENGINE_SPACE_ID].__fromAssets) {
      let stored = null;
      try {
        const obj = await bundles.get(`spaces/${ENGINE_SPACE_ID}/manifest.json`);
        stored = obj ? JSON.parse(await obj.text()) : null;
      } catch (e) { stored = null; }
      if (stored) all[ENGINE_SPACE_ID] = stored; else delete all[ENGINE_SPACE_ID];
    }
    const have = new Set();
    for (const id in all) for (const k in all[id].files) have.add(all[id].files[k].h);
    const missing = [...new Set(Object.values(files).map((f) => f && f.h).filter(Boolean))]
      .filter((h) => !have.has(h));
    const cur = all[spaceId];
    // filesUnchanged + liveSource let the client skip a commit that would change
    // nothing (same content, same provenance) — a version bump with no meaning.
    const curFiles = (cur && cur.files) || null;
    const keys = curFiles ? Object.keys(files) : [];
    const filesUnchanged = !!curFiles && keys.length === Object.keys(curFiles).length
      && keys.every((p) => files[p] && curFiles[p] && files[p].h === curFiles[p].h);
    return jsonResponse({
      missing,
      liveVersion: (cur && cur.version) || 0,
      // The public URLs GENUINELY live RIGHT NOW (backedPublicPrefixes — a dead,
      // unbacked entry is filtered out, exactly like the guard at commit), so a
      // client can see it is about to take some of them down before it uploads a
      // single blob, without also being told to pass --allow-unpublish for a page
      // that already 404s and was never really there to lose. Advisory only: the
      // refusal that counts happens at commit, where it also covers the
      // one-round-trip fast path (which never calls check) and any client that has
      // never heard of this field.
      livePrefixes: backedPublicPrefixes(cur),
      filesUnchanged,
      liveSource: cur && cur.source
        ? { sha: cur.source.sha || null, dirty: !!cur.source.dirty } : null,
      // Which engine baked what is live. filesUnchanged alone is not "no-op": an
      // engine change that happens to bake identical bytes still needs a commit to
      // advance builtWithEngine, or the drift alarm cries wolf forever after.
      liveBuiltWith: (cur && cur.builtWith && cur.builtWith.engine) || null,
      protocol: PUBLISH_PROTOCOL,
      // The floor, so a client can find out it is too old BEFORE it spends a blob
      // upload finding out at commit. Advisory here, enforced there — same split as
      // livePrefixes above, and for the same reason: commit is the only chokepoint the
      // one-round-trip fast path also goes through.
      minProtocol: tctx.MIN_CLIENT_PROTOCOL || undefined,
      engine: tctx.INSTANCE_ENGINE_VERSION || null,
    });
  }

  // ── Read side: what `augur export` walks ───────────────────────────────────
  // The store is the only copy of live content, and a publish from a dirty tree
  // exists in no repository at all — so an off-Cloudflare copy has to be takeable
  // without Cloudflare account credentials. These three reads are the whole
  // backup surface, and they are deliberately the mirror image of the writes
  // beside them: same bearer auth, same paths, same space scoping.
  //
  // Read is strictly weaker than the write these tokens already carry (a token
  // that can overwrite every byte a visitor sees can hardly be trusted less with
  // reading them), so this grants no privilege that wasn't already granted.
  if (op === "manifest" && request.method === "GET") {
    const obj = await bundles.get(`spaces/${spaceId}/manifest.json`);
    if (!obj) return jsonResponse({ error: "unknown-space" }, 404);
    return new Response(obj.body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // What is current in this workspace and what has been left behind — the SAME read the
  // gallery paints from, reached with the credential an agent actually holds.
  //
  // `F-currency-default` asks for "what is current here" to be answerable in one call, and
  // the browser's door (`/__currency`) is gated on a SESSION COOKIE, which no agent has:
  // `augur login` mints a publish token, not a session. Without this the read is exposed to
  // people and not to agents, which is half the item. It is the weakest thing a publish
  // token can do — it names units this token could overwrite and reads their dates — and it
  // is scoped to this token's own workspace, unlike the cookie door, which answers about
  // the whole instance.
  //
  // `?since=14d` is the whole of "what changed here lately".
  if (op === "currency" && request.method === "GET") {
    return currencyAnswer(tctx, request, url, env, spaceId);
  }

  // Version list, newest first. Manifest history is never pruned and blobs are
  // never garbage-collected, so this doubles as the rollback menu.
  if (op === "versions" && request.method === "GET") {
    const versions = [];
    let cursor;
    try {
      do {
        const page = await bundles.list({ prefix: `spaces/${spaceId}/versions/`, cursor, limit: 1000 });
        for (const o of page.objects) {
          const n = parseInt(o.key.slice(o.key.lastIndexOf("/") + 1), 10);
          if (n) versions.push(n);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch (e) { return jsonResponse({ error: "list-failed" }, 502); }
    return jsonResponse({ versions: versions.sort((a, b) => b - a) });
  }

  // One historical manifest, by version. (The live pointer is `manifest` above.)
  if (op === "version" && request.method === "GET") {
    const v = parseInt(arg, 10);
    if (!v || v < 1) return jsonResponse({ error: "bad-version" }, 400);
    const obj = await bundles.get(`spaces/${spaceId}/versions/${v}.json`);
    if (!obj) return jsonResponse({ error: "unknown-version" }, 404);
    return new Response(obj.body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Blob bytes by hash. Content-addressed and immutable, so this is safe to cache
  // hard — an export of thousands of blobs is the main consumer.
  if (op === "blob" && request.method === "GET") {
    if (!/^[0-9a-f]{64}$/.test(arg || "")) return jsonResponse({ error: "bad-hash" }, 400);
    const obj = await env.BUNDLES.get("blobs/" + arg);
    if (!obj) return jsonResponse({ error: "unknown-blob" }, 404);
    return new Response(obj.body, {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    });
  }

  if (op === "blob" && request.method === "PUT") {
    if (!/^[0-9a-f]{64}$/.test(arg || "")) return jsonResponse({ error: "bad-hash" }, 400);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > BLOB_MAX_BYTES) return jsonResponse({ error: "bad-size" }, 413);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    if (digest !== arg) return jsonResponse({ error: "hash-mismatch" }, 400);
    await env.BUNDLES.put("blobs/" + arg, buf);
    return new Response(null, { status: 204 });
  }

  if (op === "commit" && request.method === "POST") {
    let m;
    try { m = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    if (!m || m.id !== spaceId || !m.files || typeof m.files !== "object") {
      return jsonResponse({ error: "bad-manifest" }, 400);
    }
    // Manifest ceilings — see manifestCeiling. Refuse instead of degrade.
    const ceiling = manifestCeiling(m);
    if (ceiling) {
      return jsonResponse({ error: "manifest-ceiling", ...ceiling }, 413);
    }
    // ── Protocol floor. Off by default (see MIN_CLIENT_PROTOCOL) — a floor nobody set
    // must never be why a publish fails. Where it IS set, refusing here beats accepting
    // a write from a client too old to speak the guards it is about to walk past: a
    // pre-protocol-3 CLI sends no `baseVersion`, so the stale-base check has nothing to
    // compare and the revert guard silently degrades to "allowed". An old client cannot
    // know that; it just sees a successful publish and someone else's work disappear.
    // A client that omits `clientProtocol` entirely predates the field, so it is by
    // definition below any floor above zero.
    const clientProtocol = Number.isInteger(m.clientProtocol) ? m.clientProtocol : 0;
    delete m.clientProtocol; // transport-only, like allowUnpublish — never persisted
    if (tctx.MIN_CLIENT_PROTOCOL && clientProtocol < tctx.MIN_CLIENT_PROTOCOL) {
      return jsonResponse({
        error: "cli-outdated",
        clientProtocol,
        minProtocol: tctx.MIN_CLIENT_PROTOCOL,
        protocol: PUBLISH_PROTOCOL,
        upgrade: "npx augur@latest",
      }, 426);
    }
    // Prune any publicPrefixes entry THIS manifest declares without backing it with
    // a file, before anything downstream — the ownership checks, the unpublish
    // guard, the persisted manifest — ever sees it. A legitimate build never
    // produces one (build.js only ever adds a prefix alongside the files under it),
    // so this only ever catches drift: a bug elsewhere, a hand-edited manifest, a
    // reconcile patch that copied a routing entry without its files. Pruning here,
    // at the one chokepoint that writes the live manifest, is what stops a dead
    // entry from persisting to trap the NEXT publisher — nothing this commit writes
    // can ever contain a prefix with nothing behind it, so there is nothing left to
    // misread as live on a future commit. (It also closes the mirror-image hole: a
    // manifest that CLAIMS to keep a live prefix without actually shipping files for
    // it would otherwise slip past the guard below as "kept" while quietly creating
    // a new orphan.)
    if (m.routing && Array.isArray(m.routing.publicPrefixes)) {
      m.routing.publicPrefixes = backedPublicPrefixes(m);
    }
    const liveManifests = await loadManifests(tctx.tenantId, env, true);
    // ── Untrusted-token guard — the fix that keeps a space token to its own space. Any
    // signed-in user can mint a default-space token (`augur login`), so without this a
    // user could commit a manifest that claims /admin/* or /__canvas/canvas.js (engine
    // chrome) or another space's paths, and shadow them — then run script as the next
    // admin who loads that asset. STAR-scope tokens ("*") are admin/CI-only and already
    // all-powerful (they push instance config, i.e. the user list), so they are exempt —
    // that is how a single-workspace instance's own CI publishes /admin and /404.html under
    // `_engine`. ⚠️ IT IS NO LONGER HOW A SHARED DEPLOYMENT'S CHROME IS WRITTEN, and reading
    // it that way is the mistake this sentence exists to stop: where the chrome bundle is one
    // object serving every workspace, `sharedChromeRefusal` has already refused the request
    // before it reaches here, star scope or not. Star scope reaches `_engine` exactly where
    // `_engine` is this deployment's own.
    if (who.space !== "*") {
      const commitIsDefault = spaceId === ((tctx.SPACES.find((s) => s.default) || {}).id || null);
      const ownsPath = (k) => pathOwnedBySpace(k, spaceId, tctx.SPACES);
      for (const k in m.files) {
        if (!ownsPath(k)) return jsonResponse({ error: "path-not-owned", path: k }, 403);
        // Belt-and-suspenders: never overwrite a path another LIVE space (incl _engine)
        // already serves, whatever the base rules above would allow.
        for (const otherId in liveManifests) {
          if (otherId === spaceId) continue;
          if (liveManifests[otherId].files && liveManifests[otherId].files[k]) {
            return jsonResponse({ error: "path-conflict", path: k, owner: otherId }, 409);
          }
        }
      }
      // Routing fragment — derived site routing trusts this verbatim (public prefixes,
      // the admin-only seal, the MCP allowlist), so a rogue fragment could open the whole
      // site or un-seal a restricted space. Validate every field this space may assert.
      const rf = m.routing;
      if (rf && typeof rf === "object") {
        for (const p of rf.publicPrefixes || []) {
          // See isPublishablePublicPrefix: ownership, AND never the bare root. "/" passing
          // the ownership rule was the hole — the default space really does own the root,
          // and a root prefix opens every gated path on the site to anonymous visitors,
          // from the token any signed-in user mints with `augur login`.
          if (!isPublishablePublicPrefix(p, spaceId, tctx.SPACES)) {
            return jsonResponse({ error: "bad-routing-prefix", path: p }, 400);
          }
        }
        for (const k in rf.versionMap || {}) {
          if (!ownsPath(k)) return jsonResponse({ error: "bad-routing-version", path: k }, 400);
        }
        // Public skill assets are a default-space concept only, and live under /skills/.
        if (rf.publicSkillPrefixes) {
          if (!commitIsDefault) return jsonResponse({ error: "skill-prefixes-not-default" }, 403);
          for (const p of rf.publicSkillPrefixes) {
            if (typeof p !== "string" || !p.startsWith("/skills/")) {
              return jsonResponse({ error: "bad-skill-prefix", path: p }, 400);
            }
          }
        }
        // NOTE: a space's declared MCP targets (rf.mcpAllowlist, rf.mcpPaths) are NOT
        // constrained here. A space legitimately declares its clients' own domains (one
        // planner prototype names hundreds, on their own TLDs — not under any instance
        // suffix) and the API endpoints it talks to, and that IS the feature. The proxy's
        // real controls live in mcpProxy: only a DECLARED host is reachable, redirects
        // aren't followed, IP-literal targets are rejected, and only a declared path
        // passes, whole and exact, with a sanitized response. Constraining which targets a
        // space may declare added little over those and broke clients on their own domains.
      }
      // adminOnly/default are NOT self-asserted from a non-star manifest — a token scoped
      // to an admin-only space must not publish itself public (or claim default). Preserve
      // the trusted prior value; trust-on-first-publish only when there is no prior.
      const prior = liveManifests[spaceId] && liveManifests[spaceId].space;
      const declared = m.space && typeof m.space === "object" ? m.space : { id: spaceId };
      m.space = {
        ...declared, id: spaceId,
        adminOnly: prior ? !!prior.adminOnly : !!declared.adminOnly,
        default: prior ? !!prior.default : !!declared.default,
      };
    }
    // ── Stale-base check — refuse a commit computed against a version live has
    // moved past. Optional: a client declares the live version its delta and its
    // conflict classification were based on (`baseVersion`), and a mismatch means
    // someone published in between — the client must re-evaluate against what is
    // live NOW, so the refusal carries it. Answered from a fresh manifest read,
    // not the isolate cache, because the race this closes lives inside that
    // cache's staleness window. Clients that never send the field (older engines)
    // commit exactly as before. Checked before the unpublish guard: a stale tree
    // often also drops pages, and "reconcile first" is the useful verdict there —
    // after reconciling, the removal usually turns out not to be one.
    const curObj = await bundles.get(`spaces/${spaceId}/manifest.json`);
    const cur = curObj ? JSON.parse(await curObj.text()) : null;
    // ── Engine-downgrade guard. `_engine` is the instance's chrome, service
    // worker, and the runtime-chrome switch; a publish from a clone that predates
    // those files would 404 them site-wide and silently switch composition off —
    // and `_engine` bypasses every other guard (no reconcile client-side, no
    // publicPrefixes for the unpublish guard, star tokens skip ownership checks).
    // Compare against live: dropping /sw.js, dropping every /_chrome.* (new
    // hashes are fine — the bundle renames on every UI change), dropping
    // routing.chrome/runtimeChrome, or a semver-older builtWith.version is a
    // stale tree, not an intent. Intentional restores go through `rollback`
    // (append-only, audited) or a republish from a current engine.
    if (spaceId === "_engine" && cur) {
      const drops = [];
      const hasChrome = (f) => Object.keys(f || {}).some((p) => p.startsWith("/_chrome."));
      if ((cur.files || {})["/sw.js"] && !(m.files || {})["/sw.js"]) drops.push("/sw.js");
      if (hasChrome(cur.files) && !hasChrome(m.files)) drops.push("/_chrome.*");
      const curR = cur.routing || {}, newR = m.routing || {};
      if (curR.chrome && !newR.chrome) drops.push("routing.chrome");
      if (curR.runtimeChrome && !newR.runtimeChrome) drops.push("routing.runtimeChrome");
      const curV = cur.builtWith && cur.builtWith.version;
      const newV = m.builtWith && m.builtWith.version;
      const older = !!(curV && newV && semverBehind(newV, curV));
      if (drops.length || older) {
        return jsonResponse({
          error: "engine-downgrade",
          ...(drops.length ? { drops: drops.slice(0, 20) } : {}),
          ...(older ? { live: curV, publishing: newV } : {}),
        }, 409);
      }
    }
    const baseVersion = m.baseVersion;
    delete m.baseVersion; // transport-only — never persisted in the manifest
    // ⚠️ OPT-IN. A publisher that did not ask for it gets today's 409 exactly as before, so
    // every existing client keeps its own composition and its own retry. See resolveStaleBase.
    const forkOnConflict = m.forkOnConflict === true;
    delete m.forkOnConflict; // transport-only
    let serverForks = null;
    if (typeof baseVersion === "number" && baseVersion !== ((cur && cur.version) || 0)) {
      const resolved = forkOnConflict
        ? await resolveStaleBase(env, tctx, spaceId, m, cur, baseVersion, who.label || "")
        : null;
      if (!resolved) {
        return jsonResponse({
          error: "stale-base",
          liveVersion: (cur && cur.version) || 0,
          liveSource: cur && cur.source
            ? { sha: cur.source.sha || null, dirty: !!cur.source.dirty } : null,
        }, 409);
      }
      if (resolved.error) return jsonResponse(resolved, 409);
      m = resolved.manifest;
      serverForks = resolved.forks;
      for (const [h, bytes] of Object.entries(resolved.extraBlobs || {})) {
        await env.BUNDLES.put(`blobs/${h}`, bytes);
      }
    }
    // ── Unpublish guard — a publish may not take live pages off the site unasked.
    // A publish ships ONE working tree as the WHOLE space, routing included, so a
    // checkout that is missing a folder (or carries it somewhere else) does not
    // merely fail to add: it REMOVES every public URL it cannot see, for everyone.
    // Nothing about that is visible from the publisher's side — their own preview is
    // correct by construction, and the gate answers an unknown path with the login
    // page, so the pages that vanished read as merely locked rather than gone. One
    // such publish took an opportunity's shareable links down for an hour, and the
    // embeds already pasted into third-party sites rendered a password form.
    //
    // Removals therefore have to be asked for: the INSTANCE_SENTINELS rule below,
    // generalized from a list of paths to the whole public URL surface. Taking a
    // prototype down stays one flag away (`augur publish --allow-unpublish`, which
    // sets this field); losing one to a bad checkout is no longer possible quietly.
    // Applies to STAR-scope tokens too — a maintainer's stale tree removes exactly
    // as much as a collaborator's.
    const allowUnpublish = m.allowUnpublish === true;
    delete m.allowUnpublish; // transport-only — never persisted in the manifest
    if (!allowUnpublish) {
      const removed = removedPublicPrefixes(liveManifests[spaceId], m);
      if (removed.length) {
        return jsonResponse({ error: "unpublish-refused", count: removed.length, removed: removed.slice(0, 50) }, 422);
      }
    }
    // Inline blobs — the one-round-trip fast path: a small commit may carry its
    // fresh blobs base64-inline instead of PUTting each first. Every inline blob
    // is sha256-verified in-request, so it is proven by construction and needs
    // no spot-check subrequest afterwards.
    const inline = m.blobs && typeof m.blobs === "object" && !Array.isArray(m.blobs) ? m.blobs : null;
    delete m.blobs; // transport-only — never persisted in the manifest
    const inlineStored = new Set();
    if (inline) {
      const entries = Object.entries(inline);
      if (entries.length > INLINE_MAX_BLOBS) return jsonResponse({ error: "too-many-inline-blobs" }, 413);
      let total = 0;
      const bufs = [];
      for (const [h, b64] of entries) {
        if (!/^[0-9a-f]{64}$/.test(h) || typeof b64 !== "string") {
          return jsonResponse({ error: "bad-inline-blob" }, 400);
        }
        let buf;
        try {
          const bin = atob(b64);
          buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        } catch (e) { return jsonResponse({ error: "bad-inline-blob" }, 400); }
        total += buf.byteLength;
        if (!buf.byteLength || buf.byteLength > BLOB_MAX_BYTES || total > INLINE_MAX_BYTES) {
          return jsonResponse({ error: "bad-size" }, 413);
        }
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        if (digest !== h) return jsonResponse({ error: "hash-mismatch", hash: h }, 400);
        bufs.push([h, buf]);
      }
      await Promise.all(bufs.map(([h, buf]) => env.BUNDLES.put("blobs/" + h, buf)));
      for (const [h] of bufs) inlineStored.add(h);
    }
    // Sentinels (instance-configured paths, e.g. the DS core stylesheet): once
    // live in a space, a publish may not silently drop them — that's a broken
    // checkout, not an intent.
    for (const s of tctx.INSTANCE_SENTINELS) {
      if (cur && cur.files && cur.files[s] && !m.files[s]) {
        return jsonResponse({ error: "sentinel-missing", path: s }, 422);
      }
    }
    // Spot-validate fresh blobs (free-plan subrequest budget caps a full sweep;
    // hashed PUTs + content addressing make a missing blob unlikely, and a serve
    // 404 is the loud failure if one ever slips).
    const prev = new Set(cur ? Object.values(cur.files).map((f) => f.h) : []);
    const fresh = [...new Set(Object.values(m.files).map((f) => f && f.h).filter(Boolean))]
      .filter((h) => !prev.has(h) && !inlineStored.has(h));
    // Smaller sample when inline blobs rode along — their PUTs already spent
    // part of this request's subrequest budget.
    const sample = fresh.slice(0, inline ? 16 : 40);
    const heads = await Promise.all(sample.map((h) => env.BUNDLES.head("blobs/" + h)));
    const miss = sample.filter((h, i) => !heads[i]);
    if (miss.length) return jsonResponse({ error: "blobs-missing", missing: miss.slice(0, 5) }, 409);
    const issued = await nextPublishVersion(env, tctx, spaceId, cur);
    if (issued.error) return versionUnavailable();
    const version = issued.version;
    // A scalar a workspace can volunteer about itself without anything outside reaching into
    // its bucket. See bytesReferencedOf for what it does and does not mean.
    const bytesReferenced = bytesReferencedOf(m);
    // ── per-file provenance, recorded at the only moment it is true ────────────
    //
    // `C-manifest-provenance`. Who last changed each file and when, stamped HERE — at
    // commit — and carried forward untouched for every file whose bytes did not change.
    //
    // ⚠️ IT REPLACES A CLASS OF BUG, NOT A FEATURE. Provenance was DERIVED from `git log`
    // at build time, and publishing keeps disturbing the evidence: on one day in August
    // 2026 the same instance lost it three independent ways — a 76-poster mass commit reset
    // every card to "edited now"; a build from a shallow clone credited the graft author
    // with the entire site; and a reconcile-adoption laundered 169 pages' authorship into
    // one collaborator. Each needed its own build.js guard, and every guard is a tell.
    //
    // ⚠️ AND IT DOES NOT STORE AN ADDRESS, which is a deliberate deviation from the plan
    // item's `{author: who.label}`. `who.label` is an email. A manifest is read by more
    // things than a comment thread is, and the engine already made this exact choice for
    // messages: store `by: personId(email)`, a one-way hash, and resolve a name and a face
    // at RENDER time from the roster. Do not "finish" this by putting the address in.
    //
    // ⏳ NOTHING RENDERS IT YET. build.js still derives dates and contributor chips from
    // git, and it must keep doing so until the render moves — a card cannot read a stamp
    // that is only assigned AFTER the build that draws it (`C-manifest-provenance`'s second
    // half moves that read to the client, against the live manifest). What this buys today
    // is that provenance starts ACCUMULATING truthfully from now, so the render move lands
    // on real history instead of a flag day where every card says "unknown".
    //
    // ⚠️ "CHANGED" MEANS THE SOURCE, NOT THE SERVED BYTES. `h` is the address of what is
    // served, and the engine leaves its fingerprint in every authored page it emits — a
    // `?v=<version>` on two injected script tags, the unfurl meta, the tab emoji — so a
    // publish made with a different engine clone than the last one flips every page's `h`.
    // Keyed on `h` alone, the stamp called all of it one person's work: on 2026-09-02 the
    // reference instance alternated fourteen times in one night between a collaborator's
    // clone and the shell's re-bake, each publish restamping 368 of 479 pages, until 158 of
    // 158 units read "Edited 8 hours ago" by the CI token. build.js therefore records `sh`,
    // the hash of the SOURCE bytes, on every file it transforms, and that is what decides
    // here whenever both sides carry one. A file with no `sh` on either side (an image, a
    // script, a generated index) compares `h` exactly as before.
    //
    // Two belts. A live entry that PREDATES `sh` cannot be judged against a new one — the
    // bytes moved and nothing says whether the source did — so it keeps what it had and
    // records `sh` for next time; the alternative is one publish that restamps the whole
    // site on the day this ships, which is the symptom. And a publish whose source commit
    // IS the live one, clean on both sides, changed nothing a person wrote whatever its
    // bytes say: that is exactly what a re-bake is.
    //
    // THE STAMP RECORDS THE EDIT, NOT THE PUBLISH. "Who last changed this and when" is a
    // question about the source, and build.js answers it per file from git — author as a
    // one-way id, commit time of the last real change, the poster / mechanical / graft guards
    // applied — and sends it in the entry. A file whose source CHANGED adopts that answer;
    // `{publisher, now}` is only the fallback for a file git could not vouch for (no repo,
    // untracked, edited and not yet committed — where the publisher, now, is the truth).
    // Without this the stamp answered "who pushed the button": a publisher shipping a
    // colleague's pushed commits, a restore of a copy, a Friday publish of Monday's work
    // all put the wrong person and the wrong day on the card. A file whose source did NOT
    // change ignores whatever the body claims — the recorded stamp is the record, and an
    // unchanged file is exactly where a claim would be a forgery. Shape-checked, never an
    // address.
    const editedAt = new Date().toISOString();
    const stampedBy = who.label ? personId(who.label) : null;
    const priorFiles = (cur && cur.files) || {};
    const sameSource = !!(cur && cur.source && m.source && cur.source.sha
      && cur.source.sha === m.source.sha && !cur.source.dirty && !m.source.dirty);
    const carriedStamp = (f) => {
      if (!f || typeof f.by !== "string" || !f.by || f.by.includes("@")) return null;
      if (typeof f.editedAt !== "string" || !Number.isFinite(Date.parse(f.editedAt))) return null;
      return { by: f.by, editedAt: f.editedAt };
    };
    const stampedFiles = {};
    for (const [p2, f] of Object.entries(m.files || {})) {
      const prior = priorFiles[p2];
      const { by: _b, editedAt: _e, ...bytes } = f || {};
      let unchanged = false;
      if (prior && f) {
        if (sameSource) unchanged = true;
        else if (f.sh && prior.sh) unchanged = prior.sh === f.sh;
        else if (f.sh && !prior.sh) unchanged = true;
        else unchanged = prior.h === f.h;
      }
      // Unchanged keeps whatever the last publish recorded — including nothing, for a file
      // that predates this field. Absent is the honest answer for those, and the renderer's
      // fallback, not a stamp invented at the first publish that touches nothing.
      if (unchanged) {
        stampedFiles[p2] = { ...bytes, ...(prior.by ? { by: prior.by } : {}), ...(prior.editedAt ? { editedAt: prior.editedAt } : {}) };
        continue;
      }
      const asserted = carriedStamp(f);
      stampedFiles[p2] = asserted
        ? { ...bytes, ...asserted }
        : { ...bytes, ...(stampedBy ? { by: stampedBy } : {}), editedAt };
    }
    // ── unit lineage + ownership: carried by the server, never read from the body ───────
    //
    // `F-fork-verb`. `routing.forkedFrom` and `routing.unitOwners` are stamped by the fork
    // verb and only by it. A publisher's manifest is built from their own tree, which knows
    // nothing about a fork somebody else made — so taking `routing` verbatim would drop a
    // fork's parentage and its owner while leaving its files serving, and the fork would
    // quietly become an anonymous folder. Whatever the body claims is discarded first: an
    // owner a request may assert is an ACL anybody can type. See carriedLineage.
    //
    // The ONE exception is trust-on-first-publish, the same shape `space.adminOnly` above
    // gets: with no live manifest there is no prior value a claim could be overwriting, and
    // the caller that needs it is `augur restore` replaying an export into an empty store —
    // without it a migrated workspace arrives with its forks serving and their parentage
    // gone. Even then the shapes are checked, so that path cannot put an address in either.
    if (m.routing && typeof m.routing === "object") {
      const asserted = cur ? null : assertedLineage(m.routing);
      delete m.routing.forkedFrom;
      delete m.routing.unitOwners;
      Object.assign(m.routing, asserted || carriedLineage(cur, m.routing));
    }
    const out = {
      ...m, files: stampedFiles, version, bytesReferenced,
      publishedAt: new Date().toISOString(), publishedBy: who.label || "",
    };
    await bundles.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
    await bundles.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
    bustManifests(tctx.tenantId); cfgAt = 0; // this isolate flips immediately; others within ~1.5s
    // THE HALF THE BROWSER-SESSION STAMP MISSES. `augur publish` carries a bearer token and
    // never touches `/__me`, so a team shipping daily from CI reads as months idle on the
    // per-person clock — and a dormancy sweep keyed on that would suspend a workspace
    // somebody uses every day.
    touchWorkspaceActivity(env, tctx, null);
    // ── Stale-bake self-heal. Pages are baked with the PUBLISHER's engine clone,
    // and nothing constrains how old that clone is — runtime chrome recomposes
    // marker-wrapped chrome at serve time, but pages baked before the markers
    // existed (and all baked generated markup) can only be fixed by republishing
    // with a current engine. So: accept the publish unconditionally (the publisher
    // is never refused or told to update), then ask the deploy shell to re-bake.
    // The shell's job is drift-driven and idempotent, so over-asking is harmless;
    // a KV debounce keeps publish bursts from stampeding it. Absent dispatch
    // config, drift still converges on the next shell deploy — degraded, not broken.
    let rebake;
    if (spaceId !== "_engine") {
      try {
        const engObj = await bundles.get("spaces/_engine/manifest.json");
        const engRef = engObj ? JSON.parse(await engObj.text()) : null;
        const engineSha = (engRef && ((engRef.builtWith && engRef.builtWith.engine) || (engRef.source && engRef.source.sha))) || null;
        const publishedWith = (out.builtWith && out.builtWith.engine) || null;
        if (engineSha && publishedWith !== engineSha) {
          const kv = kvFor(env, tctx);
          const sentKey = `rebake:sent:${spaceId}`;
          const already = kv ? await kv.get(sentKey).catch(() => null) : null;
          if (already) {
            rebake = "debounced";
          } else {
            rebake = await shellDispatch(env, "space-rebake", {
              space: spaceId, publishedWith, engine: engineSha, by: who.label || "",
            });
            if (rebake === "dispatched" && kv) {
              try { await kv.put(sentKey, "1", { expirationTtl: 300 }); } catch (e) {}
            }
          }
        }
      } catch (e) {} // healing is best-effort — it must never break a persisted publish
    }
    // `forks` rides back so the publisher can print the same line `augur ship` prints when
    // IT composes — one sentence per contested unit, naming who kept the URL and where yours
    // went. Absent on an ordinary publish rather than an empty array: nothing was contested
    // is a different fact from nothing was resolved.
    return jsonResponse({
      ok: true, version,
      ...(rebake ? { rebake } : {}),
      ...(serverForks && serverForks.length ? { forks: serverForks } : {}),
    });
  }

  // ── fork: an artifact copied to a new path, with no bytes moved ────────────────────────
  //
  // `F-fork-verb`. `POST /__publish/<space>/fork  {from, to}` → the unit at `from` also
  // serves at `to`, owned by whoever asked, remembering where it came from. See
  // src/publish-fork.mjs for why this is a verb of its own and why it uploads nothing.
  //
  // ⚠️ IT IS A PUBLISH, deliberately: the same bearer token, the same freeze and suspension
  // gates the whole `/__publish/` prefix sits behind, the same version counter and the same
  // append-only history. So a fork is `rollback`-able like any other publish, shows up in
  // `versions` as the thing it was, and an export picks it up without knowing forks exist.
  //
  // ⚠️ AND IT IS THE ONE PUBLISH THAT NEEDS NO TREE. That is the point of the verb for a
  // hosted workspace: forking is two paths and a token, so a publisher with no repo, no
  // checkout and no build can still say "give me my own copy of this".
  if (op === "fork" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const from = body && body.from, to = body && body.to;
    if (typeof from !== "string" || typeof to !== "string") {
      return jsonResponse({ error: "bad-fork-body", message: "fork needs a `from` and a `to` path" }, 400);
    }
    // Read live FRESH, not from the isolate cache: the whole content of a fork is hashes
    // copied out of the live manifest, and a copy taken from a stale one would alias bytes
    // that URL has stopped serving.
    const curObj = await bundles.get(`spaces/${spaceId}/manifest.json`);
    const cur = curObj ? JSON.parse(await curObj.text()) : null;
    if (!cur) return jsonResponse({ error: "unknown-space" }, 404);

    // The target must be a path this space may publish AND open to anonymous visitors — the
    // same rule the routing fragment is held to at commit, applied here because a fork adds
    // a public prefix that no commit ever inspects. Unlike commit this is NOT waived for
    // star scope: nothing legitimate forks onto engine chrome, and a new verb starts closed.
    if (!isPublishablePublicPrefix(to, spaceId, tctx.SPACES)) {
      return jsonResponse({ error: "bad-routing-prefix", path: to }, 400);
    }

    const forked = composeFork({
      live: cur, from, to,
      // A person is a personId here and everywhere else a manifest names one. `who.label` is
      // an address; it goes no further than this line.
      by: who.label ? personId(who.label) : null,
    });
    if (forked.error) {
      const status = forked.error === "unknown-unit" ? 404
        : forked.error === "fork-target-exists" ? 409 : 400;
      return jsonResponse(forked, status);
    }

    // Never alias onto a path another live manifest — engine chrome included — is already
    // serving. Same belt-and-suspenders the commit path applies to a whole file map.
    const liveManifests = await loadManifests(tctx.tenantId, env, true);
    for (const otherId in liveManifests) {
      if (otherId === spaceId) continue;
      const other = liveManifests[otherId].files || {};
      for (const [q] of forked.aliased) {
        if (other[q]) return jsonResponse({ error: "path-conflict", path: q, owner: otherId }, 409);
      }
    }

    const m = forked.manifest;
    const ceiling = manifestCeiling(m);
    if (ceiling) return jsonResponse({ error: "manifest-ceiling", ...ceiling }, 413);

    const issued = await nextPublishVersion(env, tctx, spaceId, cur);
    if (issued.error) return versionUnavailable();
    const version = issued.version;
    // Recomputed rather than carried, and it is also the receipt: it deduplicates by hash,
    // the fork references exactly the blobs the source does, so a fork that had moved bytes
    // would move this number. It does not.
    const bytesReferenced = bytesReferencedOf(m);
    const out = {
      ...m, version, bytesReferenced,
      publishedAt: new Date().toISOString(), publishedBy: who.label || "",
    };
    await bundles.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
    await bundles.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
    bustManifests(tctx.tenantId); cfgAt = 0; // this isolate flips immediately; others within ~1.5s
    touchWorkspaceActivity(env, tctx, null);
    // No stale-bake dispatch. The forked pages are byte-identical to pages already live, so
    // whatever engine baked them baked the source too — the source's own publish already
    // asked for whatever re-bake it needed, and asking again for a copy of it would spend a
    // dispatch to change nothing.
    return jsonResponse({
      ok: true, version,
      from: forked.from, to: forked.to,
      files: forked.aliased.length,
      forkedFrom: m.routing.forkedFrom[forked.to],
      // Said out loud because it is the property that makes the verb worth having.
      blobsUploaded: 0, bytesReferenced,
    });
  }

  if (op === "rollback" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const v = parseInt(body && body.version, 10);
    if (!v || v < 1) return jsonResponse({ error: "bad-version" }, 400);
    const prev = await bundles.get(`spaces/${spaceId}/versions/${v}.json`);
    if (!prev) return jsonResponse({ error: "unknown-version" }, 404);
    // History is append-only: a rollback republishes the old CONTENT under a NEW
    // version number rather than repointing at the old one. Reusing the number
    // looked tidier and was a trap — the next publish would compute
    // cur.version + 1 and overwrite an existing versions/<n>.json, quietly
    // destroying a point in the history that recovery depends on. It also means
    // a rollback is itself visible in the history, and undone by another one.
    const restored = JSON.parse(await prev.text());
    const curObj = await bundles.get(`spaces/${spaceId}/manifest.json`);
    const cur = curObj ? JSON.parse(await curObj.text()) : null;
    const issued = await nextPublishVersion(env, tctx, spaceId, cur);
    if (issued.error) return versionUnavailable();
    const version = issued.version;
    const out = {
      ...restored, version,
      publishedAt: new Date().toISOString(),
      publishedBy: `rollback to v${v} by ${who.label || "unknown"}`,
    };
    await bundles.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
    await bundles.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
    bustManifests(tctx.tenantId); cfgAt = 0;
    return jsonResponse({ ok: true, version, restoredFrom: v });
  }

  return jsonResponse({ error: "unknown-op" }, 400);
}

// Remove every file under a URL prefix from a space's live manifest, committed as
// a normal new version (so `rollback` undoes it like any other publish).
//
// This exists because "Delete forever" used to be a lie in bundle mode. It fires a
// repo dispatch that deletes the folder in the space repo and relied on the
// FOLLOWING REDEPLOY to drop it from the site — but redeploys stopped serving space
// content, so the prototype kept rendering from the store until someone happened to
// republish that space. The button reported success and the thing stayed up.
//
// Note what is deliberately NOT changed: `source.sha`. Live content now differs
// from that commit's tree, which is exactly the "pushed but not published" state
// the deploy canary already watches for — it will ask for a republish, and the
// republish reconciles the two. Inventing a second flag for it would just be
// another number to reconcile.
async function removeFromStore(tctx, env, spaceId, urlPrefix, by) {
  if (!env.BUNDLES) return { skipped: "no-store" };
  const bundles = bundlesFor(env, tctx && tctx.tenantId);
  const obj = await bundles.get(`spaces/${spaceId}/manifest.json`);
  if (!obj) return { skipped: "unknown-space" };
  const cur = JSON.parse(await obj.text());
  const files = {};
  let removed = 0;
  for (const [p, f] of Object.entries(cur.files || {})) {
    if (p.startsWith(urlPrefix)) { removed++; continue; }
    files[p] = f;
  }
  if (!removed) return { removed: 0 };
  // Same guard a publish gets: a delete may never take out an instance sentinel.
  for (const s of tctx.INSTANCE_SENTINELS) {
    if (cur.files[s] && !files[s]) return { error: "sentinel-missing", path: s };
  }
  // Drop the dead path from the routing fragment too, or the gate keeps advertising
  // a public prefix that now resolves to nothing.
  const routing = { ...(cur.routing || {}) };
  if (Array.isArray(routing.publicPrefixes)) {
    routing.publicPrefixes = routing.publicPrefixes.filter((u) => !u.startsWith(urlPrefix));
  }
  if (routing.versionMap) {
    routing.versionMap = Object.fromEntries(
      Object.entries(routing.versionMap).filter(([u]) => !u.startsWith(urlPrefix)));
  }
  if (Array.isArray(routing.canvasCatalog)) {
    routing.canvasCatalog = routing.canvasCatalog.filter(
      (e) => !String((e && e.url) || "").startsWith(urlPrefix));
  }
  // The unit-keyed maps go the same way. A deleted unit that kept its `unitOwners` row would
  // leave an owner behind for a resource that no longer exists — and the next thing published
  // at that path would inherit an ACL nobody set on it.
  for (const field of ["forkedFrom", "unitOwners"]) {
    if (!routing[field]) continue;
    routing[field] = Object.fromEntries(
      Object.entries(routing[field]).filter(([u]) => !u.startsWith(urlPrefix)));
  }
  // The third mint, and the same counter. A delete commits as a normal new version so a
  // rollback undoes it like any other publish — which means it can collide with a publish
  // in exactly the way the other two can.
  const issued = await nextPublishVersion(env, tctx, spaceId, cur);
  if (issued.error) return { error: "version-unavailable" };
  const version = issued.version;
  const out = {
    ...cur, files, routing, version,
    publishedAt: new Date().toISOString(),
    publishedBy: `delete by ${by || "admin"}`,
  };
  await bundles.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
  await bundles.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
  bustManifests(tctx.tenantId); cfgAt = 0;
  return { removed, version };
}

// Repo path → live URL prefix. The two shapes DELETE_PATH_RE allows are
// "<folder>/prototypes/<name>" and "playground/<name>"; the served URLs drop the
// "prototypes/" segment ("/<folder>/<name>/") and carry the space's base for every
// space but the default.
function deleteUrlPrefix(tctx, space, repoPath) {
  const parts = repoPath.split("/");
  const tail = parts[0] === "playground"
    ? `/playground/${encodeURIComponent(parts[1])}/`
    : `/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[2])}/`;
  // An unknown space must NOT fall back to the root form: that would aim the
  // deletion at the default space's URLs instead. No space, no prefix.
  const meta = tctx.SPACES.find((s) => s.id === space);
  if (!meta) return null;
  return meta.default ? tail : `/${space}${tail}`;
}

// ---- Admin: engine version + update nudge -----------------------------------
// Reports the running engine version and whether the release feed (GitHub
// releases API by default, `updateFeed` in deploy.config.json to override) holds
// a newer one. The feed check is KV-cached for 6h — one origin fetch per
// instance per window, whatever the page-view rate. Admin-cookie gated; updates
// themselves stay manual (the shell's engine-bump is the release valve).
function semverBehind(cur, latest) {
  const a = String(cur).split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(latest).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y; }
  return false;
}
/**
 * The last report the cron wrote, and NOTHING ELSE — this never runs a check.
 *
 * The distinction is the whole value of the endpoint. If reading it triggered a run, then
 * "the cron is not firing" and "nobody has opened this page" would produce the same green
 * answer, and the first is the condition this item exists to make visible. So an absent
 * report is reported as absent, with the reason an operator would need: no cron is
 * configured, or one is and it has never completed.
 */
async function adminHealthApi(env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ report: null, why: "no store bound, so the cron has nowhere to write" });
  let report = null;
  try { report = JSON.parse((await kv.get(HEALTH_REPORT_KEY)) || "null"); } catch (e) { report = null; }
  if (!report) {
    return jsonResponse({
      report: null,
      why: "no report has ever been written. Either this deployment declares no `[triggers] crons` entry, or it does and the cron has not completed one run yet. An empty report is not a healthy one.",
    });
  }
  // How old it is, computed here rather than trusted from the document: a stale report is
  // the failure mode of a cron that stopped, and it is invisible if you only read `ok`.
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(report.at || 0)) / 1000));
  return jsonResponse({ report, ageSeconds });
}

async function adminVersionApi(tctx, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const current = tctx.INSTANCE_ENGINE_VERSION || null;
  const kv = kvFor(env);
  let latest = null, url = "";
  try {
    const cached = kv ? JSON.parse((await kv.get("engine:update-check")) || "null") : null;
    if (cached && Date.now() - cached.at < 6 * 3600 * 1000) {
      latest = cached.latest; url = cached.url || "";
    } else {
      const r = await fetch(tctx.UPDATE_FEED || DEFAULT_UPDATE_FEED, {
        headers: { "user-agent": "augur-update-check", accept: "application/vnd.github+json" },
      });
      if (r.ok) {
        const d = await r.json();
        latest = String(d.tag_name || d.version || "").replace(/^v/, "") || null;
        url = d.html_url || "";
      }
      // Cache misses too — a feed with no releases yet must not be re-polled
      // on every admin page view.
      if (kv) await kv.put("engine:update-check", JSON.stringify({ at: Date.now(), latest, url }));
    }
  } catch (e) {}
  const behind = !!(current && latest && semverBehind(current, latest));
  return jsonResponse({ current, latest, url, behind });
}

// ---- Admin: publish tokens (KV-backed) --------------------------------------
// GET lists token metadata (hashes only — the token itself is shown once at
// mint); POST {space,label} mints; DELETE {hash} revokes. Admin-cookie gated.
// ⚠️ THE PANEL LISTS THE UNION AND WRITES TO BOTH, for the length of the straddle. A list
// from one store alone shows an admin a revoke button for tokens that will keep publishing,
// or hides a live one entirely; the union is the set that can actually publish, which is
// the only set worth showing. `tctx` is optional so the two tests that drive this route
// without one still get the KV-only behaviour it has always had.
async function adminTokensApi(request, env, me, tctx = null) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env, tctx);
  const ident = identityFor(env, tctx, "publishTokens");
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  const raw = await kv.get(PUBLISH_TOKENS_KEY);
  const map = raw ? JSON.parse(raw) : {};
  if (request.method === "GET") {
    let tokens = map;
    if (ident) {
      // The object's rows win a collision: it is what `publishAuthDetailed` reads first,
      // so a disagreement about a token's scope should be shown as the answer that governs.
      try { tokens = { ...map, ...(await ident.tokenList()).tokens }; } catch (e) {}
    }
    return jsonResponse({ tokens });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const space = clamp(op && op.space, 60).trim() || "*";
    const label = clamp(op && op.label, 80).trim() || "unnamed";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const hash = await tokenFor("pub:" + token);
    const createdAt = new Date().toISOString();
    map[hash] = { space, label, createdAt };
    await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    if (ident) {
      try { await ident.tokenMint({ tokenHash: hash, space, label, createdAt, expiresAt: null }); }
      catch (e) { /* live in KV, which the read still falls back to */ }
    }
    return jsonResponse({ token, space, label });
  }
  if (request.method === "DELETE") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const h = clamp(op && op.hash, 80);
    // A hash the object holds and KV does not is still a revocable token — it is what the
    // read answers from. So "unknown" means neither store has it.
    let droppedFromObject = 0;
    if (ident) {
      try { droppedFromObject = (await ident.tokenRevoke({ tokenHash: h })).dropped || 0; }
      catch (e) { return jsonResponse({ error: "no-store" }, 503); }
    }
    if (!map[h] && !droppedFromObject) return jsonResponse({ error: "unknown-token" }, 404);
    if (map[h]) {
      delete map[h];
      await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    }
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Admin: bundle-store usage ----------------------------------------------
// Sums the store (5-min isolate cache — a full list is a few subrequests at
// ~2.5k objects) against the R2 free-tier ceiling so the admin panel can show
// a fill gauge long before a publish would ever hit the wall.
const STORE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // R2 free tier: 10 GB
// ⚠️ KEYED BY WORKSPACE. The number this holds is a measurement of ONE workspace's
// store — how much of the ceiling its own publishes have spent — and it is shown to that
// workspace's admins for five minutes. A single slot answers whoever asks second with
// whoever asked first's fill, which reports a neighbour's usage as this workspace's and
// leaves a workspace approaching the wall being told it has room. Bounded like the
// manifest cache above, and evicting an entry only costs the next admin one list.
const STORAGE_CACHE_MAX = 256;
// tenantId -> { at, data }
const STORAGE_CACHE = tenantCache("storage", { max: STORAGE_CACHE_MAX });
async function adminStorageApi(tenantId, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  if (!env.BUNDLES) return jsonResponse({ enabled: false });
  const hit = STORAGE_CACHE.get(tenantId);
  if (hit && hit.data && Date.now() - hit.at < 5 * 60 * 1000) {
    return jsonResponse(hit.data);
  }
  // ⚠️ WHAT THIS COUNTS DEPENDS ON WHETHER THE BUCKET IS SHARED, and it has to. With no
  // segment the bucket IS the workspace, so the whole-bucket listing is the honest number
  // and stays exactly as it was. With one, an unprefixed listing would report every
  // workspace's bytes to every workspace's admin — each one seeing the others' growth and
  // each one hitting the ceiling on it. Scoped to the prefix, the number is this
  // workspace's own. The shared families are then OUTSIDE it, which is the honest answer
  // rather than a gap: `blobs/` is deduplicated across workspaces, so no workspace holds a
  // share of it that could be named, and `spaces/_engine/` is the deployment's chrome.
  const seg = bundleWorkspaceSegment(env, tenantId).workspace;
  const scoped = seg ? { prefix: BUNDLE_TENANT_PREFIX + seg + "/" } : {};
  let bytes = 0, objects = 0, cursor;
  try {
    do {
      const page = await env.BUNDLES.list({ ...scoped, cursor, limit: 1000 });
      for (const o of page.objects) { bytes += o.size; objects++; }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) { return jsonResponse({ error: "list-failed" }, 502); }
  const data = {
    enabled: true, bytes, objects,
    limitBytes: STORE_LIMIT_BYTES,
    pct: Math.round((bytes / STORE_LIMIT_BYTES) * 1000) / 10,
    at: new Date().toISOString(),
  };
  STORAGE_CACHE.put(tenantId, { at: Date.now(), data });
  return jsonResponse(data);
}

/**
 * The Settings panel's "Custom URL" field — a workspace's claimed platform subdomain,
 * if any (`B-claim-platform-subdomain`). Reads `readSuspension`'s existing per-isolate
 * cache, the same call the front-door redirect already makes every request: no new
 * store shape, no new KV read.
 */
async function adminCustomDomainApi(tenantId, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const doc = await readSuspension(tenantId, env);
  const hostname = (doc && doc.canonicalHost) || null;
  return jsonResponse({ claimed: !!hostname, hostname });
}

// GET /__admin/backup — the whole KV namespace as one JSON document.
//
// The store's own backup (`augur export`) copies published CONTENT. This copies the
// other half: the mutable state the worker accumulates around it — password hashes,
// invites, roster overlay, publish tokens, comment threads, boards, statuses, pins,
// renames, canvases, avatars. KV has no point-in-time restore, so without a copy of
// this an account mishap or a bad bulk write is unrecoverable.
//
// A shell workflow (templates/shell/kv-backup.yml) already does this nightly over the
// Cloudflare API. This endpoint exists because that route needs ACCOUNT credentials —
// an API token, the account id, the namespace id — which is a much heavier thing to
// hand someone than a login. An admin can take a copy from anywhere with this.
//
// NO PREFIX FILTER, deliberately. Enumerating the key classes we know about is how a
// backup silently stops covering the class someone adds next; `list()` with no prefix
// cannot go stale that way.
//
// Values are copied VERBATIM and never re-parsed. Most are JSON, but a backup that parses
// is a backup that can fail on something it did not expect, and re-encoding would not
// round-trip byte-for-byte.
//
// ⚠️ VERBATIM MEANS BYTES, NOT TEXT. This read used to be `kv.get(name, "text")`, which
// answers a JPEG with U+FFFD wherever the bytes are not valid UTF-8 — silently, and
// irreversibly. Canvas board images live in this namespace (`basset:`), so the copy came
// back longer than the original, different, and no longer matching the content-addressed
// key it was filed under. Read the arrayBuffer and let src/kv-codec.mjs decide: text
// stays a JSON string, anything else rides as a base64 marker. Never reintroduce "text".
async function adminBackupApi(env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 501);
  if (typeof kv.list !== "function") return jsonResponse({ error: "kv-list-unsupported" }, 501);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(enc.encode(s));
      // A namespace can be far larger than an isolate's memory, so the document is
      // written out as it is read rather than assembled and then serialized.
      try {
        push(`{"format":${KV_BACKUP_FORMAT},"at":${JSON.stringify(new Date().toISOString())},"data":{`);
        const expirations = {};
        const vanished = [];
        let count = 0, bytes = 0, binary = 0, first = true, cursor;
        do {
          const page = await kv.list({ cursor, limit: 1000 });
          for (const k of page.keys || []) {
            // A throw here is a genuine read failure — permissions, transport, a broken
            // namespace. It must NOT become a quietly shorter file: rethrow, and the
            // catch below tears the stream down so the document never closes.
            const buf = await kv.get(k.name, "arrayBuffer");
            if (buf === null) {
              // Listed, then gone before it could be read. Real and expected — rate-limit
              // keys carry TTLs — but recorded by name rather than dropped, so a restore
              // can tell "this key was not in the namespace" from "this backup lost it".
              vanished.push(k.name);
              continue;
            }
            const raw = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            const v = encodeKvValue(raw);
            if (typeof v !== "string") binary++;
            if (k.expiration) expirations[k.name] = k.expiration;
            push(`${first ? "" : ","}${JSON.stringify(k.name)}:${JSON.stringify(v)}`);
            first = false;
            count++;
            bytes += raw.byteLength; // BYTES, not string length: the two differ on every
                                     // non-ASCII value and are unrelated on a binary one.
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        // Trailers last, so they can report on the walk that produced them. `complete`
        // is the flag a consumer should check — though it barely needs to, because the
        // failure path below never writes this object at all. `binary` says how many
        // values could not be carried as text, so an operator can tell at a glance
        // whether a copy predates the codec (0 on a namespace holding board images) or
        // genuinely holds none.
        push(`},"expirations":${JSON.stringify(expirations)}`);
        push(`,"vanished":${JSON.stringify(vanished)}`);
        push(`,"count":${count},"bytes":${bytes},"binary":${binary},"complete":true}`);
        controller.close();
      } catch (e) {
        // The status line is long gone by now — a 200 is already on the wire — so the
        // only honest way to fail is to make the bytes unusable. Erroring the stream
        // leaves the JSON unterminated, so every parser rejects it and nobody stores a
        // truncated file believing it is a backup.
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="kv-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}

function loginPage(tctx, redirect, error, requestUrl, opts = {}) {
  const safeRedirect = String(redirect).replace(/"/g, "&quot;");
  // Three states in one card, one style block. `code` = the "we emailed you a code" screen;
  // otherwise passwordless when a central account store is configured (ACCOUNT_ORIGIN), and the
  // classic email+password only when it is not (a raw self-hosted instance).
  const codeMode = !!(opts && opts.code);
  const passwordless = !!tctx.ACCOUNT_ORIGIN;
  const fillEmail = escapeHtml((opts && opts.email) || tctx.LOGIN_PREFILL_EMAIL || "");
  const errText = typeof error === "string" ? escapeHtml(error)
    : codeMode ? "That code didn’t work. Check it, or request a new one." : "Incorrect email or password. Try again.";
  const errBlock = `<p class="error" id="pw-err" role="alert">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        <span>${errText}</span>
      </p>`;
  // Password mode keeps autocomplete="username" so a manager pairs it with the password field;
  // passwordless mode is a lone address, so "email" is the right hint.
  const emailInput = (ac) => `<label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="${ac}" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required value="${fillEmail}" ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />`;
  let formBody;
  if (codeMode) {
    formBody = `<div class="code-screen">
    <p class="intro">We emailed you a 6-digit code. Enter it below, or tap the button in the email.</p>
    <form method="POST" action="/__signin/code">
      <input type="hidden" name="email" value="${fillEmail}" />
      <label for="code" class="code-label">Enter code</label>
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="000000" aria-label="6-digit code" autofocus required ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <button type="submit">Sign in</button>
      ${errBlock}
    </form>
    <form method="POST" action="/__signin" class="resend"><input type="hidden" name="email" value="${fillEmail}" /><button type="submit" class="link">Request a new code</button></form>
    </div>`;
  } else if (passwordless) {
    formBody = `<form method="POST" action="/__signin">
      ${emailInput("email")}
      <button type="submit">Sign in with email</button>
      ${errBlock}
    </form>`;
  } else {
    formBody = `<form method="POST" action="/__auth">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
      ${emailInput("username")}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required value="${escapeHtml(tctx.LOGIN_PREFILL_PASSWORD)}" ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <button type="submit">Enter</button>
      ${errBlock}
    </form>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  ${previewHead(tctx, requestUrl)}
  <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <style>
    /* Self-hosted Inter (same woff2 the app ships) — no external font request, so the
       gate's first paint never waits on a third-party font host. */
    @font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/fonts/inter-latin-wght-normal.woff2") format("woff2"); }
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
    .logo svg, .logo img { width: 40px; height: 40px; display: block; }
    .logo img { border-radius: 8px; object-fit: cover; }
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
    /* The instance's loginHint — a quiet panel under the form (demo credentials). */
    .hint {
      margin: 16px 0 0; padding: 9px 12px; border: 1px dashed var(--line-2);
      border-radius: 9px; color: #667085; font-size: 13px; text-align: center;
    }
    /* The "we emailed you a code" screen — a deliberate, centred one-time-code field.
       ONE input, never segmented boxes: autocomplete="one-time-code", paste, undo and
       screen-reader support only work on a single field (segmented inputs look tidy but
       lose all of it and need JS to move the caret). So: make the one field read as a
       code field — big, centred, tabular, generously tracked. */
    .code-screen { text-align: center; }
    .intro { margin: 0 0 20px; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .code-label {
      display: block; margin: 0 0 10px; text-align: center; font-size: 12px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint);
    }
    input#code {
      width: 100%; font: inherit; font-weight: 600; font-size: 30px; line-height: 1.2;
      text-align: center; letter-spacing: 0.4em; text-indent: 0.4em; /* text-indent recentres
        the digit group, which the trailing letter-spacing would otherwise nudge left */
      font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
      padding: 14px 12px; border-radius: 11px; border: 1px solid var(--line-2);
      background: #fff; color: var(--fg); transition: border-color .12s ease, box-shadow .12s ease;
    }
    input#code::placeholder { color: #d6d9df; }
    input#code:hover { border-color: rgba(16,17,26,0.28); }
    input#code:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(44,33,80,0.14); }
    .code-screen button[type=submit] { margin-top: 18px; }
    .resend { margin-top: 14px; text-align: center; }
    .resend .link {
      width: auto; margin: 0; padding: 0; background: none; border: 0; color: var(--muted);
      font-size: 13px; font-weight: 500; text-decoration: underline; cursor: pointer;
    }
    .resend .link:hover { color: var(--fg); background: none; }
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
      ${brandMark(tctx)}
    </div>
    ${formBody}
    ${tctx.LOGIN_HINT && !passwordless ? `<p class="hint">${escapeHtml(tctx.LOGIN_HINT)}</p>` : ""}
  </main>
</body>
</html>`;
}

// Branded 404 — same shell language as loginPage (near-white canvas, indigo accent,
// Inter, the Augur mark). Shown when env.ASSETS.fetch returns a 404 for a request
// that is PAST the gate (authed user, admin page, or a public-prototype path). The
// signed-out fallthrough keeps returning the login page instead, so an unknown URL
// never reveals whether it exists to someone who hasn't logged in.
function notFoundPage(tctx) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Not found · Augur</title>${tctx.SPACES.some((s) => s.default) ? `\n  <link rel="icon" href="/space-icon.png" />` : ""}
  <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
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
      ${AUGUR_MARK_SVG}
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
function notFoundResponse(tctx) {
  return new Response(notFoundPage(tctx), {
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
// This UPGRADES, and only ever upgrades: a year + immutable, but ONLY for assets
// whose URL changes when their content does — anything carrying a ?v= cache-buster,
// or fonts (served from versioned /fonts/ paths).
//
// ⚠️ Everything else is left alone, which is safe ONLY because the response already
// carries a revalidating Cache-Control by the time it gets here. Do not read the
// untouched branch as "leave it to the platform default" — that was the original
// reading, written when this only ever saw the assets platform (whose default is
// `max-age=0, must-revalidate`), and it is what let bundle-mode responses reach the
// CDN header-less and pick up a four-hour extension-keyed TTL instead. assetFetch()
// sets ASSET_REVALIDATE; the long comment there is the full story.
function withAssetCache(res, url) {
  // The infinite-canvas engine (canvas.js/.css/catalog.json) is loaded by absolute path
  // with no ?v= cache-buster and is actively iterated. `no-cache` forces a REVALIDATION
  // on every use (so the stale-JS ghosts no-store used to fight stay dead — every load
  // still checks) but lets the browser answer with its cached copy on the 304, so a
  // repeat open costs ~1KB of conditional requests instead of ~110KB of engine
  // re-download (was `no-store` until 2026-08-07, which disabled caching entirely).
  if (url.pathname.startsWith("/__canvas/") && /\.(js|css|json)$/i.test(url.pathname)) {
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-cache");
    return out;
  }
  // The shared chrome bundle (/_chrome.<ver>.<hash>.{js,css}) carries a content hash
  // in its name, so it's safe to cache forever like a ?v= or font asset. sw.js is NOT
  // here on purpose — it must revalidate so a new worker version is picked up.
  const versioned = url.searchParams.has("v") || /\.(woff2?|ttf|otf)$/.test(url.pathname)
    || url.pathname.startsWith("/_chrome.");
  if (!versioned) return res;
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return out;
}

// Takes the context only to hand it to versionFor: the token stamped into a page is
// that workspace's version for that path, and a page composed for one workspace must
// never carry another's.
function withLiveReload(tctx, res, url) {
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("text/html") || url.searchParams.has("raw")) return res;
  // Offline mode (`npm run offline` → wrangler pages dev) is served from localhost;
  // there we poll fast so a rebuild reloads the tab in ~1s. Live stays on 10s.
  const fast = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "::1" || url.hostname.endsWith(".localhost");
  return new HTMLRewriter()
    .on("body", { element(el) { el.append(liveReloadSnippet(versionFor(tctx, url.pathname), fast), { html: true }); } })
    .transform(res);
}

// ---- Serve-time chrome composition (runtime-chrome) --------------------------
// A stored page carries the chrome the engine baked when it was published, wrapped in
// <!--gv-chrome-start …-->…<!--gv-chrome-end--> markers and pointing at whatever
// _chrome.<ver>.<hash>.{css,js} that engine emitted. When RUNTIME_CHROME is on we
// re-render the marked region with the CURRENT engine and repoint the bundle refs, so a
// deploy updates every space/tenant instantly regardless of which engine baked the page —
// no per-space re-bake. The active tab + space come from the marker's own data-* (never
// re-derived from the path). HTMLRewriter can't replace a range between two comment nodes,
// so this buffers the (bounded, stored) HTML and does a marker splice + ref swap in JS.
const CHROME_MARK_RE = /<!--gv-chrome-start\s+([^>]*?)-->[\s\S]*?<!--gv-chrome-end-->/;
function markerAttr(attrs, name) {
  const m = attrs.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : "";
}

async function composeChrome(tctx, res, url) {
  if (!tctx.RUNTIME_CHROME || !tctx.CHROME_POINTER) return res;
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("text/html") || url.searchParams.has("raw")) return res;
  let html = await res.text();
  // (a) re-render the marked rail with the current engine, keyed on the marker's own
  //     data-space / data-active (kept verbatim so the markers survive for next time).
  html = html.replace(CHROME_MARK_RE, (full, attrs) => {
    const active = markerAttr(attrs, "data-active") || "prototypes";
    const spaceId = markerAttr(attrs, "data-space");
    // data-playground carries the bake's playground presence (absent on a pre-marker
    // page ⇒ default true, the common case). Without it a no-playground space would get
    // a stray Playground rail item at serve time.
    const hasPlayground = markerAttr(attrs, "data-playground") !== "0";
    const state = { spaces: tctx.SPACES, activeSpace: spaceId, opportunities: [], hasPlayground };
    return `<!--gv-chrome-start ${attrs}-->` + renderAppChrome(active, state, {}) + `<!--gv-chrome-end-->`;
  });
  // (b) point stale bundle refs at the current bundle.
  html = html.replace(/\/_chrome\.[\d.]+\.[0-9a-f]{8}\.css/g, "/" + tctx.CHROME_POINTER.css)
             .replace(/\/_chrome\.[\d.]+\.[0-9a-f]{8}\.js/g, "/" + tctx.CHROME_POINTER.js);
  // The recomposed body is no longer the stored blob, so its ETag/Content-Length must not
  // ride along. Served HTML stays no-cache (withAssetCache never marks it immutable), so
  // the change is visible on the next request.
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

// Test seam: loadConfig fills the chrome pointer, the workspace list and the runtime-
// chrome flag from routing.json in a live isolate; this lets a unit test drive
// composeChrome without a config load. It hands back the seeded CONTEXT, which is the
// only place the workspace list now lives.
function __setChromeTestState(pointer, spaces, on) {
  TENANT_CTX = withTenantFields(TENANT_CTX, {
    CHROME_POINTER: pointer, SPACES: spaces, RUNTIME_CHROME: on,
  });
  return TENANT_CTX; // the seeded context, for a caller that has to hand one down
}

// ---- Platform MCP proxy (same-origin bridge) ---------------------------------
// Upstream platforms often send no CORS headers on /mcp or /oauth/token, so a
// browser prototype on this origin cannot call them directly. This route lets a
// page call /__mcp/<host>/<path> on ITS OWN origin and have the worker forward to
// https://<host>/<path>. Public (before the gate) — the platform's own OAuth
// Bearer token is the real auth; the proxy adds nothing, stores nothing, and
// never logs a token. Allowlist is tight: subdomains of the injected
// MCP_HOST_SUFFIXES, the exact hosts the spaces declared at build time
// (MCP_HOST_ALLOWLIST), plus the exact hosts published at MCP_HOST_ALLOWLIST_URL,
// and exactly the paths the MCP/OAuth flows need plus the ones the spaces declared
// alongside their hosts (MCP_PATH_ALLOWLIST).

// The engine's floor: the three paths the protocol itself speaks, which are the same
// three whatever a platform is. Anything past them is a fact about ONE platform's API
// and the prototype calling it, so it is declared where that prototype lives —
// space.json "mcpAllowlists" → {"paths":[…]} → routing → MCP_PATH_ALLOWLIST. A
// workspace's endpoint has no business being spelled out in a shared engine, and an
// engine pin bump has no business being what it takes to add one.
//
// ⏳ One exception, and it is about manifest vintage rather than about any platform: a
// workspace whose live routing fragment predates path declarations (no `mcpPaths` key at
// all) is still handed the floor that engine had, so moving its pin does not take an
// endpoint away that it cannot re-declare from here. See LEGACY_MCP_PATH_FLOOR in
// src/tenant-context.mjs for what ends that.
// A frozen ARRAY rather than a Set: Object.freeze does not stop `.add()` on a Set, so a
// Set is a table this engine has no way to make un-writable. Three entries, membership
// tested with `.includes` — the same test MCP_PATH_ALLOWLIST beside it already uses.
const MCP_PROXY_PATHS = Object.freeze([
  "/mcp",
  "/oauth/registrations",
  "/oauth/token",
]);

// Exact-host allowlist, fetched from the calling workspace's MCP_HOST_ALLOWLIST_URL — a
// JSON document shaped {"hosts": ["…"]}. A suffix rule cannot express a platform
// living on its own vanity domain without opening that domain's whole public
// suffix, and an "answers like a platform?" probe would turn this route into an
// open proxy for anything reachable from the deploy network — so the instance
// publishes an explicit list instead. Unset, or unreachable, means no host beyond
// MCP_HOST_SUFFIXES is allowed: the route behaves exactly as it does without the
// knob rather than failing closed on traffic that works today.
//
// ⚠️ KEYED BY WORKSPACE, and that is why this is a Map rather than the one promise it
// used to be. Unlike the config fields around it, what is cached here is DERIVED from a
// workspace's config — a resolved list of hosts that ONE workspace's instance document
// vouches for. A single promise slot therefore hands the first workspace to warm it a
// proxy allowlist that every workspace behind it answers from, silently widening which
// third parties this origin will forward a browser's Authorization header to. Nothing in
// an era with one workspace can observe that: the resolved list is simply correct.
//
// The entry remembers the URL it was fetched from, so a workspace that changes where it
// publishes its list is not answered out of the old one. And the Map is BOUNDED for the
// same reason the tenant context cache is — an isolate serving many workspaces would
// otherwise hold every list it ever resolved. Eviction costs one re-fetch and can only
// narrow what is allowed in the meantime, never widen it.
const MCP_ALLOWLIST_CACHE_MAX = 256;
// tenantId -> { url, hosts: Promise<Set|null> }
const mcpHostAllowlist = tenantCache("mcp-host-allowlist", { max: MCP_ALLOWLIST_CACHE_MAX });

function mcpAllowlist(tctx) {
  const url = tctx.MCP_HOST_ALLOWLIST_URL;
  if (!url) return Promise.resolve(null);
  const hit = mcpHostAllowlist.get(tctx.tenantId);
  if (hit && hit.url === url) return hit.hosts;
  const entry = { url, hosts: null };
  entry.hosts = fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((doc) => new Set(Array.isArray(doc && doc.hosts) ? doc.hosts : []))
    .catch(() => {
      // Retry on the next request — but drop only THIS attempt, never whatever a later
      // config load or another workspace has already put in its place. That is what the
      // second argument means: delete only if the stored value is still this one.
      mcpHostAllowlist.drop(tctx.tenantId, entry);
      return null;
    });
  mcpHostAllowlist.put(tctx.tenantId, entry);
  return entry.hosts;
}

// The other half is the space-declared exact hosts, from routing.json (see build.js):
// no extra fetch, no failure mode, and a space publish refreshes the list with the same
// deploy that ships the prototype using it. It is `tctx.mcpStaticHosts`, a Set derived
// once at config load so the list and the set can never disagree about what is allowed.
async function mcpHostAllowed(tctx, host) {
  if (tctx.MCP_HOST_SUFFIXES.some((sfx) => host.endsWith("." + sfx))) return true;
  // Exact match only — endsWith on a bare host would let <allowed>.attacker.example
  // through. Both lists are stored without a leading "www.".
  const bare = host.replace(/^www\./, "");
  if (tctx.mcpStaticHosts.has(host) || tctx.mcpStaticHosts.has(bare)) return true;
  const allow = await mcpAllowlist(tctx);
  return !!allow && (allow.has(host) || allow.has(bare));
}

async function mcpProxy(tctx, request, url) {
  const rest = url.pathname.slice("/__mcp/".length); // "<host>/<path…>"
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  // The pattern is lowercase-only, so it also rejects any case-variant spelling of
  // an allowed host before the comparisons below. A host must be a real domain name:
  // reject bare IPv4 literals and dotless names so the allowlist can't be pointed at
  // a private/loopback address (belt-and-suspenders with the suffix rule).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
      || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes(".")
      || !(await mcpHostAllowed(tctx, host)))
    return jsonResponse({ error: "host not allowed" }, 403);
  // Exact match, against the protocol floor and then the workspace's own declarations.
  // `path` is url.pathname: already normalised (no "..", no "." segments) and carrying
  // no query string, so this compares a whole endpoint, never a prefix.
  if (!MCP_PROXY_PATHS.includes(path) && !tctx.MCP_PATH_ALLOWLIST.includes(path))
    return jsonResponse({ error: "path not allowed" }, 403);
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
    // Do NOT follow redirects: an allowed host could 302 to an arbitrary host/path
    // (re-issuing the forwarded Authorization header) and escape both the allowlist
    // and the path restriction. A 3xx is treated as a failure, not chased.
    redirect: "manual",
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    return jsonResponse({ error: "upstream redirect refused" }, 502);
  }
  // The response is rebuilt, and the upstream content type is NOT trusted. An
  // allowed host is still a third party, and /__mcp/<host>/<path> is reachable by
  // plain navigation — echoing its `text/html` would hand it script execution on
  // the origin that serves every gated page and the admin API. These paths speak
  // JSON, plus event-stream for a streaming MCP transport; anything else is
  // relabelled and never rendered. Upstream response headers are dropped wholesale
  // (no Set-Cookie on this origin, no CORS grant, and no `WWW-Authenticate: Basic`
  // summoning a credential prompt here).
  const upType = upstream.headers.get("Content-Type") || "";
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": /^\s*(application\/json|text\/event-stream)\s*(;|$)/i.test(upType)
        ? upType : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}

// ---- Review comments API (KV-backed) ----------------------------------------
// Threads are stored one KV value per prototype page path, key "c:<path>".

function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

const clamp = (s, n) => String(s == null ? "" : s).slice(0, n);
const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Authorship is stamped server-side, never trusted from the client. A caller with a
// valid session cookie (me) is authoritative: their real name is used and verified=true.
// An anonymous caller keeps their pseudonym but verified=false, and may NOT wear a
// registered user's name (blocks impersonating a teammate — or a named agent identity).
// So a forged `author:"<trusted name>"` from an un-authed POST can never look verified.
// `users` is the roster to check the pseudonym against, and it comes FIRST because it is
// the thing that varies by workspace: the names that may not be worn are one workspace's
// people, not the isolate's last-loaded ones.
function stampAuthor(users, rawAuthor, me) {
  if (me) return { author: me.name, verified: true };
  const a = clamp(rawAuthor, 80) || "Anonymous";
  const collides = users.some((u) => u.name && u.name === a);
  return { author: collides ? "Anonymous" : a, verified: false };
}

function sanitizeMsg(users, m, me) {
  const { author, verified } = stampAuthor(users, m && m.author, me);
  return {
    author,
    verified,
    // Stamped from the session like `author` above — a `by` in the request body is
    // discarded with the rest of the caller's object.
    by: me ? personId(me.email) : null,
    body: clamp(m && m.body, 4000),
    at: clamp(m && m.at, 40) || new Date().toISOString(),
  };
}

// ---- Erasure: redact a purged person from stored publish provenance -----------------
//
// `E-gdpr-provenance-redact`. Every published version records who committed it, and the
// label on a publish token IS an address. Three write sites, in two shapes:
//
//   publishedBy: who.label                          a clean field
//   publishedBy: `rollback to v3 by <label>`        an address inside a sentence
//   publishedBy: `delete by <label>`                the same
//
// The two sentences are why this is string surgery rather than a value swap, and why it
// could not simply reuse the comment sweep.
//
// WHY THE LOCAL-PART TAKES CARE OF ITSELF. `/_build.json` is served BEFORE the gate, and
// `synthBuildStamp`'s `byName` maps a stored label to the roster display name, falling
// back to `label.split("@")[0]` — the local-part — for a label it does not recognise. So a
// leftover address would surface publicly as a bare local-part. It cannot: every write
// site above stores the FULL address, so removing the full address removes the only thing
// the local-part could be derived from. A test asserts that, because it is the property
// the VERIFY actually checks and it is not obvious from the sweep alone.
//
// The sweep is bounded to ONE SPACE's prefix, because that is how versions are keyed —
// `spaces/<spaceId>/versions/`. There is no global scan. ⚠️ A space is not a workspace and
// that prefix is not a workspace's: on a deployment where the bucket is shared, which
// spaces are a given workspace's is a question only that workspace's own object can answer
// (`workspaceSpaces`), and the caller here sweeps the first space in the context rather
// than every space the workspace owns.
const PURGED_PUBLISHER = "Deleted user";

/** Redact one stored `publishedBy` value. Returns the new string, or null if unchanged. */
function redactPublishedBy(value, email) {
  if (typeof value !== "string" || !value) return null;
  const addr = lcEmail(email);
  if (!addr) return null;
  if (lcEmail(value) === addr) return PURGED_PUBLISHER;      // the clean-field shape
  if (!value.toLowerCase().includes(addr)) return null;       // nothing of theirs here
  // The sentence shapes. Replace every occurrence, case-insensitively, without a regex
  // built from user input — an address can contain regex metacharacters.
  let out = "", rest = value;
  for (;;) {
    const at = rest.toLowerCase().indexOf(addr);
    if (at < 0) { out += rest; break; }
    out += rest.slice(0, at) + PURGED_PUBLISHER;
    rest = rest.slice(at + addr.length);
  }
  return out;
}

/**
 * Sweep this workspace's stored publish history. Bounded to `spaces/<id>/`.
 * Returns {ok, redacted, versions, manifest} or {ok:false, reason}.
 *
 * `tenantId` is the workspace whose history this is. An erasure that swept somebody else's
 * history would be rewriting a stranger's records, which is a larger act than the one that
 * was asked for — so the sweep is bounded to the workspace as well as to the space.
 */
async function redactProvenance(env, spaceId, email, tenantId = "") {
  const r2 = env && env.BUNDLES ? bundlesFor(env, tenantId) : null;
  if (!r2 || typeof r2.list !== "function") return { ok: false, reason: "no-bundle-store" };
  const addr = lcEmail(email);
  if (!addr) return { ok: false, reason: "bad-address" };

  let redacted = 0;
  const versions = [];
  const rewrite = async (key) => {
    const obj = await r2.get(key);
    if (!obj) return false;
    let doc;
    try { doc = JSON.parse(await obj.text()); } catch (e) { return false; }
    const next = redactPublishedBy(doc && doc.publishedBy, addr);
    if (next === null) return false;
    doc.publishedBy = next;
    await r2.put(key, JSON.stringify(doc));
    redacted++;
    return true;
  };

  let cursor;
  do {
    const page = await r2.list({ prefix: `spaces/${spaceId}/versions/`, cursor, limit: 1000 });
    for (const o of page.objects || []) {
      if (await rewrite(o.key)) versions.push(o.key.split("/").pop().replace(/\.json$/, ""));
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  // The live manifest carries the same field and is what /_build.json reads.
  const manifest = await rewrite(`spaces/${spaceId}/manifest.json`);

  return { ok: true, redacted, versions, manifest };
}

// ---- Erasure: purge one person from a workspace's stored comments -------------------
//
// `E-gdpr-purge-user`. The existing `remove` op revokes the credential, the invites and
// the lastseen stamp, and never touches comment AUTHORSHIP anywhere. So a person removed
// from a roster is still named on every message they wrote, which is exactly the state an
// erasure request is about.
//
// WHAT IT KEEPS. `body` and `at` survive, and so does thread structure. Deleting the
// messages would erase other people's conversation — a reply that answers a question is
// unreadable once the question is gone — and the request is to stop identifying somebody,
// not to rewrite a record other people are part of. So the message stays and stops
// carrying a person: `author` becomes a fixed sentinel, `by` is cleared, `verified` goes
// false so nothing renders it as a confirmed identity.
//
// ⚠️ IDENTIFICATION IS BY A 32-BIT HASH, AND THAT IS THE SHARP EDGE. Messages store
// `by: personId(email)`, a one-way djb2 hash — deliberately, because an address in every
// stored message would be reversible PII and `/__people` is ungated on public prototypes
// precisely because ids cannot be reversed. Do NOT "fix" that by storing the address.
//
// The consequence is that two addresses can share an id, and a purge keyed on it would
// then redact an innocent third party's messages as well. A machine cannot choose between
// them, so this does not try: before sweeping, it checks the workspace roster for any
// OTHER member sharing the id and REFUSES, naming both. That converts a silent
// over-redaction into a question for a person, which is the only honest answer available.
// PURGED_AUTHOR, purgeThreads and the collision check live in src/purge.mjs, imported at
// the top of this file, because the WORKSPACE OBJECT runs the same sweep — an erasure has to
// happen in every workspace an account belongs to, and only the control plane knows which
// those are. Two copies would be two answers to "was this person erased".

/**
 * Sweep every stored thread in this workspace, plus the lastseen stamp.
 * Returns {ok, redacted, pathsTouched, scanned} or {ok:false, reason, …}.
 */
async function purgeUser(store, ident, kv, users, email) {
  if (!store) return { ok: false, reason: "no-store" };
  // The KV backing sweeps by LIST, which not every stub provides. The workspace store
  // answers the same question with a SELECT and needs no such capability, so the check
  // applies only to the backing that has it.
  if (store.backing === "kv" && (!kv || typeof kv.list !== "function")) {
    return { ok: false, reason: "kv-list-unsupported" };
  }
  const addr = lcEmail(email);
  if (!addr) return { ok: false, reason: "bad-address" };
  const id = personId(addr);

  // The collision check, before anything is written.
  const clashes = idCollisions(users, addr);
  if (clashes.length) {
    return { ok: false, reason: "id-collision", id, collidesWith: clashes.length };
  }

  let redacted = 0, scanned = 0;
  const pathsTouched = [];
  const pages = await store.read("comments");
  for (const [path, threads] of Object.entries(pages)) {
    scanned++;
    const res = purgeThreads(threads, id);
    if (!res.redacted) continue;
    // Written through `mutate`, so a comment posted between the read above and this write
    // is redacted too rather than resurrecting the erasure it raced. On the KV backing
    // that is the same read-modify-write it always was.
    await store.mutate("comments", "", path, (cur) => purgeThreads(cur, id).threads);
    redacted += res.redacted;
    pathsTouched.push(path);
  }

  // The lastseen stamp is an address in a KEY, so it is erased rather than redacted — and
  // from BOTH stores while the family is straddled, or the erasure undoes itself the moment
  // the other one is the answer.
  try { if (ident) await ident.lastseenForget(addr); } catch (e) {}
  try { if (kv) await kv.delete(LASTSEEN_PREFIX + addr); } catch (e) {}
  // The first-run record keys an address too — erased for the same reason, best-effort
  // on the store that holds it (clearFirstRunSeen matches case-insensitively).
  try { if (kv) await clearFirstRunSeen(kv, addr); } catch (e) {}

  return { ok: true, id, redacted, pathsTouched, scanned };
}

// Apply a single review op to a thread array; returns the new array. `me` is the
// server-resolved signed-in user (or null) — passed to sanitizeMsg so authorship of
// every added/replied message is stamped from the session, not the request body.
function applyOp(users, threads, op, me) {
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
        // World (board) coords when the page is an infinite canvas — the overlay
        // prefers these so a pin tracks pan/zoom instead of sticking to the screen.
        cwx: t.cwx == null ? null : +t.cwx, cwy: t.cwy == null ? null : +t.cwy,
        view: clamp(t.view, 600) || null,
        screen: clamp(t.screen, 200) || null,
        resolved: false,
        annotation: !!t.annotation,
        messages: (Array.isArray(t.messages) ? t.messages : []).slice(0, 1).map((m) => sanitizeMsg(users, m, me)),
      });
      if (threads.length > 500) threads = threads.slice(-500);
    }
  } else if (op.op === "move") {
    const t = threads.find((x) => x.id === op.id);
    if (t) {
      t.sel = clamp(op.sel, 600);
      t.fx = +op.fx || 0; t.fy = +op.fy || 0; t.px = +op.px || 0; t.py = +op.py || 0;
      if (op.cwx != null) { t.cwx = +op.cwx; t.cwy = +op.cwy; }
      if (op.view != null) t.view = clamp(op.view, 600) || null;
    }
  } else if (op.op === "reply" && op.message) {
    const t = threads.find((x) => x.id === op.id);
    if (t) t.messages = (t.messages || []).concat([sanitizeMsg(users, op.message, me)]).slice(0, 200);
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

// The two ops that take a whole thread with them: an explicit delete, and delmsg on
// the root message (applyOp filters the thread out for index 0, it does not leave a
// headless remainder). Kept next to applyOp so the two stay in step.
function removesThread(op) {
  if (!op) return false;
  return op.op === "delete" || (op.op === "delmsg" && +op.index === 0);
}

// Who may take a thread away: an admin, or the person the root message is stamped to.
// `by` is server-stamped (sanitizeMsg), never read from a request body, which is what
// makes it usable as an authorisation input rather than just a display hint.
function mayRemoveThread(thread, me) {
  if (!me) return false;
  if (me.role === "admin") return true;
  const root = (thread.messages || [])[0];
  const by = root && root.by;
  return !!by && by === personId(me.email);
}

// GET/POST /__review/api?path=<page> — read or mutate one page's threads.
// Fully OPEN, reads AND writes (see router): reviewers with only a public
// prototype link must be able to comment. applyOp clamps/caps every field.
async function reviewApi(tctx, request, url, env, authed) {
  const store = overlayFor(env, tctx);
  const path = clamp(url.searchParams.get("path") || "/", 600);
  if (!store) return jsonResponse({ threads: [], warning: "no-kv-binding" });

  if (request.method === "GET") {
    return jsonResponse({ threads: (await store.readKey("comments", "", path)) || [] });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    // Adding/replying stays open (public reviewers carry no login), but DESTRUCTIVE ops
    // — deleting a thread or a message — require a signed-in user in identity mode.
    // Otherwise anyone who learns a page URL can wipe its whole review history. `authed`
    // is undefined for callers that don't pass it (raw/open builds) → treated as open.
    if (authed === false && op && (op.op === "delete" || op.op === "delmsg")) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    // Resolve the caller's session so authorship is stamped from the cookie, not the
    // body. Reads/writes stay open (public reviewers carry no login) — this only fixes
    // WHO a message is attributed to, so a forged trusted name can't slip in.
    const me = await identify(request, env, tctx.USERS, { sessionKeys: tctx.SESSION_KEYS, tctx });
    // The permission check below reads the CURRENT threads; the mutate re-reads them and
    // may run again on a retry. Both see the same document because both go through the
    // store, and the check is about who owns a root message — a fact that does not change
    // under a concurrent add.
    let threads = (await store.readKey("comments", "", path)) || [];
    // Removing a thread erases someone else's words, so "is anyone signed in" is not a
    // strong enough gate on an instance with a roster: it let any teammate — or anyone
    // holding a shared viewer login — wipe a colleague's thread. Both ops that FULLY
    // remove a thread (`delete`, and `delmsg` on the root message) additionally require
    // the caller to be an admin or the author of that root message, matched on the
    // stable `by` marker sanitizeMsg stamps from the session. A root with no `by`
    // (anonymous, or written before the field existed) is admin-only — a display name
    // is not an ownership claim. Deleting a REPLY keeps the signed-in-only rule.
    if (authed !== undefined && removesThread(op)) {
      const t = threads.find((x) => x.id === op.id);
      if (t && !mayRemoveThread(t, me)) return jsonResponse({ error: "forbidden" }, 403);
    }
    // Read, apply, write back — retrying if somebody else wrote in between, which is the
    // whole reason a page's threads live in a row with a revision. Two reviewers on one
    // public link is the ordinary case, not the exotic one: without this, an add landing at
    // the same moment as a delete loses one of the two, and the reviewer whose comment
    // vanished has no way to know it ever existed.
    threads = await store.mutate("comments", "", path,
      (cur) => applyOp(tctx.USERS, Array.isArray(cur) ? cur : [], op, me));
    return jsonResponse({ threads });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- The content overlay: one accessor, two backings ------------------------
//
// Four families remember things ABOUT published content rather than in it: a prototype's
// dev status, a card's display-name override, the boards created from a folder index, and
// a person's pins. Each was a single KV document holding the whole map, read and written
// back on every edit.
//
// WHAT THAT COSTS. A whole-map document is read, mutated and written back, so two edits to
// DIFFERENT keys landing together lose one: the second write is computed from a map that
// predates the first. There is no error and nothing to see — a status simply does not
// stick and the person clicks it again. It is the same shape as the pins wipe this code
// already carries a warning about, and the pins fix (the client owns the whole map) works
// only because pins have ONE writer.
//
// So the families move to one row per key in the workspace's Durable Object, where two
// edits to different keys are two rows and cannot lose each other.
//
// THE KV BACKING IS TODAY'S CODE, VERBATIM, and it stays. No instance binds TENANTS yet;
// every one of them keeps the exact keys, the exact documents and the exact behaviour it
// has now, including the races. This accessor is the seam that lets a family move without
// its four call sites learning where it lives.
// TWO KV LAYOUTS, because the families really do have two. `map` is one document holding
// the whole `{key: value}` map — statuses, names, canvases, pins. `keyed` is one document
// PER key — the piti channel's `pt:view` and `pt:remarks`, which are not a map at all but
// two unrelated singletons that happen to share a prefix.
//
// The distinction lives here and only here. On the Durable Object both are rows, and no
// call site has to know which layout its family happens to have in KV.
const OVERLAY_KV_KEYS = Object.freeze({
  statuses: Object.freeze({ doc: "statuses", layout: "map" }),
  names: Object.freeze({ doc: "names", layout: "map" }),
  canvases: Object.freeze({ doc: "canvases", layout: "map" }),
  pins: Object.freeze({ doc: "pins", layout: "map" }),
  piti: Object.freeze({ doc: "pt", layout: "keyed" }),
  // One document per PAGE. Both hold a document the worker reads, changes and writes back
  // whole — a page's comment threads, a board's nodes — which is why `mutate` below exists
  // and why the row carries a revision.
  comments: Object.freeze({ doc: "c", layout: "keyed" }),
  // `workspaceScoped` — the key may carry the workspace it belongs to, as a segment
  // between the document name and the key (`board:<workspace>:<path>`). Boards are the one
  // family with it, because boards are the one family with a SECOND writer outside this
  // module: the room mirrors the same document from src/board-room.mjs. Both build the key
  // through one function (src/board-key.mjs), and test/board-key.test.mjs asserts the two
  // produce the same string, so the spelling here cannot drift away from the mirror.
  //
  // The segment is opt-in per REQUEST, not per family — see `kvWorkspaceSegment`. A
  // deployment that does not serve its own rooms passes nothing and writes the key it has
  // always written.
  boards: Object.freeze({ doc: "board", layout: "keyed", workspaceScoped: true }),
  // Canvas image METADATA — the bytes are in R2. See assetApi.
  assets: Object.freeze({ doc: "basset-meta", layout: "keyed" }),
  // WORKING MARKS — "something is editing here right now". One row per path, and the row
  // is only meaningful until its own TTL runs out. See the marks section below.
  //
  // `map` RATHER THAN `keyed`, and the trade is worth naming because it looks backwards.
  // Keyed would give one KV document per path, so two marks written in the same window
  // could not lose each other. It would also turn every READ into a kv.list plus a get per
  // row — and marks are read by a gallery page as well as by the CLI, which puts a listing
  // in front of ordinary page loads on a store whose daily get budget has been exhausted
  // before. One document is one get. What it costs is stated on `writeMark`.
  marks: Object.freeze({ doc: "marks", layout: "map" }),
});

/** How many times a compare-and-swap retries before giving up. */
const OVERLAY_CAS_ATTEMPTS = 5;

/**
 * The KV key a family+scope+key lives under, exactly as every live instance already
 * spells it. A `map` family's scope suffixes the document (`pins:<email>`); a `keyed`
 * family's key does (`pt:view`).
 *
 * `workspace` is the fourth argument and it DEFAULTS TO NONE, which is the whole of the
 * straddle: every existing caller passes three arguments and gets back the string it has
 * always got back. Only a `workspaceScoped` family reads it at all, and only when it is
 * non-empty — see the boards entry above and `kvWorkspaceSegment` below.
 */
function overlayKvKey(family, scope, k, workspace = "") {
  const spec = OVERLAY_KV_KEYS[family];
  if (!spec) throw new Error(`unknown overlay family: ${family}`);
  if (spec.layout === "keyed") {
    if (!k) throw new Error(`${family} is stored one document per key; a key is required`);
    if (spec.workspaceScoped && workspace) return `${spec.doc}:${workspace}:${k}`;
    return `${spec.doc}:${k}`;
  }
  return scope ? `${spec.doc}:${scope}` : spec.doc;
}

const overlayLayout = (family) => (OVERLAY_KV_KEYS[family] || {}).layout;

/**
 * Which workspace segment this request's KV keys carry, and whether an UNSCOPED key in
 * this namespace can be read as this workspace's.
 *
 * ⚠️ THE SEGMENT IS TIED TO THE ROOMS BINDING, AND NOT TO THE RESOLVED WORKSPACE ID.
 * That looks like the wrong discriminator until you count the writers. A board document
 * has two: this module's `/__board` rail, and the room's write-through mirror. They are
 * ONE script only on a deployment that serves its own rooms. Everywhere else the mirror
 * lives in a separate `augur-realtime-*` worker that has never heard of a workspace, and
 * scoping only this half of the pair would leave `/__board` reading a key the room never
 * writes — the board would freeze at the moment of the deploy while the room kept editing
 * a document nothing served. So the key moves on exactly the deploy that brings the room
 * in, which is what the plan item means by ONE CUTOVER.
 *
 * `legacyIsOurs` is the second half and it guards a different mistake. An unscoped key
 * predates the segment, so it belongs to whichever workspace this deployment served at the
 * time — a question with an answer only where a deployment serves ONE. Where the workspace
 * comes from the Host header, an unscoped key is unattributable, and reading it would hand
 * one workspace a board that may be another's. There, a miss is a miss.
 */
function kvWorkspaceSegment(env, tctx) {
  const hostResolved = !!(env && typeof env.TENANT_HOST_SUFFIX === "string" && env.TENANT_HOST_SUFFIX.trim());
  return {
    workspace: env && env.ROOMS ? ((tctx && tctx.tenantId) || DEFAULT_TENANT_ID) : "",
    legacyIsOurs: !hostResolved,
  };
}

function kvOverlay(kv, { workspace = "", legacyIsOurs = true } = {}) {
  // The unscoped key this family used before it gained a workspace segment, or null when
  // there is nothing to fall back TO (an unscoped deployment, a family that never scopes,
  // or a deployment that cannot attribute an unscoped key — see kvWorkspaceSegment).
  const legacyKey = (family, scope, k) => {
    if (!workspace || !legacyIsOurs) return null;
    if (!(OVERLAY_KV_KEYS[family] || {}).workspaceScoped) return null;
    return overlayKvKey(family, scope, k, "");
  };
  const readMapDoc = async (family, scope) => {
    const raw = await kv.get(overlayKvKey(family, scope));
    return raw ? JSON.parse(raw) : {};
  };
  const readOne = async (family, scope, k) => {
    if (overlayLayout(family) === "keyed") {
      const key = overlayKvKey(family, scope, k, workspace);
      const raw = await kv.get(key);
      if (raw !== null && raw !== undefined) return JSON.parse(raw);
      // READ-THROUGH. A document written before this family carried a workspace segment is
      // still this workspace's document; it is served, and written back under the scoped
      // key so the fallback is paid once per board rather than once per read.
      // `scripts/migrate-board-keys.mjs` does the same thing in one pass — this is what
      // makes the batch an optimisation rather than a prerequisite.
      const old = legacyKey(family, scope, k);
      if (!old) return null;
      const raw2 = await kv.get(old);
      if (raw2 === null || raw2 === undefined) return null;
      await kv.put(key, raw2);
      return JSON.parse(raw2);
    }
    const map = await readMapDoc(family, scope);
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
  };
  const read = async (family, scope = "") => {
    if (overlayLayout(family) !== "keyed") return readMapDoc(family, scope);
    // A keyed family's whole set is a LIST, which is the expensive call this codebase
    // otherwise avoids. Two callers need it — the review export and the purge sweep — and
    // both were hand-rolling this cursor loop; on the workspace store it is one SELECT.
    const spec = OVERLAY_KV_KEYS[family];
    const scoped = spec.workspaceScoped && workspace ? `${spec.doc}:${workspace}:` : `${spec.doc}:`;
    const out = {};
    const sweep = async (prefix, skipScoped) => {
      let cursor;
      do {
        const page = await kv.list({ prefix, cursor });
        for (const entry of page.keys) {
          // The legacy sweep runs over a prefix the scoped keys also match, so it has to
          // step over them; the scoped answer already holds those and is the newer one.
          if (skipScoped && entry.name.startsWith(scoped)) continue;
          const k = entry.name.slice(prefix.length);
          if (Object.prototype.hasOwnProperty.call(out, k)) continue;
          const raw = await kv.get(entry.name);
          if (raw === null || raw === undefined) continue;
          try { out[k] = JSON.parse(raw); } catch (e) { /* skip a corrupt document */ }
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
    };
    await sweep(scoped, false);
    // Boards that have not been through the read-through or the batch script yet are still
    // this workspace's boards, and the two callers of this — the state export and the
    // canvas-image garbage collection — are both WRONG if they miss one. The GC reads
    // image references OFF the boards, so a board it cannot see is a set of images it
    // deletes while somebody is looking at them.
    //
    // ⚠️ THE SWEEP CANNOT TELL A LEGACY KEY FROM A NEIGHBOUR'S SCOPED ONE — `board:/x/` and
    // `board:other:/x/` differ by a segment whose whole purpose is to be added later. It
    // does not have to: `legacyIsOurs` says this namespace holds ONE workspace's rows, so
    // there is no neighbour in it. Widening that flag without changing this is how one
    // workspace's export grows another's boards.
    if (legacyIsOurs && spec.workspaceScoped && workspace) await sweep(`${spec.doc}:`, true);
    return out;
  };
  return {
    backing: "kv",
    read,
    readKey: readOne,
    /**
     * Read, change, write back. On KV that is exactly what it has always been — there is
     * no conditional put, so two edits to one key can still lose each other, and pretending
     * otherwise here would be the dishonest half of a straddle.
     */
    async mutate(family, scope, k, fn) {
      const before = await readOne(family, scope, k);
      const after = fn(before);
      if (after === undefined) return before;
      await this.set(family, scope, k, after);
      return after;
    },
    // `owner` is accepted and dropped. The KV backing has nowhere to put a per-row column
    // — a map document has no rows — and the alternative, a parallel owner document, is a
    // second record of the same thing that drifts. Ownership arrives with the workspace
    // object, like every other new column in this phase.
    async set(family, scope, k, v, _owner) {
      if (overlayLayout(family) === "keyed") {
        const key = overlayKvKey(family, scope, k, workspace);
        if (v === null || v === undefined) {
          await kv.delete(key);
          // A delete has to reach the legacy key too, or a board deleted after the segment
          // arrived comes back at the next read-through. Nothing else about the fallback is
          // destructive; this one has to be, and it deletes only the key THIS workspace
          // would have served.
          const old = legacyKey(family, scope, k);
          if (old) await kv.delete(old);
        } else await kv.put(key, JSON.stringify(v));
        return v === null || v === undefined ? null : v;
      }
      const map = await readMapDoc(family, scope);
      if (v === null || v === undefined) delete map[k]; else map[k] = v;
      await kv.put(overlayKvKey(family, scope), JSON.stringify(map));
      return map;
    },
    async insert(family, scope, k, v, _owner) {
      // Read-then-write, which is what it has always been: KV has no conditional put, so
      // two creates of one key can both pass the check. Named rather than hidden — the DO
      // backing below is where this stops being true.
      const map = await readMapDoc(family, scope);
      if (Object.prototype.hasOwnProperty.call(map, k)) return { inserted: false, map };
      map[k] = v;
      await kv.put(overlayKvKey(family, scope), JSON.stringify(map));
      return { inserted: true, map };
    },
    async replace(family, scope, map) {
      if (overlayLayout(family) === "keyed") {
        // One document per key, so a whole-family replace is one write per key. The keys
        // it does not name are LEFT — a restore replays a family it read in full, and
        // deleting what the document does not mention would make an incomplete backup
        // destructive rather than merely incomplete.
        for (const [k, v] of Object.entries(map || {})) {
          await kv.put(overlayKvKey(family, scope, k, workspace), JSON.stringify(v));
        }
        return map || {};
      }
      await kv.put(overlayKvKey(family, scope), JSON.stringify(map));
      return map;
    },
  };
}

function doOverlay(stub, tenantId) {
  const call = async (op, body) => {
    const res = await stub.fetch(`https://workspace/overlay/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, workspaceId: tenantId }),
    });
    if (!res.ok) throw new Error(`workspace store answered ${res.status}`);
    return res.json();
  };
  return {
    backing: "do",
    read: async (family, scope = "") => (await call("read", { family, scope })).map,
    /**
     * Which scopes this family holds anything under. Read by the EXPORT and by nothing
     * else — every request-path caller already knows whose scope it wants, and a copy is
     * the one caller that cannot. On the KV backing the scopes are a key prefix and the
     * export lists them itself; here they are a column, so the object has to be asked.
     */
    scopes: async (family) => (await call("scopes", { family })).scopes || [],
    readKey: async (family, scope, k) => (await call("read-rev", { family, scope, k })).v,
    /**
     * Read, change, write back — and RETRY when somebody else wrote in between.
     *
     * Per-key rows fix two edits to two keys. They do nothing for two edits to ONE key,
     * which is what a comment thread and a board document are: the worker reads the whole
     * document, changes part of it and puts it back. Matching on the revision turns "one of
     * these two ops vanished" into "one of them retried", which is the difference between a
     * comment that never appeared and a comment that appeared.
     *
     * `fn` may return `undefined` to mean "nothing to write", and it runs again on each
     * attempt against a fresh read — so it must be a function OF the value, not a closure
     * over a value read earlier.
     */
    async mutate(family, scope, k, fn) {
      for (let attempt = 0; attempt < OVERLAY_CAS_ATTEMPTS; attempt++) {
        const { v, rev } = await call("read-rev", { family, scope, k });
        const after = fn(v);
        if (after === undefined) return v;
        const res = await call("cas", { family, scope, k, v: after, rev });
        if (res.ok) return after;
      }
      throw new Error(`overlay: ${family}/${k} kept changing under ${OVERLAY_CAS_ATTEMPTS} attempts`);
    },
    set: async (family, scope, k, v, owner) => (await call("set", { family, scope, k, v, owner })).map,
    insert: async (family, scope, k, v, owner) => {
      const r = await call("insert", { family, scope, k, v, owner });
      return { inserted: r.inserted, map: r.map };
    },
    /** Who owns a row. Nothing reads this to decide anything yet — see B-resource-authz-hook. */
    owner: async (family, scope, k) => call("owner", { family, scope, k }),
    replace: async (family, scope, map) => (await call("replace", { family, scope, map })).map,
  };
}

/**
 * The overlay for THIS workspace, or null when the deployment has no store at all (a raw
 * engine build). Callers answer `{map:{}, warning:"no-kv-binding"}` on null, which is what
 * they have always done.
 */
function overlayFor(env, tctx) {
  const stub = tenantStub(env, tctx && tctx.tenantId);
  if (stub) return doOverlay(stub, tctx.tenantId);
  const kv = kvFor(env);
  // The workspace object needs none of this — a row there belongs to the object that holds
  // it, so there is no key to scope. It is the KV backing that has one flat namespace, and
  // `kvWorkspaceSegment` is where the decision to use it lives.
  return kv ? kvOverlay(kv, kvWorkspaceSegment(env, tctx)) : null;
}

// ---- The identity families, one cut at a time -------------------------------
//
// `B-kv-read-cutover`. The content overlay above came across as one move because it is one
// accessor. The identity families are not: each has its own accessor, its own failure mode
// and its own way of being wrong, so each moves on its own and each has to be revertible on
// its own — the property that kept every earlier family in this phase from being able to
// take an instance down.
//
// ⚠️ REVERTING ONE FAMILY IS FLIPPING ONE WORD HERE. That is the whole of it: `false` sends
// that family's reads and writes back down the KV path with nothing else touched, and it is
// safe at any moment because the WRITES go to BOTH stores for as long as the flag is on.
// A straddle where only the object is written is a straddle you cannot come back from —
// the revert would silently lose everything minted since the cut — so dual-write is not
// belt-and-braces here, it is what makes the word a revert rather than a rollback.
//
// The reads are the other way round: the object first, KV as the FALLBACK. That is what
// carries an invite link somebody is already holding across the cut — the link predates the
// copy or the copy missed it, the object has never heard of it, and KV still has it.
//
// ⛔ `users:secrets` IS NOT HERE AND MUST NOT BE. A credential is account-level — one
// address, one password, several workspaces — so it goes to the control plane's account
// store and not to any workspace's. `effectiveSecret` moving belongs to
// `B-cross-workspace-signin`, which lands independently; whichever of the two is second
// reads the other's straddle rather than replacing it.
const KV_CUTOVER = Object.freeze({
  // `users:invites` → the object's `invites` table. Hash-keyed on both sides, and the hash
  // is the contract: `inviteHash` is `tokenFor("inv:" + token)` here, in the copy, and in
  // the redemption path, or every link already sitting in somebody's inbox dies quietly.
  invites: true,
  // `users:lastseen:<address>` → the object's `lastseen` table. The safest family in the
  // set: it grants nothing and refuses nothing, so a wrong answer costs a column in the
  // admin list and never a session.
  lastseen: true,
  // `publish:tokens` → the object's `publish_tokens` table, WITH its scope. The sharp one:
  // KV records a token as `{space, label, createdAt, expiresAt?}` and `space` is the
  // AUTHORIZATION SCOPE, not a label — `publishAuthDetailed` refuses `wrong-space` on it,
  // and `*` is admin-equivalent because a star token pushes instance config, which is the
  // user list. The table now has a `scope` column carrying that value VERBATIM, and a row
  // whose scope is NULL — one a copy wrote before the column existed — is treated as no
  // answer rather than as a guess, so no token is widened to star and none is refused for
  // a value the copy could not carry.
  publishTokens: true,
  // `users:roster` / `users:roles` / `users:names` / `users:avatars` → `members`, read back
  // as those same four documents so the serving pipeline is one pipeline rather than two
  // that have to agree. The table keeps the durable half and the overlay half in separate
  // columns, because `applyNames` DROPS a config-set `initials` when there is a name
  // override and keeps it when there is not — one merged column cannot answer both, and a
  // login-gate cut with a known divergence is not a cut.
  //
  // This is the read-volume one: six KV gets per workspace per sixty-second tick was the
  // site's dominant KV consumer, enough to exhaust a day's `get()` budget and take every
  // KV-touching route down with it. Four of the six become one round trip here.
  roster: true,
  //
  // ⏳ WHAT IS NOT HERE, AND WHY EACH ONE IS LEFT RATHER THAN SKIPPED.
  //
  // `users:spaces` → NOTHING, on purpose. The inventory sends it to `drop`: it was a role
  // per address PER SPACE from when one deployment mounted several, and a workspace is the
  // only tier now. So `readSpaces` is the one KV get `rosterFields` still spends on a cut
  // workspace, and it stays: answering `{}` from the object would drop every per-space
  // restriction an instance has recorded, and `roleIn` gives a non-member `editor` where
  // their global role might be `admin` — a WIDENING, which is the direction this item is
  // most careful about. Retiring the document is `A-retire-space-tier`'s to do, and it is a
  // deletion rather than a cut.
  //
  // `spaces:icons` → the object's `settings` table, which `importAll` does not write.
  // Declared unmapped in `UNMAPPED_WORKSPACE_FAMILIES` with that reason, so a copy of a
  // workspace does not silently claim to have carried it. Until the copy fills it, the read
  // has nothing to move to; `readSpaceIcons` is the second and last KV get on this path.
  //
  // ⛔ `users:secrets` is not a gap and never becomes one here: see the header above.
});

/**
 * This workspace's identity store for ONE family, or null when that family has not been
 * cut over or the deployment has no workspace object at all.
 *
 * Null is the KV path — the answer every self-hosted instance gets, because a deployment
 * with no `TENANTS` binding has no object to read from and never will.
 */
function identityFor(env, tctx, family) {
  if (!KV_CUTOVER[family]) return null;
  const stub = tenantStub(env, tctx && tctx.tenantId);
  return stub ? doIdentity(stub, tctx.tenantId) : null;
}

/**
 * The identity verbs on a workspace object, as the accessor the worker calls.
 *
 * ⚠️ ONLY THE HASH TRAVELS. A raw invite token never leaves the worker: the object stores
 * hashes so that a read of its storage — a backup, an export, an operator looking — cannot
 * redeem anybody's invitation, and sending the raw token over this wire to be hashed there
 * would put it in a request body for no gain.
 */
function doIdentity(stub, tenantId) {
  const call = async (op, body) => {
    const res = await stub.fetch(`https://workspace/identity/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, workspaceId: tenantId }),
    });
    if (!res.ok) throw new Error(`workspace store answered ${res.status}`);
    return res.json();
  };
  return {
    backing: "do",
    inviteRead: async (tokenHash, now) => (await call("invite/read", { tokenHash, now })).email,
    inviteConsume: async (tokenHash, now) => (await call("invite/consume", { tokenHash, now })).email,
    inviteMint: (rec, now) => call("invite/mint", { ...rec, now }),
    inviteRevoke: (email) => call("invite/revoke", { email }),
    lastseenRead: async () => (await call("lastseen/read", {})).map || {},
    lastseenTouch: (email, throttleMs, now) => call("lastseen/touch", { email, throttleMs, now }),
    lastseenForget: (email) => call("lastseen/forget", { email }),
    // The four roster documents in ONE round trip, spelled the way KV spells them —
    // `{seeded, roster, roles, names, avatars}`. `seeded` is the object saying whether it
    // has ever been given this family: an empty overlay and an un-copied one read the same
    // from the rows, and only one of them may be answered from here.
    rosterRead: () => call("roster/read", {}),
    rosterWrite: (docs) => call("roster/write", docs),
    tokenRead: async (tokenHash) => (await call("token/read", { tokenHash })).entry,
    tokenList: () => call("token/list", {}),
    tokenMint: (rec) => call("token/mint", rec),
    tokenRevoke: (sel) => call("token/revoke", sel),
  };
}

// ---- Export and restore of everything that is NOT published content ---------
//
// Driven by the inventory (`scripts/lib/state-inventory.mjs`), so the list of what a
// backup covers and the list of what exists are ONE list. See the `_state` routes for why
// that matters and for what is excluded by construction.
//
// The two layouts the accessor already knows about map straight onto two export shapes:
// a `map` family is one object, a `keyed` family is an object of objects. Everything else
// — the identity documents the accessor does not own — is read from KV as it is written,
// which is what makes this a faithful copy rather than an interpretation.
const STATE_KV_PREFIXED = Object.freeze(["users:lastseen:", "avatar:", "spaceicon:"]);

/** Read one inventory entry out of whatever store holds it. */
async function readStateFamily(tctx, env, entry, store, kv) {
  const family = Object.keys(OVERLAY_KV_KEYS).find((f) => {
    const spec = OVERLAY_KV_KEYS[f];
    return spec.doc === entry.id || spec.doc + ":" === entry.id || entry.id.startsWith(spec.doc + ":");
  });
  if (family && store) {
    if (entry.id === "pins:") {
      // The one scoped family. Every person's pins, keyed by the address they belong to —
      // read through the same listing the accessor uses for a keyed family, because a
      // scope is a suffix on the document name.
      if (store.backing === "kv") {
        const out = {};
        let cursor;
        do {
          const page = await kv.list({ prefix: "pins:", cursor });
          for (const k of page.keys) {
            const raw = await kv.get(k.name);
            if (raw != null) { try { out[k.name.slice("pins:".length)] = JSON.parse(raw); } catch (e) {} }
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        return out;
      }
      // ⚠️ THE SAME FAMILY, ASKED THE OTHER WAY. On the workspace store a person's sidebar
      // is rows under a SCOPE rather than a key under a prefix, and every other read here
      // names the scope it wants because every other caller knows it. A copy does not, so it
      // asks which scopes exist and reads each one — the same object of maps the KV branch
      // above builds, keyed by the same addresses.
      //
      // RETURNING null HERE INSTEAD (which is what this did) was the bug behind two failures
      // that look unrelated. A migration off KV compared `{}` against a family reported
      // ABSENT and refused to verify — on correct data, and above the board-move step, so
      // the one step that reads a board from its room could never run. And an export taken
      // FROM this backing carried no sidebars at all while reporting itself complete, which
      // a restore then had nothing to put back.
      //
      // Scope "" is excluded on purpose: that is the signed-out visitor's sidebar, which is
      // the bare `pins` entry in the inventory and is exported by it. KV spells the two
      // apart the same way — `pins` and `pins:<address>` — so both backings carry the same
      // split and neither carries anything twice.
      if (typeof store.scopes !== "function") return null;
      const out = {};
      for (const scope of await store.scopes("pins")) {
        if (!scope) continue;
        out[scope] = await store.read("pins", scope);
      }
      return out;
    }
    if (entry.id === "pt:view" || entry.id === "pt:remarks") {
      return await store.readKey("piti", "", entry.id.slice("pt:".length));
    }
    return await store.read(family, "");
  }
  if (!kv) return null;
  if (STATE_KV_PREFIXED.includes(entry.id)) {
    const out = {};
    let cursor;
    do {
      const page = await kv.list({ prefix: entry.id, cursor });
      for (const k of page.keys) {
        const raw = await kv.get(k.name);
        if (raw == null) continue;
        try { out[k.name.slice(entry.id.length)] = JSON.parse(raw); }
        catch (e) { out[k.name.slice(entry.id.length)] = raw; } // an avatar is a data URI, not JSON
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return out;
  }
  const raw = await kv.get(entry.id);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

/**
 * Every family destined for the workspace, as one document.
 *
 * `absent` is reported rather than omitted: a family that is empty and a family that could
 * not be read look identical in a JSON blob, and a restore that cannot tell them apart is a
 * restore that silently deletes.
 *
 * ONLY A `key` FAMILY CAN BE ABSENT, WHEREVER THERE IS A STORE TO READ. A whole-document
 * family either has a document or does not; a PREFIX family is a set of keys, and a set with
 * nothing in it is empty rather than missing — there is no third state to report and
 * inventing one would be a distinction the store cannot make.
 *
 * ⚠️ THAT IS AN INVARIANT THIS FUNCTION HAS TO KEEP, NOT AN OBSERVATION ABOUT IT. It was
 * false for `pins:` on the workspace-object backing, which reported absent whether the
 * family was empty or full, and two things downstream believe it: `augur migrate` treats an
 * absent `key` family as an empty one and REFUSES to treat an absent prefix family that way,
 * and `augur restore` clears a family it is given as `{}` while leaving one it is not given
 * at all. A prefix family reported absent therefore reads as "this copy could not enumerate
 * it", which is exactly what it means and exactly why it must never be a spelling of empty.
 * `test/state-export-absent.test.mjs` holds it shut on both backings.
 *
 * A deployment with NO store bound at all — a raw engine build — reports everything absent,
 * prefix families included, and that is the honest answer: there is nothing to enumerate.
 */
async function exportState(tctx, env) {
  const store = overlayFor(env, tctx);
  const kv = kvFor(env, tctx);
  const families = {};
  const absent = [];
  const failed = [];
  for (const entry of STATE_INVENTORY) {
    if (entry.to !== "workspace") continue;
    try {
      const value = await readStateFamily(tctx, env, entry, store, kv);
      if (value === null || value === undefined) { absent.push(entry.id); continue; }
      families[entry.id] = value;
    } catch (err) {
      failed.push({ id: entry.id, error: String((err && err.message) || err).slice(0, 200) });
    }
  }
  // The hashes a restore has to fetch the bytes for, separately, at `_state/asset/<hash>`.
  //
  // THREE SOURCES, because an image can be in any of three states and a copy that counts
  // only two makes a migration unable to prove itself.
  //
  //   · a `basset-meta:` row — an image pasted through the canvas, which writes the bytes
  //     to R2 and the row together;
  //   · a `basset:` key in KV — pasted before the R2 move, bytes still in KV, no row. Left
  //     out, `--full` quietly omits every image on any instance running a while;
  //   · an object under `assets/` in R2 with NO row — which is exactly what a restore
  //     leaves, because it writes the bytes it was given and a pre-move image never had a
  //     row to carry across.
  //
  // ⚠️ THE THIRD IS WHAT MAKES `augur migrate` VERIFIABLE. That command compares the
  // source's asset list against the target's; without this the far side reported every
  // restored pre-move image as missing, forever, on a workspace where the data had in fact
  // arrived and was serving. A verification that cannot pass on correct data teaches people
  // to skip it, on the one command whose entire purpose is proving the copy landed.
  const assets = new Set(families["basset-meta:"] ? Object.keys(families["basset-meta:"]) : []);
  if (kv && typeof kv.list === "function") {
    try {
      let cursor;
      do {
        const page = await kv.list({ prefix: ASSET_PREFIX, cursor });
        for (const k of page.keys) assets.add(k.name.slice(ASSET_PREFIX.length));
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
    } catch (err) {
      failed.push({ id: ASSET_PREFIX, error: String((err && err.message) || err).slice(0, 200) });
    }
  }
  if (env.BUNDLES && typeof env.BUNDLES.list === "function") {
    try {
      let cursor;
      // This workspace's images, not the deployment's. `assets/` carries the segment.
      const bundles = bundlesFor(env, tctx && tctx.tenantId);
      do {
        const page = await bundles.list({ prefix: ASSET_R2_PREFIX, cursor });
        for (const o of page.objects || []) assets.add(o.key.slice(ASSET_R2_PREFIX.length));
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
    } catch (err) {
      failed.push({ id: ASSET_R2_PREFIX, error: String((err && err.message) || err).slice(0, 200) });
    }
  }
  return { families, absent, failed, assets: [...assets], format: 1 };
}

/**
 * Families a reset may NEVER clear, whatever it asks for.
 *
 * Clearing the credential store would put every seeded password back into service at once
 * and strand anybody who had changed theirs; clearing invites would kill outstanding
 * links; clearing publish tokens would break the publish path for whatever holds one.
 * A nightly reset is exactly the kind of job that grows a family in its list by accident,
 * so the refusal lives here rather than in whichever script is doing the resetting.
 */
const NEVER_CLEARED = Object.freeze(["users:secrets", "users:invites", "publish:tokens"]);

/**
 * Empty named families. The verb a reset needs and a restore does not.
 *
 * Distinct from importing an empty family for two reasons: a family the inventory marks
 * droppable (`users:spaces`) is one an import correctly skips and a reset correctly
 * clears, and "empty this" said out loud is auditable in a way that "import nothing into
 * this" is not.
 */
async function clearFamilies(tctx, env, ids) {
  const store = overlayFor(env, tctx);
  const kv = kvFor(env, tctx);
  const cleared = [];
  const refused = [];
  for (const id of ids || []) {
    if (NEVER_CLEARED.includes(id)) { refused.push(id); continue; }
    const entry = STATE_INVENTORY.find((e) => e.id === id);
    if (!entry || entry.store !== "kv") { refused.push(id); continue; }
    const family = Object.keys(OVERLAY_KV_KEYS).find((f) => {
      const spec = OVERLAY_KV_KEYS[f];
      return spec.doc === id || spec.doc + ":" === id || id.startsWith(spec.doc + ":");
    });
    if (family && store) {
      const existing = await store.read(family, "");
      for (const k of Object.keys(existing)) await store.set(family, "", k, null);
      cleared.push(id);
      continue;
    }
    if (!kv) { refused.push(id); continue; }
    if (STATE_KV_PREFIXED.includes(id) || entry.kind === "prefix") {
      let cursor;
      do {
        const page = await kv.list({ prefix: id, cursor });
        for (const k of page.keys) await kv.delete(k.name);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
    } else {
      await kv.delete(id);
    }
    cleared.push(id);
  }
  return { cleared, refused };
}

/**
 * Put an exported document back.
 *
 * Family by family, and it REFUSES a document that reports failures rather than replaying
 * a partial copy — "restore what we managed to read" is how a restore turns a bad backup
 * into a bad live instance.
 *
 * `clear` empties the families it names first — a reset says "this family is exactly this
 * and nothing else", where a restore says "at least this". `prune` says the same thing for
 * the families the document DOES carry: keys it does not name are removed.
 *
 * Both are opt-in and both default off, because a restore must not be destructive on the
 * strength of an incomplete copy: a family missing from a truncated backup would otherwise
 * empty the live one.
 */
async function importState(tctx, env, doc) {
  if (!doc || doc.format !== 1 || !doc.families
      || typeof doc.families !== "object" || Array.isArray(doc.families)) {
    return { ok: false, reason: "bad-document" };
  }
  if (Array.isArray(doc.failed) && doc.failed.length) {
    return { ok: false, reason: "incomplete-export", failed: doc.failed.map((f) => f && f.id) };
  }
  const store = overlayFor(env, tctx);
  const kv = kvFor(env, tctx);
  if (!store && !kv) return { ok: false, reason: "no-store" };

  const cleared = doc.clear ? await clearFamilies(tctx, env, doc.clear) : { cleared: [], refused: [] };
  if (doc.prune && store && store.backing === "kv") {
    // Keys the document does not name, in the families it does. The workspace object does
    // this inside its own transaction (see importOverlay); KV has no such thing, so it is a
    // listing and a delete per key — correct, and part of why `prune` is opt-in rather than
    // something a restore pays for by default.
    for (const [id, value] of Object.entries(doc.families)) {
      const family = Object.keys(OVERLAY_KV_KEYS).find((f) => {
        const spec = OVERLAY_KV_KEYS[f];
        return spec.doc === id || spec.doc + ":" === id || id.startsWith(spec.doc + ":");
      });
      if (!family || id === "pins:" || id.startsWith("pt:")) continue;
      const existing = await store.read(family, "");
      for (const k of Object.keys(existing)) {
        if (!Object.prototype.hasOwnProperty.call(value || {}, k)) await store.set(family, "", k, null);
      }
    }
  }

  // ── ONE TRANSACTION, when there is an object to have one in ────────────────
  //
  // `MIG-do-import-endpoint`. Family by family is survivable for an edit and wrong for a
  // restore: a failure halfway leaves a workspace with some families from the copy and
  // some from whatever was there before — a state matching no backup and no moment in
  // time, which nobody can tell apart from a successful restore by looking.
  //
  // The worker does the translation (inventory ids → DO families and scopes) and the
  // object does the write. It has never needed to know what anything was called in KV,
  // and a restore is a poor moment to teach it.
  const stub = tenantStub(env, tctx && tctx.tenantId);
  if (stub) {
    const bundle = {};
    const written = [];
    const skipped = [];
    for (const [id, value] of Object.entries(doc.families)) {
      const entry = STATE_INVENTORY.find((e) => e.id === id);
      if (!entry || entry.to !== "workspace") { skipped.push(id); continue; }
      const family = Object.keys(OVERLAY_KV_KEYS).find((f) => {
        const spec = OVERLAY_KV_KEYS[f];
        return spec.doc === id || spec.doc + ":" === id || id.startsWith(spec.doc + ":");
      });
      if (!family) { skipped.push(id); continue; } // an identity family; translated below
      if (id === "pins:") {
        for (const [scope, map] of Object.entries(value || {})) {
          bundle.pins = bundle.pins || {};
          bundle.pins[scope] = map || {};
        }
      } else if (id.startsWith("pt:")) {
        bundle.piti = bundle.piti || { "": {} };
        bundle.piti[""][id.slice("pt:".length)] = value;
      } else {
        bundle[family] = bundle[family] || {};
        bundle[family][""] = value || {};
      }
      written.push(id);
    }

    // The identity families, translated into rows the object can store.
    //
    // ⚠️ THE ROSTER IS TWO LAYERS AND ONLY ONE OF THEM IS IN THIS DOCUMENT. `users:roster`
    // is the invite/remove overlay; the durable record is the instance config, which is why
    // `CONFIG_USERS` goes in beside it — reading the export alone would copy a workspace
    // with none of the people the config names, which on most instances is all of them.
    // `CONFIG_USERS` and not `USERS`, because the overlay is applied inside the translation
    // and applying it twice would resurrect anyone the overlay removed.
    //
    // Hashing happens HERE rather than in the object: `crypto.subtle` is async and the
    // object's write runs inside `transactionSync`, which is not.
    const { identity, skipped: identitySkipped } = await identityFromKv(
      Object.fromEntries(skipped.map((id) => [id, doc.families[id]])),
      {
        configUsers: (tctx && tctx.CONFIG_USERS) || [],
        hashInvite: inviteHash,
      },
    );

    const res = await stub.fetch("https://workspace/state/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        overlay: bundle, identity, prune: !!doc.prune, workspaceId: tctx.tenantId,
      }),
    });
    if (!res.ok) return { ok: false, reason: "workspace-refused", status: res.status };
    const { atomic, refused } = await res.json();
    // ⚠️ THE IDENTITY FAMILIES GO TO BOTH, AND THAT IS THE POINT OF THE SPLIT.
    // The object gets a faithful copy and KV stays exactly what the KV path reads, so a
    // restore cannot take an instance down whichever store is currently answering. With the
    // reads moved (`KV_CUTOVER`), skipping either half would be worse, not better: without
    // the object write a restore lands nothing the cut families read, and without the KV
    // write it lands nothing the REVERT would read.
    const rest = await replayFamilies(store, kv, doc, skipped);
    return {
      ok: true, atomic, ...cleared,
      // Said out loud rather than inferred. A caller copying KV into the object needs to
      // know the object was there to receive it: with no TENANTS binding this whole path is
      // skipped, KV is written exactly as before, and every other field below looks the
      // same — a successful no-op that reads as a successful copy.
      workspaceObject: true,
      written: [...written, ...rest.written],
      skipped: [...rest.skipped, ...identitySkipped.map((s) => s.id)],
      // Named rather than dropped: a copy that quietly omits a family is indistinguishable
      // from a complete one, which is the failure this whole path exists to avoid.
      unmapped: identitySkipped,
      refusedRows: refused || [],
    };
  }

  const out = await replayFamilies(store, kv, doc, Object.keys(doc.families));
  return { ok: true, atomic: false, workspaceObject: false, ...cleared, ...out };
}

/**
 * Family by family, which is what an instance with no workspace object can do — and, on
 * one that has an object, what the families it has no table for yet still need.
 *
 * Overlay families go through the accessor, because it is the thing that knows a family's
 * KV layout: `statuses` is one document holding a map and `c:` is one document per page,
 * and writing either the other way is a workspace that comes back missing everything.
 */
async function replayFamilies(store, kv, doc, ids) {
  const written = [];
  const skipped = [];
  for (const id of ids) {
    const value = doc.families[id];
    const entry = STATE_INVENTORY.find((e) => e.id === id);
    // An id the inventory does not know is not replayed. A restore is the worst possible
    // moment to start trusting a document about where things go.
    if (!entry || entry.to !== "workspace") { skipped.push(id); continue; }
    const family = Object.keys(OVERLAY_KV_KEYS).find((f) => {
      const spec = OVERLAY_KV_KEYS[f];
      return spec.doc === id || spec.doc + ":" === id || id.startsWith(spec.doc + ":");
    });
    if (family && store) {
      if (id === "pins:") {
        for (const [scope, map] of Object.entries(value || {})) await store.replace("pins", scope, map || {});
      } else if (id.startsWith("pt:")) {
        await store.set("piti", "", id.slice("pt:".length), value);
      } else {
        await store.replace(family, "", value || {});
      }
      written.push(id);
      continue;
    }
    if (!kv) { skipped.push(id); continue; }
    if (STATE_KV_PREFIXED.includes(id)) {
      for (const [suffix, v] of Object.entries(value || {})) {
        await kv.put(id + suffix, typeof v === "string" ? v : JSON.stringify(v));
      }
    } else {
      await kv.put(id, typeof value === "string" ? value : JSON.stringify(value));
    }
    written.push(id);
  }
  return { written, skipped };
}

// ---- The migration freeze ---------------------------------------------------
//
// `MIG-cutover-freeze`. Moving a workspace to a new home is export → verify → cut the
// hostname over, and anything written to the OLD instance inside that window is written to
// a copy nobody will ever read again. Not lost noisily — lost the way a comment is lost
// when somebody posts it, sees it appear, and comes back tomorrow to a page that never had
// it.
//
// TWO WAYS TO STOP THAT, AND THIS IS THE SMALLER ONE. Pulling the route or the DNS record
// is simpler and blocks READS too: the site goes dark for however long the copy and the
// verification take, which on a real workspace is minutes and looks like an outage to
// everybody who is not migrating. A worker-side flag refuses only the writes, so the site
// stays up, the reader sees what was there, and the person who tries to change something
// is TOLD rather than quietly ignored.
//
// IT LIVES IN KV RATHER THAN IN CONFIG, because the thing it has to be is FAST TO FLIP. A
// config field means composing and pushing an instance document; this is one key, set and
// cleared through the state routes with a publish token. During a migration KV is the store
// being read from anyway.
//
// Reads are never frozen. Neither is signing in — somebody watching the migration must be
// able to get in and look at what is about to move.
const FREEZE_KEY = "freeze";
const FREEZE_TTL_MS = 10_000;
// tenantId -> { at, doc }
const FREEZE_STATE = tenantCache("freeze", { max: 64 });

/** The freeze record for this workspace, or null. Read only on writes; see the router. */
async function readFreeze(tctx, env) {
  const kv = kvFor(env);
  if (!kv) return null;
  const cur = FREEZE_STATE.entry(tctx.tenantId, () => ({ at: 0, doc: null }));
  if (!cur.at || Date.now() - cur.at >= FREEZE_TTL_MS) {
    try {
      const raw = await kv.get(FREEZE_KEY);
      cur.doc = raw ? JSON.parse(raw) : null;
      cur.at = Date.now();
    } catch (e) { /* keep the last answer; a freeze must not fail open on a blip, and a
                     thaw that takes one tick longer costs nothing */ }
  }
  return cur.doc;
}

/**
 * The write paths a freeze closes. Named as a table rather than checked at each route, so
 * "what does a freeze stop" is answerable by reading one list.
 *
 * `/__auth` is deliberately NOT here: somebody has to be able to sign in and look at what
 * is about to move. Nor is anything that only reads.
 */
const FROZEN_WRITES = Object.freeze([
  "/__publish/",   // commit, rollback, config push — the big one
  "/__review/api", // comments
  "/__board",      // canvas documents
  "/__asset",      // canvas images
  "/__status",
  "/__name",
  "/__pins",
  "/__canvases",
  "/__admin/",     // roster, tokens, icons — a change here during a migration is lost too
  "/__me/",        // display name, profile photo
  "/__delete",
  "/__piti",
]);

/** Whether this request would write. A freeze that also blocked reads is a DNS pull. */
function isFrozenWrite(request, url) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  // The state routes are how a freeze is lifted, so they can never be frozen by one.
  if (url.pathname.startsWith("/__publish/_state/")) return false;
  return FROZEN_WRITES.some((p) => url.pathname === p || url.pathname.startsWith(p));
}

/** The refusal. Visible, and it says who to ask and when to come back. */
function freezeRefusal(doc) {
  return jsonResponse({
    error: "frozen",
    reason: (doc && doc.reason) || "this workspace is being moved",
    since: (doc && doc.at) || null,
    message: "This workspace is read-only while it is being moved. Nothing you send now would arrive. Try again shortly.",
  }, 503, { "Retry-After": "60" });
}

// ---- Suspension: the workspace is paused, and the front door says so ---------
//
// `B-suspend-check-in-resolver`. A suspension is set on the workspace object
// (`B-control-plane-verbs`) and enforced HERE, once, before anything else runs. Until this
// existed the flag was a fact recorded in a database that changed nothing anybody could see.
//
// ── ⚠️ WHAT A SUSPENSION STOPS IS NOT "EVERYTHING", AND THE PLAN ITEM WAS WRONG ─────
//
// The item's VERIFY says "confirm EVERY endpoint (page serving, /__publish/*, /__board,
// /__rt, /__asset) refuses". That is refuted by what this platform PUBLISHES TO CUSTOMERS,
// which is the later and more considered document — the hosted lifecycle page, under
// "What a suspension actually means":
//
//     What stops: the public site stops being served.
//     What keeps working: SIGNING IN — the owner and admins can always sign in.
//                         EXPORTING — a full export runs normally on a suspended workspace.
//                         "If your reason for coming back is to leave, you can."
//
// A suspension that also closed the export would make that sentence false, and it is the
// sentence that makes a suspension a pause rather than a hostage-taking. So the allow list
// below is not a convenience: it is the promise, in code, and the promise is what the two
// have to agree on. If the promise changes, this list changes the same day.
//
// ── ⚠️ IT FAILS CLOSED, WHICH IS THE OPPOSITE OF EVERY OTHER DEGRADATION HERE ───────
//
// A workspace can be suspended because it is serving a phishing page. "The store was
// unreachable for a moment" is not a reason to serve it again, so an isolate that has never
// managed to read the flag refuses rather than serves. What that costs is the case where a
// workspace object is unreachable and the site would otherwise still serve static content —
// and in hosted mode that workspace's comments, boards, roster and sign-in are all in that
// object, so what would be left is a page with nothing working on it.
//
// A STALE ANSWER IS KEPT, exactly like the freeze: a resume that takes one tick longer costs
// nothing, and a suspension that evaporates for a tick is the takedown not happening.
//
// ── AND IT COSTS A SINGLE-WORKSPACE INSTANCE NOTHING AT ALL ─────────────────────────
//
// No `TENANTS` binding — every self-hosted instance, and both live ones — returns before any
// work at all. There is no read, no cache entry and no code path taken.
const SUSPENSION_TTL_MS = 10_000;
// tenantId -> { at, doc } — `doc` null means "not suspended", undefined means "never read"
const SUSPENSION_STATE = tenantCache("suspension", { max: 64 });

/**
 * What a suspended workspace still answers. THE PUBLISHED PROMISE, as a list.
 *
 * Sign-in, because an admin has to be able to get in — and because a dormancy suspension
 * is documented to lift on an admin's first sign-in. Token minting, because the export runs
 * from the CLI on a publish token and an admin who lost theirs would otherwise be locked out
 * of their own data by the pause. The state export and the read side of the bundle store,
 * because that IS the export.
 *
 * ⚠️ NOTHING THAT WRITES IS ON THIS LIST, including `/__publish/<space>/commit`. Taking your
 * work out is not the same act as putting more in, and the second is what the pause is for.
 */
const SUSPENDED_ALLOWED = Object.freeze([
  "/__auth",
  "/__logout",
  "/__publish/_login/token",
  "/__publish/_state/export",
]);

/** The read side of the bundle store — what `augur export` walks. GET only. */
const SUSPENDED_ALLOWED_READS = Object.freeze([
  "manifest", "versions", "version", "blob",
]);

function isAllowedWhileSuspended(request, url) {
  if (SUSPENDED_ALLOWED.some((p) => url.pathname === p)) return true;
  // /__publish/<space>/<verb>[/...] — only the four reads, and only as reads.
  const m = /^\/__publish\/(?!_)[^/]+\/([^/]+)/.exec(url.pathname);
  if (m && (request.method === "GET" || request.method === "HEAD")) {
    return SUSPENDED_ALLOWED_READS.includes(m[1]);
  }
  return false;
}

/**
 * This workspace's account-store bearer, read from its own object — what `/__enter`
 * authenticates the `/__account/handoff` redemption with. `null` covers every reason it
 * is unavailable, and `enterHandoff` treats them identically: no `TENANTS` binding (a
 * self-hosted, single-workspace instance — the whole route this feeds is simply inert),
 * the object has never been provisioned, or the control plane has never delivered a key
 * via the `account-key` control verb (see `accountKey()` in src/tenant-do.js).
 *
 * Deliberately UNCACHED, unlike `readSuspension` just below: this runs once on a rare
 * cold path (a hand-off redemption), never on the hot request path, so there is nothing
 * to protect by caching it — and a stale cached answer here would keep accepting a key
 * the control plane has since rotated away.
 */
async function tenantAccountKey(tenantId, env) {
  const stub = tenantStub(env, tenantId);
  if (!stub) return null; // single-workspace instance: the question does not exist
  try {
    const res = await stub.fetch("https://workspace/account-key");
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.accountKey === "string" && body.accountKey ? body.accountKey : null;
  } catch (e) {
    return null;
  }
}

/**
 * Tell the control plane's account store that a person joined or left THIS workspace's
 * roster, so `/workspaces` (the cross-workspace switcher) lists the right workspaces for
 * them — `B-cross-workspace-signin`, the write half of the same relationship `/__enter`
 * reads. PRESENTATION-ONLY: nothing here is ever consulted for authorization, so a missed
 * or failed notify costs a stale switcher row and nothing else.
 *
 * Two cheap, synchronous checks come first — no `ACCOUNT_ORIGIN` (a self-hosted instance,
 * or a deployment that has not wired central sign-in) and no `ctx` to hand the work to —
 * either one means the call is answered before any I/O is attempted. What is left,
 * INCLUDING the workspace's own accountKey read (itself an async round trip to the
 * workspace object), is wrapped in one promise and handed to `ctx.waitUntil` so NONE of
 * it — not the key read, not the POST — sits on the caller's critical path. A thrown
 * error or a non-200 from the account store is swallowed inside that promise: this must
 * never fail or delay the admin operation that triggered it.
 */
function noteMembershipUpstream(env, ctx, tctx, { email, verb, label } = {}) {
  const origin = tctx && tctx.ACCOUNT_ORIGIN;
  if (!origin) return; // no central account store configured: inert, like /__enter
  if (!ctx || typeof ctx.waitUntil !== "function") return; // nowhere to hand off the work; never block on it here
  const p = (async () => {
    const key = await tenantAccountKey(tctx.tenantId, env);
    if (!key) return; // this workspace has never been delivered an accountKey: nothing to authenticate with
    try {
      await fetch(`${origin}/__account/index`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ verb, email, at: Date.now(), label: label != null ? label : null }),
      });
    } catch (e) { /* best-effort: a failing or unreachable account store must never surface here */ }
  })();
  ctx.waitUntil(p);
}

/**
 * This workspace's suspension, or null. `undefined` means the answer is not known and the
 * caller must refuse — see the fail-closed note above.
 */
async function readSuspension(tenantId, env, now = Date.now()) {
  const stub = tenantStub(env, tenantId);
  if (!stub) return null; // single-workspace instance: not a question that exists
  const cur = SUSPENSION_STATE.entry(tenantId, () => ({ at: 0, doc: undefined }));
  if (!cur.at || now - cur.at >= SUSPENSION_TTL_MS) {
    try {
      const res = await stub.fetch("https://workspace/suspension");
      const body = await res.json();
      // `moved` counts as an answer worth keeping for the same reason `suspended` does: a
      // workspace whose address has been changed away must not be served here, and dropping
      // the doc because it is not *paused* would cache "fine" for an address that is gone.
      // `canonicalHost` is kept too — not a pause, but the same read carries the claimed
      // address the front door redirects the generated one to, so a claimed workspace's
      // redirect costs no read of its own. The suspension gate below keys on `suspended`,
      // never on the doc being present.
      cur.doc = body && (body.suspended || body.moved || body.canonicalHost) ? body : null;
      cur.at = now;
    } catch (e) { /* keep the last answer, whatever it was — including "never read" */ }
  }
  return cur.doc;
}

/**
 * The page a visitor sees. Plain, and it says what it is.
 *
 * ⚠️ NOT A 404, and the lifecycle page promises exactly that: "Visitors to your subdomain
 * see a plain page saying the workspace is paused, not a 404 and not your last published
 * content." A 404 says the address is wrong, which sends the wrong person looking for a
 * typo; the last published content is what a suspension exists to stop serving.
 *
 * 503 with a Retry-After, so a crawler treats it as temporary and does not drop the URLs of
 * a workspace that is coming back. `noindex` because a paused workspace's holding page is
 * not what anybody should find in a search result.
 *
 * ⚠️ IT NAMES NOTHING. Not the workspace, not the reason, not who to write to about the
 * reason. A suspension can be an acceptable-use takedown, and "paused for breaking the
 * rules" on a public page is a punishment nobody decided to hand out; the reason belongs to
 * the people who can act on it, which is what `suspensionPage(paused, true)` is for.
 *
 * ⚠️ AND IT PROMISES NOTHING EITHER. The first version of this page said "an admin can sign
 * in and bring it back", which is true of a dormancy pause and FALSE of an acceptable-use
 * one and of a tombstone — so a stranger was being told a workspace was coming back when
 * nobody had decided that. What a stranger is told is the one thing true in every case:
 * it is paused, and it is not gone.
 */
function suspensionPage(paused = null, forMember = false) {
  const p = paused || {};
  const body = forMember
    ? memberSuspensionBody(p)
    : `<h1>This workspace is paused</h1>`
      + `<p>It is not gone, and nothing has been deleted. If you were expecting to find `
      + `something here, whoever runs this workspace will know why.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex,nofollow">`
    + `<title>Paused</title><style>`
    + `body{margin:0;min-height:100vh;display:grid;place-items:center;`
    + `font:16px/1.6 system-ui,sans-serif;color:#333;background:#faf9f7}`
    + `main{max-width:34rem;padding:2rem;text-align:left}`
    + `h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}`
    + `p{margin:0 0 .75rem;color:#555}`
    + `dl{margin:0 0 1rem;display:grid;grid-template-columns:auto 1fr;gap:.15rem .75rem;color:#555}`
    + `dt{color:#888}dd{margin:0}`
    + `code{background:#f0eee9;padding:.1rem .35rem;border-radius:3px;font-size:.9em}`
    + `</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "Retry-After": "3600", "Cache-Control": "no-store" },
  });
}

/**
 * What a MEMBER of the paused workspace sees instead.
 *
 * `F-suspended-instance-page`. Somebody who can prove they belong here is the person the
 * reason is for, so this page states it — the reason as the operator recorded it, when it
 * started, and for a tombstone the date the data is actually erased.
 *
 * ⚠️ IT TELLS THEM THE ONE THING THAT IS TRUE IN EVERY CASE AND USEFUL IN ALL OF THEM: the
 * export still works. That is not a consolation prize, it is the promise the lifecycle page
 * makes — "if your reason for coming back is to leave, you can" — and this is the only
 * surface where a person finds out how. Nothing else here is generic enough to promise: how
 * a workspace comes back depends on why it went, and only the operator who paused it can
 * say. So the page states the facts and does not invent a procedure.
 *
 * The reason is OPERATOR-WRITTEN TEXT and is escaped. It reaches this page from a control
 * verb, so it is not a stranger's input, but "not a stranger's" is not "safe to interpolate".
 */
function memberSuspensionBody(p) {
  const when = p.at ? String(p.at).slice(0, 10) : null;
  const tombstone = !!p.deleted;
  const rows = [
    when ? `<dt>Since</dt><dd>${escapeHtml(when)}</dd>` : "",
    p.reason ? `<dt>Reason</dt><dd>${escapeHtml(String(p.reason))}</dd>` : "",
    tombstone && p.purgeAfter
      ? `<dt>Erased on</dt><dd>${escapeHtml(String(p.purgeAfter).slice(0, 10))}</dd>` : "",
  ].filter(Boolean).join("");
  return `<h1>${tombstone ? "This workspace is deleted" : "This workspace is paused"}</h1>`
    + `<p>${tombstone
      ? "Everything is still here until the date below. After that it is erased."
      : "Nothing has been erased. Your content, comments, boards and roster are exactly as they were."}</p>`
    + (rows ? `<dl>${rows}</dl>` : "")
    + `<p>You can still take everything with you: <code>augur export --full</code> runs `
    + `normally on a paused workspace.</p>`
    + `<p>Whoever paused this workspace is the only one who can lift it, and the reason `
    + `above is what they recorded.</p>`;
}

/**
 * Would an HTML page be the wrong answer here?
 *
 * Two signals, and the path is the one that matters: every `/__…` route is machinery, and
 * `augur publish` reading a holding page as its manifest is a worse failure than a person
 * seeing JSON. `Accept` is the second because a browser sends `text/html` and a CLI does not.
 */
function wantsJson(request, url) {
  if (url.pathname.startsWith("/__")) return true;
  const accept = request.headers.get("Accept") || "";
  return !accept.includes("text/html");
}

/**
 * Is there a session cookie at all? Not "is it valid" — this is the cheap gate in front of
 * the expensive question, so a stranger with no cookie never causes a paused workspace to
 * read its own config.
 */
function hasSessionCookie(request) {
  const cookies = request.headers.get("Cookie") || "";
  return [USER_COOKIE, ...LEGACY_USER_COOKIES].some((n) => cookies.includes(n + "="));
}

/**
 * Does this cookie name somebody who belongs to the paused workspace?
 *
 * ⚠️ THIS IS NOT AN AUTHORIZATION DECISION and must never become one. Nothing is unlocked by
 * answering yes — the only difference it makes is whether a 503 page states the reason for
 * the pause. So it FAILS TO "NO" on anything at all: no config, no roster, an unreadable
 * store, a cookie that resolves to nobody. The wrong answer here costs a member a sentence.
 */
async function isPausedWorkspaceMember(request, env, tenantId) {
  try {
    const tctx = await loadConfig(tenantId, env);
    if (!tctx || !tctx.USERS.length) return false;
    return !!(await identify(request, env, tctx.USERS, { sessionKeys: tctx.SESSION_KEYS, tctx }));
  } catch (e) {
    return false;
  }
}

/** The API-shaped refusal, for a caller that is plainly not a browser. */
function suspensionRefusal() {
  return jsonResponse({
    error: "suspended",
    message: "This workspace is paused. Signing in and running a full export still work; nothing else does.",
  }, 503, { "Retry-After": "3600" });
}

/** Freeze or thaw, and report how long a freeze lasted — the number a migration publishes. */
async function setFreeze(tctx, env, { on, reason, by }) {
  const kv = kvFor(env);
  if (!kv) return { ok: false, reason: "no-store" };
  const prevRaw = await kv.get(FREEZE_KEY);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  FREEZE_STATE.bust(tctx.tenantId);
  if (!on) {
    await kv.delete(FREEZE_KEY);
    const ms = prev && prev.at ? Date.now() - Date.parse(prev.at) : null;
    return { ok: true, frozen: false, was: prev, durationMs: ms };
  }
  const doc = prev || { at: new Date().toISOString(), reason: reason || "migration", by: by || "" };
  await kv.put(FREEZE_KEY, JSON.stringify(doc));
  return { ok: true, frozen: true, since: doc.at, reason: doc.reason };
}

// ---- Deleting a workspace, and reclaiming what nothing references -----------
//
// `E-gdpr-delete-tenant`. Two operations, deliberately separate, and the separation is the
// safety property rather than a scheduling convenience.
//
// DELETING A WORKSPACE removes its published content and destroys its Durable Object
// storage. The object half is bounded to that workspace by the platform and cannot reach a
// neighbour. THE CONTENT HALF IS NOT BOUNDED BY ANYTHING IN THE KEY — `spaces/<spaceId>/…`
// names a space, and there is no workspace prefix in that bucket at all — so which spaces
// an erasure may touch is asked of the workspace itself. See `workspaceSpaces`.
//
// RECLAIMING BYTES IS A DIFFERENT JOB, because blobs are content-addressed and GLOBALLY
// deduped: `blobs/<sha256>` is one object however many workspaces publish the same file.
// So "delete the blobs this workspace referenced" is wrong in the one direction that
// matters — it takes bytes another workspace is serving. Knowing a blob is orphaned means
// reading every REMAINING manifest and every retained version of every workspace, which is
// a full-bucket walk. Doing that inside a delete request would mean either a slow delete or
// a partial scan, and a partial scan concludes that a blob nothing-it-managed-to-read
// references is unreferenced. So the delete records what it MIGHT have orphaned and the
// sweep decides, later, with the whole picture.
//
// THE SWEEP REFUSES TO CONCLUDE FROM A PARTIAL READ. If it read no manifest at all, or a
// listing was truncated and not walked to the end, it reports and deletes nothing — a
// sweep that found "everything is orphaned" because it could not look is the single worst
// outcome available here.

/** Every blob hash a manifest document references. */
const hashesIn = (m) => Object.values((m && m.files) || {}).map((f) => f && f.h).filter(Boolean);

/**
 * Walk one space's live manifest and every retained version.
 *
 * `workspace` names whose copy of that space to walk — empty for the unprefixed keys, which
 * on a single-workspace deployment is all of them and on a shared one is the legacy set
 * plus `_engine`. `blobGc` walks every workspace's, because the blob namespace is shared
 * and an orphan is only an orphan when NOBODY references it.
 */
async function spaceHashes(env, id, workspace = "") {
  const store = bundleStore(env, workspace);
  const out = new Set();
  let read = 0;
  const live = await store.get(`spaces/${id}/manifest.json`);
  if (live) { read++; for (const h of hashesIn(JSON.parse(await live.text()))) out.add(h); }
  let cursor, truncated = false;
  do {
    const page = await store.list({ prefix: `spaces/${id}/versions/`, cursor });
    for (const o of page.objects || []) {
      const v = await store.get(o.key);
      if (!v) continue;
      read++;
      try { for (const h of hashesIn(JSON.parse(await v.text()))) out.add(h); }
      catch (e) { truncated = true; } // an unreadable version is a hole in the picture
    }
    cursor = page.truncated ? page.cursor : null;
    if (page.truncated && !page.cursor) { truncated = true; break; }
  } while (cursor);
  return { hashes: out, read, truncated };
}

/**
 * Every space id the store holds, and whether that list is COMPLETE.
 *
 * The completeness matters more than the list: a sweep that saw half the spaces would
 * conclude that the other half's blobs are orphaned, and a sweep that saw none would
 * conclude that all of them are. Both are the same mistake at different scales, and both
 * are silent.
 */
async function storeSpaceIds(env, workspace = "") {
  const store = bundleStore(env, workspace);
  const ids = [];
  let cursor, complete = true;
  do {
    const page = await store.list({ prefix: "spaces/", delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes || []) ids.push(p.slice("spaces/".length, -1));
    cursor = page.truncated ? page.cursor : null;
    if (page.truncated && !page.cursor) { complete = false; break; }
  } while (cursor);
  return { ids, complete };
}

/**
 * Every workspace that holds a prefix in this bucket, and whether that list is COMPLETE.
 *
 * The DEPLOYMENT-wide question, and the only place the worker asks one. It exists for
 * `blobGc` and for nothing else: the blob namespace is shared on purpose, so a hash is an
 * orphan only when NO workspace references it, and a sweep that could not see every
 * workspace's manifests would conclude that the ones it missed are orphaned. On a
 * deployment with no segment there are no prefixes and this answers with nothing, which is
 * correct — the unprefixed listing is already the whole bucket.
 */
async function storeWorkspaceIds(env) {
  const ids = [];
  let cursor, complete = true;
  do {
    const page = await env.BUNDLES.list({ prefix: BUNDLE_TENANT_PREFIX, delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes || []) ids.push(p.slice(BUNDLE_TENANT_PREFIX.length, -1));
    cursor = page.truncated ? page.cursor : null;
    if (page.truncated && !page.cursor) { complete = false; break; }
  } while (cursor);
  return { ids, complete };
}

/**
 * Delete one workspace: the spaces it owns, and its own object's storage.
 *
 * `confirm` must be the workspace's own id. Not ceremony — a star-scope token can already
 * overwrite everything a workspace has published, and rollback undoes that; this is the one
 * verb whose result no rollback reaches, so the caller says which workspace out loud.
 */
/**
 * THE SECOND KEY on an erasure, and the reason it exists.
 *
 * `confirm === tenantId` is a fat-finger guard, not an authorisation: whoever calls this
 * already knows the workspace id, because they had to address the request to it. On a
 * hosted deployment the caller is a scheduled job in the control plane holding a bearer,
 * and a bearer can be stolen. So the workspace object is asked whether IT agrees it is
 * due, and it wrote that date itself at delete time — the caller cannot forge it, because
 * the date is not the caller's to write. Neither side can erase a workspace alone.
 *
 * ⚠️ NO BINDING AT ALL IS NOT A REFUSAL, and that asymmetry is the same one `effectiveSecret`
 * makes for the same reason. A self-hosted instance has no workspace object and never will;
 * there, `_state/delete` is an admin deleting their own content with a star-scope token,
 * which is legitimate and has no tombstone to check. But a deployment that HAS the binding
 * and cannot get a clear "yes, it is due" out of it FAILS CLOSED — a transient error must
 * not read as permission. The dangerous direction is the one that erases.
 */
async function purgeDue(env, id) {
  const stub = tenantStub(env, id);
  if (!stub) return { due: true, checked: false }; // no object model here — see the header
  let s;
  try {
    const res = await stub.fetch("https://workspace/__control/status");
    if (!res.ok) return { due: false, checked: true, reason: "workspace-status-unreadable" };
    s = await res.json();
  } catch (e) {
    return { due: false, checked: true, reason: "workspace-status-unreadable" };
  }
  if (!s || !s.deleted) return { due: false, checked: true, reason: "not-tombstoned" };
  const at = Date.parse(s.purgeAfter || "");
  if (!Number.isFinite(at)) return { due: false, checked: true, reason: "no-purge-date" };
  if (at > Date.now()) {
    return { due: false, checked: true, reason: "grace-window", purgeAfter: s.purgeAfter };
  }
  return { due: true, checked: true, purgeAfter: s.purgeAfter };
}

/**
 * WHICH SPACES AN ERASURE MAY TOUCH — asked of something that knows, never inferred.
 *
 * ⚠️ THE STORE CANNOT ANSWER THIS AND NEVER COULD. `spaces/<spaceId>/…` names a SPACE;
 * there is no workspace segment anywhere in that bucket. This used to select with
 * `ids.filter((s) => s === id || s.startsWith(id + "/"))` against the WORKSPACE id, which
 * matches only where a workspace happens to share a string with its own space — so on
 * every real deployment it selected nothing, deleted nothing, destroyed the workspace
 * object anyway and answered `ok`. The control plane erases its own record on that `ok`,
 * so a right-to-erasure request completed with the record gone and the content still
 * served. The covering test was green because its fixture was the one arrangement where
 * the two ids are the same string.
 *
 * There are two deployment shapes and they have different answers:
 *
 *   NO WORKSPACE OBJECTS BOUND — the deployment resolves exactly one workspace, the id its
 *   own build stamped into `instance.json`. An unprefixed key therefore belongs to it by
 *   construction: there is no neighbour for the selection to reach. This is the same
 *   reading `kvWorkspaceSegment`'s `legacyIsOurs` makes of an unprefixed KV key, and it is
 *   sound for exactly the reason that one is — the question "whose is this" has an answer
 *   only where a deployment serves ONE.
 *
 *   WORKSPACE OBJECTS BOUND — several workspaces may share the bucket, so the answer comes
 *   from the workspace's own object: `publish_versions`, the counter every commit,
 *   rollback and prefix-removal goes through. A row lands there only via a publish
 *   addressed to that object, and an object's storage belongs to its id, so it cannot name
 *   a neighbour's space. It is authoritative for what it holds.
 *
 * ⚠️ IT IS NOT PROVABLY COMPLETE, and the caller must not treat it as if it were. A
 * publish made before this deployment bound the objects left no row. So a workspace that
 * claims NOTHING while the store holds authored spaces is indistinguishable from one whose
 * record predates the counter — the two need opposite answers, and the erasing one is the
 * one that cannot be taken back. `deleteWorkspace` refuses there rather than guessing.
 *
 * `_engine` is declined under both shapes and on purpose rather than by accident: one
 * worker build's chrome serves every workspace on the deployment, CI pushes it through the
 * same commit path so a workspace's own counter really does claim it, and erasing it would
 * blank the deployment. It survived the broken filter by coincidence, which is not a
 * property anything was keeping.
 *
 * ⛔ ONE CASE THIS CANNOT REACH, AND IT IS NOT AN OVERSIGHT. Two workspaces that each
 * publish a space under the SAME id write the same key — one manifest, one version
 * history, one object — so erasing either takes the other's content, and no ownership
 * record can prevent it because both records are correct. This cannot even be DETECTED
 * from here: an object holds its own claims and there is no list of workspaces in the
 * engine to compare them against. A gate cannot un-collide a key; only a workspace segment
 * in the key can. `test/delete-workspace.test.mjs` pins the collision so the day the key
 * shape lands, a failing test says so.
 *
 * ⏳ RETIRE THIS WITH THE KEY SHAPE. When the store carries a workspace segment, "which
 * spaces are mine" is answered by the prefix, the unattributable case cannot arise, the
 * collision above cannot arise, and this reduces to a listing again.
 */
async function workspaceSpaces(tctx, env, listed) {
  const id = tctx && tctx.tenantId;
  // `_engine` is never anybody's to erase — see the header.
  const authored = listed.ids.filter((s) => s !== "_engine");
  const stub = tenantStub(env, id);
  if (!stub) return { ok: true, ids: authored, unattributed: 0, source: "single-workspace-deployment" };

  let claimed;
  try {
    const res = await stub.fetch("https://workspace/publish-spaces");
    const body = res.ok ? await res.json() : null;
    if (!body || !Array.isArray(body.spaces)) throw new Error(`workspace answered ${res.status}`);
    claimed = new Set(body.spaces.map(String));
  } catch (e) {
    // A transient error must not read as "this workspace owns nothing": that answer erases
    // nothing and reports success, which is the failure this whole function exists to end.
    return { ok: false, reason: "ownership-unreadable" };
  }

  const ids = authored.filter((s) => claimed.has(s));
  return {
    ok: true, ids, source: "workspace-publish-record",
    // What is in the store that this workspace does not account for. On a deployment
    // serving several workspaces this is normally the neighbours' and means nothing; it is
    // reported so a caller can never mistake "erased nothing because it owns nothing" for
    // "erased nothing because it could not tell".
    unattributed: authored.length - ids.length,
  };
}

async function deleteWorkspace(tctx, env, { confirm, dryRun = true } = {}) {
  const id = tctx && tctx.tenantId;
  if (!id) return { ok: false, reason: "no-workspace" };
  if (!dryRun && confirm !== id) return { ok: false, reason: "confirm-mismatch", expected: id };
  if (!env.BUNDLES) return { ok: false, reason: "no-store" };
  // Only on the path that actually deletes. A dry run removes nothing, and refusing it
  // would take away the one way to ask "what would this erase" before the date arrives.
  if (!dryRun) {
    const due = await purgeDue(env, id);
    if (!due.due) return { ok: false, reason: due.reason, ...(due.purgeAfter ? { purgeAfter: due.purgeAfter } : {}) };
  }

  // What this workspace referenced — recorded so the sweep has a starting point, and so a
  // dry run can say what it would eventually reclaim.
  // Scoped to this workspace's own prefix where there is one — so the listing can no longer
  // return a neighbour's space at all, and the delete below cannot name one.
  const ws = bundleWorkspaceSegment(env, id).workspace;
  const bundles = bundleStore(env, ws);
  const listed = await storeSpaceIds(env, ws);
  if (!listed.complete) return { ok: false, reason: "incomplete-listing" };
  const owned = await workspaceSpaces(tctx, env, listed);
  if (!owned.ok) return { ok: false, reason: owned.reason };
  const mine = owned.ids;
  // NOTHING ATTRIBUTABLE, AND SOMETHING THERE. This is the exact shape the bug wore — a
  // store holding authored content and a selection that comes back empty — and it cannot
  // be told apart from a workspace that genuinely published nothing while the keys carry
  // no workspace segment. So it refuses, and the caller's erasure stalls loudly rather
  // than completing on a fiction. A workspace with nothing to erase and a store with
  // nothing unaccounted for is a clean zero and passes straight through.
  if (!mine.length && owned.unattributed) {
    return { ok: false, reason: "nothing-attributable", unattributed: owned.unattributed };
  }
  const maybeOrphaned = new Set();
  const keys = [];
  for (const s of mine) {
    const { hashes } = await spaceHashes(env, s, ws);
    for (const h of hashes) maybeOrphaned.add(h);
    keys.push(`spaces/${s}/manifest.json`);
    let cursor;
    do {
      const page = await bundles.list({ prefix: `spaces/${s}/versions/`, cursor });
      for (const o of page.objects || []) keys.push(o.key);
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
  }

  if (dryRun) {
    // The spaces by name, not only the count: an operator checking the blast radius of an
    // erasure they are considering needs to recognise what is about to go.
    return {
      ok: true, dryRun: true, workspace: id, objects: keys.length,
      maybeOrphaned: maybeOrphaned.size,
      spaces: mine, ownership: owned.source, unattributed: owned.unattributed,
    };
  }

  // ⚠️ THROUGH THIS WORKSPACE'S VIEW, so a key collected above is deleted under the same
  // segment it was listed under. A delete straight at the binding would take the
  // UNPREFIXED key of the same name — which on a shared bucket is the legacy object nobody
  // can attribute, and possibly another workspace's.
  for (const k of keys) await bundles.delete(k);

  // The object last: while its storage exists the workspace can still say what it was, and
  // a delete that died between the two halves is better left with the record than with the
  // content.
  let store = { skipped: "no-object" };
  const stub = tenantStub(env, id);
  if (stub) {
    try {
      const res = await stub.fetch("https://workspace/destroy", { method: "POST" });
      store = res.ok ? await res.json() : { error: res.status };
    } catch (e) { store = { error: String((e && e.message) || e).slice(0, 200) }; }
  }
  return {
    ok: true, workspace: id, objects: keys.length, store,
    // WHAT WAS ERASED AND ON WHOSE WORD. An erasure that removed nothing is a real answer
    // and a wrong one wearing the same shape, so the result says which spaces went and
    // where the ownership came from rather than leaving a count to be read as either.
    spaces: mine, ownership: owned.source, unattributed: owned.unattributed,
    // Handed back rather than acted on: only the sweep can tell an orphan from a blob
    // another workspace is serving.
    maybeOrphaned: [...maybeOrphaned],
  };
}

/**
 * Delete the blobs no remaining workspace references, live or in any retained version.
 *
 * Deferred and batched on purpose — see the header. It reads EVERY space's manifests before
 * it deletes anything, and refuses outright if that picture is incomplete.
 */
async function blobGc(env, { dryRun = true } = {}) {
  if (!env.BUNDLES) return { ok: false, reason: "no-store" };
  // ⚠️ EVERY WORKSPACE, DELIBERATELY, AND THIS IS THE ONE SWEEP THAT CROSSES THE SEGMENT.
  // `blobs/` is shared by decision, so a hash is an orphan only when no workspace anywhere
  // on this deployment references it — a per-workspace sweep would delete the bytes its
  // neighbour is serving, which is exactly the failure `assetGc` had. The workspace listing
  // is therefore held to the same completeness rule as the space listing below: an
  // unfinished list of workspaces means their blobs read as orphaned.
  const workspaces = await storeWorkspaceIds(env);
  if (!workspaces.complete) return { ok: false, reason: "incomplete-listing" };
  // "" first: the unprefixed keys, which on a single-workspace deployment are the whole
  // bucket, and on a shared one are the legacy set plus `spaces/_engine/` — the chrome
  // every workspace serves, and whose blobs a sweep that skipped it would collect.
  const scopes = ["", ...workspaces.ids];
  const spaces = [];
  const referenced = new Set();
  let manifestsRead = 0, incomplete = false;
  for (const ws of scopes) {
    const listed = await storeSpaceIds(env, ws);
    // The space listing FIRST, and its completeness before anything else: half a list means
    // the other half's blobs read as orphaned, and no list at all means all of them do.
    if (!listed.complete) return { ok: false, reason: "incomplete-listing" };
    for (const s of listed.ids) {
      spaces.push(ws ? `${ws}/${s}` : s);
      const r = await spaceHashes(env, s, ws);
      for (const h of r.hashes) referenced.add(h);
      manifestsRead += r.read;
      if (r.truncated) incomplete = true;
    }
  }
  // A sweep that found "everything is orphaned" because it could not look is the single
  // worst outcome available here, so it is the one this refuses to reach.
  if (incomplete) return { ok: false, reason: "incomplete-scan" };
  if (spaces.length && !manifestsRead) return { ok: false, reason: "no-manifests-read" };

  const orphans = [];
  let cursor, blobsSeen = 0;
  do {
    const page = await env.BUNDLES.list({ prefix: "blobs/", cursor });
    for (const o of page.objects || []) {
      blobsSeen++;
      const hash = o.key.slice("blobs/".length);
      if (!referenced.has(hash)) orphans.push(o.key);
    }
    cursor = page.truncated ? page.cursor : null;
    if (page.truncated && !page.cursor) return { ok: false, reason: "incomplete-listing" };
  } while (cursor);

  if (!dryRun) for (const k of orphans) await env.BUNDLES.delete(k);
  return {
    ok: true, dryRun, spaces: spaces.length, manifestsRead,
    blobs: blobsSeen, referenced: referenced.size,
    reclaimed: orphans.length, keys: orphans.slice(0, 20),
  };
}

// ---- The move onto the segment ----------------------------------------------
//
// `B-bundle-store-tenancy`. A deployment that starts writing `t/<workspace>/…` does not
// thereby start reading what it wrote yesterday: the unprefixed keys stay exactly where
// they are, and on a Host-resolved deployment there is no read-through fallback to them,
// deliberately, because an unprefixed key is unattributable there. So a live workspace has
// to be MOVED onto the segment, and this is the move.
//
// ⚠️ IT IS A COPY AND NEVER A CUT. Nothing here deletes the source. Three reasons, and each
// alone would be enough: it makes the run RE-RUNNABLE after any failure at any point, it
// makes the per-family flag a real revert (flip the word back and the unprefixed answer is
// still there), and it means a half-finished run leaves a workspace serving its old keys
// rather than serving nothing. Reclaiming the originals is a separate act, taken once
// somebody has looked.
//
// ⚠️ AND IT IS CORRECT FOR EXACTLY ONE WORKSPACE PER DEPLOYMENT. An unprefixed key belongs
// to whichever workspace this deployment served before the segment existed — a question
// with an answer only where a deployment served ONE. Running this as a SECOND workspace
// would hand it the FIRST one's content, which is the disclosure the segment exists to
// close, performed on purpose. `confirm` is the workspace saying its own name out loud, and
// `guard` below refuses when the deployment already holds more than one prefix.
//
// WHAT MOVES, by family. `spaces` is the manifests and the never-pruned version history —
// the expensive half, and the half that carries the collision. `config` is the one instance
// document. `assets` is the canvas image bytes, opt-in because `assets/<hash>` is
// content-addressed and two workspaces pasting one picture wrote one key, so "whose is it"
// is a question the key genuinely cannot answer.
//
// ⛔ `blobs/` AND `spaces/_engine/` DO NOT MOVE, AND MUST NOT. Both are shared by decision
// (see `bundleKey`), both are already at the key every workspace reads them at, and copying
// either would be inventing a private copy of something that is deliberately one copy.
// `bundleKey` maps them to themselves, so `dest === src` for every one of their keys and
// the loop below skips them by the same test it uses for "already there".
const REKEY_FAMILIES = Object.freeze(["spaces", "config", "assets"]);
const REKEY_DEFAULT_FAMILIES = Object.freeze(["spaces", "config"]);
// One page of copies per call. A re-key is a `get` plus a `put` per object and a workspace's
// history runs to hundreds; the caller loops until `done`, which is also what makes an
// interrupted run cost one page rather than the whole move.
const REKEY_LIMIT = 200;

async function rekeyToSegment(tctx, env, { confirm, families, limit, dryRun = true } = {}) {
  const id = tctx && tctx.tenantId;
  if (!id) return { ok: false, reason: "no-workspace" };
  if (!env.BUNDLES) return { ok: false, reason: "no-store" };
  const seg = bundleWorkspaceSegment(env, id).workspace;
  // Nothing to do, and saying so is the honest answer rather than an error: a deployment
  // that serves one workspace writes no segment, so its keys are already where it reads.
  if (!seg) return { ok: true, done: true, reason: "no-segment", workspace: id };
  if (!dryRun && confirm !== id) return { ok: false, reason: "confirm-mismatch", expected: id };

  const want = Array.isArray(families) && families.length ? families : REKEY_DEFAULT_FAMILIES;
  const unknown = want.filter((f) => !REKEY_FAMILIES.includes(f));
  if (unknown.length) return { ok: false, reason: "unknown-family", unknown };

  // The guard on "exactly one workspace". A second prefix in the bucket means somebody else
  // is already here, and then no unprefixed key can be said to be this workspace's.
  const held = await storeWorkspaceIds(env);
  if (!held.complete) return { ok: false, reason: "incomplete-listing" };
  const others = held.ids.filter((w) => w !== seg);
  if (others.length) return { ok: false, reason: "not-the-only-workspace", others };

  // Every unprefixed key this run would move, in the order the families were asked for.
  const src = [];
  const listAll = async (prefix, onKey) => {
    let cursor;
    do {
      const page = await env.BUNDLES.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects || []) onKey(o.key);
      cursor = page.truncated ? page.cursor : null;
      if (page.truncated && !page.cursor) throw new Error("incomplete-listing");
    } while (cursor);
  };
  try {
    if (want.includes("config")) await listAll("config/", (k) => src.push(k));
    if (want.includes("spaces")) await listAll("spaces/", (k) => src.push(k));
    if (want.includes("assets")) await listAll(ASSET_R2_PREFIX, (k) => src.push(k));
  } catch (e) { return { ok: false, reason: "incomplete-listing" }; }

  const cap = Number(limit) > 0 ? Math.min(Number(limit), REKEY_LIMIT) : REKEY_LIMIT;
  const copied = [];
  let skipped = 0, shared = 0, bytes = 0, pending = 0;
  for (const key of src) {
    const dest = bundleKey(key, seg);
    // `spaces/_engine/…` and anything else the scheme leaves global. Counted rather than
    // ignored, so a run says out loud how much it deliberately did not move.
    if (dest === key) { shared++; continue; }
    // Already there. This is what makes the run idempotent: a second run over a finished
    // move copies nothing and answers `done`.
    const there = env.BUNDLES.head ? await env.BUNDLES.head(dest) : await env.BUNDLES.get(dest);
    if (there) { skipped++; continue; }
    if (copied.length >= cap) { pending++; continue; }
    if (dryRun) { copied.push(key); continue; }
    const obj = await env.BUNDLES.get(key);
    if (!obj) { skipped++; continue; } // vanished between the listing and now
    const buf = await obj.arrayBuffer();
    // The httpMetadata rides along or an image would come back as a download. The bytes are
    // copied verbatim; nothing here parses or rewrites a manifest, which is why this is
    // safe to re-run and why it cannot corrupt a document it does not understand.
    await env.BUNDLES.put(dest, buf, obj.httpMetadata ? { httpMetadata: obj.httpMetadata } : undefined);
    bytes += buf.byteLength;
    copied.push(key);
  }
  // The isolate that ran this is serving from the old view until it re-reads.
  if (!dryRun && copied.length) { bustManifests(id); cfgAt = 0; }
  return {
    ok: true, dryRun: !!dryRun, workspace: id, segment: BUNDLE_TENANT_PREFIX + seg + "/",
    families: [...want], considered: src.length,
    copied: copied.length, skipped, shared, bytes, pending,
    // `done` is the caller's loop condition and it means what it says: nothing is left to
    // move for the families asked for.
    done: pending === 0,
    keys: copied.slice(0, 20),
  };
}

// ---- The same move, for the identity documents ------------------------------
//
// `B-identity-kv-write-segmentation`. The bundle-store move above has an exact twin here
// and it exists for the same reason: `identityWorkspaceSegment` has NO read-through where
// the workspace comes from the Host, because an unsegmented `users:roster` belongs to
// whichever workspace this deployment served before the segment existed and nothing in the
// key says which. So a workspace already living on such a deployment has to be MOVED, and
// the move is a prerequisite for turning the flags on rather than an optimisation.
//
// ⚠️ IT IS A COPY AND NEVER A CUT, and here that matters more than it does for content. The
// source documents are what a per-family revert reads: flip one word in `IDENTITY_TENANCY`
// back and the unsegmented roster has to still be there, or the revert is a rollback to the
// day of the cut and everybody minted since is gone.
//
// ⚠️ AND IT IS CORRECT FOR EXACTLY ONE WORKSPACE PER DEPLOYMENT, guarded by the same
// question the content move asks — `storeWorkspaceIds`, which is the deployment's own
// account of which workspaces hold a prefix. Running it as a SECOND workspace would hand
// that workspace the FIRST one's roster and publish tokens, which is the disclosure the
// segment exists to close, performed on purpose.
//
// ⛔ `users:secrets` IS NOT COPIED, because it is not segmented: a credential is
// account-level. `IDENTITY_KV_FAMILIES` is the whole list and this walks it, so a family
// added there is moved here without anybody remembering to.
const IDENTITY_REKEY_LIMIT = 500;

async function rekeyIdentityToSegment(tctx, env, { confirm, families, limit, dryRun = true } = {}) {
  const id = tctx && tctx.tenantId;
  if (!id) return { ok: false, reason: "no-workspace" };
  const kv = kvForRaw(env);
  if (!kv) return { ok: false, reason: "no-store" };
  const seg = identityWorkspaceSegment(env, id).workspace;
  // A deployment that serves one workspace writes no segment, so its documents are already
  // where it reads them. Saying so is the honest answer rather than an error.
  if (!seg) return { ok: true, done: true, reason: "no-segment", workspace: id };
  if (!dryRun && confirm !== id) return { ok: false, reason: "confirm-mismatch", expected: id };

  const all = Object.keys(IDENTITY_KV_FAMILIES).filter((f) => IDENTITY_TENANCY[f]);
  const want = Array.isArray(families) && families.length ? families : all;
  const unknown = want.filter((f) => !all.includes(f));
  if (unknown.length) return { ok: false, reason: "unknown-family", unknown };

  const held = await storeWorkspaceIds(env);
  if (!held.complete) return { ok: false, reason: "incomplete-listing" };
  const others = held.ids.filter((w) => w !== seg);
  if (others.length) return { ok: false, reason: "not-the-only-workspace", others };

  // Every unsegmented key this run would move. A family's document is either one key or a
  // prefix; a prefix is LISTED, and the listing is on the raw namespace because the point
  // is to find what is NOT under the segment.
  const src = [];
  try {
    for (const family of want) {
      for (const doc of IDENTITY_KV_FAMILIES[family]) {
        if (!doc.endsWith(":")) { src.push(doc); continue; }
        let cursor;
        do {
          const page = await kv.list({ prefix: doc, cursor, limit: 1000 });
          for (const k of page.keys || []) {
            // A key already under a segment is somebody's move, not a source for this one.
            if (!k.name.startsWith(IDENTITY_TENANT_PREFIX)) src.push(k.name);
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
      }
    }
  } catch (e) { return { ok: false, reason: "incomplete-listing" }; }

  const cap = Number(limit) > 0 ? Math.min(Number(limit), IDENTITY_REKEY_LIMIT) : IDENTITY_REKEY_LIMIT;
  const copied = [];
  let skipped = 0, absent = 0, bytes = 0, pending = 0;
  for (const key of src) {
    const dest = identityKey(key, seg);
    if (dest === key) { skipped++; continue; }
    // Already there. This is what makes the run idempotent, and it is also why a re-run
    // after a live write does not undo that write.
    const there = await kv.get(dest);
    if (there !== null && there !== undefined) { skipped++; continue; }
    if (copied.length >= cap) { pending++; continue; }
    if (dryRun) { copied.push(key); continue; }
    const raw = await kv.get(key);
    if (raw === null || raw === undefined) { absent++; continue; }
    await kv.put(dest, raw);
    bytes += raw.length;
    copied.push(key);
  }
  return {
    ok: true, dryRun: !!dryRun, workspace: id, segment: IDENTITY_TENANT_PREFIX + seg + "/",
    families: [...want], considered: src.length,
    copied: copied.length, skipped, absent, bytes, pending,
    done: pending === 0,
    keys: copied.slice(0, 20),
  };
}

// ---- What a workspace volunteers about itself -------------------------------
//
// `B-tenant-status-payload`. The shape is FORCED rather than chosen: the control plane is
// bound to nothing but its signup store, and its own test fails the build if that changes.
// So it cannot list a bucket or scan a namespace to compute any of this. The workspace
// computes its own facts and hands them over.
//
// COUNTS AND SCALARS ONLY. This is read by an operator-facing isolate, and a comment body
// has no business being anywhere near one — so no customer content crosses, not even the
// address a publish token is labelled with, which is mapped to a display name exactly the
// way the public build stamp maps it.
//
// The three expensive numbers are all precomputed elsewhere: `bytesReferenced` is written
// into the manifest header at publish (see the commit handler), the counts are
// `SELECT COUNT(*)` in the workspace's own object, and `lastActivityAt` is one column
// bumped at the two places that mean somebody used this workspace.
async function workspaceStatus(tctx, env) {
  const stub = tenantStub(env, tctx && tctx.tenantId);
  let store = { provisioned: false, hasStoredData: false, unavailable: !stub };
  if (stub) {
    try {
      const res = await stub.fetch("https://workspace/status");
      if (res.ok) store = await res.json();
    } catch (e) { store = { provisioned: false, hasStoredData: false, unavailable: true }; }
  }

  // The published side. Read from the manifest HEADER — nothing here parses a file list.
  const spaces = {};
  let bytesReferenced = 0;
  let prototypes = 0;
  let versions = 0;
  let lastPublish = null;
  try {
    const manifests = await loadManifests(tctx.tenantId, env);
    for (const [id, m] of Object.entries(manifests || {})) {
      if (id === "_engine") continue;
      const units = (m.routing && m.routing.unitSources) || {};
      const dirtyUnits = Object.values(units).filter((u) => u && u.dirty).length;
      bytesReferenced += Number(m.bytesReferenced) || 0;
      prototypes += Object.keys(units).length;
      versions += Number(m.version) || 0;
      spaces[id] = {
        version: Number(m.version) || 0,
        prototypes: Object.keys(units).length,
        // The only unreproducible state the system has: a prototype published from a tree
        // that was never committed exists in no repository at all.
        prototypesFromDirtyTree: dirtyUnits,
        bytesReferenced: Number(m.bytesReferenced) || 0,
        publishedAt: m.publishedAt || null,
      };
      if (!lastPublish || (m.publishedAt || "") > (lastPublish.at || "")) {
        lastPublish = {
          space: id,
          version: Number(m.version) || 0,
          at: m.publishedAt || null,
          // Never the raw address a token is labelled with — the same mapping the public
          // build stamp uses, for the same reason.
          by: publisherDisplayName(tctx, m.publishedBy),
          sha: (m.source && m.source.sha) || null,
          dirty: !!(m.source && m.source.dirty),
        };
      }
    }
  } catch (e) { /* a store that cannot be read reports zeros, not a 500 */ }

  return {
    workspace: (tctx && tctx.tenantId) || null,
    ...store,
    prototypes, versions, bytesReferenced, spaces, lastPublish,
    at: new Date().toISOString(),
  };
}

/**
 * Note that somebody used this workspace. Fire-and-forget: a status column is not worth
 * failing a sign-in or a publish over, and the object throttles the write itself.
 */
function touchWorkspaceActivity(env, tctx, ctx) {
  const stub = tenantStub(env, tctx && tctx.tenantId);
  if (!stub) return;
  const p = stub.fetch("https://workspace/activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: tctx.tenantId }),
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

/**
 * An admin signed in successfully. Offer the workspace the chance to come back.
 *
 * `E-dormancy-resume`. The hosted lifecycle page promises that a workspace suspended for
 * DORMANCY "reactivates on the first successful sign-in by an admin", and that nothing else
 * does — an acceptable-use takedown and a tombstone both survive their own admin signing in.
 *
 * ⚠️ THE REASON IS NOT CHECKED HERE, AND MUST NOT BE. `paused` is a cached copy with a TTL
 * (SUSPENSION_TTL_MS), so a workspace re-suspended for something else moments ago still
 * reads as its old reason from here — and "resume because my copy said dormancy" is exactly
 * the un-take-down this item exists to prevent. The allowlist lives in the workspace object
 * (`DORMANCY_SUSPENSION_REASONS`, src/tenant-do.js), which reads the live row inside its own
 * single thread. Copying it here would put the discriminator in two places, and one of them
 * would be the wrong one.
 *
 * What IS checked here is the half only this side knows, plus a cheap filter:
 *   · ADMIN — the roster is the worker's, and the object cannot re-derive a role a live
 *     instance does not yet keep in it. An editor or a viewer never gets as far as a call.
 *   · PAUSED AT ALL — a live workspace has nothing to resume, and this is a per-sign-in
 *     round trip we should not make for the overwhelmingly common case. `undefined` (the
 *     never-read, fail-closed answer) is not evidence of a suspension and is not a call
 *     either; if the flag was unreadable the object is unreachable anyway.
 *
 * Fire-and-forget, exactly like touchWorkspaceActivity: a sign-in must not fail, or wait,
 * because a resume did not happen. The next sign-in — or the next isolate — tries again.
 */
function resumeAfterDormancy(env, tctx, user, paused, ctx) {
  // `paused.suspended`, not the doc: the same read now carries `canonicalHost` for a
  // claimed-but-live workspace, and a live workspace has nothing to resume.
  if (!paused || !paused.suspended || !user || user.role !== "admin") return;
  const stub = tenantStub(env, tctx && tctx.tenantId);
  if (!stub) return;
  const p = stub.fetch("https://workspace/resume-on-sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Never the address. `by` is the same one-way id every stored provenance stamp carries.
    body: JSON.stringify({ workspaceId: tctx.tenantId, role: user.role, by: personId(user.email) }),
  }).then((res) => res.json()).then((out) => {
    // The workspace really did come back, so this isolate's cached "paused" is known wrong
    // — drop it rather than serve the holding page for the rest of the TTL. A HINT, not a
    // guarantee: every other isolate still waits the TTL out, which is the number to quote
    // to somebody refreshing the page, and is well inside the "few minutes" we publish.
    if (out && out.resumed) SUSPENSION_STATE.bust(tctx.tenantId);
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

// ---- Quotas -----------------------------------------------------------------
//
// A ceiling is per WORKSPACE, seeded at provisioning (src/tenant-quotas.mjs) and counted
// in the workspace's own Durable Object — one statement per bump, so two requests arriving
// together cannot both read the same number and both be let past.
//
// ⚠️ NO STORE, NO CEILING, and that is the deliberate half. Every instance today binds no
// TENANTS namespace, so nothing here changes for any of them: the two endpoints below have
// never had a rate limit and do not grow one by taking this engine. Inventing a limit for
// them would be a behaviour change nobody asked for, applied to somebody's live canvas
// session, in the same release as the machinery that would make it correct. The ceiling
// arrives with the workspace store, which is what the number is per.
//
// The window is computed HERE and the ceiling is read THERE. A limit that travels in a
// request body is a limit the caller can choose; a clock that lives in the object would be
// one more thing a test cannot move.
const quotaMinute = (now) => new Date(now || Date.now()).toISOString().slice(0, 16);
const quotaDay = (now) => new Date(now || Date.now()).toISOString().slice(0, 10);

/**
 * Count one use against a workspace's ceiling. Returns `{allowed}` — `true` when there is
 * no store to count in, because an instance with no ceiling has nothing to exceed.
 */
async function quotaBump(env, tctx, { key, field, window, by = 1 }) {
  const stub = tenantStub(env, tctx && tctx.tenantId);
  if (!stub) return { allowed: true, unmetered: true };
  try {
    const res = await stub.fetch("https://workspace/quota/bump", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ k: key, field, window, by, workspaceId: tctx.tenantId }),
    });
    if (!res.ok) throw new Error(`workspace store answered ${res.status}`);
    return await res.json();
  } catch (err) {
    // A counter that cannot be reached must not become a gate: refusing a canvas save
    // because a bookkeeping object hiccuped loses somebody's work, which is a worse outcome
    // than one unmetered write. The opposite call from the publish counter, and for the
    // opposite reason — there, letting one through corrupts the history.
    return { allowed: true, unmetered: true };
  }
}

/** The refusal a ceiling answers with. */
const quotaRefusal = (what, verdict) => jsonResponse({
  error: "quota-exceeded",
  what,
  ...(Number.isFinite(verdict && verdict.limit) ? { limit: verdict.limit } : {}),
  message: `This workspace has reached its ${what} limit. It resets on its own; nothing was lost.`,
}, 429);

// ---- Dev-status API (KV-backed, single key) ---------------------------------
// The ENTIRE status map lives under one key ("statuses"), so a page load is one
// kv.get and a click is one kv.put — NO kv.list (the small-bucket call that burned
// quota in the old badge system). Default status is "ignore"; the build-time chip
// baseline comes from the committed prototype-status.json, and this overlays live
// edits on top. Values: in-progress | dev-ready | ignore | reviewed (components).
const STATUS_KEY = "statuses";
// The vocabulary is `STATUS_LABELS` in src/currency.mjs and NOWHERE ELSE. What this route
// accepts and what a card says a status IS are the same list by construction: a status the
// gallery can print but this route rejects, or the reverse, is a word that exists on one
// surface only, which is the failure `F-currency-default` is about.
const VALID_STATUS = Object.freeze(
  Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 1])),
);

async function statusApi(tctx, request, url, env, me) {
  const store = overlayFor(env, tctx);
  if (!store) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    return jsonResponse({ map: await store.read("statuses") });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const key = clamp(op && op.key, 300);
    const status = clamp(op && op.status, 40);
    if (!key || !VALID_STATUS[status]) return jsonResponse({ error: "bad-input" }, 400);
    // Whoever first set a status on a prototype owns that row. Stamped from the session
    // the gate already resolved, never from the body — this route is signed-in-only, so
    // there is always one.
    return jsonResponse({ map: await store.set("statuses", "", key, status, me ? me.email : null) });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Currency API: what is current here, and what has been left behind -------
//
// `F-currency-default`. ONE read, answering both audiences, because two reads become two
// definitions of "current". A gallery card paints its freshness sentence from it, and an
// agent asked "what changed here in the last two weeks" answers from `?since=14d` in a
// single call instead of walking a manifest.
//
// It STORES NOTHING and it adds no field. Status comes from the overlay map the chip has
// always written; freshness is computed from the per-file `editedAt` the commit handler
// records. There is deliberately no "archived" flag: the person who abandons a prototype
// is the last person who will ever come back to tick a box, so a flag would be accurate
// only for the units that were never the problem.
//
// GET only, and there is nothing to POST — see src/currency.mjs for the whole decision.
//
// ⚠️ IT IS REACHABLE TWO WAYS AND IT IS ONE ANSWER. A browser arrives at `/__currency`
// with a session cookie; an agent has a PUBLISH TOKEN and no cookie, so it arrives at
// `/__publish/<workspace>/currency`, which is a scoped view of this same function. The two
// doors exist because the two callers hold different credentials — not because there are
// two definitions of current, which is the thing this item is about. Both call
// `currencyAnswer`, so a divergence would have to be written on purpose.
async function currencyAnswer(tctx, request, url, env, onlySpace) {
  if (request.method !== "GET") return jsonResponse({ error: "method-not-allowed" }, 405);
  // A window that was not understood is REFUSED, never quietly widened to everything:
  // answering a different question than the one asked is how an agent reports a dead
  // workspace as busy.
  const raw = url.searchParams.get("since");
  const sinceMs = raw ? parseSince(raw) : 0;
  if (raw && !sinceMs) {
    return jsonResponse({
      error: "bad-since",
      message: "since is a number and h, d or w — 36h, 14d, 2w. A bare number means days.",
    }, 400);
  }
  const store = overlayFor(env, tctx);
  const [statuses, all] = await Promise.all([
    store ? store.read(STATUS_KEY) : Promise.resolve({}),
    loadManifests(tctx.tenantId, env),
  ]);
  // A publish token is scoped to a workspace, so the token door answers about that
  // workspace and no other — the scoping is applied to the INPUT rather than filtered out
  // of the rows, because a filter is a place for a row to survive.
  const spaces = onlySpace
    ? (all[onlySpace] ? { [onlySpace]: all[onlySpace] } : {})
    : all;
  const now = Date.now();
  const units = currencyRows(spaces, statuses, { now, sinceMs });
  return jsonResponse({
    // Echoed, never assumed: a client that hardcoded 90 would keep saying "untouched"
    // against a threshold the instance had moved.
    staleAfterDays: STALE_AFTER_DAYS,
    now: new Date(now).toISOString(),
    since: raw || null,
    count: units.length,
    units,
  });
}

/** The browser's door: whatever the session may see, which is the whole workspace. */
function currencyApi(tctx, request, url, env) {
  return currencyAnswer(tctx, request, url, env, null);
}

// ---- Pins API (KV-backed, single key) ---------------------------------------
// User-pinned prototypes/projects for the sidebar. Whole map under one key ("pins")
// — one kv.get per session, one kv.put per toggle (same frugal pattern as statuses).
// Value: { "<path>": { label, href } }. POST { key, label, href, pinned } toggles.
const PINS_KEY = "pins";

async function pinsApi(tctx, request, url, env, user) {
  const store = overlayFor(env, tctx);
  if (!store) return jsonResponse({ map: {}, warning: "no-kv-binding" });
  // Pins are per-user (key "pins:<email>"), independent across users; the global
  // "pins" key is only the fallback when nobody is signed in. Note: NO migration
  // from the global map — that seeded EVERY new user from one shared (effectively
  // the first user's) map, leaking pins across accounts. A new user starts empty.
  // The scope, not the key: the accessor turns it back into `pins:<email>` on the KV
  // backing, so the documents a live instance already holds keep their exact names.
  const scope = user ? user.email : "";

  if (request.method === "GET") {
    return jsonResponse({ map: await store.read("pins", scope) });
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
      return jsonResponse({ map: await store.read("pins", scope), skipped: "empty-guard" });
    }
    return jsonResponse({ map: await store.replace("pins", scope, next) });
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

async function nameApi(tctx, request, url, env) {
  const store = overlayFor(env, tctx);
  if (!store) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    return jsonResponse({ map: await store.read("names") });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const key = clamp(op && op.key, 300);
    // Component descriptions (keys ending "#desc") are full sentences; names stay short.
    const name = clamp(op && op.name, key && key.endsWith("#desc") ? 280 : 80);
    if (!key) return jsonResponse({ error: "bad-input" }, 400);
    // An empty name CLEARS: null is the accessor's "delete this key", and the card reverts
    // to its build-time default.
    return jsonResponse({ map: await store.set("names", "", key, name || null) });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Working marks (KV-backed, single key) ----------------------------------
//
// `F-presence-marks`. Nothing anywhere said what was already being worked on. Two
// collaborators' tools — usually two agents, on two machines, told to improve "the
// checkout flow" — would each open the same folder, each edit it, and find out at publish
// time, where the answer is a fork and a conflict file nobody asked for.
//
// ⚠️ THIS IS DELIBERATELY NOT A LOCK, and every line below is written so it cannot become
// one. A mark REFUSES NOTHING. It is not consulted by the gate, by the publish handler, by
// the commit CAS or by anything else that could say no. It is a note left where the next
// reader will look, and the whole protocol is: write one before you start, read them
// before you start. Enforcement when coordination fails is the composed publish's job
// (`src/publish-compose.mjs`), which is the only place in this engine allowed to refuse a
// write over a collision — and it does it on evidence, after the fact, never on a claim.
//
// THE PROTOCOL IS AGENT-FIRST. The badge a person sees on a gallery card is the byproduct,
// not the point: as an agent's edit shrinks toward seconds, a mark is FELT almost never and
// READ always. So the write side is the CLI (`augur mark`, over a publish token, see the
// `_marks` branch in publishApi) and the browser side is read-only — a person editing in a
// tab is not running a work-start step and inventing one for them would be a lie about who
// wrote what.
//
// ⚠️ A MARK EXPIRES BY ITSELF AND IS NEVER TRUSTED TO BE CLEARED. The thing that leaves a
// mark is a process that can be killed — Ctrl-C, an OOM, a laptop lid — and a claim that
// outlives the claimant is worse than no claim at all, because the next reader believes it.
// So EXPIRY IS A READ-TIME FILTER (`liveMarks`), not a cleanup job: the moment `startedAt +
// ttl` is in the past the mark is gone from every answer, whether or not anything ever runs
// again. `sweepExpired` below only reclaims the BYTES, opportunistically, and correctness
// never depends on it having run.

/** How long a mark is good for when the caller does not say. */
const MARK_TTL_MS = 10 * 60_000;
/**
 * The longest a caller may ask for. An agent that wants four hours is describing a lock,
 * and the answer to a lock is a shorter mark re-written as the work continues.
 */
const MARK_TTL_MAX_MS = 60 * 60_000;
/** The shortest, so a `--ttl 0` cannot write a mark that is already dead. */
const MARK_TTL_MIN_MS = 5_000;
/**
 * How many lapsed rows one write may reclaim. Bounded low because on the KV backing each
 * row delete is a whole-document read and put, so the sweep can cost more than the litter
 * it collects; an unbounded one would turn a work-start step into a hundred writes on a
 * workspace nobody has marked in a month. Nothing depends on it running at all.
 */
const MARK_SWEEP_MAX = 4;
/** Belt and braces: a workspace cannot be filled with marks by a loop. */
const MARK_MAX_ROWS = 200;

/**
 * One spelling of a path, so two tools that mean the same folder agree.
 *
 * Leading and trailing slash, always: a mark names a UNIT — the prototype folder a URL
 * names and a person edits — and `unitOfPath` in src/publish-units.mjs decides containment
 * by prefix, which only works when a folder ends in a slash. `/a/b` and `/a/bc/` would
 * otherwise overlap.
 */
function normalizeMarkPath(p) {
  const s = clamp(p, 300);
  if (!s) return "";
  const trimmed = s.trim().replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}

/**
 * Do these two paths describe overlapping work? Containment in either direction — a mark
 * on `/checkout/` covers `/checkout/step-two/`, and a mark on `/checkout/step-two/` is
 * worth showing to somebody about to take `/checkout/`.
 */
function markPathsOverlap(a, b) {
  const x = normalizeMarkPath(a), y = normalizeMarkPath(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** The instant a mark stops meaning anything. Pure, and the only definition of expiry. */
function markExpiresAt(m) {
  const started = Date.parse((m && m.startedAt) || "");
  if (!Number.isFinite(started)) return 0;
  const ttl = Number.isFinite(+(m && m.ttl)) ? +m.ttl : MARK_TTL_MS;
  return started + Math.min(Math.max(ttl, MARK_TTL_MIN_MS), MARK_TTL_MAX_MS);
}

/**
 * The live marks in a stored map, newest first. THE expiry rule — every reader goes
 * through here, so a lapsed mark cannot be reported by one surface and hidden by another.
 */
function liveMarks(map, now = Date.now()) {
  return Object.entries(map || {})
    .map(([path, m]) => (m && typeof m === "object" ? { ...m, path: m.path || path } : null))
    .filter((m) => m && markExpiresAt(m) > now)
    .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
}

/**
 * What a mark looks like on the wire: the stored row plus two things a reader would
 * otherwise have to compute, and one it could not — the display name behind the id.
 *
 * The NAME IS RESOLVED, NEVER STORED. `personId` is the same one-way hash a comment
 * carries, so a mark holds no address; the roster turns it back into a face at read time,
 * which also means a rename shows through and an ex-member resolves to nobody.
 */
function decorateMark(m, users, now = Date.now()) {
  const u = (users || []).find((x) => x && personId(x.email) === m.personId);
  return {
    path: m.path,
    personId: m.personId || null,
    startedAt: m.startedAt,
    ttl: markExpiresAt(m) - Date.parse(m.startedAt),
    by: u ? u.name || nameFromEmail(u.email) : null,
    initials: u ? u.initials || initialsFor(u.name || u.email) : null,
    color: u ? u.color || null : null,
    expiresIn: Math.max(0, markExpiresAt(m) - now),
  };
}

/** Read the live marks for a workspace, decorated. `null` store answers with nothing. */
async function readMarks(tctx, env) {
  const store = overlayFor(env, tctx);
  if (!store) return { marks: [], warning: "no-kv-binding" };
  const map = await store.read("marks");
  const now = Date.now();
  return { marks: liveMarks(map, now).map((m) => decorateMark(m, tctx.USERS, now)), now };
}

/**
 * Reclaim the bytes of rows that lapsed. NOT the expiry mechanism — `liveMarks` already
 * stopped reporting these, and this runs only so a one-way author id does not sit in the
 * store for months after it stopped meaning anything. Per-key deletes, never a whole-family
 * `replace`: a replace computed from a read taken moments ago would drop a mark another
 * agent wrote in between, and on the workspace object it would delete rows it never read.
 *
 * It swallows its own failures on purpose. Reclaiming bytes may never be the reason a
 * work-start step reports a failure, because the mark it was announcing is already written.
 */
async function sweepExpired(store, map, now, keep) {
  let swept = 0;
  for (const [path, m] of Object.entries(map || {})) {
    if (swept >= MARK_SWEEP_MAX) break;
    if (path === keep) continue;
    if (markExpiresAt(m) > now) continue;
    try { await store.set("marks", "", path, null); swept++; } catch (e) { break; }
  }
  return swept;
}

/**
 * Write one mark. `who` is resolved by the caller from a credential — a session or a
 * publish token — and NEVER from the request body, exactly like a comment's authorship.
 *
 * ⚠️ ON THE KV BACKING TWO MARKS WRITTEN IN THE SAME WINDOW CAN LOSE EACH OTHER, and that
 * is a known cost rather than an oversight. A `map` family is one document: `set` reads it,
 * changes one key and puts it back, so a mark written between the read and the put is
 * overwritten — and KV reads converge globally rather than instantly, which makes the
 * window as wide as the convergence, not as wide as the round trip. The overlay's own
 * header says the same thing about statuses, names and pins; the workspace object closes
 * it for all of them at once by making each key a row.
 *
 * WHY IT IS SURVIVABLE HERE AND WOULD NOT BE IN A LOCK. A lost mark costs the next reader
 * a hint. It cannot cost anybody work, because nothing anywhere asks a mark for permission:
 * the loser of the race is still editing, still publishing, and still protected by the
 * composed publish, which settles a real collision on evidence. A lock that lost a write
 * would hand two writers the same exclusive claim, which is why this is not one.
 */
async function writeMark(tctx, env, who, { path, ttl }) {
  const store = overlayFor(env, tctx);
  if (!store) return { error: "no-kv-binding" };
  const p = normalizeMarkPath(path);
  if (!p) return { error: "bad-input" };
  const ms = Number.isFinite(+ttl) && +ttl > 0
    ? Math.min(Math.max(+ttl, MARK_TTL_MIN_MS), MARK_TTL_MAX_MS)
    : MARK_TTL_MS;
  const now = Date.now();
  const before = await store.read("marks");
  // The only refusal on this route, and it is a runaway-loop guard rather than a policy:
  // this many things being worked on at once in one workspace is a script, not a team.
  const live = liveMarks(before, now);
  if (live.length >= MARK_MAX_ROWS && !live.some((m) => m.path === p)) {
    return { error: "too-many-marks" };
  }
  // ⚠️ THE ROW CARRIES NO ADDRESS — not in the value and not in the `owner` column. A mark
  // is read by more things than a comment thread is (a gallery page stamps a badge from
  // it), and `personId` is exactly enough to put a face on it.
  const mark = { path: p, personId: who.personId, startedAt: new Date(now).toISOString(), ttl: ms };
  await store.set("marks", "", p, mark, null);
  const swept = await sweepExpired(store, before, now, p);
  // The answer is COMPUTED from what was just written, never re-read. A second read costs
  // a round trip to say what this function already knows, and on KV it can come back
  // STALER than the write it was meant to confirm — a work-start step that printed "your
  // mark is not there" right after writing it would teach people to distrust the tool.
  const marks = [mark, ...live.filter((m) => m.path !== p)];
  return {
    mark: decorateMark(mark, tctx.USERS, now),
    marks: marks.map((m) => decorateMark(m, tctx.USERS, now)),
    swept,
  };
}

/**
 * Release a mark early. A COURTESY, never the guarantee — the TTL is the guarantee, and a
 * tool that is killed never reaches this. Only the mark's own author may clear it: taking
 * somebody else's mark down would turn the note into something worth fighting over.
 */
async function clearMark(tctx, env, who, { path }) {
  const store = overlayFor(env, tctx);
  if (!store) return { error: "no-kv-binding" };
  const p = normalizeMarkPath(path);
  if (!p) return { error: "bad-input" };
  const map = await store.read("marks");
  const cur = (map || {})[p];
  const now = Date.now();
  if (!cur || markExpiresAt(cur) <= now) return { cleared: false, reason: "no-mark" };
  if (cur.personId !== who.personId) return { cleared: false, reason: "not-yours" };
  await store.set("marks", "", p, null);
  const marks = liveMarks(map, now).filter((m) => m.path !== p);
  return { cleared: true, marks: marks.map((m) => decorateMark(m, tctx.USERS, now)) };
}

/**
 * The browser's read. GET only, on purpose — see the header: the badge is the byproduct of
 * an agent protocol, and a tab is not a work-start step.
 */
async function marksApi(tctx, request, url, env) {
  if (request.method !== "GET") return jsonResponse({ error: "method-not-allowed" }, 405);
  const out = await readMarks(tctx, env);
  return jsonResponse({ ...out, ttlMs: MARK_TTL_MS });
}

// ---- Prototype deletion (repo-write via dispatch webhook) -------------------
// "Delete forever" on a prototype card. The worker holds NO repo credentials —
// it forwards the request to a per-instance webhook (a GitHub repository_dispatch
// on the deploy shell, which runs the actual `git rm` + push; the redeploy that
// follows removes the prototype from the live site). Both values come from runtime
// env (Cloudflare project settings), so the engine stays generic and a raw/local
// build answers 501: DELETE_DISPATCH_URL (the dispatches endpoint) and
// DELETE_DISPATCH_TOKEN (a token with write access to fire it).
// Path shapes are the two prototype homes only — never galleries, never skills.
const DELETE_PATH_RE = /^(?:[a-z0-9][a-z0-9._-]*\/prototypes\/[a-z0-9][a-z0-9._-]*|playground\/[a-z0-9][a-z0-9._-]*)$/;

// Fire a typed repository_dispatch at the deploy shell — the one channel a worker
// action has for changing a REPO (the durable record) rather than only live state.
// "Delete forever" sends prototype-delete; the Admin roster sends roster-update.
// Config-driven (DELETE_DISPATCH_URL/TOKEN, per-instance runtime env), so the
// engine stays generic; absent config means the instance has no such bridge, and
// each caller decides whether that is a hard 501 or merely worth noting.
async function shellDispatch(env, eventType, payload) {
  if (!env.DELETE_DISPATCH_URL || !env.DELETE_DISPATCH_TOKEN) return "unconfigured";
  try {
    const r = await fetch(env.DELETE_DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DELETE_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "augur-worker",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    });
    return r.ok || r.status === 204 ? "dispatched" : "failed";
  } catch (e) { return "failed"; }
}

async function deleteApi(tctx, request, env, me) {
  if (request.method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
  if (!env.DELETE_DISPATCH_URL || !env.DELETE_DISPATCH_TOKEN) {
    return jsonResponse({ error: "not-configured" }, 501);
  }
  let op;
  try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  const space = clamp(op && op.space, 60);
  const path = clamp(op && op.path, 200);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(space) || !DELETE_PATH_RE.test(path) || path.includes("..")) {
    return jsonResponse({ error: "bad-input" }, 400);
  }
  const d = await shellDispatch(env, "prototype-delete", { space, path, by: me ? me.email : "" });
  if (d !== "dispatched") return jsonResponse({ error: "dispatch-failed" }, 502);
  // The repo deletion is in flight. Now take it off the live site, which in bundle
  // mode ONLY the store can do — the redeploy this used to rely on no longer ships
  // space content. Dispatch first, because that half is the durable record; if this
  // half fails we say so rather than reporting a clean success.
  let store = null;
  if (bundleMode(env)) {
    const prefix = deleteUrlPrefix(tctx, space, path);
    if (!prefix) return jsonResponse({ error: "unknown-space", space }, 400);
    try {
      store = await removeFromStore(tctx, env, space, prefix, me ? me.email : "");
    } catch (e) {
      store = { error: "store-write-failed" };
    }
    if (store && store.error) {
      return jsonResponse({ error: "removed-from-repo-but-not-live", store }, 502);
    }
  }
  return jsonResponse({ ok: true, ...(store ? { store } : {}) }, 202);
}

// ---- Created canvases (KV-backed, single key) -------------------------------
// "New canvas" from a folder index: registers a board at <dir><slug>/ in one shared
// { "<path>": {name, by, t} } map (same frugal one-key pattern as statuses/names).
// The worker then SERVES the standard canvas loader at that path (virtualCanvas
// below) — no repo file exists until someone materializes the folder. Created
// boards are PUBLIC like any published prototype (obscure share link, no login) —
// the loader is served past the gate in the fetch fallthrough. Board CONTENTS live
// where every canvas keeps them: the /__board doc for that URL — so materializing
// later is just committing the 12-line loader.
const CANVASES_KEY = "canvases";
// A creatable dir is one or more lowercase slug segments ("/playground/",
// "/<folder>/", "/<space>/<folder>/") — never the site root.
const CANVAS_DIR_RE = /^\/(?:[a-z0-9-]+\/)+$/;

// `tenantId` is carried for one reason: the shadow check below asks whether a real file
// already serves the URL a board is being created at, and that question is answered from
// one workspace's published content. Passed rather than looked up, so a create in one
// workspace can never be refused — or waved through — by what a neighbour publishes.
async function canvasesApi(tctx, request, url, env, me) {
  const tenantId = tctx && tctx.tenantId;
  const store = overlayFor(env, tctx);
  if (!store) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    return jsonResponse({ map: await store.read("canvases") });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const map = await store.read("canvases");

    if (op && op.remove) {
      const path = clamp(op.path, 300);
      if (!map[path]) return jsonResponse({ error: "not-found" }, 404);
      // The board doc (board:<path>) is left in KV on purpose — recreating the same
      // name restores the board, so a mis-click never destroys anyone's work.
      const after = await store.set("canvases", "", path, null);
      bustCanvasRegistry(tenantId);
      return jsonResponse({ map: after });
    }
    // Rename in place: the display name changes, the path (and so the board doc)
    // stays — same model as card renames, but the registry IS the name store here.
    if (op && op.rename) {
      const path = clamp(op.path, 300);
      const name = clamp(op.name, 80).trim();
      if (!map[path] || !name) return jsonResponse({ error: "bad-input" }, 400);
      const after = await store.set("canvases", "", path, { ...map[path], name });
      bustCanvasRegistry(tenantId);
      return jsonResponse({ map: after });
    }

    const dir = clamp(op && op.dir, 200);
    const name = clamp(op && op.name, 80).trim();
    if (!name || !CANVAS_DIR_RE.test(dir)) return jsonResponse({ error: "bad-input" }, 400);
    const slug = name.toLowerCase().replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    if (!slug) return jsonResponse({ error: "bad-input" }, 400);
    const path = dir + slug + "/";
    if (map[path]) return jsonResponse({ error: "exists", path }, 409);
    // Never shadow a real shipped file at the same URL (any non-404, incl. redirects).
    if (await assetPathExists(tenantId, env, new URL(path, url))) return jsonResponse({ error: "exists", path }, 409);
    // `insert`, not `set`: the check above and the write below are two steps, so two
    // creates of one name both pass the check and the second takes the first's board.
    // On the DO backing that is one statement and the loser is told; on KV it is the
    // read-then-write it has always been, and the guard above is all there is.
    const created = await store.insert("canvases", "", path,
      { name, by: me ? me.email : "", t: Date.now() }, me ? me.email : null);
    if (!created.inserted) return jsonResponse({ error: "exists", path }, 409);
    bustCanvasRegistry(tenantId);
    return jsonResponse({ map: created.map, path });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// The three canvas fields are read off the CALLING workspace's context
// (`tctx.CANVAS_LOADER_EXTRAS`, `tctx.CANVAS_CATALOG`, `tctx.CANVAS_TRACKS`), never out
// of module scope. Each is that workspace's own routing talking, and a board is served
// to whoever holds its link — so a shared copy would hand an anonymous visitor of one
// workspace the neighbouring workspace's script tags, insert picker and track list.
//
// CANVAS_LOADER_EXTRAS — the extra tags every BUILT prototype page carries: the
// review/comment overlay (graph.js + comments.js, which power C-to-comment and
// Shift+C provenance) plus any build addon's tags. Without this a worker-served
// canvas page mounts the engine but loses the overlay stack that real prototype
// files get injected at build.
//
// CANVAS_CATALOG / CANVAS_TRACKS — the two site-wide canvas aggregates: every
// embeddable thing across all spaces (the insert picker's catalog) and every track
// any space installs. They are SYNTHESIZED, never shipped as files, because no single
// publisher ever holds the whole picture: content publishes one space at a time, so a
// space that wrote the whole file would blank every other space's entries. Each space
// contributes its own slice in its routing fragment; the merge lands on the context.
// Both modes feed it: bundle mode from the live manifests (derivedRoutingFields),
// assets mode from routing.json (routingFields).

// Serve one of the aggregates. Reachable without a login, matching what the files were:
// canvas boards are shareable links that render for a signed-out viewer, so their insert
// picker and music player must load too. Never cached at the edge — a publish changes it
// immediately.
//
// The CATALOG, though, is the site's whole inventory: the title, group and exact URL of
// every prototype, page and component that ships. Served openly it is a directory —
// it turns "you need the link" into "here is every link", which is the difference
// between a shared prototype and a browsable index of the team's work. A signed-out
// viewer needs the BOARD they were sent to render, not the catalogue of everything else
// that exists, so they get an empty picker. Empty array rather than a 401 so the canvas
// client's fetch still parses and the board renders normally.
function canvasAggregate(tctx, which, authed = true) {
  // tracks: `authed` means ADMIN here (the caller resolves it) — a non-admin is told the
  // instance has no music, so the canvas hides its music surface instead of offering a
  // picker whose every track answers 404.
  if (which === "tracks") return jsonResponse(authed ? tctx.CANVAS_TRACKS : []);
  return jsonResponse(authed ? tctx.CANVAS_CATALOG : []);
}

// The same loader a repo canvas folder carries — the page just names the board and
// mounts the shared /__canvas/ engine; contents persist to /__board keyed by URL.
function canvasLoaderPage(tctx, name) {
  // Full escape — the value lands in a "-quoted attribute (content="…(${title})"), so a
  // bare " would break out and inject further meta attributes on this PUBLIC page.
  const title = escapeHtml(name);
  const boot = JSON.stringify({ name: String(name) }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="description" content="Live canvas board (${title}): created from the folder page; its content lives in the board doc at /__board" />
<title>${title}</title>
<link rel="stylesheet" href="/__canvas/canvas.css" />
<script>window.GV_CANVAS = ${boot};</script>
</head>
<body>
<script src="/__canvas/canvas.js" defer></script>${tctx.CANVAS_LOADER_EXTRAS}
</body>
</html>`;
}

// The 404-path registry read, cached per isolate. Every asset miss lands in
// virtualCanvas — every gated page an anonymous visitor opens, every genuinely
// missing file — so an uncached read here is a steady KV consumer, and an UNCAUGHT
// one is how the day the free-tier KV get() budget ran out (2026-08-20) turned
// into error 1101 on those routes instead of the branded 404/login flow. A
// throwing KV degrades: the last-read registry keeps serving if one was read (the
// stamp is NOT advanced, so recovery is retried next call), fallthrough if not —
// never a 500. Registry writes bust via bustCanvasRegistry(), so a just-created
// canvas is live at once on its isolate; other isolates converge within the TTL.
//
// KEYED BY WORKSPACE, and that key is the whole of what makes the cache safe. The value
// is one workspace's board registry — the paths it has created boards at and the names
// on them — and the route that reads it is the LAST door in fetch(): a registered path
// is served to a signed-out stranger, before the login page, because a board is a share
// link. A single slot therefore hands the second workspace to ask, inside the TTL, the
// first one's boards at the first one's URLs, ungated — while that workspace's OWN
// boards 404 into its login page, because the registry answering is not the one its KV
// holds. Bounded like the manifest cache and the proxy allowlist: an evicted workspace
// re-reads its own registry, which costs one KV get and can never answer with a
// neighbour's.
const CANVAS_REG_TTL_MS = 15_000;
const CANVAS_REG_CACHE_MAX = 256;
// tenantId -> { at, raw }
const CANVAS_REGISTRY = tenantCache("canvas-registry", { max: CANVAS_REG_CACHE_MAX });

// Takes the workspace, not only the binding: the caller (virtualCanvas) has one in hand,
// and a read that knows only which store to talk to cannot tell whose entry it is filling.
//
// It caches the MAP rather than the raw document, because the document is no longer the
// unit — the overlay accessor answers with a map whichever backing it is reading from, and
// a cache that held bytes would have to know which one that was.
async function readCanvasRegistry(tctx, env) {
  const store = overlayFor(env, tctx);
  if (!store) return null;
  // Insert BEFORE the await, so two concurrent requests for one workspace fill one entry
  // rather than racing two into the map.
  const cur = CANVAS_REGISTRY.entry(tctx.tenantId, () => ({ at: 0, map: null }));
  if (!cur.at || Date.now() - cur.at >= CANVAS_REG_TTL_MS) {
    try {
      cur.map = await store.read("canvases");
      cur.at = Date.now();
    } catch (e) { /* keep the last good map rather than blanking the registry */ }
  }
  return cur.map;
}

// A registry write making itself visible on the very next request, for ITS workspace —
// busting the whole map would send every other workspace back to KV for a change that
// was never theirs. The last-read document is KEPT: this asks for a re-read, it does not
// blank what the workspace is serving in the meantime.
function bustCanvasRegistry(tenantId) {
  CANVAS_REGISTRY.bust(tenantId);
}

// Serve a registered created-canvas path (null when the path isn't one). Called only
// on asset 404s, so the extra kv.get never taxes a real page load. Bare
// "/dir/slug" redirects to the trailing-slash form — the board doc and the room are
// keyed by the page's URL path, and two spellings must not split one board in two.
async function virtualCanvas(tctx, request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let p = url.pathname;
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  const normalized = p.endsWith("/") ? p : p + "/";
  if (!CANVAS_DIR_RE.test(normalized)) return null;
  const map = await readCanvasRegistry(tctx, env);
  if (!map) return null;
  const entry = map[normalized];
  if (!entry) return null;
  if (url.pathname !== normalized && !url.pathname.endsWith("/index.html")) {
    return Response.redirect(new URL(normalized, url).toString(), 301);
  }
  return new Response(canvasLoaderPage(tctx, entry.name), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

// ---- Canvas board documents (KV-backed, one key per canvas URL) -------------
// Each canvas (a prototype that mounts the shared /__canvas/ engine) owns ONE board
// document — nodes + view + name — keyed by its URL path, the same per-URL rail comments
// use, so it isolates per-space for free. The client owns the whole document, so we store
// exactly what it POSTs (authoritative full-state write, like pins) — no server-side merge
// that could race under KV eventual consistency. GET returns { doc } (null if never saved).
// The key is NOT spelled here. `BOARD_PREFIX` is imported from src/board-key.mjs, which
// src/board-room.mjs imports too, and `OVERLAY_KV_KEYS.boards` above derives its document
// name from that same constant — so the rail and the room's mirror cannot name two
// different documents. There used to be a third declaration on this line, exported for
// tests and read by nothing, which is the state a drift starts from.
const BOARD_MAX_BYTES = 20 * 1024 * 1024; // under KV's 25MB per-value ceiling (inline images)

async function boardApi(tctx, request, url, env, me) {
  const store = overlayFor(env, tctx);
  if (!store) return jsonResponse({ doc: null, warning: "no-kv-binding" });
  const path = clamp(url.searchParams.get("path"), 600);
  if (!path) return jsonResponse({ error: "bad-input" }, 400);

  if (request.method === "GET") {
    return jsonResponse({ doc: (await store.readKey("boards", "", path)) || null });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.text();
    if (body.length > BOARD_MAX_BYTES) return jsonResponse({ error: "too-large" }, 413);
    let op;
    try { op = JSON.parse(body); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const doc = op && op.doc;
    if (typeof doc !== "object" || doc === null || !Array.isArray(doc.nodes)) return jsonResponse({ error: "bad-input" }, 400);
    // The write ceiling. This route is unauthenticated by design — the board is the
    // credential — so it is the one place a stranger with a link can spend a workspace's
    // storage and subrequests indefinitely. Counted per minute, and the shape check above
    // comes first so a malformed flood is refused before it is metered.
    const verdict = await quotaBump(env, tctx, {
      key: "board-writes", field: "boardWritesPerMinute", window: quotaMinute(),
    });
    if (!verdict.allowed) return quotaRefusal("board write", verdict);
    // LAST WRITE WINS, deliberately and unchanged. A board document is the client's whole
    // canvas, reconciled in the realtime room before it ever gets here; two PUTs merged
    // server-side would produce a canvas neither person drew. The revision machinery the
    // comment threads use is exactly what must NOT be applied to this.
    //
    // The OWNER is stamped from the session and only on creation — see the overlay schema.
    // This route is unauthenticated by design, so an anonymous save leaves it absent rather
    // than inventing one; what it must never do is take an address from the body, which is
    // why nothing here reads one.
    await store.set("boards", "", path, doc, me ? me.email : null);
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

/**
 * Delete canvas images no board refers to any more.
 *
 * `B-asset-upload-quota`. An image is uploaded once and referenced from a board document
 * by its `/__asset/<hash>` URL. Delete the board — or the node — and the bytes stay in R2
 * forever, counted against a workspace's storage and against the account's bill, with
 * nothing that would ever notice.
 *
 * REFERENCES ARE READ OFF THE BOARDS, NOT COUNTED ON THE WAY IN. A refcount maintained at
 * write time is a number that has to be right on every path that ever touches a board,
 * including the realtime worker's own saves and a restore from backup — and the first time
 * it is wrong, it is wrong in the direction of deleting an image somebody is looking at.
 * Reading the boards is O(boards) instead of O(1) and cannot drift.
 *
 * THE GRACE WINDOW IS WHAT MAKES IT SAFE, and it protects a specific moment: an image is
 * uploaded seconds BEFORE the board that will reference it is saved. Without a window, a
 * pass landing in that gap deletes an image the person is still placing. A re-paste
 * refreshes the row's stamp, so an image that is being used keeps buying itself time.
 *
 * `dryRun` reports what it would delete and deletes nothing — which is how anybody should
 * run it the first time on a real workspace.
 */
const ASSET_GC_GRACE_MS = 24 * 60 * 60 * 1000;
async function assetGc(env, tctx, { graceMs = ASSET_GC_GRACE_MS, now = Date.now(), dryRun = false } = {}) {
  const store = overlayFor(env, tctx);
  // ⚠️ THIS WORKSPACE'S IMAGES ONLY, AND THAT IS THE POINT OF PREFIXING `assets/`. The rows
  // and the boards this pass reads are already this workspace's; the KEY was not. Two
  // workspaces pasting the same picture produce the same 40-hex hash and the same bytes, so
  // an unprefixed delete here removed the object the OTHER workspace was displaying —
  // cross-workspace data loss with no attacker in it, reachable by a collector doing exactly
  // its job. `blobGc` was written for a shared namespace and refuses to conclude from a
  // partial read; this pass never had that care, and the segment is what makes it
  // unnecessary rather than a second thing to remember.
  const r2 = (env.BUNDLES && bundlesFor(env, tctx && tctx.tenantId)) || null;
  if (!store || !r2) return { ok: false, reason: "no-store" };

  const rows = await store.read("assets");
  const hashes = Object.keys(rows);
  if (!hashes.length) return { ok: true, scanned: 0, referenced: 0, deleted: 0, kept: 0, hashes: [] };

  // Every board document, as text. A node's shape has changed more than once and will
  // again; the URL has not, and searching for it finds a reference wherever it is nested.
  const boards = await store.read("boards");
  const referenced = new Set();
  for (const doc of Object.values(boards)) {
    const text = JSON.stringify(doc || null);
    for (const m of text.matchAll(/\/__asset\/([0-9a-f]{40})/g)) referenced.add(m[1]);
  }

  const deleted = [];
  let kept = 0;
  for (const hash of hashes) {
    if (referenced.has(hash)) { kept++; continue; }
    const at = Date.parse((rows[hash] && rows[hash].at) || "") || 0;
    if (now - at < graceMs) { kept++; continue; }
    if (!dryRun) {
      // The bytes first, then the row. The other order leaves an object nothing knows
      // about, which is the state this whole pass exists to remove.
      if (r2.delete) await r2.delete(ASSET_R2_PREFIX + hash);
      await store.set("assets", "", hash, null);
    }
    deleted.push(hash);
  }
  return {
    ok: true, dryRun: !!dryRun,
    scanned: hashes.length, referenced: referenced.size, kept, deleted: deleted.length,
    hashes: deleted.slice(0, 20),
  };
}

// ---- Canvas board images (/__asset) -----------------------------------------
// Pasted/dropped canvas images used to be inlined into the board doc as data URLs, which
// made every doc write (and every room seed) carry every image ever pasted. Now the client
// uploads the compressed JPEG once; we store it under its content hash (immutable, so the
// browser caches it forever) and the doc carries only the tiny /__asset/<hash> URL.
// Old boards with inline data URLs still render — <img src> takes either form.
const ASSET_PREFIX = "basset:";
const ASSET_R2_PREFIX = "assets/";
const ASSET_MAX_BYTES = 4 * 1024 * 1024; // client compresses to ~<1MB; hard stop well below that x4

// THE BYTES GO TO R2, THE ROW STAYS IN THE WORKSPACE. A pasted screenshot is megabytes,
// and a Durable Object's SQLite caps a single stored value around 2MB — the realtime
// worker's own NODE_CHUNK constant documents that ceiling. So the one family that could
// not move into the workspace object moves to the same content-addressed R2 the published
// blobs already use, and the workspace keeps a row saying the image exists, what it is and
// how big — which is what a quota and a garbage collection pass will read.
//
// NO refCount, deliberately. Nothing counts references yet: the GC pass that would
// maintain one is its own item, and a counter nobody increments is worse than no counter,
// because the first thing that reads it deletes an image somebody is looking at.
//
// READS TRY R2 AND THEN KV, in that order, and the KV half is not legacy tolerance for its
// own sake: every image pasted on a live instance before this is a `basset:<hash>` value,
// and a board that half-renders is worse than one that cannot grow. The fallback drains on
// its own as boards are re-pasted; nothing has to migrate for a board to keep working.
async function assetApi(tctx, request, url, env) {
  const kv = kvFor(env, tctx);
  const r2 = (env.BUNDLES && bundlesFor(env, tctx && tctx.tenantId)) || null;
  const store = overlayFor(env, tctx);
  // ⚠️ THE SWITCH IS THE WORKSPACE STORE, NOT THE BUNDLE STORE, and the reason is BACKUPS.
  // Every live instance already binds R2, so keying the write on that alone would move
  // every new pasted image out of KV today — and out of the nightly KV backup with it,
  // while the store backup walks `blobs/` and would not see `assets/` either. New images
  // would be in neither copy, silently, which is the failure the canvas-image backup test
  // exists because of.
  //
  // So the bytes move when the workspace moves: the same single switch as every other
  // family in this phase, and the export endpoints that cover `assets/` are part of that
  // migration rather than something this change quietly needs first.
  const toR2 = !!(r2 && store && store.backing === "do");
  if (!kv && !r2) return jsonResponse({ error: "no-kv-binding" }, 503);

  if (request.method === "POST" && url.pathname === "/__asset") {
    const ct = (request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return jsonResponse({ error: "bad-type" }, 415);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > ASSET_MAX_BYTES) return jsonResponse({ error: "too-large" }, 413);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);

    // The daily volume ceiling, counted in BYTES rather than uploads: what costs a
    // workspace is what it stores, and ten megabytes is ten megabytes however many requests
    // it arrived in. Counted after the size and type checks, so a refused upload is not
    // metered — and before the write, so a workspace over its ceiling stores nothing.
    const verdict = await quotaBump(env, tctx, {
      key: "asset-bytes", field: "assetUploadDailyBytes", window: quotaDay(), by: buf.byteLength,
    });
    if (!verdict.allowed) return quotaRefusal("daily image upload", verdict);

    if (toR2) {
      // Content-addressed → a re-paste of the same image is free. `head` rather than `get`
      // so the check does not pull megabytes back to decide it already has them.
      if (!(await r2.head(ASSET_R2_PREFIX + hash))) {
        await r2.put(ASSET_R2_PREFIX + hash, buf, { httpMetadata: { contentType: ct } });
      }
      // The row is bookkeeping, not the record: the image is in R2 either way, so a failed
      // metadata write must not fail an upload that succeeded. It is REWRITTEN on a
      // re-paste even though the bytes are not, because the stamp is what the collector
      // reads: an image somebody is still placing keeps buying itself another grace window.
      try { await store.set("assets", "", hash, { ct, bytes: buf.byteLength, at: new Date().toISOString() }); }
      catch (e) { /* the bytes are stored; the row can be rebuilt from a listing */ }
      return jsonResponse({ url: "/__asset/" + hash });
    }

    // The KV path: every instance today, and every raw or offline build. Unchanged.
    const key = ASSET_PREFIX + hash;
    if ((await kv.get(key, { type: "arrayBuffer" })) === null) {
      await kv.put(key, buf, { metadata: { ct } });
    }
    return jsonResponse({ url: "/__asset/" + hash });
  }

  if (request.method === "GET") {
    const hash = url.pathname.slice("/__asset/".length);
    if (!/^[0-9a-f]{40}$/.test(hash)) return jsonResponse({ error: "bad-input" }, 400);
    // content-hashed = immutable: one read per browser, ever, whichever store answers.
    const immutable = { "cache-control": "public, max-age=31536000, immutable" };
    if (r2) {
      const obj = await r2.get(ASSET_R2_PREFIX + hash);
      if (obj) {
        return new Response(obj.body, {
          headers: {
            "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
            ...immutable,
          },
        });
      }
    }
    // ⚠️ THE LEGACY KV BYTES ARE READ ONLY WHERE THEY CAN BE ATTRIBUTED. `basset:<hash>` is
    // one flat namespace with no segment in it. On a deployment serving one workspace those
    // bytes are that workspace's and this is the compatibility path it has always been; on
    // one that resolves the workspace from the Host they belong to whoever pasted them, a
    // question this key cannot answer — and "the hash is the credential" would then be a
    // credential that spans workspaces. Same judgement, same word, as the KV overlay's.
    if (kv && bundleWorkspaceSegment(env, tctx && tctx.tenantId).legacyIsOurs) {
      const got = await kv.getWithMetadata(ASSET_PREFIX + hash, { type: "arrayBuffer" });
      if (got && got.value) {
        return new Response(got.value, {
          headers: { "content-type": (got.metadata && got.metadata.ct) || "image/jpeg", ...immutable },
        });
      }
    }
    return jsonResponse({ error: "not-found" }, 404);
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Canvas multiplayer (/__rt) ---------------------------------------------
//
// TWO PATHS, CHOSEN BY WHETHER THIS DEPLOYMENT BINDS `ROOMS`, and the straddle is the
// same one deploy.yml already carries for the two front doors: a deployment moves on its
// own schedule and rollback is removing a binding.
//
//   OWN ROOMS (`env.ROOMS` bound) — the BoardRoom Durable Objects are in THIS worker's
//   module graph (src/entry.js exports the class), so the room is reached directly. No
//   second worker, no second public URL, and no shared secret to protect one.
//
//   PROXY (no binding) — what every deployment does today. The rooms live in a SEPARATE
//   worker (Pages cannot define a DO class), deployed from realtime/, one per instance.
//   Proxying keeps the client same-origin (no hardcoded workers.dev URL in canvas.js,
//   works offline too); fetch() with the Upgrade header intact returns the 101 + socket.
//   The origin is `tctx.RT_ORIGIN` — the CALLING workspace's, read per request, injected
//   at build from the deploy config's `realtimeOrigin`. Without one, boards run solo (the
//   client's socket-down fallback: it persists via /__board to this instance's own KV).
//
// ⚠️ THE ROOM'S NAME IS COMPUTED HERE AND NOWHERE ELSE. `idFromName` hashes whatever
// string it is handed, so that string IS the isolation boundary. The proxy path hands the
// realtime worker a `?path=` and that worker names the room after it — a value taken
// entirely from the query string, with nothing authenticating it, which is exactly why the
// standalone worker needs a shared secret and a seal check in front of it. On the binding
// path the name starts with the workspace `resolveTenant()` already resolved for this
// request, so no query string can steer it: two workspaces with a board at the same path
// are two rooms, structurally, and the computation is incapable of taking a workspace from
// the client.
function roomName(tctx, path) {
  return workspaceOf(tctx) + ":" + path;
}
const workspaceOf = (tctx) => (tctx && tctx.tenantId) || DEFAULT_TENANT_ID;

function rtProxy(tctx, request, url, env, me) {
  // Sandbox seal (offline mode without deploy creds): local KV alone is not a sandbox
  // if the canvas still joins the shared rooms — board ops would half-escape while
  // solo saves diverge locally. The flag beats a configured origin on purpose.
  if (env && env.GV_RT_DISABLE) return jsonResponse({ error: "realtime-disabled" }, 501);
  // Ticket mint (A-room-tickets). A non-Upgrade GET with ?mint=1 is the client asking for a
  // short-lived signed ticket to carry on the socket open. It rides the SAME authenticated
  // request the page did and is dispatched only AFTER the restricted-space gate above (which
  // 403s a non-admin naming a restricted path), so a ticket is minted only for a board this
  // caller may already reach. No secret ⇒ 501, and the client opens the socket directly
  // (legacy realtime) or drops to solo — see canvas.js mpConnect. `who` is the caller's
  // signed-in email or "anon"; it is bound into the ticket, not asserted by the socket.
  if (request.headers.get("Upgrade") !== "websocket"
      && request.method === "GET" && url.searchParams.get("mint")) {
    const secret = env && env.ROOM_TICKET_SECRET;
    if (!secret) return jsonResponse({ error: "tickets-unconfigured" }, 501);
    const path = clamp(url.searchParams.get("path"), 600);
    if (!path) return jsonResponse({ error: "bad-input" }, 400);
    const who = (me && me.email) ? me.email : "anon";
    return signRoomTicket(secret, { workspace: workspaceOf(tctx), path, who })
      .then((t) => jsonResponse(t));
  }
  if (env && env.ROOMS) {
    if (request.headers.get("Upgrade") !== "websocket") return jsonResponse({ error: "expected-websocket" }, 426);
    // The same clamp /__board applies, so the room the socket joins and the document the
    // rail reads are named from one string.
    const path = clamp(url.searchParams.get("path"), 600);
    if (!path) return jsonResponse({ error: "bad-input" }, 400);
    // Re-wrap so the workspace can be stamped on; the Upgrade header and the socket
    // handling ride along, exactly as they do on the proxy path below. `set` OVERWRITES,
    // which is what makes the header the worker's answer and not the caller's — a client
    // may send this name and it is discarded.
    const req = new Request(url.toString(), request);
    req.headers.set(RT_WORKSPACE_HEADER, workspaceOf(tctx));
    return env.ROOMS.get(env.ROOMS.idFromName(roomName(tctx, path))).fetch(req);
  }
  if (!tctx.RT_ORIGIN) return jsonResponse({ error: "realtime-not-configured" }, 501);
  if (request.headers.get("Upgrade") !== "websocket") return jsonResponse({ error: "expected-websocket" }, 426);
  // Re-wrap so a header can be added; the Upgrade header and the socket handling ride
  // along. The secret proves the request came through this worker, which is where the
  // admin-only-space seal is enforced (see the isRestrictedPath check on ?path= above).
  // Unset = send nothing, and a realtime worker without the secret accepts as before.
  const req = new Request(tctx.RT_ORIGIN + "/room" + url.search, request);
  const secret = env && env.RT_SHARED_SECRET;
  if (secret) req.headers.set("X-Augur-RT", secret);
  return fetch(req);
}

// Admin surface: manage PEOPLE, not credentials. There is deliberately no path here
// that sets, reads or recovers a password — reset re-issues an invite instead.
async function adminUsersApi(tctx, request, url, env, me, users = tctx.USERS, configUsers = tctx.CONFIG_USERS, spaces = tctx.SPACES, ctx = null) {
  // Admin of ANY space gets in; every mutation below re-checks the SPECIFIC space it
  // touches. On an instance that never set memberships this is the old global check,
  // because a global admin administers everything by default.
  if (!me || !administersAny(me, spaces)) return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env, tctx);
  // A roster write lands in THIS isolate on its next request (so the list the admin is
  // looking at is right) and everywhere else within ROSTER_TTL_MS. Two statements do
  // that, and both name the workspace they belong to or nothing at all: the overlay bust
  // is keyed by workspace, so the six KV documents re-read are the ones this write
  // touched and no neighbour is sent back to its own store for a change that was never
  // theirs; `cfgAt = 0` retires this isolate's config tick so that re-read happens now
  // rather than up to 1.5s from now.
  //
  // ⚠️ NOTHING HERE WRITES `TENANT_CTX`, and that is the fix, not an omission. This used
  // to also stamp the re-derived roster straight into the module slot, guarded by
  // `users === tctx.USERS` — a true statement about the PARAMETER (the router lets it
  // default to the context's list; a caller that injected its own gets that one back
  // untouched) and a statement about nothing at all where it was used. The slot is one
  // slot; this code runs several awaits deep (`readRoster`, `kv.put`, `revokeSecret`,
  // `mintInvite`); a request for another workspace resolving during any one of them
  // leaves ITS context in the slot, and the write-through then stamped this workspace's
  // roster — its members AND their roles, which is an authorization answer — onto the
  // neighbour's context. Comparing `TENANT_CTX === tctx` before writing would have closed
  // that, and was rejected: it keeps a second writer to a slot whose only owner should be
  // the config loader, it has to be re-argued every time an await is added above it, and
  // it buys nothing, because the write-through was never observable. The two statements
  // below send the next request for this workspace back to KV and rebuild `USERS` from
  // what it finds — overwriting exactly what the slot write had put there. Immediacy
  // comes from the bust; the slot write only ever added a way to be wrong.
  // `test/tenant-ctx-writeback.test.mjs` pins both halves.
  const commitRoster = () => {
    bustRosterOverlay(tctx.tenantId); cfgAt = 0;
  };

  if (request.method === "GET") {
    // ?space=<id> scopes the list to that space's members and reports each person's
    // role THERE. Without it the answer is the whole roster at global roles, which is
    // what every caller predating per-space admin expects.
    const scope = url.searchParams.get("space");
    // Administering SOME space got you through the door; reading a space's roster
    // requires administering THAT one. Without this, an admin of one workspace could
    // enumerate the members of every other by editing the query string — which would
    // make per-space roles decorative.
    if (scope && roleIn(me, scope) !== "admin") return jsonResponse({ error: "forbidden" }, 403);
    const inScope = scope ? users.filter((u) => isMemberOf(u, scope)) : users;
    // ONE read for the whole column where the family has been cut over, against one KV get
    // per person before it. The stamps are a table there, so asking for them one at a time
    // would be paying the round trip the move was for — and a per-person KV fallback
    // BEHIND it would pay it anyway for everybody the object has no row for, which on a
    // fresh workspace is everybody. So the object's answer is the whole column when the
    // object answers; KV is reached only when it could not, which is a degradation and not
    // a merge. The copy carries `users:lastseen:`, so nothing predating the cut is lost —
    // and what a stamp written between the copy and the cut costs is one column value that
    // this person's next page view rewrites.
    const ident = identityFor(env, tctx, "lastseen");
    let seenMap = null;
    if (ident) { try { seenMap = await ident.lastseenRead(); } catch (e) { /* KV below */ } }
    // With SESSION_KEYS on, someone signed in by invite link holds no credential at all,
    // so the credential alone would report them "pending" forever. Redeemed-by-link IS
    // accepted, and the stored session key is the record the redemption left. One read
    // for the whole list, and a read that fails leaves the credential answer standing.
    let keyMap = null;
    if (tctx.SESSION_KEYS && kv) keyMap = await readSessionKeys(kv);
    const out = [];
    for (const u of inScope) {
      let lastSeen = null;
      if (seenMap) lastSeen = seenMap[lcEmail(u.email)] || null;
      else {
        try { lastSeen = kv ? await kv.get(LASTSEEN_PREFIX + u.email) : null; } catch (e) {}
      }
      const secret = await effectiveSecret(env, u);
      out.push({
        email: u.email, name: u.name, role: scope ? roleIn(u, scope) : roleOf(u),
        initials: u.initials || "", color: u.color || "#4f46e5",
        avatar: avatarUrl(u),
        state: (secret || (keyMap && keyMap[u.email])) ? "accepted" : "pending",
        lastSeen,
        // Whether THIS admin may reset THIS person — the panel hides the action rather
        // than offering one the API will refuse. See mayResetPassword.
        mayReset: mayResetPassword(users, me.email, u.email, spaces),
      });
    }
    return jsonResponse({ users: out, space: scope || null });
  }

  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const kind = op && op.op;
    if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
    const link = (token) => `${url.origin}/__invite?t=${encodeURIComponent(token)}`;
    // The workspace's own display name for the account-store notify — same source mailLink
    // uses for its "workspace" mail var, so a switcher row and an invite mail agree.
    const workspaceLabel = (spaces.find((s) => s.default) || {}).name || url.host;
    // Email the link as well as returning it. NEVER instead of returning it: the panel
    // shows the copy-pasteable link either way, and this verdict — sent, unconfigured,
    // capped, or the provider's own refusal — is what it shows next to it. A deployment
    // that has configured no provider gets reason "unconfigured" and a blank note, which
    // is the behaviour that predates mail existing at all. Awaited on purpose: the admin
    // is standing there deciding whether they still have to send it themselves.
    const mailLink = async (to, template, token, extra = {}) => {
      const result = await sendMail(env, {
        to,
        template,
        vars: {
          workspace: (spaces.find((s) => s.default) || {}).name || url.host,
          link: link(token),
          expiresHours: Math.round(INVITE_TTL_MS / 3600000),
          // Where the link LANDS is the deployment's SESSION_KEYS choice, and the mail
          // must describe that landing: promising "choose a password" above a link that
          // signs the person straight in reads as a phishing tell.
          passwordless: !!tctx.SESSION_KEYS,
          ...extra,
        },
      }, {
        kv,
        // The per-actor ceiling only exists if somebody tells it who the actor is. Here
        // that is the signed-in admin: this whole handler is behind an admin check, so
        // there is a name to attribute the sends to, and it is more useful than an IP.
        // The unauthenticated paths (signup, self-service reset) live in the control
        // plane and key on the client address instead.
        actor: (me && me.email) || "admin",
      });
      return { ...result, note: mailNotice(result, to) };
    };

    if (kind === "reset") {
      const u = userByEmail(op.email, users);
      if (!u) return jsonResponse({ error: "unknown-user" }, 400);
      // A reset is an ACCOUNT action. Refuse it when the target reaches a space the
      // caller does not administer, or the reset becomes a door into that space.
      if (!mayResetPassword(users, me.email, u.email, spaces)) {
        return jsonResponse({ error: "beyond-scope", message:
          "This person belongs to a space you don't administer. They can reset their own password from Settings." }, 403);
      }
      // Clearing the secret and minting the link are ONE action: there is never a state
      // where a known password is still live alongside a pending invite.
      await revokeSecret(env, u.email, tctx);
      await revokePublishTokens(tctx, env, u.email); // a reset password must not leave a live publish token
      const token = await mintInvite(tctx, env, u.email);
      const mail = await mailLink(u.email, "credential-reset", token);
      return jsonResponse({ ok: true, email: u.email, url: link(token), mail });
    }

    // Invite = put the address on the roster overlay AND mint its link, in one action.
    if (kind === "invite") {
      const email = lcEmail(op.email);
      if (!isEmailish(email)) return jsonResponse({ error: "bad-email" }, 400);
      if (userByEmail(email, users)) return jsonResponse({ error: "already-a-user" }, 409);
      // All three roles, not the old admin-or-nothing coercion. `editor` is written
      // out in full — the legacy `user` spelling still READS as editor, but nothing
      // new should be created wearing it.
      const role = ROLES.includes(op.role) ? op.role : "editor";
      const name = clamp(op.name, 80).trim() || nameFromEmail(email);
      const roster = await readRoster(env, tctx);
      if (Object.keys(roster.add).length >= ROSTER_ADD_MAX) {
        return jsonResponse({ error: "roster-full" }, 409);
      }
      roster.remove = roster.remove.filter((e) => lcEmail(e) !== email); // re-inviting undoes a removal
      roster.add[email] = {
        email, name, role,
        initials: initialsFor(name), color: colorFor(email),
        addedAt: new Date().toISOString(), addedBy: me.email,
      };
      await kv.put(USER_ROSTER_KEY, JSON.stringify(roster));
      await mirrorRosterDocs(tctx, env, { roster });
      // A stale hash under this address (a previous member of the same name) would make
      // the new invitee "accepted" on arrival, holding someone else's old password.
      await revokeSecret(env, email, tctx);
      const token = await mintInvite(tctx, env, email);
      commitRoster();
      // Tell the control plane's account store this person now belongs here, so the
      // cross-workspace switcher lists this workspace for them. Best-effort, off the
      // critical path — see noteMembershipUpstream.
      noteMembershipUpstream(env, ctx, tctx, { email, verb: "joined", label: workspaceLabel });
      // One record, not two: ask the deploy shell to commit this person to the
      // identity file. The overlay entry above made them live NOW; the file commit
      // (and the config push its deploy sends back) makes them durable — at which
      // point the overlay entry drains itself. Best-effort by design: the invite
      // already succeeded, so a failed dispatch is reported, never fatal.
      const fileSync = await shellDispatch(env, "roster-update", {
        action: "add",
        user: { email, name, initials: roster.add[email].initials, color: roster.add[email].color, role },
        by: me.email,
      });
      const mail = await mailLink(email, "roster-invite", token, { inviter: me.name || me.email });
      return jsonResponse({ ok: true, email, url: link(token), fileSync, mail });
    }

    // Change someone's role. The thing an operator actually reaches for, and the thing
    // that did not exist: until now the only way was remove-and-re-invite, which loses
    // their password and their history, and still could not produce a viewer.
    // Membership: add someone to a space, change their role there, or drop them from
    // it. {op:"space", email, space, role}; role:null removes them from that space.
    // Authority is checked against the SPACE being changed, never the global role —
    // per-space roles are worth nothing if the power to set them is not scoped too.
    if (kind === "space") {
      const u = userByEmail(op.email, users);
      if (!u) return jsonResponse({ error: "unknown-user" }, 400);
      const sid = String(op.space || "");
      if (!spaces.some((s) => s.id === sid)) return jsonResponse({ error: "unknown-space" }, 400);
      if (roleIn(me, sid) !== "admin") return jsonResponse({ error: "forbidden" }, 403);
      const role = op.role === null ? null : (ROLES.includes(op.role) ? op.role : null);
      if (op.role != null && role === null) {
        return jsonResponse({ error: "bad-role", roles: ROLES }, 400);
      }
      const email = lcEmail(u.email);
      // Losing this space's last admin is the lockout nobody can undo from in-app —
      // the same trap roles.test.mjs guards instance-wide, one level down.
      const demoting = roleIn(u, sid) === "admin" && role !== "admin";
      if (demoting && lastAdminOf(users, sid, email)) {
        return jsonResponse({ error: "last-admin", message: "This is the only admin of this space." }, 409);
      }
      const index = await readSpaces(env, tctx);
      // An absent entry means "every space" (see USER_SPACES_KEY), so the first write
      // for someone must SPELL OUT the spaces they already had — otherwise granting
      // one space silently removes every other.
      const current = index[email] && typeof index[email] === "object" && !Array.isArray(index[email])
        ? index[email]
        : Object.fromEntries(spaces.map((s) => [s.id, roleOf(u)]));
      const next = { ...current };
      if (role === null) delete next[sid]; else next[sid] = role;
      index[email] = next;
      await kv.put(USER_SPACES_KEY, JSON.stringify(index));
      // The next request re-reads THIS workspace's overlay, so the panel sees its own write.
      bustRosterOverlay(tctx.tenantId); cfgAt = 0;
      return jsonResponse({ ok: true, email, space: sid, role });
    }

    if (kind === "role") {
      const u = userByEmail(op.email, users);
      if (!u) return jsonResponse({ error: "unknown-user" }, 400);
      const role = op.role;
      if (!ROLES.includes(role)) return jsonResponse({ error: "bad-role", roles: ROLES }, 400);
      const email = lcEmail(u.email);
      // The overlay is what takes effect, so it — not the caller's user list — is what
      // "their current role" means. Those two disagree for a whole config tick after
      // any change, and reading the stale one would report a real change as a no-op and
      // skip the write (and the token revocation that rides with it).
      const overlay = await readRoles(env, tctx);
      const from = ROLES.includes(overlay[email]) ? overlay[email] : roleOf(u);
      if (from === role) return jsonResponse({ ok: true, email, role, unchanged: true });

      // The lockout an instance cannot recover from in-app. There is no break-glass:
      // every admin route, the panel itself and the star-scope token all require an
      // admin, so an instance with none needs a redeploy of identity.json to come back.
      // Counted over the LIVE roster, so it sees config users and overlay users alike.
      if (from === "admin") {
        const effective = (x) => {
          const o = overlay[lcEmail(x.email)];
          return ROLES.includes(o) ? o : roleOf(x);
        };
        const admins = users.filter((x) => effective(x) === "admin").length;
        if (admins <= 1) {
          return jsonResponse({
            error: "last-admin",
            message: "This is the only admin. Promote someone else first — an instance with no admin cannot be fixed from inside it.",
          }, 409);
        }
      }

      // Write the overlay, or DRAIN it when identity.json already agrees: a change back
      // to what the file says needs no overlay entry, and leaving one behind would
      // quietly override the file forever after.
      const configRole = (() => {
        const c = userByEmail(email, configUsers);
        return c ? roleOf(c) : null;
      })();
      if (configRole === role) {
        await clearRole(tctx, env, email);
      } else {
        overlay[email] = role;
        await kv.put(USER_ROLES_KEY, JSON.stringify(overlay));
        await mirrorRosterDocs(tctx, env, { roles: overlay });
      }
      // Keep the roster overlay honest too, for an invited (non-config) user — the
      // roles overlay is what takes effect, but two records disagreeing about the same
      // person is how the next reader gets it wrong.
      const roster = await readRoster(env, tctx);
      if (roster.add[email]) {
        roster.add[email].role = role;
        await kv.put(USER_ROSTER_KEY, JSON.stringify(roster));
        await mirrorRosterDocs(tctx, env, { roster });
      }

      // A demotion must not leave the privilege behind in a token. Losing admin drops
      // the star-scope token; becoming a viewer drops every publish token they hold,
      // because a viewer may hold none at all. publishAuth re-checks both at resolve
      // time as well — this is the immediate half, that one is the durable half.
      if (role === "viewer") await revokePublishTokens(tctx, env, email);
      else if (from === "admin") await revokePublishTokens(tctx, env, email);

      // This isolate's roster on its next request, everywhere within ROSTER_TTL_MS —
      // through the same two statements as invite/remove, and for the same reason there
      // is no third one writing the module slot here either (see commitRoster).
      commitRoster();

      // identity.json stays the durable record: ask the shell to commit the new role,
      // and the config push its deploy sends back drains the overlay entry above.
      // Best-effort, like invite and remove — the change already took effect.
      const fileSync = await shellDispatch(env, "roster-update", {
        action: "role",
        user: { email, name: u.name, initials: u.initials || "", color: u.color || "", role },
        email, role, by: me.email,
      });
      return jsonResponse({ ok: true, email, role, from, fileSync });
    }

    // Remove = drop from the overlay AND revoke the credential (see the roster notes:
    // the tombstone, not the list, is what actually keeps them out).
    if (kind === "remove") {
      const u = userByEmail(op.email, users);
      if (!u) return jsonResponse({ error: "unknown-user" }, 400);
      const email = lcEmail(u.email);
      if (email === lcEmail(me.email)) return jsonResponse({ error: "cannot-remove-self" }, 400);
      const roster = await readRoster(env, tctx);
      delete roster.add[email];
      // Only a CONFIG user needs a tombstone in the list — dropping the add entry is
      // enough for an invited one, and an unbounded remove list would grow forever.
      if (userByEmail(email, configUsers) && !roster.remove.some((e) => lcEmail(e) === email)) {
        roster.remove.push(email);
      }
      await kv.put(USER_ROSTER_KEY, JSON.stringify(roster));
      await mirrorRosterDocs(tctx, env, { roster });
      // The CANONICAL address, not the lowercased key: effectiveSecret looks the
      // tombstone up by u.email exactly, so a case-folded key would miss it and fall
      // through to the config roster's legacy `pass`.
      await revokeSecret(env, u.email, tctx);     // kills their session too (cookies bind to it)
      await revokePublishTokens(tctx, env, email); // and any publish token they minted via `augur login`
      await revokeInvitesFor(tctx, env, email);   // an outstanding link must not let them back in
      try { await clearAvatar(tctx, env, email); } catch (e) {} // their face leaves the index too
      try { await clearName(tctx, env, email); } catch (e) {}   // …and so does their chosen name
      // A re-invited address must not inherit the last person's role — least of all admin.
      try { await clearRole(tctx, env, email); } catch (e) {}
      // …nor their spaces, least of all one they administered.
      try { await clearSpaces(env, email, tctx); } catch (e) {}
      try { await kv.delete(LASTSEEN_PREFIX + u.email); } catch (e) {}
      // …and the first-run record: a re-invited address is a new person to the
      // workspace, so they get the first-run surface again.
      try { await clearFirstRunSeen(kv, u.email); } catch (e) {}
      // …and from the object, where the family is now read. Both, for revokeInvitesFor's
      // reason: a stamp left in one store comes back the moment the other is the answer.
      try {
        const identLs = identityFor(env, tctx, "lastseen");
        if (identLs) await identLs.lastseenForget(u.email);
      } catch (e) {}
      commitRoster();
      // Symmetric to invite: tell the account store this person no longer belongs here,
      // so the switcher stops listing this workspace for them. Best-effort, off the
      // critical path — see noteMembershipUpstream.
      noteMembershipUpstream(env, ctx, tctx, { email, verb: "left" });
      // Symmetric to invite: the identity file should stop naming them too. The
      // tombstone above is the security boundary either way — this only keeps the
      // durable record honest.
      const fileSync = await shellDispatch(env, "roster-update", { action: "remove", email, by: me.email });

      // REMOVAL IS NOT ERASURE, and conflating them would be wrong in both directions.
      // Everything above revokes access; none of it touches what this person's name is
      // still attached to. A removed colleague normally SHOULD stay named on the comments
      // they wrote, because the thread is a record other people are part of.
      //
      // `purge: true` is the erasure request, asked for explicitly, and it is a distinct
      // decision because it edits a shared record. The result rides back on the same
      // response rather than throwing: the removal itself already succeeded, and an
      // erasure that could not complete must be visible rather than swallowed.
      let purge;
      if (op && op.purge === true) {
        try { purge = await purgeUser(overlayFor(env, tctx), identityFor(env, tctx, "lastseen"), kv, users, email); }
        catch (e) { purge = { ok: false, reason: "failed", detail: String((e && e.message) || e).slice(0, 200) }; }
        // Publish history is the OTHER place an address is stored, and it is the one that
        // is readable before the gate: /_build.json is public, and it derives what it
        // shows from these records. Reported separately because the two sweeps touch
        // different stores and either can fail on its own — an erasure that half happened
        // has to say which half.
        try {
          const sid = (tctx.SPACES.find((sp) => sp.default) || tctx.SPACES[0] || {}).id;
          purge.provenance = sid ? await redactProvenance(env, sid, email, tctx && tctx.tenantId) : { ok: false, reason: "no-space" };
        } catch (e) {
          purge.provenance = { ok: false, reason: "failed", detail: String((e && e.message) || e).slice(0, 200) };
        }
      }
      return jsonResponse({ ok: true, email, fileSync, ...(purge ? { purge } : {}) });
    }

    // Backfill: notify the account store of every CURRENT member, one "joined" each — for
    // a workspace whose memberships predate `noteMembershipUpstream` existing at all.
    // Idempotent by construction: the account store's own `at`-CAS makes a repeat notify
    // for someone already listed a no-op there, so running this twice, or against a
    // roster that has not changed, costs nothing beyond the calls themselves. Every
    // notify is fire-and-forget (see noteMembershipUpstream), so this returns as soon as
    // the calls are QUEUED, not once the account store has answered.
    if (kind === "reconcile-membership") {
      let notified = 0;
      for (const u of users) {
        if (!u || !u.email) continue;
        noteMembershipUpstream(env, ctx, tctx, { email: u.email, verb: "joined", label: workspaceLabel });
        notified++;
      }
      return jsonResponse({ ok: true, notified });
    }

    return jsonResponse({ error: "unknown-op" }, 400);
  }

  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// /__review/api/export?key=<REVIEW_EXPORT_KEY> — all comment threads.
// Secret-guarded so tooling can read review data WITHOUT the site password.
//   GET  → { pages, generatedAt }
//   POST → apply a moderation op ({ path, op:"resolve"|"delete", id, resolved })
//          to one page's threads and return that page's updated threads. This lets
//          CLI tooling resolve/close threads without the site password.
async function reviewExport(tctx, request, url, env) {
  const secret = env.REVIEW_EXPORT_KEY;
  if (!secret) return jsonResponse({ error: "export-disabled" }, 404);
  const given = url.searchParams.get("key") || request.headers.get("X-Review-Key") || "";
  if (given.length !== secret.length || given !== secret) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  const store = overlayFor(env, tctx);
  if (!store) return jsonResponse({ pages: {}, warning: "no-kv-binding" });

  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const path = clamp(op && op.path, 600);
    if (!path) return jsonResponse({ error: "missing-path" }, 400);
    const threads = await store.mutate("comments", "", path,
      (cur) => applyOp(tctx.USERS, Array.isArray(cur) ? cur : [], op));
    return jsonResponse({ path, threads });
  }

  // Every page's threads, in one call. It was a hand-rolled cursor loop here and another
  // in the purge sweep; the accessor owns the shape now, and on the workspace store it is
  // one SELECT rather than a listing.
  const pages = await store.read("comments");
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
// The two documents, named here so the KV keys a live instance already holds are readable
// in the place that explains them. The accessor composes the same strings from the `piti`
// family's `keyed` layout — see OVERLAY_KV_KEYS — and a test pins that they match.
const PITI_VIEW_KEY = "pt:view";
const PITI_REMARKS_KEY = "pt:remarks";
// Per-isolate poll cache — see the GET remarks path in pitiApi.
//
// KEYED BY WORKSPACE, for the same reason the canvas registry above is. The value is one
// workspace's queued remarks — the text an agent wrote for that workspace's pages — and
// the poll that reads it is an OPEN route, taken at an early exit in fetch() before the
// gate, because the cat lives on public prototypes that carry no cookie. A single slot
// therefore reads one workspace's queue once and reads it aloud to every workspace behind
// it for the rest of the TTL, without touching their keys at all. Bounded and evicted the
// same way: an evicted workspace re-reads its own document.
const PITI_REMARKS_TTL_MS = 15_000;
const PITI_REMARKS_CACHE_MAX = 256;
// tenantId -> { at, list }
const PITI_REMARKS = tenantCache("piti-remarks", { max: PITI_REMARKS_CACHE_MAX });

// A remark or a clear making itself visible on the next poll, for ITS workspace only.
function bustPitiRemarks(tenantId) {
  PITI_REMARKS.bust(tenantId);
}

// Takes the CONTEXT, for two reasons that used to be one. The cache above is keyed by
// workspace, and the overlay accessor decides between the workspace's own store and the
// instance's KV — neither of which a binding alone can answer.
//
// The two documents are the `piti` family, whose KV layout is one document PER key
// (`pt:view`, `pt:remarks`) rather than one holding a map: they are two unrelated
// singletons that happen to share a prefix, and pretending otherwise would put the view
// on the wire on every poll of the remarks.
async function pitiApi(tctx, request, url, env) {
  const tenantId = tctx && tctx.tenantId;
  const store = overlayFor(env, tctx);
  if (!store) return jsonResponse({ warning: "no-kv-binding" });
  const secret = env.REVIEW_EXPORT_KEY;
  const given = url.searchParams.get("key") || request.headers.get("X-Review-Key") || "";
  const authed = !!secret && given.length === secret.length && given === secret;

  if (request.method === "GET") {
    // Agent reads what the user is looking at (secret-guarded — it's a peek at activity).
    if (url.searchParams.get("type") === "view") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      return jsonResponse({ view: await store.readKey("piti", "", "view") });
    }
    // Browser polls the quips queued for its page (open). since=<last id seen>.
    // Cached per isolate: every poll is a KV read on the daily quota, and open tabs
    // keep whatever cadence their loaded piti.js shipped with — this cache is the
    // only lever that reaches a stale tab (2026-08-20 quota outage). Remark/clear
    // writes bust it, so delivery stays inside one client poll interval. A throwing
    // KV serves the last-read list (the stamp is NOT advanced — recovery retries
    // next poll), or empty — never a 500 at the cat.
    const path = clamp(url.searchParams.get("path") || "/", 600);
    const since = Number(url.searchParams.get("since")) || 0;
    const cur = PITI_REMARKS.entry(tenantId, () => ({ at: 0, list: null }));
    if (!cur.at || Date.now() - cur.at >= PITI_REMARKS_TTL_MS) {
      try {
        cur.list = await store.readKey("piti", "", "remarks");
        cur.at = Date.now();
      } catch (e) { /* keep the last good list; the stamp is NOT advanced, so the next poll retries */ }
    }
    const all = Array.isArray(cur.list) ? cur.list : [];
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
      await store.set("piti", "", "view", view);
      return jsonResponse({ ok: true });
    }

    // Agent posts a quip for the cat to deliver (secret-guarded so only the wingman,
    // never a random visitor, can put words in the cat's mouth).
    if (body && body.type === "remark") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      const path = clamp(body.path, 600);
      const text = clamp(body.text, 220);
      if (!path || !text) return jsonResponse({ error: "bad-input" }, 400);
      const stored = await store.readKey("piti", "", "remarks");
      let all = Array.isArray(stored) ? stored : [];
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
      await store.set("piti", "", "remarks", all);
      bustPitiRemarks(tenantId);
      return jsonResponse({ ok: true, id: all[all.length - 1].id });
    }

    // Agent wipes the queue at the start of a fresh wingman session (secret-guarded).
    if (body && body.type === "clear") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      await store.set("piti", "", "remarks", []);
      bustPitiRemarks(tenantId);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "bad-input" }, 400);
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ── Per-request log line ──────────────────────────────────────────────────────
//
// This worker had no logging at all. One structured line per request, and the field that
// makes it worth having is `tenant`: once one deployment serves several workspaces, an
// error rate, a 500 or a burst of 404s means nothing until you can say WHOSE it was, and
// a log you have to correlate by hand at 3am is a log you do not read.
//
// It is JSON on one line so it groups and filters as data rather than as prose.
//
// WHAT IT DELIBERATELY DOES NOT CARRY. Never the query string: publish and review paths
// carry bearer tokens and export secrets there, and a log is a place secrets go to be
// kept. Never a cookie, never a body, never an address. The PATH is instance content
// (prototype folder names) and stays, because a log that cannot say which page 500ed
// cannot be acted on — it is capped so one long URL cannot dominate a line.
//
// It never throws. A logger that can fail the request it is describing is a worse
// availability risk than having no logs, so the whole thing sits inside a try/catch that
// discards its own errors.
function logRequest(trace, request, url, status, ms, err) {
  try {
    const line = {
      tenant: trace.tenant || "-",
      status,
      method: request.method,
      path: url.pathname.slice(0, 200),
      ms,
    };
    if (err) {
      line.level = "error";
      line.error = String((err && err.message) || err).slice(0, 300);
    }
    console.log(JSON.stringify(line));
  } catch { /* a logger may never break a response */ }
}

/**
 * ⚠️ THE CRON LIVES HERE AND NOT IN src/entry.js, deliberately.
 *
 * entry.js is an export manifest and `test/worker-entry.test.mjs` reads its source to keep
 * it one: no `await`, no branch, no Response, and its default export must BE this object
 * rather than a copy. A `scheduled` handler written there would also be invisible to every
 * test in this repo, because they all drive src/_worker.js. Hanging it off this object
 * instead means entry.js re-exports it unchanged and the tests can reach it.
 *
 * ⚠️ IT NEVER RUNS ON A PAGES INSTANCE, which is every instance today. Pages has no cron
 * triggers, so this property is inert there — and inert is the right shape: identical code
 * on both front doors, with the platform deciding whether it fires, rather than two
 * codebases that drift.
 *
 * It also does not fire on a Worker instance until that instance's wrangler.toml declares
 * a `[triggers] crons` entry. None does. So this ships dark, twice over.
 */
async function runScheduledHealth(env) {
  // ⚠️ IT DOES NOT CALL resolveTenant, and it must not: `scripts/one-tenant-resolver.mjs`
  // fails the build on a second call site, and the reason is exactly this shape of caller.
  // A cron has no request, so it has no Host, so on a deployment that tells workspaces
  // apart BY Host there is no one workspace for it to check — and inventing one would be a
  // second answer to the question the whole isolation model is keyed on. So it declines,
  // out loud, rather than checking somebody's workspace at random.
  const suffix = env && typeof env.TENANT_HOST_SUFFIX === "string" ? env.TENANT_HOST_SUFFIX : "";
  if (suffix.trim()) {
    return {
      at: new Date().toISOString(), ok: true, failures: 0, stored: false,
      checks: [{
        name: "health cron", skip: true,
        detail: "this deployment resolves workspaces by hostname and a cron has no hostname, so there is no single workspace to check. Per-workspace checks belong to a job that holds the workspace list.",
      }],
    };
  }
  const tenantId = (await readInstanceTenantId(env)) || DEFAULT_TENANT_ID;
  const tctx = await loadConfig(tenantId, env);
  // No context means the config read failed, and the honest report is that one — not a
  // health report computed from nothing, which would read as an all-clear.
  const stamp = tctx && bundleMode(env)
    ? synthBuildStamp(tctx, await loadManifests(tenantId, env, true))
    : null;
  const report = await runHealth({ stamp });
  const kv = kvFor(env);
  // A report nobody can read is not a check. If there is nowhere to put it, say so in the
  // log rather than failing the cron: a thrown scheduled handler retries and re-runs every
  // check, and the thing that could not be written still cannot be.
  if (!kv) return { ...report, stored: false, why: "no store bound" };
  try {
    await kv.put(HEALTH_REPORT_KEY, JSON.stringify(report));
    return { ...report, stored: true };
  } catch (e) {
    return { ...report, stored: false, why: String((e && e.message) || e).slice(0, 200) };
  }
}

export default {
  /**
   * Cloudflare reads `scheduled` off this object. See runScheduledHealth above for why it
   * is here rather than in entry.js, and why it is inert on every instance today.
   */
  async scheduled(event, env, ctx) {
    const out = await runScheduledHealth(env);
    // One line, the same shape the request log uses, because the only place a cron's
    // result can surface without a request is the log.
    try {
      console.log(JSON.stringify({ t: "health", at: out.at, ok: out.ok, failures: out.failures, stored: out.stored }));
    } catch (e) { /* a log line must never fail the run it describes */ }
  },

  async fetch(request, env, ctx) {
    // The thin wrapper exists so the log line sees the STATUS. handleRequest has dozens of
    // early returns and wrapping each one would be a change to every route; wrapping the
    // whole thing is one place that cannot fall out of date. `trace` is how the tenant
    // comes back out — it is resolved deep inside, after the /__config refusal, which is
    // deliberately context-free and must stay ahead of it.
    const t0 = Date.now();
    const trace = { tenant: "" };
    const url = new URL(request.url);
    let res;
    try {
      res = await handleRequest(request, env, ctx, url, trace);
    } catch (err) {
      logRequest(trace, request, url, 500, Date.now() - t0, err);
      throw err;
    }
    logRequest(trace, request, url, res.status, Date.now() - t0, null);
    return res;
  },
};

async function handleRequest(request, env, ctx, url, trace) {

    // Runtime config is data served alongside the assets, for the worker's own
    // reads only — instance.json carries the user list. Reject external requests
    // BEFORE any asset serving, unconditionally (even in open/legacy mode).
    if (url.pathname === "/__config" || url.pathname.startsWith("/__config/")) {
      // Context-free by construction: the refusal predates the resolve, so there is no
      // workspace to answer for and it does not reach for one. See configSealedResponse —
      // this used to render the branded 404 out of the module slot, i.e. out of whichever
      // workspace this isolate loaded last.
      return configSealedResponse();
    }

    // Which workspace this request belongs to — resolved ONCE, here, before anything
    // reads config, and passed down from this point on. The only call site: see
    // scripts/one-tenant-resolver.mjs, which fails the build if a second one appears.
    // (The /__config refusal above comes first because it is the same answer for every
    // workspace and costs no read.)
    const { tenantId } = await resolveTenant(request, env);
    trace.tenant = tenantId; // the one field the log line exists for
    // Null means the hostname names no workspace, which only a multi-workspace deployment
    // can say. Refuse HERE, before the config load — there is no workspace to load config
    // for, and every branch below assumes there is one.
    if (!tenantId) return unknownHostResponse();

    // ── the suspension ────────────────────────────────────────────────────────
    // BEFORE the config load, because a paused workspace should not read its own store to
    // find out it is paused, and the page a visitor sees needs nothing from it. One list,
    // read once — see SUSPENDED_ALLOWED for what still answers and why it is the promise
    // the lifecycle page makes rather than a convenience. Costs a single-workspace
    // instance nothing: no TENANTS binding, no question.
    //
    // The answer is kept past this block for ONE reason: sign-in is on the allow list, and
    // a dormancy suspension is documented to lift on an admin's first successful one. See
    // resumeAfterDormancy at the /__auth handler — nothing else below reads it, and nothing
    // else should, because a decision taken from this value is taken from a cached copy.
    let paused = null;
    if (env && env.TENANTS) {
      // Assigned, never re-declared: `paused` is the outer `let` above, because the
      // /__auth handler reads this same answer to lift a dormancy suspension.
      paused = await readSuspension(tenantId, env);
      // ── the address that is not this workspace's address any more ───────────
      // A rename is a CUT-OVER, not a redirect: this hostname answers exactly what a
      // hostname naming no workspace answers, byte for byte, and it never says where the
      // workspace went. Three reasons it is this and not a 301-then-404, all of which the
      // confirmation copy states before anybody presses the button:
      //   · a workspace address is generated and unguessable, so the usual reason to change
      //     one is that it reached somebody it should not have — a forwarder hands that
      //     person the new one, which undoes the change for the only person it was made for;
      //   · a redirect keeps the old address alive in links and search results for years, so
      //     the address is never really given up and the retirement means less than it says;
      //   · "clean redirect then 404 later" is two promises, and the second one is kept by a
      //     future deploy nobody has scheduled. One promise, kept immediately, is smaller and
      //     true.
      // Before the suspension branch, because a moved address is not a pause and has no
      // allow-list: nothing answers here, not sign-in and not the export. Both still run at
      // the workspace's own address, which is where its members are.
      if (paused && paused.moved) return unknownHostResponse();
      // `undefined` is "this isolate has never managed to read the flag". It refuses, and
      // that is the one degradation in this file that shuts a door instead of opening one.
      // The gate keys on `suspended`, not on the doc existing: the same read now also
      // carries `canonicalHost` for a claimed-but-live workspace, and a claim is not a pause.
      if (paused === undefined || (paused && paused.suspended)) {
        if (!isAllowedWhileSuspended(request, url)) {
          if (wantsJson(request, url)) return suspensionRefusal();
          // ⚠️ A MEMBER SEES THE REASON; A STRANGER DOES NOT. Proving membership costs a
          // config read and a cookie check, and it is paid ONLY when a session cookie is
          // actually present — so a stranger, a crawler and a link in a chat still cost this
          // paused workspace nothing at all, which is the property the check was placed above
          // the config load for. See suspensionPage/memberSuspensionBody.
          const forMember = hasSessionCookie(request)
            ? await isPausedWorkspaceMember(request, env, tenantId)
            : false;
          return suspensionPage(paused === undefined ? null : paused, forMember);
        }
      }
      // ── the claimed hostname ─────────────────────────────────────────────────
      // `B-claim-platform-subdomain`. A workspace with a claimed canonical hostname keeps
      // its generated address WORKING — decided, never freed — and the generated address
      // sends browsers on: a 302 preserving path and query, so every link ever published
      // keeps landing where the workspace now lives. Three deliberate narrowings:
      //   · GET/HEAD only. A redirected POST loses its body (302) or its Authorization
      //     header (cross-origin 307), so a write is served where it was aimed.
      //   · Never a path under `/_`. That is the machine surface — /__publish, /__auth,
      //     /_build.json and the rest — and publish tokens, probes and CI hold the
      //     generated origin in config; the programmatic surface answers in place so no
      //     stored origin breaks on the day of a claim.
      //   · Same read as the suspension, so a claim costs the front door nothing new; a
      //     suspension outranks it (the holding page serves wherever it is asked).
      if (paused && paused.canonicalHost && (request.method === "GET" || request.method === "HEAD")
          && !url.pathname.startsWith("/_")) {
        const canonical = normalizeHost(paused.canonicalHost);
        const reqHost = normalizeHost(request.headers.get("host"));
        if (canonical && reqHost && reqHost !== canonical) {
          return Response.redirect(`https://${canonical}${url.pathname}${url.search}`, 302);
        }
      }
    }
    // ONE context for this request, for THAT workspace, built here and handed down.
    // `tctx` is the config half of the request — users, prefixes, versions, the gate's
    // flag — as a single frozen value, and from here on the router reads it and nothing
    // else. There is no module binding left to reach for: `scripts/no-tenant-globals.mjs`
    // allowlists no config field at all, so declaring one fails the build rather than
    // giving one route an answer this context does not agree with.
    //
    // Note what is NOT here: no second resolve, and no config read that picks its own
    // workspace. Everything below is downstream of these two lines.
    const tctx = await loadConfig(tenantId, env);
    // No context means the config for THIS workspace could not be read and this isolate
    // has no recent good copy of it. Refuse here, before a single route runs: every
    // decision below — who is signed in, which paths are public, which store to serve
    // from — is a config question, and answering it from the empty defaults would answer
    // it the way a raw build with no identity answers it, which is "open".
    if (!tctx) return configUnavailableResponse();

    // ── the migration freeze ──────────────────────────────────────────────────
    // Checked here rather than at each write route, so "what does a freeze stop" is
    // answerable by reading one list. Only for requests that would WRITE, so a frozen
    // workspace costs a reader nothing at all — see FROZEN_WRITES.
    if (isFrozenWrite(request, url)) {
      const freeze = await readFreeze(tctx, env);
      if (freeze) return freezeRefusal(freeze);
    }

    // Direct-publish API — self-authed (bearer tokens), before the gate like
    // the other tooling routes.
    // Device pairing rides alongside the publish API but is NOT part of it: two of its
    // three routes are unauthenticated, and it answers null when the instance has not
    // opted in, so the request falls through to the ordinary 404 rather than a 403 that
    // would advertise a flow to come back for.
    // The approval page. Gated like any other page — this is the one place the flow WANTS
    // an authenticated browser — and absent entirely when the instance has not opted in.
    if (url.pathname === "/__connect" && tctx.DEVICE_PAIRING) {
      const who = tctx.USERS.length ? await identify(request, env, tctx.USERS, { sessionKeys: tctx.SESSION_KEYS, tctx }) : null;
      if (!who && tctx.USERS.length) return htmlResponse(loginPage(tctx, "/__connect", false, url.href), 200);
      return htmlResponse(connectPage(tctx, who), 200);
    }
    if (url.pathname.startsWith("/__publish/_pair/")) {
      // Identity is resolved here rather than reusing the gate's `me` below, because this
      // route runs BEFORE the gate — the same early-exit shape /__version and the review
      // export use. `usersActive` is not in scope yet either; on an instance with no
      // roster there is nobody to approve, and approve is the only step that needs one.
      const who = tctx.USERS.length ? await identify(request, env, tctx.USERS, { sessionKeys: tctx.SESSION_KEYS, tctx }) : null;
      const paired = await pairApi(tctx, request, url, env, who);
      if (paired) return paired;
    }
    if (url.pathname.startsWith("/__publish/")) return publishApi(tctx, request, url, env);

    // In bundle mode the public build stamp is synthesized from the live
    // manifests — same shape and contract as the static file Pages serves.
    if (url.pathname === "/_build.json" && bundleMode(env)) {
      return jsonResponse(synthBuildStamp(tctx, await loadManifests(tctx.tenantId, env)));
    }

    // Vanity domains (from the deploy config): a host CNAME'd to this
    // Pages project + added as a custom domain runs this worker. DNS can't target
    // a path, so land each such host's root on its configured page. Scoped to the
    // exact hosts in the map — never affects pages.dev or any other domain.
    const vanityPath = tctx.VANITY_REDIRECTS[url.hostname];
    if (vanityPath && (url.pathname === "/" || url.pathname === "")) {
      return Response.redirect(`https://${url.hostname}${vanityPath}`, 302);
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
      return new Response(p ? versionFor(tctx, p) : tctx.BUILD_ID, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // Review export bypasses the password gate (its own secret guards it).
    if (url.pathname === "/__review/api/export") return reviewExport(tctx, request, url, env);

    // Piti live channel bypasses the gate too: the cat lives on PUBLIC prototypes
    // (no cookie), so browser reads/view-writes are open; agent ops self-guard with
    // the export secret. Same early-exit shape as /__version and the review export.
    if (url.pathname === "/__piti") return pitiApi(tctx, request, url, env);

    // Platform MCP proxy — public prototypes call the platform through their own
    // origin (the platform's Bearer token is the real auth; see mcpProxy).
    if (url.pathname.startsWith("/__mcp/")) return mcpProxy(tctx, request, url);

    const expected = env.SITE_PASSWORD;
    const usersActive = tctx.USERS.length > 0;
    // Resolve identity once (identity mode); null in legacy/open mode.
    const me = usersActive ? await identify(request, env, tctx.USERS, { sessionKeys: tctx.SESSION_KEYS, tctx }) : null;
    // Is this request past the gate? identity mode → a known user; legacy → the
    // shared-password cookie; neither configured → open (raw/local build, no gate).
    let authed;
    if (usersActive) authed = !!me;
    else if (expected) {
      const token = await tokenFor(expected);
      const cookies = request.headers.get("Cookie") || "";
      authed = cookies.split(/;\s*/).some((c) => c === `${COOKIE}=${token}`);
    } else {
      // No users AND no shared password. Genuinely open ONLY when this instance has no
      // config source at all (offline / raw engine build). A real deployment — BUNDLES
      // or ASSETS bound — that has not yet loaded its config must FAIL CLOSED: a cold
      // isolate whose first config read failed would otherwise serve the whole gated
      // site open until the next 1.5s tick. Once config loads (even with an empty user
      // list, an intentionally-open instance), CONFIG_LOADED flips and this opens.
      const expectsConfig = !!(env && (env.BUNDLES || env.ASSETS));
      authed = expectsConfig ? tctx.CONFIG_LOADED : true;
    }

    // The canvas insert-picker catalog and the session-music list: merged from every
    // space's routing fragment rather than served as files, because they are the only two
    // site-wide aggregates and no single publisher can own one (see canvasAggregate).
    // Both answer without a login, so a shared board renders for a signed-out viewer —
    // but the catalog is served EMPTY to one, because the full list is a directory of
    // every URL on the site. Dispatched here, just after `authed` resolves and before any
    // gate enforces anything, so it stays reachable to everyone either way.
    if (url.pathname === "/__canvas/catalog.json") return canvasAggregate(tctx, "catalog", authed);
    if (url.pathname === "/__canvas/tracks.json") return canvasAggregate(tctx, "tracks", !usersActive || !!(me && me.role === "admin"));

    // Who am I — the sidebar profile chip and the comment overlay read this. Open
    // (returns {user:null} when signed out) so the chip can decide what to render.
    // Doubles as the "last seen" heartbeat: it fires once per page view.
    // `accounts` tells a client whether this deployment HAS user accounts at all, so
    // {user:null} can be read correctly: signed out (accounts:true) vs an instance
    // with no user list, where everyone is the operator (accounts:false).
    if (url.pathname === "/__me") {
      if (me && ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(tctx, env, me));
      // The workspace's own activity clock, which is a different question from the
      // person's: the dormancy policy asks whether the WORKSPACE is being used, and this is
      // half of that answer (the other half is a publish, below).
      if (me) touchWorkspaceActivity(env, tctx, ctx);
      // `spaces` is the switcher's whole input. The rail ships every space's row in the
      // HTML (build time cannot know the viewer), so the rows are hidden until this
      // answer names them — which means a signed-out visitor is told nothing at all.
      return jsonResponse({
        user: publicUser(me), accounts: usersActive,
        spaces: me ? meSpaces(me, tctx.SPACES) : [],
      });
    }

    // A workspace's icon. Serving is ungated like /__avatar/ (the rail renders it on
    // the login page too, and the allowlist check inside stops hash-guessing); setting
    // it is admin-of-that-workspace only, re-checked inside spaceIconApi.
    if (url.pathname.startsWith("/__space-icon/")) {
      return serveSpaceIcon(tctx, env, url.pathname.slice("/__space-icon/".length));
    }
    if (url.pathname === "/__admin/space-icon") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return spaceIconApi(tctx.tenantId, request, env, me, tctx.SPACES, tctx);
    }

    // My own profile photo — set or clear. Ahead of the gate for the same reason
    // /__me is: the profile chip is chrome, and it must work on every page a signed-in
    // person can already see. meAvatarApi re-checks the session (401 without one).
    if (url.pathname === "/__me/avatar") return meAvatarApi(tctx.tenantId, request, env, me, tctx);

    // My own display name — same placement and the same reasoning as the photo route
    // above: chrome, ahead of the gate, re-checks the session itself (401 without one).
    if (url.pathname === "/__me/name") return meNameApi(tctx.tenantId, request, env, me, tctx);

    // My workspaces — the cross-workspace switcher's dropdown. Same placement as the
    // two routes above (chrome, ahead of the gate) and the same self-check (401 without
    // a session); best-effort against the control plane, never an error.
    if (url.pathname === "/__me/workspaces") return meWorkspacesApi(tctx, request, env, me);

    // Comment-author faces, same deal as /__me and /__avatar/ above: this route must
    // stay here, ahead of the auth gate, because intercepting first is what makes it
    // reachable without a session — there's no isPublicPath entry for it, and adding
    // one would be dead code the gate never sees.
    if (url.pathname === "/__people") {
      if (request.method !== "GET") return jsonResponse({ error: "method-not-allowed" }, 405);
      return peopleApi(url, tctx.USERS);
    }

    // A user's avatar image: either a self-set photo out of KV ("u/<hash>") or one
    // decoded from the identity list's data URI. Deliberately ungated in both cases:
    // presence chips on PUBLIC boards render it for everyone in the room.
    if (url.pathname.startsWith("/__avatar/")) {
      const key = url.pathname.slice("/__avatar/".length);
      if (key.startsWith(AVATAR_KV_PREFIX)) {
        return serveKvAvatar(tctx, env, key.slice(AVATAR_KV_PREFIX.length));
      }
      const u = tctx.USERS.find((x) => x.avatar && x.avatar.startsWith("data:") && avatarKey(x) === key);
      const m = u && /^data:([^;,]+);base64,(.*)$/.exec(u.avatar);
      if (!m) return new Response("Not found", { status: 404 });
      const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: {
          "Content-Type": m[1],
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // The first-run surface — where an invite redemption LANDS the first time, ever
    // (firstRunLanding decides, and records before it redirects). Dispatched ONLY when
    // the instance opted in: with FIRST_RUN off this branch does not exist and the path
    // answers exactly what it answered before the flag did. Self-guarding like /__me:
    // on a deployment with members, a stranger is bounced to "/" where the gate already
    // knows what to say.
    if (tctx.FIRST_RUN && url.pathname === FIRST_RUN_PATH) {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      if (usersActive && !me) {
        return new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store" } });
      }
      return htmlResponse(firstRunPage(tctx), 200);
    }

    // Sign out — clear the identity cookie and bounce home.
    if (url.pathname === "/__logout") {
      const out = new Headers({ Location: "/", "Cache-Control": "no-store" });
      out.append("Set-Cookie", `${USER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      // ⏳ MIGRATION WINDOW — clear every older name too. Sign-out has to reach the cookie
      // the browser is actually holding, or a session issued before a rename survives its
      // own sign-out. Delete this loop with LEGACY_USER_COOKIES.
      for (const name of LEGACY_USER_COOKIES) {
        out.append("Set-Cookie", `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      }
      return new Response(null, { status: 303, headers: out });
    }

    // Admin users/passwords API — admin-only (adminUsersApi re-checks me.role).
    if (url.pathname === "/__admin/users") {
      return adminUsersApi(tctx, request, url, env, me, undefined, undefined, undefined, ctx);
    }

    // Admin publish-token API — mint/list/revoke per-space publish tokens.
    if (url.pathname === "/__admin/tokens") return adminTokensApi(request, env, me, tctx);

    // Admin bundle-store gauge — bytes/objects vs the free-tier ceiling.
    if (url.pathname === "/__admin/storage") return adminStorageApi(tctx.tenantId, env, me);

    // Settings panel's "Custom URL" field — a claimed workspace's platform hostname.
    if (url.pathname === "/__admin/custom-domain") return adminCustomDomainApi(tctx.tenantId, env, me);

    // Admin KV export — the other half of durability, next to `augur export`.
    if (url.pathname === "/__admin/backup") return adminBackupApi(env, me);

    // Engine version + update-available nudge (the profile chip's fetch).
    if (url.pathname === "/__admin/version") return adminVersionApi(tctx, env, me);

    // The last thing the health cron wrote. Admin-only, and deliberately a READ: it never
    // runs the checks, because a health check that only ever runs when somebody looks at it
    // is not a check, and a page that could trigger one would make the two states — "the
    // cron is dead" and "nobody has opened this page" — indistinguishable. An absent report
    // says exactly that, in words, rather than answering 404 and letting an operator read
    // it as "healthy".
    if (url.pathname === "/__admin/health") return adminHealthApi(env, me);

    // Invite redemption is reachable WITHOUT a session — that is the whole point.
    if (url.pathname === "/__invite") {
      if (request.method === "GET") return inviteGet(tctx, url, env);
      if (request.method === "POST") return invitePost(tctx, request, url, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Cross-workspace hand-off redemption — reachable WITHOUT a session, like /__invite
    // just above, and for the same reason: it IS how a session gets minted. Already past
    // the suspension gate above (it is deliberately NOT on SUSPENDED_ALLOWED, the same
    // choice made for /__invite), so a paused workspace answers the suspension response
    // and never reaches this branch. GET only — a hand-off token rides the query string,
    // the switcher's own link shape. See enterHandoff for the trust model.
    if (url.pathname === WORKSPACE_ENTER_PATH) {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return enterHandoff(tctx, request, url, env);
    }

    // The space's own passwordless login — reachable WITHOUT a session, like /__enter and
    // /__invite above, because it IS how a session gets minted. POST only. The code path is
    // checked first (more specific), though both are exact matches. Inert when there is no
    // account store (`signinFromSpace`/`signinCodeSubmit` render the ordinary gate then).
    if (url.pathname === SIGNIN_CODE_PATH) {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return signinCodeSubmit(tctx, request, env);
    }
    if (url.pathname === SIGNIN_FROM_SPACE_PATH) {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return signinFromSpace(tctx, request, env);
    }

    // Login form submission.
    if (request.method === "POST" && url.pathname === "/__auth") {
      const form = await request.formData();
      const requested = (form.get("redirect") || "/").toString();
      // Reject scheme-relative ("//host") and backslash ("/\\host") targets too — both
      // start with "/" but navigate off-origin. A freshly-authenticated user landing on
      // an attacker page is prime credential-harvest bait.
      const redirect = /^\/($|[^/\\])/.test(requested) ? requested : "/";
      if (usersActive) {
        const email = form.get("email");
        const rlIds = loginRlIds(request, email);
        if (await loginThrottled(env, rlIds)) {
          return htmlResponse(loginPage(tctx, redirect, "Too many attempts. Wait a few minutes and try again.", url.href), 429);
        }
        if (await loginSlowed(env, rlIds)) await new Promise((r) => setTimeout(r, LOGIN_SLOW_MS));
        const u = userByEmail(email, tctx.USERS);
        const pass = (form.get("password") || "").toString();
        // Resolve through effectiveSecret even when no user matched (a throwaway address),
    // so an unknown email pays the SAME users:secrets KV read as a known one — without
    // this the KV read is a residual timing oracle after the dummy-hash equalizes PBKDF2.
    const real = await effectiveSecret(env, u || { email: "\x00nouser" });
        // Always run PBKDF2 — against the real hash or a dummy — so an unknown email
        // costs the same as a known one (no timing enumeration).
        const ok = await verifyPassword(pass, real || DUMMY_HASH);
        if (u && real && ok) {
          const token = await userToken(env, u, undefined, tctx.SESSION_KEYS, tctx);
          if (ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(tctx, env, u));
          touchWorkspaceActivity(env, tctx, ctx);
          // ⚠️ INSIDE THE SUCCESS BRANCH, WHICH IS THE POINT. A wrong password falls through
          // to loginFail below and never reaches this line, so a dormant workspace cannot be
          // brought back by somebody who only knows an admin's address. Whether it actually
          // resumes is the workspace object's decision — see resumeAfterDormancy.
          resumeAfterDormancy(env, tctx, u, paused, ctx);
          return new Response(null, {
            status: 303,
            headers: {
              Location: redirect,
              "Set-Cookie": `${USER_COOKIE}=${u.email}.${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
              "Cache-Control": "no-store",
            },
          });
        }
        // Failed attempt — count it against the email + IP.
        await loginFail(env, rlIds);
        // A roster user with NO effective secret has been reset (or never redeemed an
        // invite) — their password does not exist, so "incorrect password" sends them
        // hunting for a typo that isn't there. Say what actually happened. This does
        // reveal that a given address is on the roster and currently has no password;
        // for a team this size that is a worthwhile trade against nine people
        // re-checking a password manager for a credential we deleted.
        return htmlResponse(loginPage(tctx, redirect, u && !real ? RESET_NOTICE : true, url.href), 401);
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
      return htmlResponse(loginPage(tctx, redirect, true, url.href), 401);
    }

    // These three data APIs key off a caller-supplied ?path=, and they are dispatched
    // BEFORE the admin-only-space gate below — so without this an anonymous caller could
    // read or overwrite a restricted space's boards/threads by naming its path directly.
    // Seal any path inside an admin-only space to admins (identity mode only).
    const dataPath = clamp(url.searchParams.get("path"), 600);
    if (usersActive && dataPath && isRestrictedPath(tctx, dataPath)
        && (url.pathname === "/__review/api" || url.pathname === "/__board" || url.pathname === "/__rt")
        && (!me || me.role !== "admin")) {
      return jsonResponse({ error: "forbidden" }, 403);
    }

    // Comments: fully OPEN (reads and writes) so devs who only have the public
    // prototype link — no login — can leave feedback that syncs to KV. Obscure
    // share links, not public discovery; applyOp already clamps/caps every field.
    // Destructive ops (delete a thread/message) require a signed-in user (see reviewApi).
    if (url.pathname === "/__review/api") return reviewApi(tctx, request, url, env, authed);

    // Overlay APIs — gated by the same rule as the site (open in legacy no-gate mode
    // so raw/local builds keep working). Pins are scoped to the signed-in user.
    // Prototype status and prototype names are CONTENT, shared with everyone who
    // opens the site — so a viewer may read them and may not write them. Reads stay
    // open to any signed-in user; writes ask the role IN THE SPACE that owns the
    // path being changed, not the global role, because the same person can be a
    // viewer in one workspace and an editor in another.
    if (url.pathname === "/__status") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      const denied = viewerWriteRefusal(request, url, me, "status", tctx.SPACES);
      if (denied) return denied;
      return statusApi(tctx, request, url, env, me);
    }
    // What is current here and what has been left behind. A pure READ of two facts the
    // workspace already holds, gated exactly like the galleries it paints — a viewer may
    // see it, and there is nothing here for anyone to write. `?since=14d` narrows it to
    // what actually changed, which is the whole of an agent's "what happened lately".
    if (url.pathname === "/__currency") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return currencyApi(tctx, request, url, env);
    }
    if (url.pathname === "/__pins") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return pinsApi(tctx, request, url, env, me);
    }
    // Working marks — READ ONLY here. Who is working where is workspace-internal, so it
    // asks for a session like the gallery around it; the WRITE side is a publish token and
    // lives under /__publish/_marks, because a work-start step is something a tool runs.
    if (url.pathname === "/__marks") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return marksApi(tctx, request, url, env);
    }
    if (url.pathname === "/__name") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      const denied = viewerWriteRefusal(request, url, me, "name", tctx.SPACES);
      if (denied) return denied;
      return nameApi(tctx, request, url, env);
    }
    // The shipped space list (id/name/badge/base/adminOnly) for shell UI — gated
    // like the rail pages that render it (space names are internal until shipped
    // somewhere public on purpose).
    if (url.pathname === "/__spaces") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({ spaces: tctx.SPACES });
    }
    // Created-canvases registry — gated like /__status: any signed-in user (or anyone,
    // in legacy/open mode) can create/rename/remove a board. The board PAGES it
    // registers are public (served past the gate in the fetch fallthrough below).
    if (url.pathname === "/__canvases") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      // Creating a canvas is creating content. A viewer looks and comments; it does
      // not add things other people will find in the gallery.
      const denied = viewerWriteRefusal(request, url, me, "canvas", tctx.SPACES);
      if (denied) return denied;
      return canvasesApi(tctx, request, url, env, me);
    }
    // Prototype deletion — DESTRUCTIVE (repo write). Admin-only in identity mode; in
    // legacy/open mode any authed operator (a single-operator instance has no roles).
    if (url.pathname === "/__delete") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      if (usersActive && (!me || me.role !== "admin")) return jsonResponse({ error: "forbidden" }, 403);
      return deleteApi(tctx, request, env, me);
    }
    // Canvas board docs follow the COMMENTS model, not the status/pins model: a canvas is a
    // PUBLISHED prototype (public, obscure share link), so its board must load & save without a
    // login, exactly like /__review/api. Writes are full-state but size-capped in boardApi.
    if (url.pathname === "/__board") return boardApi(tctx, request, url, env, me);
    // Board images live OUTSIDE the doc (content-hashed, immutable) — same public model as
    // /__board: the hash is the credential. Reads stay public (a public board renders its
    // images for anyone); UPLOADS require a signed-in user in identity mode, so the KV
    // image store can't be filled by anonymous callers.
    if (url.pathname.startsWith("/__asset")) {
      if (request.method === "POST" && usersActive && !authed) return jsonResponse({ error: "unauthorized" }, 401);
      // A viewer's canvas rights stop where an anonymous visitor's do, and an
      // anonymous visitor cannot upload (the check above). So neither can a viewer.
      const denied = viewerWriteRefusal(request, url, me, "asset", tctx.SPACES);
      if (denied) return denied;
      // Reads stay open on an instance with uploads off: images stored before the switch
      // still render, and a board that half-renders is worse than one that cannot grow.
      if (request.method === "POST") {
        const off = imagesDisabledRefusal(tctx);
        if (off) return off;
      }
      return assetApi(tctx, request, url, env);
    }
    // Canvas multiplayer: same-origin WebSocket proxied to the augur-realtime worker (one
    // BoardRoom Durable Object per board path — cursors/presence/live ops). Public like
    // /__board: the board is the credential. The engine degrades to solo if this fails.
    if (url.pathname === "/__rt") return rtProxy(tctx, request, url, env, me);

    // Admin-only spaces: seal the whole base path BEFORE the public-prototype
    // door, so nothing under it — not even an og.jpg — leaks. Only an admin
    // gets through; a signed-in non-admin is bounced home; a signed-out
    // visitor gets the login page. Skipped in legacy/open mode
    // (no users injected), same as the /admin gate.
    if (usersActive && isRestrictedPath(tctx, url.pathname)) {
      if (!authed) return htmlResponse(loginPage(tctx, url.pathname + url.search, false, url.href), 200);
      if (!me || me.role !== "admin") return Response.redirect(new URL("/", url).toString(), 303);
    }

    // Session music: admins only (see isTrackPath). Not a redirect and not a login page —
    // this is an <audio> src, and the honest answer to "may I have this file" from anyone
    // else is that it isn't there. An instance with no user list at all has no admins to
    // distinguish, and every visitor there is the operator, so it stays open.
    if (usersActive && isTrackPath(url.pathname) && (!me || me.role !== "admin")) return notFoundResponse(tctx);

    // Admin pages (/admin/…): require an admin user. A signed-out visitor gets the
    // login page; a signed-in non-admin is bounced home.
    //
    // Checked BEFORE the public-prototype door below, for the same reason the
    // admin-only-space seal is: PUBLIC_PREFIXES is publisher-supplied data, and a door
    // that opens on it must never be able to open the admin panel. The prefixes are
    // validated at commit, but ordering makes that a second line of defence rather than
    // the only one.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!authed) return htmlResponse(loginPage(tctx, url.pathname + url.search, false, url.href), 200);
      // Admin of ANY space is enough to reach the page — it scopes itself to a space
      // the caller actually administers, and the /__admin APIs re-check per space. A
      // global admin with no membership recorded administers everything, so this is
      // the same door it has always been on an instance that never set memberships.
      if (usersActive && (!me || !administersAny(me, tctx.SPACES))) {
        return Response.redirect(new URL("/", url).toString(), 303);
      }
      const asset = await assetFetch(tctx.tenantId, env, request);
      if (asset.status === 404) return notFoundResponse(tctx);
      return withAssetCache(await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url);
    }

    // Published prototypes are public — never gated, regardless of the cookie.
    // The open door is for easy link-sharing, NOT public discovery, so tag every
    // public response as non-indexable (covers HTML and assets alike).
    if (isPublicPath(tctx, url.pathname)) {
      const asset = await assetFetch(tctx.tenantId, env, request);
      if (asset.status === 404) return notFoundResponse(tctx);
      const res = withAssetCache(await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url);
      const out = new Response(res.body, res);
      out.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return out;
    }

    // Membership gate. With the path-mount tier retired there is one workspace, so this is
    // simply "are you in it?" — the path no longer selects among several spaces, so the
    // gate resolves the one workspace directly instead of per-request from url.pathname
    // (D6). The membership/role MODEL is unchanged (Q2): isMemberOf still answers from the
    // {email: {spaceId: role}} map, and an ABSENT membership still means "the whole
    // instance", so a user with none recorded passes exactly as before.
    //
    // 404, not 403 or a redirect — a workspace you are not a member of must not be
    // confirmable from the outside, and "forbidden" confirms it. Placed AFTER the
    // public-prototype door on purpose: share links stay open, so a signed-in
    // non-member never fares worse than a signed-out stranger looking at the same URL.
    if (usersActive && me) {
      const sid = (tctx.SPACES.find((s) => s.default) || {}).id || null;
      if (sid && !isMemberOf(me, sid)) return notFoundResponse(tctx);
    }

    // Past the gate (or nothing gates the site) → serve. A 404 gets one more chance
    // as a created canvas (a KV-registered board with no repo file — see canvasesApi).
    if (authed) {
      const asset = await assetFetch(tctx.tenantId, env, request);
      if (asset.status === 404) {
        const virt = await virtualCanvas(tctx, request, env, url);
        if (virt) return virt;
        return notFoundResponse(tctx);
      }
      return withAssetCache(await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url);
    }

    // Created canvas boards are public like published prototypes — same obscure
    // share-link model (the /__board doc and /__rt room were already open; only the
    // loader page was gated). Checked only after every other door failed, so the KV
    // read never taxes normal traffic. Boards under an admin-only space never reach
    // here — isRestrictedPath sealed them above.
    const virt = await virtualCanvas(tctx, request, env, url);
    if (virt) return virt;

    // Otherwise show the login page, remembering where they were headed.
    // 200 (not 401) so password managers treat it as a normal login page.
    return htmlResponse(loginPage(tctx, url.pathname + url.search, false, url.href), 200);
}

// Pure helpers exposed for unit tests. Nothing in the request path references
// __testables — it exists only so test/worker.test.mjs can import them.
export const __testables = Object.freeze({
  applyInstance,
  hashPassword, verifyPassword, isPassHash, safeEqual, userByEmail, userByAliasEmail,
  personId, avatarKey, publicUser, stampAuthor, sanitizeMsg, applyOp, reviewApi, reviewExport,
  purgeThreads, purgeUser, PURGED_AUTHOR,
  redactPublishedBy, redactProvenance, PURGED_PUBLISHER,
  peopleApi,
  tokenFor, hmacToken, userToken, identify, effectiveSecret,
  sessionBinding, rotateSessionKey, clearSessionKey, SESSION_KEYS_KEY,
  FIRST_RUN_KEY, FIRST_RUN_PATH, FIRST_RUN_COPY, firstRunLanding, firstRunPage,
  readFirstRunSeen, clearFirstRunSeen,
  mintInvite, readInvite, consumeInvite, touchLastSeen,
  // B-kv-read-cutover: which identity families read from the workspace object, and the
  // accessor that answers. Exported so test/kv-read-cutover.test.mjs can assert the
  // straddle from both sides rather than describe it.
  KV_CUTOVER, identityFor, inviteHash, LASTSEEN_PREFIX, USER_INVITES_KEY,
  readRosterDocs, mirrorRosterDocs, PUBLISH_TOKENS_KEY,
  invitePost, inviteGet, invitePage, setUserSecret, MIN_PASSWORD_LENGTH,
  loginPage, RESET_NOTICE, previewHead, ENGINE_TAGLINE, notFoundPage,
  PBKDF2_ITERATIONS,
  INVITE_TTL_MS,
  adminUsersApi, adminBackupApi,
  ROLES, roleOf, readRoles, applyRoles, clearRole, USER_ROLES_KEY,
  USER_SPACES_KEY, readSpaces, applySpaces, membershipOf, isMemberOf, roleIn,
  spacesFor, clearSpaces, meSpaces, spaceIdForPath, administersAny, lastAdminOf, mayResetPassword,
  viewerWriteRefusal,
  SPACE_ICONS_KEY, SPACE_ICON_BLOB_PREFIX, readSpaceIcons, applySpaceIcons, serveSpaceIcon, spaceIconApi,
  mergeRoster, readRoster, revokeSecret, revokeInvitesFor,
  applyAvatars, readAvatars, parseAvatarDataUri, avatarHash, clearAvatar,
  meAvatarApi, serveKvAvatar, avatarUrl, USER_AVATARS_KEY, AVATAR_BLOB_PREFIX,
  meWorkspacesApi,
  meNameApi, applyNames, cleanName, readNames, clearName, USER_NAMES_KEY, NAME_MAX_CHARS,
  AVATAR_MAX_CHARS,
  isEmailish, nameFromEmail, initialsFor,
  applyDerivedRouting, canvasAggregate, synthBuildStamp,
  mcpProxy, MCP_PROXY_PATHS,
  assetFetch, withAssetCache, ASSET_REVALIDATE,
  deleteUrlPrefix, removeFromStore,
  revokePublishTokens, loginThrottled, loginSlowed, loginFail, DUMMY_HASH,
  pathOwnedBySpace, isPublishablePublicPrefix, removedPublicPrefixes, publishApi, loadManifests, LOGIN_MAX_FAILS,
  bundleKey, bundleFamily, bundleStore, bundlesFor, bundleWorkspaceSegment, storeWorkspaceIds,
  BUNDLE_TENANCY, BUNDLE_TENANT_PREFIX, ENGINE_SPACE_ID,
  tokenActorRefusal, publishTokenTtlMs, mintPublishToken, adminTokensApi,
  nextPublishVersion, overlayFor, overlayKvKey, statusApi, nameApi, pinsApi,
  currencyApi, currencyRows, freshness, whenWords, parseSince, unitKey, unitProvenance,
  STALE_AFTER_DAYS, STATUS_LABELS, VALID_STATUS,
  marksApi, readMarks, writeMark, clearMark, liveMarks, markExpiresAt, decorateMark,
  normalizeMarkPath, markPathsOverlap, sweepExpired,
  MARK_TTL_MS, MARK_TTL_MAX_MS, MARK_TTL_MIN_MS, MARK_SWEEP_MAX, MARK_MAX_ROWS,
  exportState, importState,
  quotaBump, quotaMinute, quotaDay, workspaceStatus, touchWorkspaceActivity,
  deleteWorkspace, purgeDue, blobGc, clearFamilies, NEVER_CLEARED,
  rekeyToSegment, REKEY_FAMILIES, REKEY_DEFAULT_FAMILIES, REKEY_LIMIT,
  IDENTITY_TENANCY, IDENTITY_KV_FAMILIES, IDENTITY_TENANT_PREFIX, identityKey,
  identityFamily, identityKvView, identityWorkspaceSegment, rekeyIdentityToSegment,
  kvFor, kvForRaw,
  capabilityRefusal, CAP_ROUTES,
  sharedChromeRefusal, PUBLISH_READ_OPS, capabilityGrantsRoute,
  runScheduledHealth, adminHealthApi, HEALTH_REPORT_KEY,
  readFreeze, setFreeze, isFrozenWrite, FROZEN_WRITES, FREEZE_KEY,
  readSuspension, isAllowedWhileSuspended, SUSPENDED_ALLOWED, SUSPENDED_ALLOWED_READS,
  SUSPENSION_TTL_MS,
  suspensionPage, suspensionRefusal, wantsJson, hasSessionCookie, memberSuspensionBody,
  resumeAfterDormancy,
  PITI_VIEW_KEY, PITI_REMARKS_KEY,
  publishAuthDetailed, publishRefusalBody,
  adminStorageApi,
  adminCustomDomainApi,
  isPrefixBacked, backedPublicPrefixes,
  composeFork, carriedLineage, assertedLineage, manifestCeiling, bytesReferencedOf,
  isPublicPath, isTrackPath, isRestrictedPath, versionFor, brandMark,
  boardApi, canvasesApi, virtualCanvas, rtProxy, roomName, kvWorkspaceSegment,
  OVERLAY_KV_KEYS, overlayKvKey,
  CANVASES_KEY, BOARD_PREFIX, BOARD_MAX_BYTES,
  assetApi, ASSET_PREFIX, ASSET_R2_PREFIX, ASSET_MAX_BYTES, assetGc, ASSET_GC_GRACE_MS,
  composeChrome, renderAppChrome, renderSpaceContextScript, __setChromeTestState,
  loadConfig, loadTenantContext, __setConfigTestState, __usersNow, pitiApi,
  CONFIG_STALE_CEILING_MS,
  resolveTenant, DEFAULT_TENANT_ID, TENANT_MEMO_TTL_MS, __setTenantTestState, tenantStub,
  tenantNamespace,
  aliasTenantId,
  unknownHostResponse,
  WORKSPACE_ENTER_PATH, enterHandoff, tenantAccountKey,
  noteMembershipUpstream,
});
