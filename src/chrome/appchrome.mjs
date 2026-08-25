// Shared, PURE page-level chrome renderer — the rail, tab bar, mobile header and the
// body-level overlays (help drawer, settings modal, pinned/profile sheets). Imported by
// BOTH build.js (bakes it into every page) and src/_worker.js (re-renders it at serve
// time so an engine deploy updates every space instantly — runtime-chrome).
//
// It is deliberately self-contained: it reads NOTHING from a module global. Every value
// that varies per page arrives in the `state` argument:
//   state = { spaces, activeSpace, opportunities, hasPlayground[, base, projectsLabel] }
// (`base`/`projectsLabel` are optional — derived from the active space entry otherwise).
// The co-located constants/icons/utilities below are the ONLY things it depends on, so
// the worker can import it with no build.js in scope.

// The SITE shell version — rail foot, chrome bundle filenames, the marker's data-ui.
// Single source of truth; build.js imports this rather than redeclaring it.
export const UI_VERSION = "1.14";

// ── Small pure utilities (shared with build.js, which imports them from here) ──
export const escAttr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ACRONYMS = new Set(["sms", "ui", "ux", "uxui", "api", "url", "faq", "sso", "cta", "pdf", "csv", "riot", "fo", "bo"]);
export function titleCase(slug) {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\S+/g, (w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
    );
}

export function fmtDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function relTime(ms) {
  if (!ms) return "";
  const sec = Math.round(Math.max(0, Date.now() - ms) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, s] of units) {
    const v = Math.floor(sec / s);
    if (v >= 1) return `Edited ${v} ${name}${v > 1 ? "s" : ""} ago`;
  }
  return "Edited just now";
}

// ── Icons / marks used by the chrome (co-located so the module is self-contained) ──
export const ic = (inner) => `<svg class="gvic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const GV_MARK = `<img class="gvmark" src="/augur-eye.svg" alt="" aria-hidden="true" width="24" height="24" />`;
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

const IC_HOME = ic(`<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>`); // layout-grid
const IC_PLAY = ic(`<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>`); // flask-conical
const IC_FOLDER = ic(`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`); // folder
const IC_PRIM = ic(`<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>`); // shapes
const IC_COMP = ic(`<path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/><path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"/><path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"/><path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>`); // component
const IC_PAGE = ic(`<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>`); // app-window (pages are websites, not paper)
const IC_RESEARCH = ic(`<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/><path d="M8.5 13h7M8.5 16.5h4.5"/>`); // document with text lines (internal research/context docs)
const IC_LIBRARY = ic(`<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>`); // library
const IC_CHANGELOG = ic(`<path d="M12 8v4l3 2"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 21v-5h5"/>`); // history (clock + counter-rotate)
const IC_GEAR = ic(`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`); // settings
const IC_SIGNOUT = ic(`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>`); // log-out
const IC_USERS = ic(`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`); // users — admin People
const IC_SEARCH = ic(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`); // search — mobile tab bar (.gvic-sized; SEARCH_ICON is the un-classed header variant)
const IC_LOCK = ic(`<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`); // lock — marks a "Change …" that isn't wired yet
const IC_SLIDERS = ic(`<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>`); // sliders-vertical (account settings)
const IC_CLOSE = ic(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`); // x
const IC_TOKEN = ic(`<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`); // palette (tokens)
const IC_PATTERN = ic(`<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M10 17.5h4"/>`); // grid + links (patterns)
// Pushpin glyph for the tab bar's Pinned tab specifically — a star reads as "favourite"
// floating alone in a primary nav slot; the lucide `pin` says "pinned" directly.
const IC_PIN = ic(`<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>`);

// The library's own sections — used both to build its rail and to know when the rail
// should BE the library's (see renderAppChrome).
const LIB_KEYS = ["tokens", "base", "components", "patterns", "pages", "primitives"];

// ── Per-page state derivation ────────────────────────────────────────────────
// The active space object out of the space list, and the two ambient values the rail
// used to read from build globals: the URL base (space scope) and the Projects label.
// Both prefer an explicit value on `state` (build passes it), else derive from the
// active space entry — so the worker can pass just { spaces, activeSpace } and still
// resolve the correct base for a non-default space.
function activeSpaceOf(state) {
  const spaces = state.spaces || [];
  return spaces.find((s) => s.id === state.activeSpace) || spaces[0] || null;
}
function baseOf(state) {
  if (typeof state.base === "string") return state.base;
  const a = activeSpaceOf(state);
  if (!a) return "";
  return typeof a.base === "string" ? a.base : (a.default ? "" : `/${a.id}`);
}
function projectsLabelOf(state) {
  if (state.projectsLabel) return state.projectsLabel;
  const a = activeSpaceOf(state);
  return (a && a.projectsLabel) || "Projects";
}

