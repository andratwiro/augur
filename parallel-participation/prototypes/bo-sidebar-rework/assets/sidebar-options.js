/* ════════════════════════════════════════════════════════════════════════
   BO SIDEBAR rework bench — 10 options × {expanded, collapsed}
   Renders one chosen sidebar into <nav id="sbHost"> and a floating switcher.
   Styling lives in assets/sidebar.css (token-driven .sb base + [data-sb="N"]).
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const host = document.getElementById("sbHost");
  if (!host) return;

  /* ── Nav data — the real back-office sections (Dashboard … Support) ──────── */
  const D  = { icon: "admin-dashboard",     label: "Dashboard" };
  const PR = { icon: "admin-projects",      label: "Projects", active: true };
  const IM = { icon: "admin-input",         label: "Input manager" };
  const US = { icon: "admin-users",         label: "Users" };
  const MS = { icon: "admin-messaging",     label: "Messaging" };
  const RP = { icon: "admin-reporting",     label: "Reporting" };
  const CM = { icon: "admin-community",     label: "Community monitor" };
  const IH = { icon: "admin-inspiration",   label: "Inspiration hub" };
  const TL = { icon: "admin-tools",         label: "Tools" };
  const PG = { icon: "admin-pages",         label: "Pages & menu" };
  const ST = { icon: "admin-settings",      label: "Settings" };
  const NT = { icon: "admin-notifications", label: "Notifications", badge: 29 };
  const SP = { icon: "admin-support",       label: "Support", support: true };

  const TOP_FLAT = [D, PR, IM, US, MS, RP, CM, IH];
  const TOP_GROUPS = [
    { h: "Overview", items: [D] },
    { h: "Manage",   items: [PR, IM, US, MS] },
    { h: "Analyze",  items: [RP, CM, IH] },
  ];
  const BOTTOM = [TL, PG, ST]; // Notifications / account / support rendered explicitly

  /* ── Option configs (structure flags; palette lives in CSS [data-sb=N]) ──── */
  const OPTS = [
    { n: 1,  name: "Refined Navy",  tag: "Better current", platform: "band",   accentbar: true,
      note: "Today's bar, fixed: legible icons, a real rail-hover state, clearer active. The safe ship." },
    { n: 2,  name: "Teal Pill",     tag: "Better current", platform: "back",
      note: "Softer slate bar; active is a solid teal pill. Calm and modern, same bones + fixed contrast." },
    { n: 3,  name: "Sectioned",     tag: "Structure", platform: "back", groups: true,
      note: "Same items, grouped under quiet headers (Overview / Manage / Analyze) so the long list scans." },
    { n: 4,  name: "Command-first", tag: "Structure", platform: "switch", accentbar: true, search: true,
      note: "A Search / ⌘K field for dense admins; the exit becomes a proper app-switcher header." },
    { n: 5,  name: "Comfortable",   tag: "Targets", platform: "back",
      note: "Bigger hit-targets and a generous 86px rail — built around the collapsed icon experience." },
    { n: 6,  name: "Light admin",   tag: "Departure", platform: "back", accentbar: true,
      note: "Flips to a white bar with dark text + teal accent. Inherently high-contrast; feels lighter." },
    { n: 7,  name: "City-branded",  tag: "Departure", platform: "switch", accentbar: true, city: true,
      note: "Brings the city's logo + accent into the admin — tests tenant branding (off-spec today)." },
    { n: 8,  name: "Floating card", tag: "Departure", platform: "band", card: true,
      note: "The sidebar floats as a rounded, shadowed card; active items are teal pills." },
    { n: 9,  name: "Dense",         tag: "Density", platform: "back", groups: true,
      note: "Compact power-user density — shorter rows, grouped, more visible before any scroll." },
    { n: 10, name: "Bold gradient", tag: "Risk", platform: "switch", accentbar: true,
      note: "Teal→navy gradient with a vivid mint active accent + app-switcher. The expressive risk." },
  ];

  /* ── Markup helpers ─────────────────────────────────────────────────────── */
  const ico = (name, extra = "") => `<span class="sb__icon"${extra} data-gv-icon="${name}"></span>`;

  function item(it) {
    const cls = "sb__item" + (it.active ? " is-active" : "");
    const badge = it.badge ? `<span class="sb__badge">${it.badge}</span>` : "";
    const iconExtra = it.support ? ' style="color:var(--sb-support)"' : "";
    const badgeAttr = it.badge ? " data-badge" : "";
    return `<a class="${cls}" href="javascript:void(0)" data-label="${it.label}"${badgeAttr}>` +
           ico(it.icon, iconExtra) + `<span class="sb__label">${it.label}</span>${badge}</a>`;
  }

  function topBlock(opt) {
    if (opt.groups) {
      return TOP_GROUPS.map(g =>
        `<div class="sb__grouphdr">${g.h}</div>` + g.items.map(item).join("")
      ).join("");
    }
    return TOP_FLAT.map(item).join("");
  }

  function platformBlock(opt) {
    if (opt.platform === "band") {
      return `<a class="sb__platform sb__platform--band" href="javascript:void(0)" data-label="Back to platform">` +
        `<span class="sb__platform-ico" data-gv-icon="admin-back"></span>` +
        `<span class="sb__platform-label">Back to platform<small>Resident site</small></span></a>`;
    }
    if (opt.platform === "back") {
      return `<a class="sb__platform sb__platform--back" href="javascript:void(0)" data-label="Back to platform">` +
        `<span class="sb__platform-ico" data-gv-icon="arrow-left"></span>` +
        `<span class="sb__platform-label">Back to platform</span></a>`;
    }
    // app-switcher
    const brand = opt.city ? "Engaged California" : "GoVocal";
    const sub   = opt.city ? "City platform · admin" : "Switch to resident site";
    const mark  = opt.city
      ? `<span class="sb__mark sb__mark--city">EC</span>`
      : `<span class="sb__mark" data-gv-icon="admin-projects"></span>`;
    return `<div class="sb__platform sb__platform--switch" data-label="${brand}">` +
      mark +
      `<span class="sb__platform-label">${brand}<small>${sub}</small></span>` +
      `<span class="sb__chev" data-gv-icon="chevron-down" style="margin-left:auto;opacity:.55"></span></div>`;
  }

  function searchBlock() {
    return `<div class="sb__search">` +
      `<span data-gv-icon="search"></span>` +
      `<input type="text" placeholder="Search admin…" aria-label="Search admin" />` +
      `<span class="sb__kbd">⌘K</span></div>`;
  }

  function accountBlock() {
    return `<a class="sb__item sb__account" href="javascript:void(0)" data-label="Go Vocal Admin">` +
      `<span class="sb__avatar" data-gv-icon="user"></span>` +
      `<span class="sb__name">Go Vocal Admin<small>Administrator</small></span>` +
      `<span class="sb__chev" data-gv-icon="chevron-right"></span></a>`;
  }

  function render(opt, collapsed) {
    host.dataset.sb = String(opt.n);
    host.classList.toggle("is-collapsed", collapsed);
    host.toggleAttribute("data-accentbar", !!opt.accentbar);

    host.innerHTML =
      `<div class="sb__head">${platformBlock(opt)}</div>` +
      (opt.search ? searchBlock() : "") +
      `<div class="sb__top">${topBlock(opt)}</div>` +
      `<div class="sb__bottom">` +
        BOTTOM.map(item).join("") +
        item(NT) +
        `<div class="sb__div"></div>` +
        accountBlock() +
        item(SP) +
      `</div>`;

    if (window.GVIcons) window.GVIcons.render(host);

    // Publish the current screen so review comments scope per option/state (CLAUDE.md SPA contract)
    document.body.dataset.gvScreen = `sidebar-${opt.n}-${collapsed ? "collapsed" : "expanded"}`;
  }

  /* ── Floating switcher ──────────────────────────────────────────────────── */
  let cur = 0;            // index into OPTS
  let collapsed = false;

  const sbx = document.createElement("div");
  sbx.className = "sbx";
  sbx.innerHTML =
    `<div class="sbx__title"><b>Sidebar rework</b> · 10 options</div>` +
    `<div class="sbx__row">${OPTS.map((o, i) =>
      `<button class="sbx__n" data-i="${i}" title="${o.name}">${o.n}</button>`).join("")}</div>` +
    `<div class="sbx__meta"><b class="sbx__name"></b><span class="sbx__tag"></span><p class="sbx__note"></p></div>` +
    `<div class="sbx__toggle">` +
      `<button data-state="expanded">Expanded</button>` +
      `<button data-state="collapsed">Collapsed</button>` +
    `</div>`;
  document.body.appendChild(sbx);

  const nameEl = sbx.querySelector(".sbx__name");
  const tagEl  = sbx.querySelector(".sbx__tag");
  const noteEl = sbx.querySelector(".sbx__note");
  const numBtns = [...sbx.querySelectorAll(".sbx__n")];
  const toggleBtns = [...sbx.querySelectorAll(".sbx__toggle button")];

  function paint() {
    const opt = OPTS[cur];
    render(opt, collapsed);
    numBtns.forEach((b, i) => b.classList.toggle("is-on", i === cur));
    toggleBtns.forEach(b => b.classList.toggle("is-on", (b.dataset.state === "collapsed") === collapsed));
    nameEl.textContent = String(opt.n).padStart(2, "0") + " · " + opt.name;
    tagEl.textContent = opt.tag;
    noteEl.textContent = opt.note;
  }

  numBtns.forEach(b => b.addEventListener("click", () => { cur = +b.dataset.i; paint(); }));
  toggleBtns.forEach(b => b.addEventListener("click", () => { collapsed = b.dataset.state === "collapsed"; paint(); }));

  // Keyboard: 1–9/0 pick option, C toggles collapse
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea")) return;
    if (e.key >= "1" && e.key <= "9") { cur = +e.key - 1; paint(); }
    else if (e.key === "0") { cur = 9; paint(); }
    else if (e.key.toLowerCase() === "c") { collapsed = !collapsed; paint(); }
  });

  function start() { paint(); }
  if (window.GVIcons) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
