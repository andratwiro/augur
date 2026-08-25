// Source for dist/_worker.js — copied VERBATIM by build.js into the deploy dir.
// Cloudflare Pages Advanced Mode: this Worker runs in front of every request.
//
// RUNTIME CONFIG: everything deployment- or build-specific (USERS, PUBLIC_PREFIXES,
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

// The per-request config VALUE that is replacing the module-scope globals below. Same
// deal as the chrome renderer: build.js copies this module next to the worker
// (dist/tenant-context.mjs) so the relative import resolves at the edge. Pure and
// side-effect-free at import; it performs no I/O and owns no state.
import {
  emptyTenantContext, instanceFields, routingFields, withTenantFields,
  LEGACY_MCP_PATH_FLOOR,
} from "./tenant-context.mjs";

// The mail transport. Same deal again: build.js copies it next to the worker
// (dist/mail.mjs) so the relative import resolves at the edge. It reads its provider,
// endpoint, key and sending address from the runtime env and holds no state, so a
// deployment that configures none of that gets exactly the behaviour that predates it —
// a link, and a verdict saying no mail was sent. See src/mail.mjs.
import { sendMail, mailNotice } from "./mail.mjs";

const COOKIE = "gv_auth";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// ---- Users / identity -------------------------------------------------------
// Augur is a private internal tool — the only real risk is impersonation, and the
// real work happens through git commits, so this is a casual identity layer, not
// auth hardening. USERS is the ROSTER — who exists, not what they know — filled at
// runtime from instance.json (loadConfig). Empty in a raw copy → no users → the gate
// stays open (offline/local builds with no identity configured). Each entry:
//   { email, name, initials, color, role?, passHash? }
// role:"admin" gates the admin API and admin-only spaces; admins can NOT set or read
// passwords, only reset a user (which revokes and mints an invite link). `passHash` is a
// seed consulted only when users:secrets has no key for that email — it exists so a NEW
// instance's first admin can log in, since there is nobody to invite them.
// Credentials live in KV, never here — see effectiveSecret for the exact precedence.
// CONFIG_USERS is what instance.json named; USERS is that list with the KV roster
// overlay applied (people the admin panel invited or removed since). Everything that
// resolves a person reads USERS.
let CONFIG_USERS = [];
let USERS = [];
// Deploy-specific knobs, filled at runtime from instance.json (all empty in a raw
// engine build): gate-exempt skill-asset path prefixes, MCP-proxy host allowlist
// (suffix rule + space-declared exact hosts + the URL of an exact-host list), and
// vanity-host redirects.
// MCP_HOST_ALLOWLIST and MCP_PATH_ALLOWLIST alone come from routing.json: the union of
// the {"hosts":[…], "paths":[…]} files the spaces declare via space.json "mcpAllowlists"
// (see build.js).
let PUBLIC_SKILL_PREFIXES = [];
let MCP_HOST_SUFFIXES = [];
let MCP_HOST_ALLOWLIST = [];
let MCP_HOST_ALLOWLIST_URL = "";
let MCP_PATH_ALLOWLIST = [];
let VANITY_REDIRECTS = {};
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
const SPACE_ICONS_KEY = "spaces:icons";
const SPACE_ICON_BLOB_PREFIX = "spaceicon:";
let SPACE_ICON_KEYS = new Set(); // hashes the index vouches for — see the serve route
let SPACE_ICONS = {};       // last-read icon index, re-applied whenever SPACES is rebuilt
// The three roles, and the one rule that turns a stored value into one of them.
//
// `user` is the legacy spelling of `editor` — it was the only non-admin value the
// panel could produce, so every existing roster and identity.json is full of it.
// Read-through, never a flag day: a stored `user` IS an editor, and so is an absent
// role. Anything unrecognised also lands on editor, because the alternative is an
// account that silently loses or gains privileges on a typo.
const ROLES = ["admin", "editor", "viewer"];
const roleOf = (u) => {
  const r = u && u.role;
  return r === "admin" || r === "viewer" ? r : "editor";
};
const NAME_MAX_CHARS = 60;
// Raster formats only, and each one is checked against its magic bytes before storage:
// /__avatar/ is ungated and echoes this mime back, so "trust the label" would let a
// signed-in user park arbitrary bytes behind an image content-type.
const AVATAR_MIMES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // links get pasted into chat — expire them

// Build id for the live-reload poller — routing.json carries this build's id; it's
// the FALLBACK version for any path not in VERSION_MAP (index/shell pages, assets).
// "dev" in a raw/local copy just means a stable id.
let BUILD_ID = "dev";

// Serve-time chrome composition (runtime-chrome). CHROME_POINTER is the CURRENT engine's
// chrome bundle names + UI version (routing.chrome); RUNTIME_CHROME gates composeChrome.
// Inert defaults so a raw/local copy (and every test import) stays side-effect-free — the
// worker fills them in loadConfig from routing.json (assets mode). Off ⇒ served HTML is
// untouched, exactly as before.
let CHROME_POINTER = null;
let RUNTIME_CHROME = false;

// Per-page live-reload versions: URL-prefix → token that changes only when that
// folder's content changes (routing.json). Lets a tab reload only when ITS
// own prototype changed, so unrelated deploys (e.g. another agent's prototype) don't
// reload it. versionFor() returns the longest-prefix match, else BUILD_ID.
let VERSION_MAP = {};

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

// PUBLIC prototype path-prefixes — served WITHOUT the password. routing.json carries
// the real list of `/<opportunity>/<prototype>/` prefixes, derived from the same
// build that shipped them, so it can never drift from what actually ships. Empty
// default so a raw/local copy of this file gates nothing differently (local builds
// have no password anyway).
let PUBLIC_PREFIXES = [];

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
  // (Slack, iMessage, Twitter) can load the image even if its folder is gated.
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

// ADMIN-ONLY space base paths. RETIRED with the path-mount tier: an adminOnly space only
// ever sealed a NON-DEFAULT "/<id>/" mount, and no such mount exists any more, so nothing
// is derived into this list — it is permanently empty and everything below reads it as
// "no path is restricted." The declaration and its consumer (isRestrictedPath) are kept
// as a harmless always-false read rather than ripped out; assets mode still assigns from
// a routing.restrictedBases field defensively, but the build no longer emits one.
let RESTRICTED_BASES = [];

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