// ── Research/context surface — gated metadata only (count + filenames on click) ──
function researchLabel(n) { return `${n} research ${n === 1 ? "file" : "files"}`; }
function researchListItems(research) {
  return research
    .map((r) => `<li><span class="research-pop__name">${escAttr(r.name)}</span><span class="research-pop__date" title="${escAttr(fmtDate(r.mtimeMs))}">${relTime(r.mtimeMs)}</span></li>`)
    .join("");
}
export function researchChip(research) {
  if (!research || !research.length) return "";
  const label = researchLabel(research.length);
  return `<span class="research-wrap"><button type="button" class="research-chip" aria-expanded="false" aria-label="${label}" title="${label}">${IC_RESEARCH}<span class="research-chip__n">${research.length}</span></button><div class="research-pop" role="group" aria-label="Research &amp; context files" hidden><div class="research-pop__head">Research &amp; context</div><ul class="research-pop__list">${researchListItems(research)}</ul></div></span>`;
}

// The omni search field — lives in the rail, filters whatever cards are on the right.
function railSearch(state) {
  const S = (p) => baseOf(state) + p;
  return `<div class="gvsearch" data-search-src="${S("/__search.json")}" data-search-base="${S("/")}">${SEARCH_ICON}` +
    `<input type="text" data-filter placeholder="Search…" aria-label="Search content" autocomplete="off" autocapitalize="off" spellcheck="false" />` +
    `<button type="button" class="gvsearch__clear" data-filter-clear aria-label="Clear search" hidden>&times;</button>` +
    `<kbd data-filter-kbd>/</kbd></div>`;
}

// Profile chip — filled per-request by PROFILE_JS from /__me; hidden by default.
function profileChip() {
  return `<div class="gvprof" data-prof hidden>
      <button type="button" class="gvprof__btn" data-prof-toggle aria-haspopup="true" aria-expanded="false" aria-label="Account">
        <span class="gvprof__av" data-prof-av aria-hidden="true"></span>
        <span class="gvprof__name" data-prof-name>…</span>
        <span class="gvprof__dot" data-prof-dot hidden title="Update available">!</span>
        <svg class="gvprof__cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="gvprof__menu" data-prof-menu role="menu" hidden>
        <div class="gvprof__id">
          <span class="gvprof__av lg" data-prof-av aria-hidden="true"></span>
          <span class="gvprof__idtext"><span class="gvprof__name" data-prof-name></span><span class="gvprof__email" data-prof-email></span></span>
        </div>
        <button type="button" class="gvprof__item" role="menuitem" data-prof-settings>${IC_SLIDERS}<span>Settings</span></button>
        <a class="gvprof__item" href="/__logout" role="menuitem" data-prof-signout>${IC_SIGNOUT}<span>Sign out</span></a>
        <div class="gvprof__ver" data-prof-ver hidden>
          <span data-prof-vercur></span>
          <a data-prof-verlink href="#" target="_blank" rel="noopener" hidden></a>
        </div>
      </div>
    </div>`;
}

// Space switcher — the active space's icon + name. Hidden when no space to name.
function spaceSwitcher(state) {
  const spaces = state.spaces || [];
  if (!spaces.length) return "";
  const active = spaces.find((s) => s.id === state.activeSpace) || spaces[0];
  const iconSrc = "/space-icon.png";
  const icon = `<span class="gvspace__icon"><img src="${iconSrc}" alt="" width="20" height="20" data-space-icon /></span>`;
  return `<div class="gvspace" data-space data-space-active="${escAttr(active.id)}">
      <div class="gvspace__row">
        <span class="gvspace__btn">
          ${icon}<span class="gvspace__name" data-space-name>${escAttr(active.name)}</span>
        </span>
      </div>
    </div>`;
}

// The persistent left rail: brand → search → Projects/Playground → Pinned → foot.
function sideRail(active, state) {
  const S = (p) => baseOf(state) + p;
  const item = (href, label, key, icon) =>
    `<a href="${S(href)}"${active === key ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  const playground = state.hasPlayground ? item("/playground/", "Playground", "playground", IC_PLAY) : "";
  const adminItem = `<a class="gvside__admin" href="/admin/" data-space-admin${
    state.activeSpace ? ` data-space-id="${escAttr(state.activeSpace)}"` : ""
  }>${IC_GEAR}<span>Admin</span></a>`;
  const libraryItem = item("/tokens/", "Design system", "library", IC_LIBRARY);
  const pinned = `<p class="gvside__label">Pinned</p>
      <div class="gvside__group" data-pinned-list></div>
      <p class="gvside__pinhint" data-pinned-empty hidden>Star a prototype to pin it here.</p>`;
  return `<aside class="gvside" id="gvside" aria-label="Augur">
    ${profileChip()}
    ${railSearch(state)}
    <div class="gvside__rule"></div>
    ${spaceSwitcher(state)}
    <div class="gvside__scroll">
      <div class="gvside__group">
        ${item("/", projectsLabelOf(state), "prototypes", IC_HOME)}
        ${playground}
        ${libraryItem}
        ${adminItem}
      </div>
      ${pinned}
    </div>
    <div class="gvside__foot">
      <div class="gvside__rule"></div>
      <div class="gvside__group" style="margin-top:6px">
        <a href="/changelog/"${active === "changelog" ? ' aria-current="page"' : ""}>${IC_CHANGELOG}<span>Changelog</span><span class="gvside__ver">v${UI_VERSION}</span></a>
      </div>
    </div>
  </aside>`;
}

// Mobile bottom tab bar. Mirrors the same three-way branch renderAppChrome() computes.
function tabBar(active, state) {
  const S = (p) => baseOf(state) + p;
  const tab = (href, label, key, icon, extraAttrs) =>
    `<a class="gvtab" href="${S(href)}"${active === key ? ' aria-current="page"' : ""}${extraAttrs || ""}>${icon}<span>${label}</span></a>`;
  const blankSlot = `<span class="gvtab is-blank" aria-hidden="true"></span>`;

  if (active === "admin") {
    return `<nav class="gvtabbar" aria-label="Workspace settings">
      <button type="button" class="gvtab" data-admin-tab="people">${IC_USERS}<span>People</span></button>
      <button type="button" class="gvtab" data-admin-tab="content">${IC_FOLDER}<span>Content</span></button>
      <button type="button" class="gvtab" data-admin-tab="settings">${IC_GEAR}<span>Settings</span></button>
      ${blankSlot}${blankSlot}
    </nav>`;
  }

  if (LIB_KEYS.includes(active)) {
    return `<nav class="gvtabbar" aria-label="Design system">
      ${tab("/tokens/", "Tokens", "tokens", IC_TOKEN)}
      ${tab("/base/", "Base", "base", IC_PRIM)}
      ${tab("/components/", "Components", "components", IC_COMP)}
      ${tab("/patterns/", "Patterns", "patterns", IC_PATTERN)}
      ${tab("/pages/", "Pages", "pages", IC_PAGE)}
    </nav>`;
  }

  const playground = state.hasPlayground
    ? tab("/playground/", "Playground", "playground", IC_PLAY)
    : blankSlot;
  const projectsActive = active !== "playground" && active !== "changelog";
  return `<nav class="gvtabbar" aria-label="Primary">
    <a class="gvtab" href="${S("/")}"${projectsActive ? ' aria-current="page"' : ""}>${IC_HOME}<span>${projectsLabelOf(state)}</span></a>
    ${playground}
    ${tab("/tokens/", "Design system", "library", IC_LIBRARY)}
    <button type="button" class="gvtab" data-tab-pinned aria-haspopup="dialog">${IC_PIN}<span>Pinned</span></button>
    <button type="button" class="gvtab" data-mobile-search-toggle aria-label="Search">${IC_SEARCH}<span>Search</span></button>
    <button type="button" class="gvtab" data-prof data-tab-profile aria-haspopup="dialog" hidden><span class="gvprof__av" data-prof-av aria-hidden="true"></span><span>Profile</span></button>
  </nav>`;
}

// Second copy of the pinned list for mobile (the rail's is off-canvas).
function mobilePinnedSheet() {
  return `<div class="gvsheet" id="gvpinsheet" data-pin-sheet hidden>
    <div class="gvsheet__scrim" data-pin-sheet-scrim></div>
    <div class="gvsheet__panel" role="dialog" aria-modal="true" aria-label="Pinned">
      <div class="gvsheet__head">
        <h2 class="gvsheet__title">Pinned</h2>
        <button type="button" class="gvsheet__x" data-pin-sheet-close aria-label="Close">${IC_CLOSE}</button>
      </div>
      <div class="gvside__group" data-pinned-list></div>
      <p class="gvside__pinhint" data-pinned-empty hidden>Star a prototype to pin it here.</p>
    </div>
  </div>`;
}

// Second copy of the profile chip's identity block/menu for mobile, plus Admin + Changelog.
function mobileProfileSheet(state) {
  return `<div class="gvsheet" id="gvprofsheet" data-prof-sheet hidden>
    <div class="gvsheet__scrim" data-prof-sheet-scrim></div>
    <div class="gvsheet__panel" role="dialog" aria-modal="true" aria-label="Profile">
      <div class="gvsheet__head">
        <h2 class="gvsheet__title">Profile</h2>
        <button type="button" class="gvsheet__x" data-prof-sheet-close aria-label="Close">${IC_CLOSE}</button>
      </div>
      ${profileChip()}
      <a class="gvprof__item gvside__admin" href="/admin/" data-space-admin${
        state.activeSpace ? ` data-space-id="${escAttr(state.activeSpace)}"` : ""
      }>${IC_GEAR}<span>Admin</span></a>
      <a class="gvprof__item" href="/changelog/">${IC_CHANGELOG}<span>Changelog</span></a>
    </div>
  </div>`;
}

// The Help drawer — a right-side slide-in panel opened from the rail footer.
function helpDrawer() {
  return `<div class="gvhelp" data-help hidden>
    <div class="gvhelp__scrim" data-help-scrim></div>
    <div class="gvhelp__panel" role="dialog" aria-modal="true" aria-label="Help">
      <header class="gvhelp__head">
        <h3 class="gvhelp__title">Help</h3>
        <button type="button" class="gvhelp__x" data-help-close aria-label="Close help">${IC_CLOSE}</button>
      </header>
      <div class="gvhelp__tabs" role="tablist" aria-label="Help topics">
        <button type="button" class="gvhelp__tab" data-help-tab="review" role="tab">Reviewing</button>
        <button type="button" class="gvhelp__tab" data-help-tab="build" role="tab">Building</button>
      </div>
      <div class="gvhelp__body">
        <section class="gvhelp__track" data-help-track="review" role="tabpanel">
          <h4>Comment</h4>
          <ul>
            <li><kbd>Shift</kbd>+<kbd>C</kbd>: toggle review mode.</li>
            <li>Click any element to drop a pin, type, press <kbd>Enter</kbd>.</li>
            <li>Pins scope to the screen they were made on. Off-screen pins hide.</li>
            <li><kbd>Esc</kbd>: exit review mode.</li>
          </ul>

          <h4>Layers view</h4>
          <ul>
            <li>In review mode, press <kbd>&uarr;</kbd>/<kbd>&darr;</kbd> (or click the Layers pill, bottom-left).</li>
            <li>Boxes every element by layer: Components, +Base, +Tokens.</li>
            <li>+Tokens paints live spacing on each box.</li>
          </ul>

          <h4>Marks</h4>
          <ul>
            <li><b>Comments</b>: your pins and threads (review mode on).</li>
            <li><b>Annotations</b>: notes pinned to stay visible with review off. Skipped by "resolve comments".</li>
            <li><b>Status</b>: the badge on each card. Click to cycle Dev ready, In progress, Ignore.</li>
          </ul>

          <h4>Cards</h4>
          <ul>
            <li>Right-click a card: Open, Copy link, Download HTML, Rename, Edit description.</li>
            <li>Star a card to pin it to the sidebar. Drag pinned items to reorder.</li>
          </ul>

          <h4>Search</h4>
          <ul>
            <li><kbd>/</kbd> focus. <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> focus and select. <kbd>Esc</kbd> clear.</li>
          </ul>

          <h4>Replies appear</h4>
          <ul><li>An agent may answer or resolve your comment in-thread. That is the comment loop (see Building).</li></ul>
        </section>

        <section class="gvhelp__track" data-help-track="build" role="tabpanel" hidden>
          <h4>Prototypes</h4>
          <ul>
            <li>Self-contained static HTML, no build step — a prototype has to work opened straight from disk.</li>
            <li>The design system is read-only from a prototype. Edit the skill's own source rather than copying its classes out.</li>
          </ul>

          <h4>Comment loop <span class="gvhelp__tag">maintainer</span></h4>
          <ul>
            <li><code>npm run review --open</code> lists open threads.</li>
            <li>The agent fixes, replies, resolves in-thread. Put it on <code>/loop</code> to keep watching.</li>
            <li>Not automated. You steer it.</li>
          </ul>
        </section>
      </div>
    </div>
  </div>`;
}

// Account settings — a centred modal opened from the profile menu.
function settingsModal() {
  return `<div class="gvset" data-set hidden>
    <div class="gvset__scrim" data-set-scrim></div>
    <div class="gvset__panel" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="gvset__head">
        <div class="gvset__tabs" role="tablist" aria-label="Settings sections">
          <button type="button" class="gvset__tab is-active" data-set-tab="account" role="tab" aria-selected="true">Account</button>
        </div>
        <button type="button" class="gvset__x" data-set-close aria-label="Close settings">${IC_CLOSE}</button>
      </div>
      <div class="gvset__body">
        <section class="gvset__cols" data-set-panel="account" role="tabpanel" aria-label="Account">
          <div class="gvset__avcol">
            <span class="gvset__av" data-prof-av aria-hidden="true"></span>
            <button type="button" class="gvset__edit" data-set-edit>Edit</button>
            <p class="gvset__err" data-set-err hidden></p>
            <input type="file" accept="image/*" data-set-file hidden />
          </div>
          <div class="gvset__fields">
            <div>
              <h3 class="gvset__label">Name</h3>
              <div data-set-name-view>
                <p class="gvset__value" data-prof-name></p>
                <button type="button" class="gvset__link" data-set-rename>Change name</button>
              </div>
              <form class="gvset__form" data-set-name-form hidden>
                <input type="text" class="gvset__input" data-set-name-input maxlength="60"
                  autocomplete="name" aria-label="Your name" />
                <button type="submit" class="gvset__btn" data-set-name-save>Save</button>
                <button type="button" class="gvset__btn gvset__btn--ghost" data-set-name-cancel>Cancel</button>
                <span class="gvset__msg" data-set-name-msg aria-live="polite"></span>
              </form>
            </div>
            <div>
              <h3 class="gvset__label">Email</h3>
              <p class="gvset__value" data-prof-email></p>
              <button type="button" class="gvset__link" disabled title="Changing your email isn't available yet">${IC_LOCK}Change email</button>
            </div>
            <div>
              <h3 class="gvset__label">Password</h3>
              <p class="gvset__value">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</p>
              <button type="button" class="gvset__link" disabled title="Changing your own password isn't built yet — ask an admin of every workspace you belong to, or the instance admin, to reset it">${IC_LOCK}Change password</button>
            </div>
            <div><h3 class="gvset__label">Role</h3><p class="gvset__value" data-set-role></p></div>
          </div>
        </section>
      </div>
    </div>
  </div>
  <div class="gvcrop" data-crop hidden>
    <div class="gvcrop__scrim" data-crop-scrim></div>
    <div class="gvcrop__panel" role="dialog" aria-modal="true" aria-label="Crop photo">
      <button type="button" class="gvcrop__x" data-crop-close aria-label="Cancel">${IC_CLOSE}</button>
      <div class="gvcrop__stage"><canvas class="gvcrop__canvas" data-crop-canvas width="576" height="576"></canvas></div>
      <div class="gvcrop__zoom">
        <button type="button" class="gvcrop__step" data-crop-out aria-label="Zoom out">&minus;</button>
        <input type="range" class="gvcrop__range" data-crop-range min="1" max="3" step="0.01" value="1" aria-label="Zoom" />
        <button type="button" class="gvcrop__step" data-crop-in aria-label="Zoom in">+</button>
      </div>
      <div class="gvcrop__foot">
        <button type="button" class="gvcrop__save" data-crop-save>Save image</button>
        <p class="gvcrop__msg" data-crop-msg hidden></p>
      </div>
    </div>
  </div>`;
}

// The rail while inside the design system: profile chip, a way back, this section's tabs.
function libraryRail(active, state) {
  const S = (p) => baseOf(state) + p;
  const item = (href, label, key, icon) =>
    `<a href="${S(href)}"${active === key ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  return `<aside class="gvside" id="gvside" aria-label="Design system">
    ${profileChip()}
    <div class="gvside__rule"></div>
    <a class="gvadmin__back" href="${S("/")}">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Design system</span>
    </a>
    <div class="gvside__scroll">
      <div class="gvside__group">
        ${item("/tokens/", "Tokens", "tokens", IC_TOKEN)}
        ${item("/base/", "Base", "base", IC_PRIM)}
        ${item("/components/", "Components", "components", IC_COMP)}
        ${item("/patterns/", "Patterns", "patterns", IC_PATTERN)}
        ${item("/pages/", "Pages", "pages", IC_PAGE)}
      </div>
    </div>
  </aside>`;
}

// The rail while inside workspace settings: profile chip, a back link, the sections.
function adminRail() {
  const tab = (key, label) =>
    `<button type="button" class="gvside__act gvadmin__tab" data-admin-tab="${key}">${label}</button>`;
  return `<aside class="gvside" id="gvside" aria-label="Workspace settings">
    ${profileChip()}
    <div class="gvside__rule"></div>
    <a class="gvadmin__back" href="/" data-admin-back>
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span data-admin-space-name>Workspace</span>
    </a>
    <div class="gvside__scroll">
      <div class="gvside__group" data-admin-nav>
        ${tab("people", "People")}
        ${tab("content", "Content")}
        ${tab("settings", "Settings")}
      </div>
    </div>
  </aside>`;
}

// Full chrome injected at the top of <body>: slim mobile top bar + the rail + the
// drawer scrim (the last two are off-canvas / hidden on desktop via CSS).
export function renderAppChrome(active, state, opts = {}) {
  const spaces = state.spaces || [];
  const activeSpaceObj = spaces.find((s) => s.id === state.activeSpace) || spaces[0];
  const isLibOrAdmin = active === "admin" || LIB_KEYS.includes(active);
  const isOpportunity = !isLibOrAdmin && !!active && active !== "prototypes" && active !== "playground" && active !== "changelog";
  const spaceName = activeSpaceObj ? activeSpaceObj.name : "augur";
  const sectionLabel = active === "admin" ? "Workspace settings"
    : LIB_KEYS.includes(active) ? "Design system"
    : active === "changelog" ? "Changelog"
    : active === "playground" ? "Playground"
    : isOpportunity ? titleCase(active)
    : projectsLabelOf(state);
  const homeMark = activeSpaceObj
    ? `<img class="gvtop__logo" src="/space-icon.png" alt="" width="22" height="22" />`
    : `<span class="gvtop__logo gvtop__logo--mark">${GV_MARK}</span>`;
  const S = (p) => baseOf(state) + p;
  const crumbs = `<nav class="gvtop__crumbs" aria-label="Breadcrumb">
      <a class="gvtop__crumb gvtop__crumb--home" href="${S("/")}">${homeMark}<span>${escAttr(spaceName)}</span></a>
      <span class="gvtop__crumbsep" aria-hidden="true">›</span>
      <span class="gvtop__crumb gvtop__crumb--current" aria-current="page">${escAttr(sectionLabel)}</span>
    </nav>`;
  const headerAction = opts.research && opts.research.length
    ? `<div class="gvtop__action">${researchChip(opts.research)}</div>`
    : "";
  const top = `<header class="gvtop">
    <div class="gvtop__center">${crumbs}</div>
    <div class="gvtop__searchwrap">${railSearch(state)}</div>
    ${headerAction}
  </header>`;
  const rail = active === "admin" ? adminRail()
    : LIB_KEYS.includes(active) ? libraryRail(active, state)
    : sideRail(active, state);
  return `${top}${rail}<div class="gvscrim" data-side-scrim></div>${tabBar(active, state)}${mobilePinnedSheet()}${mobileProfileSheet(state)}${helpDrawer()}${settingsModal()}`;
}

// Per-page data script: this space's base + the other spaces' bases, for the pins filter.
export function renderSpaceContextScript(state) {
  const spaces = state.spaces || [];
  const active = spaces.find((s) => s.id === state.activeSpace) || spaces[0] || { base: "" };
  const others = spaces.filter((s) => !s.default).map((s) => s.base);
  return `window.__GV_SPACE=${JSON.stringify({ base: active.base || "", others })};`;
}

// Delimiters wrapping the baked chrome region. HTML comments — inert, changing no
// rendering — carrying the space id + active tab so the worker can re-render the
// CURRENT engine's chrome in place at serve time (composeChrome in src/_worker.js).
export const CHROME_MARK_START = (space, active, hasPlayground) =>
  `<!--gv-chrome-start data-space="${escAttr(space)}" data-active="${escAttr(active)}" data-playground="${hasPlayground ? "1" : "0"}" data-ui="${UI_VERSION}"-->`;
export const CHROME_MARK_END = `<!--gv-chrome-end-->`;