// Does this path live inside an admin-only space? Matches the base ("/space-2"),
// its root ("/space-2/") and everything beneath it.
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
// build.js emits next to the assets — as ONE value (loadTenantContext), then mirrors it
// onto the bindings above until the read sites take it as a parameter. Cached per isolate
// for ~1.5s: fast enough that a fresh deploy (or an offline rebuild) flips the gate's view
// of the world almost immediately, cheap enough to run on the hot path (between refreshes
// the call is a sync timestamp check). A missing or unreadable document leaves the current
// values in place — so a raw copy (no config emitted) keeps its empty defaults, and a
// transient read failure never wipes a working gate.
let SPACES = [];
let INSTANCE_SENTINELS = [];
// The oldest publish protocol this instance will accept a commit from
// (deploy.config.json "minClientProtocol"). 0 = accept anything, which is the
// default and the right one for a single-operator instance: a floor that nobody
// set should never be the reason a publish fails.
let MIN_CLIENT_PROTOCOL = 0;
// Optional one-liner rendered on the login page (deploy.config.json "loginHint") —
// how a demo instance surfaces its test credentials without opening the gate.
let LOGIN_HINT = "";
// Optional email/password baked into the login form's value= attributes
// (deploy.config.json "loginPrefill": {email, password}) — a demo instance's way of
// making its throwaway account a one-click login instead of a copy-paste. Empty by
// default, so a normal instance's form renders with no values, same as before.
let LOGIN_PREFILL_EMAIL = "";
let LOGIN_PREFILL_PASSWORD = "";
// Engine version of the build that produced the live config/chrome (from
// package.json via build.js) + the release feed the update nudge polls.
let INSTANCE_ENGINE_VERSION = "";
let UPDATE_FEED = "";
const DEFAULT_UPDATE_FEED = "https://api.github.com/repos/andratwiro/augur/releases/latest";
let cfgAt = 0;
// The context this isolate is currently serving from — config as ONE value instead of
// twenty-nine bindings. It is the keep-last-good half of the cache above, expressed as a
// reference: a tick that reads nothing usable returns this same object, so "keep the last
// good config" is "do not swap the reference" rather than "do not overwrite twenty-nine
// variables one at a time". Single-slot, so like the globals it mirrors it would answer a
// second workspace with the first one's config; the per-tenant cache in
// src/tenant-context.mjs is what replaces it when fetch() threads the context down.
let TENANT_CTX = emptyTenantContext(null);
// Transitional test seam: the request path builds the identity fields as a value now
// (instanceFields), but the gate, publish and admin baselines drive this to seed the
// module globals directly. test/tenant-context.test.mjs pins the two to the same
// coercions, so a change to either without the other is a red test.
//
// ⚠️ It also advances TENANT_CTX, and must keep doing so. The router now hands the
// context down, and a read site reached through it must see exactly what the global it
// replaces would have said. A seam that wrote only the globals would give a threaded
// site one answer and an unthreaded one another — the two halves of a half-done sweep
// disagreeing, which is the one failure a green test suite could not show.
function applyInstance(inst) {
  TENANT_CTX = withTenantFields(TENANT_CTX, instanceFields(inst));
  CONFIG_USERS = Array.isArray(inst.users) ? inst.users : [];
  USERS = CONFIG_USERS; // rosterFields() overlays the KV additions/removals next
  INSTANCE_ENGINE_VERSION = inst.engineVersion || "";
  UPDATE_FEED = inst.updateFeed || "";
  MCP_HOST_SUFFIXES = inst.mcpHostSuffixes || [];
  MCP_HOST_ALLOWLIST_URL = inst.mcpHostAllowlistUrl || "";
  VANITY_REDIRECTS = inst.vanityRedirects || {};
  RT_ORIGIN = inst.rtOrigin || "";
  INSTANCE_SENTINELS = Array.isArray(inst.sentinels) ? inst.sentinels : [];
  MIN_CLIENT_PROTOCOL = Number.isInteger(inst.minClientProtocol) && inst.minClientProtocol > 0
    ? inst.minClientProtocol : 0;
  LOGIN_HINT = typeof inst.loginHint === "string" ? inst.loginHint : "";
  const prefill = inst.loginPrefill && typeof inst.loginPrefill === "object" ? inst.loginPrefill : {};
  LOGIN_PREFILL_EMAIL = typeof prefill.email === "string" ? prefill.email : "";
  LOGIN_PREFILL_PASSWORD = typeof prefill.password === "string" ? prefill.password : "";
  CONFIG_LOADED = true; // an instance document was actually applied this isolate
  // The seeded CONTEXT, for the same reason applyDerivedRouting hands one back: a caller
  // that has to give a threaded function a workspace gets one from the seed it already
  // wrote, instead of reaching into module scope for it.
  return TENANT_CTX;
}
// Has a real instance config ever loaded in THIS isolate? A cold isolate whose first
// config read fails would otherwise leave USERS empty and default the gate to "open"
// (the raw/offline case). This flag lets the gate tell "genuinely no identity" (raw
// build) from "config not loaded yet" (deployment, must fail closed). See the gate.
let CONFIG_LOADED = false;
// ONE config load for ONE workspace: read whichever documents this serving mode keeps
// config in, and RETURN the context they describe. It does the I/O and nothing else —
// no global is written here, which is what lets the same function answer for a second
// workspace without the first one's answer being in the way.
//
// KEEP-LAST-GOOD is the whole reason it takes `prev` and returns rather than assigns.
// Every field starts at the previous context's value and is replaced only by a document
// that actually parsed, so a read that fails, 404s or returns nonsense contributes
// nothing instead of clearing what it owns. Returning `prev` itself (the `!env.ASSETS`
// exit, or an unchanged bundle read) tells the caller "nothing to swap".
//
// The order inside bundle mode's try is load-bearing and matches what it replaced: a
// throw while deriving routing leaves an instance document that already parsed applied,
// because `next` only advances on a value that came back whole.
async function loadTenantContext(tenantId, env, { prev = null, forced = false } = {}) {
  let next = prev && prev.tenantId === tenantId ? prev : emptyTenantContext(tenantId);
  // Bundle mode: instance config lives in the store (pushed via /__publish/
  // _instance/config) and routing derives from the live manifests.
  if (bundleMode(env)) {
    try {
      const [instObj, manifests] = await Promise.all([
        env.BUNDLES.get("config/instance.json"),
        loadManifests(env, true),
      ]);
      if (instObj) next = withTenantFields(next, instanceFields(JSON.parse(await instObj.text())));
      next = withTenantFields(next, derivedRoutingFields(manifests, next.SPACE_ICONS));
    } catch (e) {}
    return withTenantFields(next, await rosterFields(next, env, forced));
  }
  if (!env.ASSETS) return next;
  const grab = async (name) => {
    try {
      const r = await env.ASSETS.fetch("https://config/__config/" + name);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };
  const [inst, routing] = await Promise.all([grab("instance.json"), grab("routing.json")]);
  if (inst) next = withTenantFields(next, instanceFields(inst));
  // Assets mode gets the two canvas aggregates pre-merged by the build that shipped them
  // (there is only ever one whole-site build in this mode, so the file is authoritative).
  // Same fields, same serving route as bundle mode.
  if (routing) next = withTenantFields(next, routingFields(routing));
  return withTenantFields(next, await rosterFields(next, env, forced));
}

// Transitional: mirror a loaded context onto the module globals the ~110 read sites still
// read. Every threading commit shrinks this function; A-fetch-entrypoint deletes it along
// with the bindings it writes.
//
// SPACE_ICON_KEYS is deliberately absent: applySpaceIcons still writes it as a side
// effect of building the space list, so mirroring the context's (unfilled) copy over it
// would blank the hash allowlist the icon route checks.
function applyTenantContext(ctx) {
  CONFIG_USERS = ctx.CONFIG_USERS;
  USERS = ctx.USERS;
  CONFIG_LOADED = ctx.CONFIG_LOADED;
  INSTANCE_ENGINE_VERSION = ctx.INSTANCE_ENGINE_VERSION;
  UPDATE_FEED = ctx.UPDATE_FEED;
  MCP_HOST_SUFFIXES = ctx.MCP_HOST_SUFFIXES;
  MCP_HOST_ALLOWLIST = ctx.MCP_HOST_ALLOWLIST;
  MCP_HOST_ALLOWLIST_URL = ctx.MCP_HOST_ALLOWLIST_URL;
  mcpStaticHosts = ctx.mcpStaticHosts;
  MCP_PATH_ALLOWLIST = ctx.MCP_PATH_ALLOWLIST;
  VANITY_REDIRECTS = ctx.VANITY_REDIRECTS;
  RT_ORIGIN = ctx.RT_ORIGIN;
  INSTANCE_SENTINELS = ctx.INSTANCE_SENTINELS;
  MIN_CLIENT_PROTOCOL = ctx.MIN_CLIENT_PROTOCOL;
  LOGIN_HINT = ctx.LOGIN_HINT;
  LOGIN_PREFILL_EMAIL = ctx.LOGIN_PREFILL_EMAIL;
  LOGIN_PREFILL_PASSWORD = ctx.LOGIN_PREFILL_PASSWORD;
  BUILD_ID = ctx.BUILD_ID;
  VERSION_MAP = ctx.VERSION_MAP;
  PUBLIC_PREFIXES = ctx.PUBLIC_PREFIXES;
  PUBLIC_SKILL_PREFIXES = ctx.PUBLIC_SKILL_PREFIXES;
  RESTRICTED_BASES = ctx.RESTRICTED_BASES;
  CANVAS_LOADER_EXTRAS = ctx.CANVAS_LOADER_EXTRAS;
  CANVAS_CATALOG = ctx.CANVAS_CATALOG;
  CANVAS_TRACKS = ctx.CANVAS_TRACKS;
  SPACES = ctx.SPACES;
  SPACE_ICONS = ctx.SPACE_ICONS;
  CHROME_POINTER = ctx.CHROME_POINTER;
  RUNTIME_CHROME = ctx.RUNTIME_CHROME;
}

// The transitional caller: one tick of the clock, then the mirror. It owns the two
// properties the cache has to keep, and both are here rather than inside
// loadTenantContext because the CALLER is what decides a failed read is not worth
// swapping the context for:
//
//   STAMP-FIRST — the tick is stamped BEFORE the read, so a config document that is
//   broken costs one attempt per 1.5s tick instead of one per concurrent request.
//   KEEP-LAST-GOOD — the mirror runs only when the load handed back a different context.
//   A read that produced nothing returns the reference it was given, and the gate keeps
//   serving the last config that worked.
//
// It RETURNS the context it settled on — the value fetch() hands down. Every exit
// returns one, including the two that do no work: "the clock says this tenant's config
// is fresh" and "nothing parsed" both mean the caller should serve from the context
// already in hand, not from an empty one. Returning nothing there would hand the router
// a hole where its config should be.
async function loadConfig(tenantId, env) {
  if (!env || Date.now() - cfgAt < 1500) return TENANT_CTX;
  const forced = !cfgAt; // a write handler busted the cache — roster must re-read now
  cfgAt = Date.now(); // stamp first — a failed load retries next tick, never stampedes
  const next = await loadTenantContext(tenantId, env, { prev: TENANT_CTX, forced });
  if (next === TENANT_CTX) return TENANT_CTX;
  TENANT_CTX = next;
  applyTenantContext(next);
  return TENANT_CTX;
}

// ---- The tenant resolver seam -----------------------------------------------
// ONE function answers "which workspace is this request for", and fetch() calls it
// ONCE, before any config is read. Everything downstream takes the answer as a
// parameter, so the day the answer stops being static there is a single line to
// change instead of a hunt through the read sites.
//
// TODAY the body is static: a deployment serves exactly one workspace, so the answer
// is the identity the build stamped into instance.json (`tenantId`), read once per
// isolate. NEXT, serving several workspaces from one deployment replaces this body
// with a Host lookup — `request.headers.get("Host")` → the workspace that claims that
// hostname → its id. Same signature, same single call site, same `{tenantId}` answer;
// `request` is a parameter today for exactly that reason and is deliberately unused.
//
// The fallback carries more weight than the happy path. Every instance built before
// the field existed carries no `tenantId`, and a raw or offline build has no config
// document at all — all of them answer DEFAULT_TENANT_ID, which is precisely what the
// single-workspace world has been doing all along under another name: one identity,
// one config cache, one gate. Nothing about a live deployment changes when it takes
// this engine; it starts naming out loud the tenant it already was.
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

async function resolveTenant(request, env) {
  if (tenantMemo) {
    if (tenantMemo.tenantId) return { tenantId: tenantMemo.tenantId };
    if (Date.now() - tenantMemo.at < TENANT_MEMO_TTL_MS) return { tenantId: DEFAULT_TENANT_ID };
  }
  tenantMemo = { at: Date.now(), tenantId: null }; // stamp first, then read
  const tenantId = await readInstanceTenantId(env);
  if (tenantId) tenantMemo = { at: Date.now(), tenantId };
  return { tenantId: tenantId || DEFAULT_TENANT_ID };
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
// leaves USERS as the config list, which would resurrect a removed CONFIG user in the
// list — so `remove` ALSO writes the users:secrets tombstone that reset writes. That
// tombstone fails closed on a KV error (see effectiveSecret) and identify() refuses any
// user without an effective secret, so a removed person cannot sign in even if this
// overlay is momentarily unreadable. Never "simplify" removal down to the list alone.
const lcEmail = (e) => String(e == null ? "" : e).trim().toLowerCase();
// A FRESH object every time, never a shared constant: the write ops mutate what this
// returns before putting it back, so handing out one shared empty would let the first
// invite scribble on every later read.
const emptyRoster = () => ({ add: {}, remove: [] });

async function readRoster(env) {
  const kv = kvFor(env);
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
// still runs every tick — applyInstance resets USERS to the config list and counts
// on the overlay landing on top — only the KV reads are cached. Freshness: any
// admin write sets cfgAt = 0, which reaches here as `forced` and re-reads at once
// on that isolate; other isolates converge within ROSTER_TTL_MS. None of this
// touches auth: identify() resolves users:secrets per request, so a removal or
// reset still bites immediately — the tombstone, not this overlay, is the boundary.
const ROSTER_TTL_MS = 60_000;
let rosterReadAt = 0;
let rosterCache = null;
// Test hooks: the cadence above is timing state a test can't reach otherwise.
function __setConfigTestState({ cfgAt: c, rosterReadAt: r } = {}) {
  if (c !== undefined) cfgAt = c;
  if (r !== undefined) { rosterReadAt = r; if (!r) rosterCache = null; }
}
const __usersNow = () => USERS;
// The overlay as a VALUE: it reads KV and returns the three fields the overlay owns, on
// top of the context the config documents just produced. Nothing is written here, so a
// throw anywhere in the chain reaches the caller having changed nothing — and the answer
// then is the config roster alone, which is the one thing that must never be an overlay's
// to decide (the tombstone, not this, is the security boundary — see the note above).
async function rosterFields(ctx, env, forced) {
  try {
    if (forced || !rosterCache || Date.now() - rosterReadAt >= ROSTER_TTL_MS) {
      rosterReadAt = Date.now();
      rosterCache = await Promise.all([
        readRoster(env), readAvatars(env), readNames(env), readRoles(env), readSpaces(env),
        readSpaceIcons(env),
      ]);
    }
    const [roster, avatars, names, roles, spaces, icons] = rosterCache;
    return {
      SPACE_ICONS: icons,
      SPACES: applySpaceIcons(ctx.SPACES, icons),
      USERS: applySpaces(
        applyRoles(applyAvatars(applyNames(mergeRoster(ctx.CONFIG_USERS, roster), names), avatars), roles),
        spaces,
      ),
    };
  } catch (e) { return { USERS: ctx.CONFIG_USERS }; }
}

// ---- Self-set display names -------------------------------------------------
// Same bargain as the photo below: who you are is a deploy decision, what you are
// CALLED is yours. A config-baked name is the seed someone sees until they change it.
async function readNames(env) {
  const kv = kvFor(env);
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
async function readRoles(env) {
  const kv = kvFor(env);
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
async function clearRole(env, email) {
  const kv = kvFor(env);
  if (!kv) return;
  try {
    const index = await readRoles(env);
    if (!(lcEmail(email) in index)) return;
    delete index[lcEmail(email)];
    await kv.put(USER_ROLES_KEY, JSON.stringify(index));
  } catch (e) {}
}

// ---- Per-space membership ---------------------------------------------------
// See USER_SPACES_KEY for the absent-vs-empty rule these all turn on.
async function readSpaces(env) {
  const kv = kvFor(env);
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
function viewerWriteRefusal(request, url, me, what, spaces = SPACES) {
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
async function readSpaceIcons(env) {
  const kv = kvFor(env);
  if (!kv) return {};
  try {
    const doc = JSON.parse((await kv.get(SPACE_ICONS_KEY)) || "null");
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch (e) { return {}; }
}

// Stamp each space's icon URL and refresh the hash allowlist the serve route checks.
// Same copy-never-mutate rule as applyAvatars: SPACES entries come from the live
// manifests, so writing onto them would outlive the overlay.
function applySpaceIcons(spaces, index) {
  const keys = new Set();
  const out = (spaces || []).map((s) => {
    const rec = index && index[s.id];
    const k = rec && typeof rec.k === "string" ? rec.k : null;
    if (!k) return s;
    keys.add(k);
    return { ...s, icon: "/__space-icon/" + k };
  });
  SPACE_ICON_KEYS = keys;
  return out;
}

// Serve a workspace icon. The allowlist check comes FIRST for the same reason it does
// on /__avatar/: an ungated route must not become a KV read amplifier for anyone
// typing hashes at it.
async function serveSpaceIcon(env, k) {
  if (!SPACE_ICON_KEYS.has(k)) return new Response("Not found", { status: 404 });
  const kv = kvFor(env);
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
async function spaceIconApi(request, env, me, spaces = SPACES) {
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  const sid = String((body && body.space) || "");
  if (!spaces.some((s) => s.id === sid)) return jsonResponse({ error: "unknown-space" }, 400);
  if (roleIn(me, sid) !== "admin") return jsonResponse({ error: "forbidden" }, 403);

  if (request.method === "DELETE") {
    const index = await readSpaceIcons(env);
    if (sid in index) { delete index[sid]; await kv.put(SPACE_ICONS_KEY, JSON.stringify(index)); }
    cfgAt = 0;
    return jsonResponse({ ok: true, icon: null });
  }
  if (request.method === "POST") {
    const parsed = parseAvatarDataUri(body && body.icon);
    if (!parsed) return jsonResponse({ error: "bad-image" }, 400);
    const k = await avatarHash(body.icon);
    // Blob first: an index entry pointing at a missing blob serves a broken icon,
    // whereas a blob no index names is just an orphan.
    await kv.put(SPACE_ICON_BLOB_PREFIX + k, body.icon);
    const index = await readSpaceIcons(env);
    index[sid] = { k, mime: parsed.mime, at: new Date().toISOString() };
    await kv.put(SPACE_ICONS_KEY, JSON.stringify(index));
    cfgAt = 0;
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
function mayResetPassword(users, actorEmail, targetEmail, spaces = SPACES) {
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
async function clearSpaces(env, email) {
  const kv = kvFor(env);
  if (!kv) return;
  try {
    const index = await readSpaces(env);
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
async function clearName(env, email) {
  const kv = kvFor(env);
  if (!kv) return false;
  const index = await readNames(env);
  const key = lcEmail(email);
  if (!index[key]) return false;
  delete index[key];
  await kv.put(USER_NAMES_KEY, JSON.stringify(index));
  return true;
}

// POST /__me/name {name} — set MY display name. Signed-in users only, and only ever
// their own row: there is no email parameter, the same rule the photo route follows.
// A rename propagates everywhere a name is read (chip, admin table, comment authors),
// because comments store a person id, never a name snapshot.
async function meNameApi(request, env, me) {
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
  const name = cleanName(body && body.name);
  if (!name) return jsonResponse({ error: "bad-name" }, 400);
  const index = await readNames(env);
  index[lcEmail(me.email)] = { name, at: new Date().toISOString() };
  await kv.put(USER_NAMES_KEY, JSON.stringify(index));
  cfgAt = 0; // this isolate re-reads on the next request; others within ~1.5s
  return jsonResponse({ ok: true, name, initials: initialsFor(name) });
}

// ---- Self-set profile photos ------------------------------------------------
// The one place the config file does NOT win. Everything else about a person is a
// deploy decision (who they are, what they may do); their face is theirs, so a photo
// set from the profile menu overrides a data URI baked into the identity file. A
// config-baked photo therefore acts as a SEED — the value someone sees until they
// change it — which is what lets an instance carrying baked photos take this feature
// by pin bump with nothing to migrate.
let AVATAR_KEYS = new Set(); // the hashes the index vouches for; see the /__avatar/ route

async function readAvatars(env) {
  const kv = kvFor(env);
  if (!kv) return {};
  try {
    const doc = JSON.parse((await kv.get(USER_AVATARS_KEY)) || "null");
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch (e) { return {}; }
}

// Copies, never in-place mutation: USERS entries are the very objects instance.json
// produced, so stamping `avatar` onto them would outlive the overlay — a photo removed
// from KV would keep serving until the next config reload replaced CONFIG_USERS.
function applyAvatars(users, index) {
  const keys = new Set();
  const out = (users || []).map((u) => {
    const rec = index && index[lcEmail(u.email)];
    const k = rec && typeof rec.k === "string" ? rec.k : null;
    if (!k) return u;
    keys.add(k);
    return { ...u, avatar: "/__avatar/" + AVATAR_KV_PREFIX + k };
  });
  AVATAR_KEYS = keys;
  return out;
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
async function clearAvatar(env, email) {
  const kv = kvFor(env);
  if (!kv) return false;
  const index = await readAvatars(env);
  const key = lcEmail(email);
  if (!index[key]) return false;
  delete index[key];
  await kv.put(USER_AVATARS_KEY, JSON.stringify(index));
  return true;
}

// POST /__me/avatar {avatar: "data:image/jpeg;base64,…"} — set MY photo.
// DELETE /__me/avatar — drop it (falling back to a config-baked seed, or initials).
// Signed-in users only, and only ever their own row: there is no email parameter.
//
// NOTE: nothing in the shell calls DELETE any more — the account settings modal
// deliberately ships no "remove photo" affordance. The route stays live and tested
// on purpose (a later UI, or a script, still needs it); it is not dead code.
async function meAvatarApi(request, env, me) {
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);

  if (request.method === "DELETE") {
    await clearAvatar(env, me.email);
    cfgAt = 0; // this isolate re-reads on the next request; others within ~1.5s
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
    const index = await readAvatars(env);
    index[lcEmail(me.email)] = { k, mime: parsed.mime, at: new Date().toISOString() };
    await kv.put(USER_AVATARS_KEY, JSON.stringify(index));
    cfgAt = 0;
    return jsonResponse({ ok: true, avatar: "/__avatar/" + AVATAR_KV_PREFIX + k });
  }

  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// Serve a self-set photo. The index-backed AVATAR_KEYS check comes FIRST so an ungated
// route can't be turned into a KV read amplifier by anyone typing hashes at it.
async function serveKvAvatar(env, k) {
  if (!AVATAR_KEYS.has(k)) return new Response("Not found", { status: 404 });
  const kv = kvFor(env);
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
const ROSTER_COLORS = ["#4f46e5", "#0e7490", "#b45309", "#be123c", "#15803d", "#7c3aed", "#0369a1", "#a21caf"];
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
async function revokeSecret(env, email) {
  const kv = kvFor(env);
  if (!kv) throw new Error("no-kv-binding");
  const raw = await kv.get(USER_SECRETS_KEY);
  const ov = raw ? JSON.parse(raw) : {};
  ov[email] = null;
  await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
}

// Drop every outstanding invite for one address (mintInvite does this for the address it
// is issuing; removal needs it without minting anything).
async function revokeInvitesFor(env, email) {
  const kv = kvFor(env);
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
async function revokePublishTokens(env, email) {
  const kv = kvFor(env);
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
function userByEmail(email, users = USERS) {
  const e = String(email == null ? "" : email).trim().toLowerCase();
  return users.find((u) => u.email.toLowerCase() === e) || null;
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
function peopleApi(url, users = USERS) {
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

async function mintInvite(env, email, nowMs = Date.now()) {
  const kv = kvFor(env);
  if (!kv) throw new Error("no-kv-binding");
  const token = toB64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const map = pruneInvites(await readInvites(kv), nowMs);
  // Issuing invalidates this user's outstanding links, so there is never more than one.
  // Case-insensitive, like every other email match — an exact compare let a reset (which
  // mints under the roster's canonical case) miss an invite minted under the lowercased
  // address, leaving two live links for one person.
  for (const [tok, rec] of Object.entries(map)) if (rec && lcEmail(rec.email) === lcEmail(email)) delete map[tok];
  map[token] = { email, expires: nowMs + INVITE_TTL_MS };
  await kv.put(USER_INVITES_KEY, JSON.stringify(map));
  return token;
}

async function readInvite(env, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token) return null;
  const kv = kvFor(env);
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
async function consumeInvite(env, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token) return null;
  const kv = kvFor(env);
  if (!kv) return null;
  const map = pruneInvites(await readInvites(kv), nowMs);
  const rec = map[token];
  if (!rec || typeof rec.expires !== "number" || rec.expires <= nowMs) return null;
  const email = rec.email;
  delete map[token];
  await kv.put(USER_INVITES_KEY, JSON.stringify(map));
  return email;
}

const MIN_PASSWORD_LENGTH = 10;

// Shown when a roster user has no effective secret — reset, or never redeemed. Kept as
// one string so the web gate and the CLI say the same thing.
const RESET_NOTICE = "This account was reset. Ask for a new invite link — your old password no longer exists.";

async function setUserSecret(env, email, hash) {
  const kv = kvFor(env);
  if (!kv) throw new Error("no-kv-binding");
  const raw = await kv.get(USER_SECRETS_KEY);
  const ov = raw ? JSON.parse(raw) : {};
  ov[email] = hash;
  await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
}

// The engine's own mark — the fallback brand on the front-door pages, and the mark the
// in-product 404 always wears (that page sits next to the rail, which is Augur's).
const AUGUR_MARK_SVG = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Augur">
        <g transform="translate(153.5 153.5) scale(1.115)" fill="#2C2150" fill-rule="evenodd"><path d="M303.668 0.501099C480.9 -9.31876 632.543 126.378 642.396 303.609C652.249 480.839 516.579 632.508 339.35 642.392C162.076 652.279 10.36 516.567 0.504883 339.291C-9.34912 162.015 126.39 10.3241 303.668 0.501099ZM321.31 58.589C313.993 78.2949 309.682 91.0001 300.003 110.42C256.894 196.544 185.761 265.436 98.3008 305.765C84.5568 312.054 73.3451 316.365 59.0391 321.205C166.492 358.562 254.54 437.345 303.567 540.001C306.201 545.441 320.11 580.712 320.888 581.447C329.254 559.649 338.869 536.27 350.55 515.916C397.544 434.024 469.471 370.244 555.57 331.86C563.577 328.29 574.85 323.736 583.145 321.47C472.786 278.754 383.1 203.746 334.938 93.8761C332.878 89.1732 321.885 59.2127 321.31 58.589Z"/></g>
      </svg>`;

// The mark on the front-door pages (the gate and the invite form). A deployment's front
// door wears the DEPLOYMENT's brand, not the engine's: this is the same /space-icon.png
// the rail's space switcher shows, so the icon a signed-in user knows is the one that
// greets them signed out. build.js copies that file from the DEFAULT space's repo root,
// so it exists exactly when a default space is mounted — an engine-only site has no
// space branding to wear and keeps the engine's mark. Clipped to a circle here so a
// square space icon still reads as a front-door avatar.
// ⚠️ /space-icon.png must stay listed in isPublicPath(): these two pages are for
// signed-out visitors, so a gated icon would fetch the login HTML into the <img>.
function brandMark(tctx) {
  return tctx.SPACES.some((s) => s.default)
    ? `<img src="/space-icon.png" alt="" width="40" height="40" />`
    : AUGUR_MARK_SVG;
}

// The engine's own one-line description, taken from the public repo's summary. The
// default space's space.json "description" replaces it per instance (build.js carries
// the field on the space entry, so it rides routing.json and published manifests alike).
const ENGINE_TAGLINE = "Real, clickable prototypes and the design system they are built from, on one site with login, comments and live boards on top.";

// <head> block for the gate: the <title> plus the meta an unfurl bot reads (a Notion
// bookmark, a Slack/iMessage card). A gated instance's only public HTML is the gate,
// so this IS the instance's link preview: the default space's name and description,
// and the same public, KV-overridable /space-icon.png that brandMark() wears — an
// icon changed from the admin panel updates the unfurl with no deploy. requestUrl
// makes og:url/og:image absolute (unfurl bots require absolute image URLs); callers
// without one simply get no og:url/og:image. robots stays noindex in the pages that
// carry this: unfurlers read the meta regardless, search engines stay out.
function previewHead(tctx, requestUrl) {
  const def = tctx.SPACES.find((s) => s.default);
  const name = (def && typeof def.name === "string" ? def.name : "").trim();
  const desc = (def && typeof def.description === "string" ? def.description : "").trim() || ENGINE_TAGLINE;
  let page = null;
  try { page = new URL(requestUrl); } catch {}
  const lines = [
    `<title>${escapeHtml(name ? `${name} · Augur` : "Augur")}</title>`,
    `<meta name="description" content="${escapeHtml(desc)}" />`,
  ];
  if (def) lines.push(`<link rel="icon" href="/space-icon.png" />`);
  lines.push(
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Augur" />`,
    `<meta property="og:title" content="${escapeHtml(name || "Augur")}" />`,
    `<meta property="og:description" content="${escapeHtml(desc)}" />`,
  );
  if (page) {
    lines.push(`<meta property="og:url" content="${escapeHtml(page.origin + page.pathname)}" />`);
    if (def) lines.push(`<meta property="og:image" content="${escapeHtml(page.origin + "/space-icon.png")}" />`);
  }
  lines.push(
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(name || "Augur")}" />`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
  );
  return lines.join("\n  ");
}

// GET /__invite?t=… — the set-password form. Deliberately says nothing about whether
// the token is valid beyond "this link is no longer valid": no user enumeration.
function invitePage(tctx, token, error, email) {
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
  <title>Set your password — Augur</title>
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
    .logo img { border-radius: 50%; object-fit: cover; }
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
    <h1>Set your password</h1>
    <p class="error" role="alert">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      <span>${msg}</span>
    </p>
    <form method="POST" action="/__invite">
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
    </form>
  </main>
  <script>
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
  </script>
</body></html>`;
}

async function inviteGet(tctx, url, env) {
  const token = url.searchParams.get("t") || "";
  const email = await readInvite(env, token);
  if (!email) return htmlResponse(invitePage(tctx, "", "This link is no longer valid. Ask for a new one."), 400);
  // Show WHOSE account this link sets — a wrong recipient sees an address that isn't
  // theirs and stops, and no one can quietly claim a different identity (it's read-only).
  return htmlResponse(invitePage(tctx, token, "", email), 200);
}

async function invitePost(tctx, request, url, env, users = tctx.USERS) {
  const form = await request.formData();
  const token = (form.get("token") || "").toString();
  const password = (form.get("password") || "").toString();

  // Validate the password BEFORE consuming the token, so a typo doesn't burn the link.
  const email = await readInvite(env, token);
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

  const consumed = await consumeInvite(env, token);
  if (!consumed) return htmlResponse(invitePage(tctx, "", "This link is no longer valid. Ask for a new one."), 400);

  // From here on the token is already burned — a thrown error must not escape as
  // an unhandled exception (dead link, no explanation) but fail cleanly instead.
  try {
    await setUserSecret(env, u.email, hash);
    const token2 = await userToken(env, u);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${USER_COOKIE}=${u.email}.${token2}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("invite: setUserSecret failed", e && e.stack || e);
    return htmlResponse(invitePage(tctx, "", "Something went wrong setting your password. Ask for a new link."), 500);
  }
}

// Session cookie token: HMAC-SHA-256(SESSION_SECRET, "email:effectiveSecret").
// SESSION_SECRET is a runtime env var — NEVER baked into the bundle — so a cookie
// cannot be forged from repo-visible data. Binding to the effective secret means
// changing or clearing a password invalidates that user's cookies for free.
// `resolved` is an OPTIONAL pre-resolved effective secret. identify() passes the one
// value it guarded on so the guard and the derivation cannot disagree; every other
// caller omits it and this resolves its own, unchanged.
async function userToken(env, u, resolved) {
  const secret = resolved === undefined ? await effectiveSecret(env, u) : resolved;
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
// no session store. `users` defaults to the injected USERS; tests pass their own list.
async function identify(request, env, users = USERS) {
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
  if (!secret) return null;
  const token = val.slice(dot + 1);
  if (safeEqual(token, await userToken(env, u, secret))) return u;
  return null;
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
// renames/etc.) reads & writes the PRODUCTION KV — the shared live-overlay layer.
// (wrangler's remote KV bindings 500 on every op, so we go straight to the KV REST
// API.) Active ONLY when GV_KV_TOKEN is present; in prod it's unset → the normal
// env.COMMENTS binding is returned and nothing changes. The shim mirrors the subset of
// the KV API the worker uses: get / put / list.
function kvFor(env) {
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

const PUBLISH_TOKENS_KEY = "publish:tokens"; // KV {sha256("pub:"+token): {space,label,createdAt}}
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

let MANIFESTS = { at: 0, spaces: {}, etags: {} };
async function loadManifests(env, force) {
  if (!force && Date.now() - MANIFESTS.at < 1500) return MANIFESTS.spaces;
  MANIFESTS.at = Date.now();
  try {
    const list = await env.BUNDLES.list({ prefix: "spaces/", delimiter: "/" });
    const ids = (list.delimitedPrefixes || []).map((p) => p.slice("spaces/".length, -1));
    const out = {}, etags = {};
    // Parse cost must not ride the request path: JSON.parse of a multi-MB manifest
    // on the refresh tick is what blew the CPU budget when the 2026-08-22 cascade
    // doubled a live instance's manifest (error 1102). head+etag per manifest is
    // metadata-only — the body is fetched and parsed ONLY when the etag moved, i.e.
    // once per publish rather than once per tick. `force` (the publish API's own
    // callers) still bypasses the parse skip via the etag change it just caused.
    await Promise.all(ids.map(async (id) => {
      const key = `spaces/${id}/manifest.json`;
      const head = env.BUNDLES.head ? await env.BUNDLES.head(key) : null;
      const etag = head && (head.etag || head.httpEtag);
      if (etag && MANIFESTS.etags[id] === etag && MANIFESTS.spaces[id]) {
        out[id] = MANIFESTS.spaces[id];
        etags[id] = etag;
        return;
      }
      const obj = await env.BUNDLES.get(key);
      if (!obj) return;
      out[id] = JSON.parse(await obj.text());
      etags[id] = etag || (obj.etag || obj.httpEtag) || "";
    }));
    MANIFESTS.spaces = out;
    MANIFESTS.etags = etags;
  } catch (e) {} // a transient list/get failure keeps serving the last good view
  return MANIFESTS.spaces;
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
    SPACES: applySpaceIcons(spaces, spaceIcons),
    CHROME_POINTER: chromePointer,
    RUNTIME_CHROME: runtimeChrome,
  };
}

// Transitional test seam: write the derived fields into the module globals the ~110 read
// sites still use. The request path no longer calls this — loadTenantContext takes the
// same value and puts it on a context — but the gate, board and link-preview baselines
// drive it directly to seed a routing table. It goes when the globals do.
//
// ⚠️ It advances TENANT_CTX for the same reason applyInstance does: the router hands the
// context down now, so a seam that seeded only the globals would let a threaded read site
// and an unthreaded one answer differently from the same fixture.
function applyDerivedRouting(manifests) {
  const f = derivedRoutingFields(manifests, SPACE_ICONS);
  TENANT_CTX = withTenantFields(TENANT_CTX, f);
  BUILD_ID = f.BUILD_ID;
  VERSION_MAP = f.VERSION_MAP;
  PUBLIC_PREFIXES = f.PUBLIC_PREFIXES;
  PUBLIC_SKILL_PREFIXES = f.PUBLIC_SKILL_PREFIXES;
  RESTRICTED_BASES = f.RESTRICTED_BASES;
  CANVAS_LOADER_EXTRAS = f.CANVAS_LOADER_EXTRAS;
  CANVAS_CATALOG = f.CANVAS_CATALOG;
  CANVAS_TRACKS = f.CANVAS_TRACKS;
  MCP_HOST_ALLOWLIST = f.MCP_HOST_ALLOWLIST;
  mcpStaticHosts = f.mcpStaticHosts;
  MCP_PATH_ALLOWLIST = f.MCP_PATH_ALLOWLIST;
  SPACES = f.SPACES;
  CHROME_POINTER = f.CHROME_POINTER;
  RUNTIME_CHROME = f.RUNTIME_CHROME;
  // Returns the CONTEXT, not the bare field patch. It is a superset — every field of the
  // patch is a field of the context — so a caller reading `f.MCP_PATH_ALLOWLIST` reads the
  // same value, and a caller that now has to hand a context to a threaded predicate has
  // one without seeding anything twice.
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
const ENGINE_CHROME_PATHS = [
  "/fonts/", "/pitis/", "/__review/", "/__canvas/", "/admin", "/changelog",
  "/piti.js", "/404.html", "/manifest.webmanifest", "/sw.js",
  "/augur-eye.svg", "/augur-icon-192.png", "/augur-icon-512.png", "/augur-mark.png",
];
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
    if (f) return f;
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
  if (direct) return { f: direct };
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
async function assetFetch(env, request) {
  if (!bundleMode(env)) return env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const manifests = await loadManifests(env);
  const r = resolveBundlePath(manifests, url.pathname);
  if (r.redirect) return Response.redirect(new URL(r.redirect + url.search, url).toString(), 308);
  if (r.miss) return new Response("Not Found", { status: 404 });
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
async function assetPathExists(env, url) {
  if (!bundleMode(env)) {
    const asset = await env.ASSETS.fetch(new Request(url.toString()));
    return asset.status !== 404;
  }
  const r = resolveBundlePath(await loadManifests(env), url.pathname);
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
function synthBuildStamp(tctx, manifests) {
  const spaces = {}, engine = { sha: null };
  if (tctx.INSTANCE_ENGINE_VERSION) engine.version = tctx.INSTANCE_ENGINE_VERSION;
  let builtAt = null;
  // /_build.json is served BEFORE the gate, so publishedBy must not leak the raw email
  // the publish token is labelled with. Map it to the roster display name when known,
  // else the local-part — enough to say who published, without publishing addresses.
  const byName = (label) => {
    if (!label) return "";
    const u = userByEmail(label, tctx.USERS);
    return u ? u.name : String(label).split("@")[0];
  };
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
      engine.sha = src.sha || null;
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
async function publishAuth(request, env, spaceId, anySpace) {
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m) return null;
  const token = m[1].trim();
  if (env.PUBLISH_BOOTSTRAP_TOKEN && token === env.PUBLISH_BOOTSTRAP_TOKEN) {
    return { space: "*", label: "bootstrap" };
  }
  const kv = kvFor(env);
  if (!kv) return null;
  try {
    const h = await tokenFor("pub:" + token);
    const raw = await kv.get(PUBLISH_TOKENS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const e = map[h];
    if (!e) return null;
    // A star-scope token is admin-equivalent — it pushes instance config, i.e. the user
    // list itself. `augur login` labels the token it mints with the holder's email, so if
    // that address is still on the roster but is no longer an admin, the token has
    // outlived the role that justified it. (Reset and remove revoke tokens outright; a
    // demotion is the one transition that left one live.) Labels an admin typed by hand
    // — "ci", "backup" — match no roster user and are unaffected.
    if (e.space === "*" && e.label) {
      const u = userByEmail(e.label);
      if (u && roleOf(u) !== "admin") return null;
    }
    // The same reasoning one rung down, and the reason it is here rather than only at
    // mint time: a viewer may not hold ANY publish token, but a demotion happens to an
    // account that already has one. The role op revokes on demotion; this catches the
    // paths that never go through it — a hand-edited identity.json, a config push that
    // lands before the revoke, a token minted while the overlay was mid-write.
    if (e.label) {
      const u = userByEmail(e.label);
      if (u && roleOf(u) === "viewer") return null;
    }
    if (!anySpace && e.space !== "*" && e.space !== spaceId) return null;
    return e;
  } catch (err) { return null; }
}

async function publishApi(request, url, env) {
  if (!env.BUNDLES) return jsonResponse({ error: "bundle-store-not-configured" }, 501);
  const [spaceId, op, arg] = url.pathname.slice("/__publish/".length).split("/");
  if (!spaceId || !op || !/^[a-z0-9_][a-z0-9-]*$/.test(spaceId)) return jsonResponse({ error: "bad-path" }, 400);

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
    const u = userByEmail(email);
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
    const kv = kvFor(env);
    if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
    // A viewer signs in, comments and drives boards like anyone else, but can never
    // hold a publish token — the role for accounts whose password is public knowledge
    // (a demo instance's loginHint). Checked after credential verification so an
    // unknown email and a viewer stay indistinguishable in timing.
    if (roleOf(u) === "viewer") {
      return jsonResponse({ error: "viewer-role", message: "This account can look around but not publish." }, 403);
    }
    const space = roleOf(u) === "admin" ? "*" : (SPACES.find((s) => s.default) || { id: null }).id;
    if (!space) return jsonResponse({ error: "no-default-space" }, 500);
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const raw = await kv.get(PUBLISH_TOKENS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[await tokenFor("pub:" + token)] = { space, label: u.email, createdAt: new Date().toISOString() };
    await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    return jsonResponse({ token, space });
  }

  // Sanitized contributor profiles for identity-less builds (any valid publish
  // token): name/initials/color/avatar URL + email aliases — exactly what the
  // build needs to keep editor chips on cards, and nothing secret. The avatar
  // URLs resolve at runtime against the instance's real identity, so a build
  // from a bare space clone renders the same faces an identity-file build does.
  if (spaceId === "_instance" && op === "profiles" && request.method === "GET") {
    if (!(await publishAuth(request, env, spaceId, true))) return jsonResponse({ error: "forbidden" }, 403);
    // No `role` here: any valid publish token (including a non-admin default-space one)
    // can read this, and it only needs the fields that render editor faces — leaking
    // who the admins are is gratuitous.
    const profiles = USERS.map((u) => ({
      id: personId(u.email),
      email: u.email, emails: u.emails || [],
      name: u.name, initials: u.initials || "", color: u.color || "#4f46e5",
      avatar: avatarUrl(u),
    }));
    return jsonResponse({ profiles });
  }

  const who = await publishAuth(request, env, spaceId);
  if (!who) return jsonResponse({ error: "forbidden" }, 403);

  // Instance config push (star-scope tokens only): the deploy shell's identity +
  // knobs become config/instance.json — the bundle-mode source loadConfig reads.
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
      const liveObj = await env.BUNDLES.get("config/instance.json");
      const live = liveObj ? JSON.parse(await liveObj.text()) : null;
      if (live && live.engineVersion) {
        const incoming = cfg.engineVersion || "";
        if (!incoming || semverBehind(incoming, live.engineVersion)) {
          return jsonResponse({ error: "engine-downgrade", live: live.engineVersion, publishing: incoming || null }, 409);
        }
      }
    } catch (e) {}
    await env.BUNDLES.put("config/instance.json", body);
    cfgAt = 0;
    // The deploy that ships an updated identity file also retires the roster
    // overlay entries it supersedes: an `add` the config now names is a duplicate
    // record (invites flow back into the file via roster-update), and a `remove`
    // for someone the config no longer names has finished its job. The
    // users:secrets tombstones are NOT touched — they are the security boundary;
    // this is only the roster list converging back to one record.
    try {
      const kv = kvFor(env);
      if (kv) {
        const named = new Set((cfg.users || []).map((u) => String((u && u.email) || "").toLowerCase()).filter(Boolean));
        const roster = await readRoster(env);
        const add = Object.fromEntries(Object.entries(roster.add).filter(([e]) => !named.has(String(e).toLowerCase())));
        const remove = roster.remove.filter((e) => named.has(String(e).toLowerCase()));
        if (Object.keys(add).length !== Object.keys(roster.add).length || remove.length !== roster.remove.length) {
          await kv.put(USER_ROSTER_KEY, JSON.stringify({ ...roster, add, remove }));
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
    const have = new Set();
    const all = await loadManifests(env, true);
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
      minProtocol: MIN_CLIENT_PROTOCOL || undefined,
      engine: INSTANCE_ENGINE_VERSION || null,
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
    const obj = await env.BUNDLES.get(`spaces/${spaceId}/manifest.json`);
    if (!obj) return jsonResponse({ error: "unknown-space" }, 404);
    return new Response(obj.body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Version list, newest first. Manifest history is never pruned and blobs are
  // never garbage-collected, so this doubles as the rollback menu.
  if (op === "versions" && request.method === "GET") {
    const versions = [];
    let cursor;
    try {
      do {
        const page = await env.BUNDLES.list({ prefix: `spaces/${spaceId}/versions/`, cursor, limit: 1000 });
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
    const obj = await env.BUNDLES.get(`spaces/${spaceId}/versions/${v}.json`);
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
    // ── Manifest ceilings: refuse instead of degrade. ─────────────────────────
    // An oversized manifest is not merely rude — every request on the instance
    // pays for it (the refresh tick re-parses it; 1102s on live within hours of
    // the 2026-08-22 cascade doubling one manifest), which multi-tenant means one
    // space degrading everyone. And a manifest sprouting -conflict- prefixes is
    // the signature of that cascade itself: protocol-5 clients cannot produce one
    // (the litter filter), so arrival here means an old, patched, or hostile
    // client — the write is refused, the litter never goes live. Ceilings sit
    // ~4-8x above the reference instance's real size (3.8k files, 142 prefixes,
    // 0.7MB manifest, 0 conflict prefixes at v499): headroom for growth, a wall
    // against runaway. `sanity` names the failing limit so a legitimate giant
    // space raises the ceiling deliberately, in code, not by quiet erosion.
    const ceiling = (() => {
      const files = Object.keys(m.files).length;
      if (files > 30000) return { limit: "files", value: files, max: 30000 };
      const prefixes = ((m.routing || {}).publicPrefixes || []);
      if (prefixes.length > 1000) return { limit: "prefixes", value: prefixes.length, max: 1000 };
      const litter = prefixes.filter((p) => /-conflict-[a-z0-9][a-z0-9-]*\/?$/.test(String(p))).length;
      if (litter > 20) return { limit: "conflict-prefixes", value: litter, max: 20 };
      const bytes = JSON.stringify(m).length;
      if (bytes > 8_000_000) return { limit: "manifest-bytes", value: bytes, max: 8_000_000 };
      return null;
    })();
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
    if (MIN_CLIENT_PROTOCOL && clientProtocol < MIN_CLIENT_PROTOCOL) {
      return jsonResponse({
        error: "cli-outdated",
        clientProtocol,
        minProtocol: MIN_CLIENT_PROTOCOL,
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
    const liveManifests = await loadManifests(env, true);
    // ── Untrusted-token guard — the fix that keeps a space token to its own space. Any
    // signed-in user can mint a default-space token (`augur login`), so without this a
    // user could commit a manifest that claims /admin/* or /__canvas/canvas.js (engine
    // chrome) or another space's paths, and shadow them — then run script as the next
    // admin who loads that asset. STAR-scope tokens ("*") are admin/CI-only and already
    // all-powerful (they push instance config, i.e. the user list), so they are exempt —
    // that is also how the trusted `_engine` chrome publish writes /admin, /404.html, etc.
    if (who.space !== "*") {
      const commitIsDefault = spaceId === ((SPACES.find((s) => s.default) || {}).id || null);
      const ownsPath = (k) => pathOwnedBySpace(k, spaceId, SPACES);
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
          if (!isPublishablePublicPrefix(p, spaceId, SPACES)) {
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
    const curObj = await env.BUNDLES.get(`spaces/${spaceId}/manifest.json`);
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
    if (typeof baseVersion === "number" && baseVersion !== ((cur && cur.version) || 0)) {
      return jsonResponse({
        error: "stale-base",
        liveVersion: (cur && cur.version) || 0,
        liveSource: cur && cur.source
          ? { sha: cur.source.sha || null, dirty: !!cur.source.dirty } : null,
      }, 409);
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
    for (const s of INSTANCE_SENTINELS) {
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
    const version = ((cur && cur.version) || 0) + 1;
    const out = { ...m, version, publishedAt: new Date().toISOString(), publishedBy: who.label || "" };
    await env.BUNDLES.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
    await env.BUNDLES.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
    MANIFESTS.at = 0; cfgAt = 0; // this isolate flips immediately; others within ~1.5s
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
        const engObj = await env.BUNDLES.get("spaces/_engine/manifest.json");
        const engRef = engObj ? JSON.parse(await engObj.text()) : null;
        const engineSha = (engRef && ((engRef.builtWith && engRef.builtWith.engine) || (engRef.source && engRef.source.sha))) || null;
        const publishedWith = (out.builtWith && out.builtWith.engine) || null;
        if (engineSha && publishedWith !== engineSha) {
          const kv = kvFor(env);
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
    return jsonResponse({ ok: true, version, ...(rebake ? { rebake } : {}) });
  }

  if (op === "rollback" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const v = parseInt(body && body.version, 10);
    if (!v || v < 1) return jsonResponse({ error: "bad-version" }, 400);
    const prev = await env.BUNDLES.get(`spaces/${spaceId}/versions/${v}.json`);
    if (!prev) return jsonResponse({ error: "unknown-version" }, 404);
    // History is append-only: a rollback republishes the old CONTENT under a NEW
    // version number rather than repointing at the old one. Reusing the number
    // looked tidier and was a trap — the next publish would compute
    // cur.version + 1 and overwrite an existing versions/<n>.json, quietly
    // destroying a point in the history that recovery depends on. It also means
    // a rollback is itself visible in the history, and undone by another one.
    const restored = JSON.parse(await prev.text());
    const curObj = await env.BUNDLES.get(`spaces/${spaceId}/manifest.json`);
    const cur = curObj ? JSON.parse(await curObj.text()) : null;
    const version = ((cur && cur.version) || 0) + 1;
    const out = {
      ...restored, version,
      publishedAt: new Date().toISOString(),
      publishedBy: `rollback to v${v} by ${who.label || "unknown"}`,
    };
    await env.BUNDLES.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
    await env.BUNDLES.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
    MANIFESTS.at = 0; cfgAt = 0;
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
async function removeFromStore(env, spaceId, urlPrefix, by) {
  if (!env.BUNDLES) return { skipped: "no-store" };
  const obj = await env.BUNDLES.get(`spaces/${spaceId}/manifest.json`);
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
  for (const s of INSTANCE_SENTINELS) {
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
  const version = (cur.version || 0) + 1;
  const out = {
    ...cur, files, routing, version,
    publishedAt: new Date().toISOString(),
    publishedBy: `delete by ${by || "admin"}`,
  };
  await env.BUNDLES.put(`spaces/${spaceId}/versions/${version}.json`, JSON.stringify(out));
  await env.BUNDLES.put(`spaces/${spaceId}/manifest.json`, JSON.stringify(out));
  MANIFESTS.at = 0; cfgAt = 0;
  return { removed, version };
}

// Repo path → live URL prefix. The two shapes DELETE_PATH_RE allows are
// "<folder>/prototypes/<name>" and "playground/<name>"; the served URLs drop the
// "prototypes/" segment ("/<folder>/<name>/") and carry the space's base for every
// space but the default.
function deleteUrlPrefix(space, repoPath) {
  const parts = repoPath.split("/");
  const tail = parts[0] === "playground"
    ? `/playground/${encodeURIComponent(parts[1])}/`
    : `/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[2])}/`;
  // An unknown space must NOT fall back to the root form: that would aim the
  // deletion at the default space's URLs instead. No space, no prefix.
  const meta = SPACES.find((s) => s.id === space);
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
async function adminTokensApi(request, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);
  const raw = await kv.get(PUBLISH_TOKENS_KEY);
  const map = raw ? JSON.parse(raw) : {};
  if (request.method === "GET") return jsonResponse({ tokens: map });
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const space = clamp(op && op.space, 60).trim() || "*";
    const label = clamp(op && op.label, 80).trim() || "unnamed";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    map[await tokenFor("pub:" + token)] = { space, label, createdAt: new Date().toISOString() };
    await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    return jsonResponse({ token, space, label });
  }
  if (request.method === "DELETE") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const h = clamp(op && op.hash, 80);
    if (!map[h]) return jsonResponse({ error: "unknown-token" }, 404);
    delete map[h];
    await kv.put(PUBLISH_TOKENS_KEY, JSON.stringify(map));
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Admin: bundle-store usage ----------------------------------------------
// Sums the store (5-min isolate cache — a full list is a few subrequests at
// ~2.5k objects) against the R2 free-tier ceiling so the admin panel can show
// a fill gauge long before a publish would ever hit the wall.
const STORE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // R2 free tier: 10 GB
let STORAGE_CACHE = { at: 0, data: null };
async function adminStorageApi(env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  if (!env.BUNDLES) return jsonResponse({ enabled: false });
  if (STORAGE_CACHE.data && Date.now() - STORAGE_CACHE.at < 5 * 60 * 1000) {
    return jsonResponse(STORAGE_CACHE.data);
  }
  let bytes = 0, objects = 0, cursor;
  try {
    do {
      const page = await env.BUNDLES.list({ cursor, limit: 1000 });
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
  STORAGE_CACHE = { at: Date.now(), data };
  return jsonResponse(data);
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
// Values are copied as RAW STRINGS and never re-parsed. Most are JSON, but a backup
// that parses is a backup that can fail on something it did not expect, and re-encoding
// would not round-trip byte-for-byte.
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
        push(`{"format":1,"at":${JSON.stringify(new Date().toISOString())},"data":{`);
        const expirations = {};
        const vanished = [];
        let count = 0, bytes = 0, first = true, cursor;
        do {
          const page = await kv.list({ cursor, limit: 1000 });
          for (const k of page.keys || []) {
            // A throw here is a genuine read failure — permissions, transport, a broken
            // namespace. It must NOT become a quietly shorter file: rethrow, and the
            // catch below tears the stream down so the document never closes.
            const v = await kv.get(k.name, "text");
            if (v === null) {
              // Listed, then gone before it could be read. Real and expected — rate-limit
              // keys carry TTLs — but recorded by name rather than dropped, so a restore
              // can tell "this key was not in the namespace" from "this backup lost it".
              vanished.push(k.name);
              continue;
            }
            if (k.expiration) expirations[k.name] = k.expiration;
            push(`${first ? "" : ","}${JSON.stringify(k.name)}:${JSON.stringify(v)}`);
            first = false;
            count++;
            bytes += v.length;
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        // Trailers last, so they can report on the walk that produced them. `complete`
        // is the flag a consumer should check — though it barely needs to, because the
        // failure path below never writes this object at all.
        push(`},"expirations":${JSON.stringify(expirations)}`);
        push(`,"vanished":${JSON.stringify(vanished)}`);
        push(`,"count":${count},"bytes":${bytes},"complete":true}`);
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

function loginPage(tctx, redirect, error, requestUrl) {
  const safeRedirect = String(redirect).replace(/"/g, "&quot;");
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
    .logo img { border-radius: 50%; object-fit: cover; }
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
    <form method="POST" action="/__auth">
      <input type="hidden" name="redirect" value="${safeRedirect}" />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required value="${escapeHtml(tctx.LOGIN_PREFILL_EMAIL)}" ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required value="${escapeHtml(tctx.LOGIN_PREFILL_PASSWORD)}" ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ""} />
      <button type="submit">Enter</button>
      <p class="error" id="pw-err" role="alert">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        <span>${typeof error === "string" ? escapeHtml(error) : "Incorrect email or password. Try again."}</span>
      </p>
    </form>
    ${tctx.LOGIN_HINT ? `<p class="hint">${escapeHtml(tctx.LOGIN_HINT)}</p>` : ""}
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
  <title>Not found · Augur</title>${SPACES.some((s) => s.default) ? `\n  <link rel="icon" href="/space-icon.png" />` : ""}
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

// Test seam: loadConfig sets CHROME_POINTER/SPACES/RUNTIME_CHROME from routing.json in a
// live isolate; this lets a unit test drive composeChrome without a config load.
function __setChromeTestState(pointer, spaces, on) {
  // ⚠️ TENANT_CTX moves with the globals — see applyInstance. A seam that seeded one and
  // not the other would give composeChrome a different answer through the threaded
  // context than through the binding it is replacing.
  TENANT_CTX = withTenantFields(TENANT_CTX, {
    CHROME_POINTER: pointer, SPACES: spaces, RUNTIME_CHROME: on,
  });
  CHROME_POINTER = pointer;
  SPACES = spaces;
  RUNTIME_CHROME = on;
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
const MCP_PROXY_PATHS = new Set([
  "/mcp",
  "/oauth/registrations",
  "/oauth/token",
]);

// Exact-host allowlist, fetched once per isolate from MCP_HOST_ALLOWLIST_URL — a
// JSON document shaped {"hosts": ["…"]}. A suffix rule cannot express a platform
// living on its own vanity domain without opening that domain's whole public
// suffix, and an "answers like a platform?" probe would turn this route into an
// open proxy for anything reachable from the deploy network — so the instance
// publishes an explicit list instead. Unset, or unreachable, means no host beyond
// MCP_HOST_SUFFIXES is allowed: the route behaves exactly as it does without the
// knob rather than failing closed on traffic that works today.
let mcpHostAllowlist = null;

function mcpAllowlist(tctx) {
  if (!tctx.MCP_HOST_ALLOWLIST_URL) return Promise.resolve(null);
  if (!mcpHostAllowlist) {
    mcpHostAllowlist = fetch(tctx.MCP_HOST_ALLOWLIST_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((doc) => new Set(Array.isArray(doc && doc.hosts) ? doc.hosts : []))
      .catch(() => { mcpHostAllowlist = null; return null; }); // retry on the next request
  }
  return mcpHostAllowlist;
}

// Space-declared exact hosts, from routing.json (see build.js): no extra fetch, no
// failure mode, and a space publish refreshes the list with the same deploy that
// ships the prototype using it. Rebuilt by loadConfig on every config refresh.
let mcpStaticHosts = new Set();

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
  if (!MCP_PROXY_PATHS.has(path) && !MCP_PATH_ALLOWLIST.includes(path))
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
function stampAuthor(rawAuthor, me) {
  if (me) return { author: me.name, verified: true };
  const a = clamp(rawAuthor, 80) || "Anonymous";
  const collides = USERS.some((u) => u.name && u.name === a);
  return { author: collides ? "Anonymous" : a, verified: false };
}

function sanitizeMsg(m, me) {
  const { author, verified } = stampAuthor(m && m.author, me);
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

// Apply a single review op to a thread array; returns the new array. `me` is the
// server-resolved signed-in user (or null) — passed to sanitizeMsg so authorship of
// every added/replied message is stamped from the session, not the request body.
function applyOp(threads, op, me) {
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
        messages: (Array.isArray(t.messages) ? t.messages : []).slice(0, 1).map((m) => sanitizeMsg(m, me)),
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
    if (t) t.messages = (t.messages || []).concat([sanitizeMsg(op.message, me)]).slice(0, 200);
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
async function reviewApi(request, url, env, authed) {
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
    const me = await identify(request, env);
    const raw = await kv.get(key);
    let threads = raw ? JSON.parse(raw) : [];
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
    threads = applyOp(threads, op, me);
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
  // the first user's) map, leaking pins across accounts. A new user starts empty.
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

async function deleteApi(request, env, me) {
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
    const prefix = deleteUrlPrefix(space, path);
    if (!prefix) return jsonResponse({ error: "unknown-space", space }, 400);
    try {
      store = await removeFromStore(env, space, prefix, me ? me.email : "");
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

async function canvasesApi(request, url, env, me) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ map: {}, warning: "no-kv-binding" });

  if (request.method === "GET") {
    const raw = await kv.get(CANVASES_KEY);
    return jsonResponse({ map: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    const raw = await kv.get(CANVASES_KEY);
    const map = raw ? JSON.parse(raw) : {};

    if (op && op.remove) {
      const path = clamp(op.path, 300);
      if (!map[path]) return jsonResponse({ error: "not-found" }, 404);
      // The board doc (board:<path>) is left in KV on purpose — recreating the same
      // name restores the board, so a mis-click never destroys anyone's work.
      delete map[path];
      await kv.put(CANVASES_KEY, JSON.stringify(map));
      bustCanvasRegistry();
      return jsonResponse({ map });
    }
    // Rename in place: the display name changes, the path (and so the board doc)
    // stays — same model as card renames, but the registry IS the name store here.
    if (op && op.rename) {
      const path = clamp(op.path, 300);
      const name = clamp(op.name, 80).trim();
      if (!map[path] || !name) return jsonResponse({ error: "bad-input" }, 400);
      map[path].name = name;
      await kv.put(CANVASES_KEY, JSON.stringify(map));
      bustCanvasRegistry();
      return jsonResponse({ map });
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
    if (await assetPathExists(env, new URL(path, url))) return jsonResponse({ error: "exists", path }, 409);
    map[path] = { name, by: me ? me.email : "", t: Date.now() };
    await kv.put(CANVASES_KEY, JSON.stringify(map));
    bustCanvasRegistry();
    return jsonResponse({ map, path });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// From routing.json: the extra tags every BUILT prototype page carries — the
// review/comment overlay (graph.js + comments.js, which power C-to-comment and
// Shift+C provenance) plus any build addon's tags. Without this a worker-served
// canvas page mounts the engine but loses the overlay stack that real prototype
// files get injected at build.
let CANVAS_LOADER_EXTRAS = "";

// The two site-wide canvas aggregates — every embeddable thing across all spaces
// (the insert picker's catalog) and every track any space installs. They are
// SYNTHESIZED here, never shipped as files, because no single publisher ever holds
// the whole picture: content publishes one space at a time, so a space that wrote
// the whole file would blank every other space's entries. Each space contributes
// its own slice in its routing fragment; these hold the merge. Both modes feed
// them: bundle mode from the live manifests (applyDerivedRouting), assets mode
// from routing.json (loadConfig).
let CANVAS_CATALOG = [];
let CANVAS_TRACKS = [];

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
const CANVAS_REG_TTL_MS = 15_000;
let canvasRegAt = 0;
let canvasRegRaw = null;
async function readCanvasRegistry(kv) {
  if (!canvasRegAt || Date.now() - canvasRegAt >= CANVAS_REG_TTL_MS) {
    try {
      canvasRegRaw = await kv.get(CANVASES_KEY);
      canvasRegAt = Date.now();
    } catch (e) {}
  }
  return canvasRegRaw;
}
const bustCanvasRegistry = () => { canvasRegAt = 0; };

// Serve a registered created-canvas path (null when the path isn't one). Called only
// on asset 404s, so the extra kv.get never taxes a real page load. Bare
// "/dir/slug" redirects to the trailing-slash form — the board doc and the room are
// keyed by the page's URL path, and two spellings must not split one board in two.
async function virtualCanvas(tctx, request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const kv = kvFor(env);
  if (!kv) return null;
  let p = url.pathname;
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  const normalized = p.endsWith("/") ? p : p + "/";
  if (!CANVAS_DIR_RE.test(normalized)) return null;
  const raw = await readCanvasRegistry(kv);
  if (!raw) return null;
  let entry;
  try { entry = JSON.parse(raw)[normalized]; } catch (e) { return null; }
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

// ---- Canvas board images (/__asset) -----------------------------------------
// Pasted/dropped canvas images used to be inlined into the board doc as data URLs, which
// made every doc write (and every room seed) carry every image ever pasted. Now the client
// uploads the compressed JPEG once; we store it under its content hash (immutable, so the
// browser caches it forever) and the doc carries only the tiny /__asset/<hash> URL.
// Old boards with inline data URLs still render — <img src> takes either form.
const ASSET_PREFIX = "basset:";
const ASSET_MAX_BYTES = 4 * 1024 * 1024; // client compresses to ~<1MB; hard stop well below that x4
async function assetApi(request, url, env) {
  const kv = kvFor(env);
  if (!kv) return jsonResponse({ error: "no-kv-binding" }, 503);
  if (request.method === "POST" && url.pathname === "/__asset") {
    const ct = (request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return jsonResponse({ error: "bad-type" }, 415);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > ASSET_MAX_BYTES) return jsonResponse({ error: "too-large" }, 413);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
    const key = ASSET_PREFIX + hash;
    // content-addressed → a re-paste of the same image is free (skip the duplicate write)
    if ((await kv.get(key, { type: "arrayBuffer" })) === null) {
      await kv.put(key, buf, { metadata: { ct } });
    }
    return jsonResponse({ url: "/__asset/" + hash });
  }
  if (request.method === "GET") {
    const hash = url.pathname.slice("/__asset/".length);
    if (!/^[0-9a-f]{40}$/.test(hash)) return jsonResponse({ error: "bad-input" }, 400);
    const got = await kv.getWithMetadata(ASSET_PREFIX + hash, { type: "arrayBuffer" });
    if (!got || !got.value) return jsonResponse({ error: "not-found" }, 404);
    return new Response(got.value, {
      headers: {
        "content-type": (got.metadata && got.metadata.ct) || "image/jpeg",
        // content-hashed = immutable: one KV read per browser, ever
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

// ---- Canvas multiplayer proxy (/__rt → the instance's realtime worker) ------
// The BoardRoom Durable Objects live in a SEPARATE worker (Pages can't define DO
// classes), deployed from realtime/ — one PER INSTANCE, each with its own name and
// its own board KV binding, or rooms (keyed by board path) and board docs would be
// shared across instances. Proxying keeps the client same-origin (no hardcoded
// workers.dev URL in canvas.js, works offline too); fetch() with the Upgrade header
// intact returns the 101 + socket, passed through. Injected at build from the deploy
// config's `realtimeOrigin`; without one, boards run solo (the client's socket-down
// fallback: it persists via /__board to this instance's own KV).
let RT_ORIGIN = "";
function rtProxy(tctx, request, url, env) {
  // Sandbox seal (offline mode without deploy creds): local KV alone is not a sandbox
  // if the canvas still joins the shared rooms — board ops would half-escape while
  // solo saves diverge locally. The flag beats a configured origin on purpose.
  if (env && env.GV_RT_DISABLE) return jsonResponse({ error: "realtime-disabled" }, 501);
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
async function adminUsersApi(request, url, env, me, users = USERS, configUsers = CONFIG_USERS, spaces = SPACES) {
  // Admin of ANY space gets in; every mutation below re-checks the SPECIFIC space it
  // touches. On an instance that never set memberships this is the old global check,
  // because a global admin administers everything by default.
  if (!me || !administersAny(me, spaces)) return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);
  // A roster write lands in THIS isolate immediately (so the list the admin is looking
  // at is right) and everywhere else on the next config tick, which cfgAt=0 brings
  // forward to the next request. Only the live list is touched — a caller that injected
  // its own roster (tests) gets its list back untouched.
  const commitRoster = (roster) => {
    const next = mergeRoster(configUsers, roster);
    // ⚠️ The context moves with the binding — see applyInstance. The router serves from
    // the context now, so a roster written here has to land in both or this isolate
    // answers one way through the threaded read sites and another through the rest.
    if (users === USERS) { USERS = next; TENANT_CTX = withTenantFields(TENANT_CTX, { USERS: next }); }
    cfgAt = 0;
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
    const out = [];
    for (const u of inScope) {
      let lastSeen = null;
      try { lastSeen = kv ? await kv.get(LASTSEEN_PREFIX + u.email) : null; } catch (e) {}
      const secret = await effectiveSecret(env, u);
      out.push({
        email: u.email, name: u.name, role: scope ? roleIn(u, scope) : roleOf(u),
        initials: u.initials || "", color: u.color || "#4f46e5",
        avatar: avatarUrl(u),
        state: secret ? "accepted" : "pending",
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
          ...extra,
        },
      }, { kv });
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
      await revokeSecret(env, u.email);
      await revokePublishTokens(env, u.email); // a reset password must not leave a live publish token
      const token = await mintInvite(env, u.email);
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
      const roster = await readRoster(env);
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
      // A stale hash under this address (a previous member of the same name) would make
      // the new invitee "accepted" on arrival, holding someone else's old password.
      await revokeSecret(env, email);
      const token = await mintInvite(env, email);
      commitRoster(roster);
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
      const index = await readSpaces(env);
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
      cfgAt = 0; // the next request re-reads, so the panel sees its own write
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
      const overlay = await readRoles(env);
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
        await clearRole(env, email);
      } else {
        overlay[email] = role;
        await kv.put(USER_ROLES_KEY, JSON.stringify(overlay));
      }
      // Keep the roster overlay honest too, for an invited (non-config) user — the
      // roles overlay is what takes effect, but two records disagreeing about the same
      // person is how the next reader gets it wrong.
      const roster = await readRoster(env);
      if (roster.add[email]) {
        roster.add[email].role = role;
        await kv.put(USER_ROSTER_KEY, JSON.stringify(roster));
      }

      // A demotion must not leave the privilege behind in a token. Losing admin drops
      // the star-scope token; becoming a viewer drops every publish token they hold,
      // because a viewer may hold none at all. publishAuth re-checks both at resolve
      // time as well — this is the immediate half, that one is the durable half.
      if (role === "viewer") await revokePublishTokens(env, email);
      else if (from === "admin") await revokePublishTokens(env, email);

      // USERS in this isolate, then everywhere on the next tick — same as invite/remove.
      const nextRoles = await readRoles(env);
      if (users === USERS) {
        USERS = applyRoles(mergeRoster(configUsers, roster), nextRoles);
        // ⚠️ The context moves with the binding it is replacing. The router hands the
        // context down now, so leaving TENANT_CTX behind here would make this isolate's
        // freshened roster visible through the global and invisible through the context.
        TENANT_CTX = withTenantFields(TENANT_CTX, { USERS });
      }
      cfgAt = 0;

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
      const roster = await readRoster(env);
      delete roster.add[email];
      // Only a CONFIG user needs a tombstone in the list — dropping the add entry is
      // enough for an invited one, and an unbounded remove list would grow forever.
      if (userByEmail(email, configUsers) && !roster.remove.some((e) => lcEmail(e) === email)) {
        roster.remove.push(email);
      }
      await kv.put(USER_ROSTER_KEY, JSON.stringify(roster));
      // The CANONICAL address, not the lowercased key: effectiveSecret looks the
      // tombstone up by u.email exactly, so a case-folded key would miss it and fall
      // through to the config roster's legacy `pass`.
      await revokeSecret(env, u.email);     // kills their session too (cookies bind to it)
      await revokePublishTokens(env, email); // and any publish token they minted via `augur login`
      await revokeInvitesFor(env, email);   // an outstanding link must not let them back in
      try { await clearAvatar(env, email); } catch (e) {} // their face leaves the index too
      try { await clearName(env, email); } catch (e) {}   // …and so does their chosen name
      // A re-invited address must not inherit the last person's role — least of all admin.
      try { await clearRole(env, email); } catch (e) {}
      // …nor their spaces, least of all one they administered.
      try { await clearSpaces(env, email); } catch (e) {}
      try { await kv.delete(LASTSEEN_PREFIX + u.email); } catch (e) {}
      commitRoster(roster);
      // Symmetric to invite: the identity file should stop naming them too. The
      // tombstone above is the security boundary either way — this only keeps the
      // durable record honest.
      const fileSync = await shellDispatch(env, "roster-update", { action: "remove", email, by: me.email });
      return jsonResponse({ ok: true, email, fileSync });
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
// Per-isolate poll cache — see the GET remarks path in pitiApi.
const PITI_REMARKS_TTL_MS = 15_000;
let pitiRemarksAt = 0;
let pitiRemarksRaw = null;

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
    // Cached per isolate: every poll is a KV read on the daily quota, and open tabs
    // keep whatever cadence their loaded piti.js shipped with — this cache is the
    // only lever that reaches a stale tab (2026-08-20 quota outage). Remark/clear
    // writes bust it, so delivery stays inside one client poll interval. A throwing
    // KV serves the last-read list (the stamp is NOT advanced — recovery retries
    // next poll), or empty — never a 500 at the cat.
    const path = clamp(url.searchParams.get("path") || "/", 600);
    const since = Number(url.searchParams.get("since")) || 0;
    if (!pitiRemarksAt || Date.now() - pitiRemarksAt >= PITI_REMARKS_TTL_MS) {
      try {
        pitiRemarksRaw = await kv.get(PITI_REMARKS_KEY);
        pitiRemarksAt = Date.now();
      } catch (e) {}
    }
    let all;
    try { all = pitiRemarksRaw ? JSON.parse(pitiRemarksRaw) : []; } catch (e) { all = []; }
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
      pitiRemarksAt = 0;
      return jsonResponse({ ok: true, id: all[all.length - 1].id });
    }

    // Agent wipes the queue at the start of a fresh wingman session (secret-guarded).
    if (body && body.type === "clear") {
      if (!authed) return jsonResponse({ error: "forbidden" }, 403);
      await kv.put(PITI_REMARKS_KEY, JSON.stringify([]));
      pitiRemarksAt = 0;
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "bad-input" }, 400);
  }
  return jsonResponse({ error: "method-not-allowed" }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Runtime config is data served alongside the assets, for the worker's own
    // reads only — instance.json carries the user list. Reject external requests
    // BEFORE any asset serving, unconditionally (even in open/legacy mode).
    if (url.pathname === "/__config" || url.pathname.startsWith("/__config/")) {
      return notFoundResponse();
    }

    // Which workspace this request belongs to — resolved ONCE, here, before anything
    // reads config, and passed down from this point on. The only call site: see
    // scripts/one-tenant-resolver.mjs, which fails the build if a second one appears.
    // (The /__config refusal above comes first because it is the same answer for every
    // workspace and costs no read.)
    const { tenantId } = await resolveTenant(request, env);
    // ONE context for this request, for THAT workspace, built here and handed down.
    // `tctx` is the config half of the request — users, prefixes, versions, the gate's
    // flag — as a single frozen value, and from here on the router reads it instead of
    // reaching for a module binding. The bindings still exist and still mirror it (see
    // applyTenantContext): the later A-thread-* items take the last read sites and delete
    // them. Until then the two are held equal on purpose — every seam that writes one
    // writes the other — so a half-threaded router cannot answer two ways.
    //
    // Note what is NOT here: no second resolve, and no config read that picks its own
    // workspace. Everything below is downstream of these two lines.
    const tctx = await loadConfig(tenantId, env);

    // Direct-publish API — self-authed (bearer tokens), before the gate like
    // the other tooling routes.
    if (url.pathname.startsWith("/__publish/")) return publishApi(request, url, env);

    // In bundle mode the public build stamp is synthesized from the live
    // manifests — same shape and contract as the static file Pages serves.
    if (url.pathname === "/_build.json" && bundleMode(env)) {
      return jsonResponse(synthBuildStamp(tctx, await loadManifests(env)));
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
    if (url.pathname === "/__review/api/export") return reviewExport(request, url, env);

    // Piti live channel bypasses the gate too: the cat lives on PUBLIC prototypes
    // (no cookie), so browser reads/view-writes are open; agent ops self-guard with
    // the export secret. Same early-exit shape as /__version and the review export.
    if (url.pathname === "/__piti") return pitiApi(request, url, env);

    // Platform MCP proxy — public prototypes call the platform through their own
    // origin (the platform's Bearer token is the real auth; see mcpProxy).
    if (url.pathname.startsWith("/__mcp/")) return mcpProxy(tctx, request, url);

    const expected = env.SITE_PASSWORD;
    const usersActive = tctx.USERS.length > 0;
    // Resolve identity once (identity mode); null in legacy/open mode.
    const me = usersActive ? await identify(request, env, tctx.USERS) : null;
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
      if (me && ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(env, me));
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
      return serveSpaceIcon(env, url.pathname.slice("/__space-icon/".length));
    }
    if (url.pathname === "/__admin/space-icon") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return spaceIconApi(request, env, me, tctx.SPACES);
    }

    // My own profile photo — set or clear. Ahead of the gate for the same reason
    // /__me is: the profile chip is chrome, and it must work on every page a signed-in
    // person can already see. meAvatarApi re-checks the session (401 without one).
    if (url.pathname === "/__me/avatar") return meAvatarApi(request, env, me);

    // My own display name — same placement and the same reasoning as the photo route
    // above: chrome, ahead of the gate, re-checks the session itself (401 without one).
    if (url.pathname === "/__me/name") return meNameApi(request, env, me);

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
        return serveKvAvatar(env, key.slice(AVATAR_KV_PREFIX.length));
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
      return adminUsersApi(request, url, env, me, tctx.USERS, tctx.CONFIG_USERS, tctx.SPACES);
    }

    // Admin publish-token API — mint/list/revoke per-space publish tokens.
    if (url.pathname === "/__admin/tokens") return adminTokensApi(request, env, me);

    // Admin bundle-store gauge — bytes/objects vs the free-tier ceiling.
    if (url.pathname === "/__admin/storage") return adminStorageApi(env, me);

    // Admin KV export — the other half of durability, next to `augur export`.
    if (url.pathname === "/__admin/backup") return adminBackupApi(env, me);

    // Engine version + update-available nudge (the profile chip's fetch).
    if (url.pathname === "/__admin/version") return adminVersionApi(tctx, env, me);

    // Invite redemption is reachable WITHOUT a session — that is the whole point.
    if (url.pathname === "/__invite") {
      if (request.method === "GET") return inviteGet(tctx, url, env);
      if (request.method === "POST") return invitePost(tctx, request, url, env);
      return new Response("Method Not Allowed", { status: 405 });
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
    if (url.pathname === "/__review/api") return reviewApi(request, url, env, authed);

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
      return statusApi(request, url, env);
    }
    if (url.pathname === "/__pins") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      return pinsApi(request, url, env, me);
    }
    if (url.pathname === "/__name") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      const denied = viewerWriteRefusal(request, url, me, "name", tctx.SPACES);
      if (denied) return denied;
      return nameApi(request, url, env);
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
      return canvasesApi(request, url, env, me);
    }
    // Prototype deletion — DESTRUCTIVE (repo write). Admin-only in identity mode; in
    // legacy/open mode any authed operator (a single-operator instance has no roles).
    if (url.pathname === "/__delete") {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      if (usersActive && (!me || me.role !== "admin")) return jsonResponse({ error: "forbidden" }, 403);
      return deleteApi(request, env, me);
    }
    // Canvas board docs follow the COMMENTS model, not the status/pins model: a canvas is a
    // PUBLISHED prototype (public, obscure share link), so its board must load & save without a
    // login, exactly like /__review/api. Writes are full-state but size-capped in boardApi.
    if (url.pathname === "/__board") return boardApi(request, url, env);
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
      return assetApi(request, url, env);
    }
    // Canvas multiplayer: same-origin WebSocket proxied to the augur-realtime worker (one
    // BoardRoom Durable Object per board path — cursors/presence/live ops). Public like
    // /__board: the board is the credential. The engine degrades to solo if this fails.
    if (url.pathname === "/__rt") return rtProxy(tctx, request, url, env);

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
    if (usersActive && isTrackPath(url.pathname) && (!me || me.role !== "admin")) return notFoundResponse();

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
      const asset = await assetFetch(env, request);
      if (asset.status === 404) return notFoundResponse();
      return withAssetCache(await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url);
    }

    // Published prototypes are public — never gated, regardless of the cookie.
    // The open door is for easy link-sharing, NOT public discovery, so tag every
    // public response as non-indexable (covers HTML and assets alike).
    if (isPublicPath(tctx, url.pathname)) {
      const asset = await assetFetch(env, request);
      if (asset.status === 404) return notFoundResponse();
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
      if (sid && !isMemberOf(me, sid)) return notFoundResponse();
    }

    // Past the gate (or nothing gates the site) → serve. A 404 gets one more chance
    // as a created canvas (a KV-registered board with no repo file — see canvasesApi).
    if (authed) {
      const asset = await assetFetch(env, request);
      if (asset.status === 404) {
        const virt = await virtualCanvas(tctx, request, env, url);
        if (virt) return virt;
        return notFoundResponse();
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
  },
};

// Pure helpers exposed for unit tests. Nothing in the request path references
// __testables — it exists only so test/worker.test.mjs can import them.
export const __testables = {
  applyInstance,
  hashPassword, verifyPassword, isPassHash, safeEqual, userByEmail,
  personId, avatarKey, publicUser, stampAuthor, sanitizeMsg, applyOp, reviewApi,
  peopleApi,
  tokenFor, hmacToken, userToken, identify, effectiveSecret,
  mintInvite, readInvite, consumeInvite,
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
  meNameApi, applyNames, cleanName, readNames, clearName, USER_NAMES_KEY, NAME_MAX_CHARS,
  AVATAR_MAX_CHARS,
  isEmailish, nameFromEmail, initialsFor,
  applyDerivedRouting, canvasAggregate, synthBuildStamp,
  mcpProxy, MCP_PROXY_PATHS,
  assetFetch, withAssetCache, ASSET_REVALIDATE,
  deleteUrlPrefix, removeFromStore,
  revokePublishTokens, loginThrottled, loginSlowed, loginFail, DUMMY_HASH,
  pathOwnedBySpace, isPublishablePublicPrefix, removedPublicPrefixes, publishApi, loadManifests, LOGIN_MAX_FAILS,
  isPrefixBacked, backedPublicPrefixes,
  isPublicPath, isTrackPath, isRestrictedPath, versionFor, brandMark,
  boardApi, canvasesApi, virtualCanvas, rtProxy, CANVASES_KEY, BOARD_PREFIX, BOARD_MAX_BYTES,
  composeChrome, renderAppChrome, renderSpaceContextScript, __setChromeTestState,
  loadConfig, loadTenantContext, __setConfigTestState, __usersNow, pitiApi,
  resolveTenant, DEFAULT_TENANT_ID, TENANT_MEMO_TTL_MS, __setTenantTestState,
};
