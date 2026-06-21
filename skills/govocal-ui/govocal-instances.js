/* govocal-instances.js — the canonical COMPONENT INSTANCE registry (window.GV).
 *
 * The Figma model, on the web. A consumer (library demo OR prototype) IMPORTS a
 * component as a LIVE INSTANCE: it passes only PROPS (state + copy), never markup.
 * The markup AND the .gv-* class hooks come from here; styling flows in from the
 * linked canonical CSS (govocal-*.css). Edit a renderer here and every instance
 * everywhere updates — exactly like editing a Figma master.
 *
 *   GV.render(name, props)     -> canonical HTML string for that component
 *   GV.<name>(props)           -> shorthand for GV.render('<name>', props)
 *   GV.mount(elOrSel, name, p) -> set innerHTML + hydrate (fill icons, wire behaviours)
 *   GV.hydrate(root)           -> wire any GV-injected instances under root
 *   GV.register(name, fn)      -> add a component renderer (one source of truth)
 *
 * Props are a component's "variants / properties" (Figma): e.g. the sidebar's
 * `active` item, its item labels, `rail` vs auto. An instance stays LINKED by
 * default; to fork one for a prototype, DETACH it (CLI: `npm run detach`) — which
 * flattens GV.render(...)'s output to static local markup. GV.render(props) IS the
 * detached form, so detach is just "freeze this instance's current output".
 *
 * Mirrors govocal-widgets.js conventions (IIFE namespace, esc(), data-gv-icon glyphs
 * filled by GVIcons.render()). Pairs with govocal-tokens/-primitives/-ui/-bo CSS.
 */
window.GV = (function () {
  "use strict";
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]);
    });
  };

  var registry = {};
  function register(name, fn) { registry[name] = fn; }
  function render(name, props) {
    var fn = registry[name];
    if (!fn) throw new Error('GV: no component "' + name + '"');
    return fn(props || {});
  }

  /* ════════════════════════════════════════════════════════════════════════
     sidebar — the back-office staff navigation.
     Source-grounded default nav (real admin glyphs + order, transcribed from the
     live admin). Props override any of it. BO chrome is NOT city-themed — it uses
     the fixed BO palette (--gv-bo-*), per the theming contract.
     ════════════════════════════════════════════════════════════════════════ */
  var SIDEBAR_TOP = [
    { icon: "admin-dashboard",   label: "Dashboard",         id: "dashboard" },
    { icon: "admin-projects",    label: "Projects",          id: "projects" },
    { icon: "admin-input",       label: "Input manager",     id: "input" },
    { icon: "admin-users",       label: "Users",             id: "users" },
    { icon: "admin-messaging",   label: "Messaging",         id: "messaging" },
    { icon: "admin-reporting",   label: "Reporting",         id: "reporting" },
    { icon: "admin-community",   label: "Community monitor", id: "community" },
    { icon: "admin-inspiration", label: "Inspiration hub",   id: "inspiration" },
  ];
  var SIDEBAR_BOTTOM = [
    { icon: "admin-tools",         label: "Tools",        id: "tools" },
    { icon: "admin-pages",         label: "Pages & menu", id: "pages" },
    { icon: "admin-settings",      label: "Settings",     id: "settings" },
    { icon: "admin-notifications", label: "Notifications", id: "notifications", badge: "29" },
  ];

  function navItem(it, active) {
    var isA = it.id && it.id === active;
    var style = it.iconColor ? ' style="color:' + esc(it.iconColor) + '"' : "";
    var icon = '<span class="gv-bo-nav__icon"' + style + ' data-gv-icon="' + esc(it.icon) + '"></span>';
    var badge = it.badge ? '<span class="gv-bo-count">' + esc(it.badge) + "</span>" : "";
    return '<a class="gv-bo-nav__item' + (isA ? " is-active" : "") + '" href="' + esc(it.href || "#") + '" title="' + esc(it.label) + '"' +
      (isA ? ' aria-current="page"' : "") + ">" + icon +
      '<span class="gv-bo-nav__label">' + esc(it.label) + "</span>" + badge + "</a>";
  }

  function sidebar(props) {
    props = props || {};
    var active = props.active || "";
    var top = props.items || SIDEBAR_TOP;
    var bottom = props.bottom || SIDEBAR_BOTTOM;
    var brand = props.brand || { label: "To platform", icon: "admin-back", href: "#" };
    var account = props.account || { label: "Go Vocal Admin", sub: "Administrator", icon: "user" };
    var cls = "gv-bo-side" + (props.rail ? " is-rail" : "");
    var autoAttr = props.auto ? " data-gv-side-auto" : "";

    var html = '<nav class="' + cls + '" aria-label="' + esc(props.ariaLabel || "Admin") + '"' + autoAttr + ">";
    html += '<a class="gv-bo-side__brand" href="' + esc(brand.href || "#") + '">' +
      '<span class="gv-bo-side__logo"><span data-gv-icon="' + esc(brand.icon || "admin-back") + '"></span></span>' +
      '<span class="gv-bo-side__brandtext">' + esc(brand.label || "To platform") + "</span></a>";
    html += '<div class="gv-bo-nav">' + top.map(function (i) { return navItem(i, active); }).join("") + "</div>";
    html += '<div class="gv-bo-nav gv-bo-nav--bottom">' + bottom.map(function (i) { return navItem(i, active); }).join("");
    if (account) {
      html += '<a class="gv-bo-nav__item" href="#" title="' + esc(account.label) + '">' +
        '<span class="gv-bo-avatar" data-gv-icon="' + esc(account.icon || "user") + '"></span>' +
        '<span class="gv-bo-nav__label">' + esc(account.label) +
        '<span class="gv-bo-nav__sub">' + esc(account.sub || "") + "</span></span>" +
        '<span class="gv-bo-chev" data-gv-icon="chevron-right"></span></a>';
    }
    if (props.support !== false) {
      html += '<a class="gv-bo-nav__item" href="#" title="Support">' +
        '<span class="gv-bo-nav__icon" style="color:var(--gv-green-400)" data-gv-icon="admin-support"></span>' +
        '<span class="gv-bo-nav__label">Support</span>' +
        '<span class="gv-bo-chev" data-gv-icon="chevron-right"></span></a>';
    }
    html += "</div></nav>";
    return html;
  }
  register("sidebar", sidebar);
  // expose the default nav so consumers can extend rather than redefine
  sidebar.TOP = SIDEBAR_TOP;
  sidebar.BOTTOM = SIDEBAR_BOTTOM;

  /* ── hydrate: fill data-gv-icon glyphs + wire the container-aware auto-collapse
       (a sidebar with `auto:true` collapses to the icon rail when its CONTAINER,
       not the viewport, drops below 1200px). Idempotent per element. ── */
  function hydrate(root) {
    root = root || document;
    if (window.GVIcons) GVIcons.render();
    var sides = (root.querySelectorAll ? root : document).querySelectorAll("[data-gv-side-auto]");
    sides.forEach(function (side) {
      if (side.__gvWired) return;
      side.__gvWired = 1;
      var container = side.closest(".gv-bo-shell, .gv-bo") || side.parentElement;
      if (!container || typeof ResizeObserver === "undefined") return;
      new ResizeObserver(function (entries) {
        var narrow = entries[0].contentRect.width < 1200;
        side.classList.toggle("is-rail", narrow);
        container.classList.toggle("is-rail", narrow);
      }).observe(container);
    });
  }

  function mount(el, name, props) {
    if (typeof el === "string") el = document.querySelector(el);
    if (!el) return null;
    el.innerHTML = render(name, props);
    hydrate(el);
    return el;
  }

  var api = { render: render, mount: mount, hydrate: hydrate, register: register, components: registry, esc: esc };
  // shorthands: GV.sidebar(props), etc. (one per registered component)
  api.sidebar = sidebar;
  return api;
})();

/* ════════════════════════════════════════════════════════════════════════════
   COMPONENTS — registered onto window.GV after the core IIFE. Each is one source
   of truth: GV.register('<name>', function (props) { return canonical HTML; }).
   Use GV.esc() to escape interpolated text, data-gv-icon for glyphs, and ONLY
   canonical .gv-* classes + --gv-* token vars — never a hardcoded off-grid value.
   Consumers import via GV.mount(el, '<name>', props). (Appended by Phase 2.)
   ════════════════════════════════════════════════════════════════════════════ */


/* ── accordion ─────────────────────────────────────────────────────────── */
/* accordion.js — canonical instance renderer for the accordion component.
 *
 * Props (with defaults matching the primary HEAD instance):
 *   items : Array of { q: string, body: string, open: boolean }
 *           (default = the three Westmere FAQ items from HEAD, first item open)
 *
 * GV.render("accordion") → reproduces the full .gv-accordion block from HEAD verbatim.
 *
 * Each item in `items`:
 *   q    : question text (the <summary> label)           [required]
 *   body : answer HTML/text (inside <p> in .gv-acc__body) [required]
 *   open : boolean — adds the `open` attribute            [default false]
 */
GV.register("accordion", function (props) {
  props = props || {};
  var esc = GV.esc;

  var DEFAULT_ITEMS = [
    {
      q: "How will my idea be used?",
      body: "Every idea is read by the project team and grouped with similar suggestions. The most-supported, workable ideas move forward to the prioritisation phase, where residents help decide which ones to take into the final design.",
      open: true
    },
    {
      q: "What can I suggest?",
      body: "Anything that fits within Market Square and its surrounding streets — seating, planting and trees, the weekly market layout, play, lighting, paving, cycle parking or how traffic moves through. Out-of-scope ideas are tagged and passed to the right team.",
      open: false
    },
    {
      q: "Who is running this project?",
      body: "The City of Westmere — Engagement team, together with the Old Town public-space designers. Project updates are posted to followers as each phase opens.",
      open: false
    }
  ];

  var items = (props.items !== undefined) ? props.items : DEFAULT_ITEMS;

  var itemsHtml = items.map(function (item) {
    var openAttr = item.open ? " open" : "";
    return (
      '<details class="gv-acc__item"' + openAttr + ">" +
        '<summary class="gv-acc__head">' +
          '<span class="gv-acc__q">' + esc(item.q) + "</span>" +
          '<span class="gv-acc__chev" data-gv-icon="chevron-right" aria-hidden="true"></span>' +
        "</summary>" +
        '<div class="gv-acc__body"><p>' + esc(item.body) + "</p></div>" +
      "</details>"
    );
  }).join("\n        ");

  return '<div class="gv-accordion">\n        ' + itemsHtml + "\n      </div>";
});

/* ── approval-voting ─────────────────────────────────────────────────────────── */
/* approval-voting.js — canonical instance renderer for the approval-voting component.
 * Registered onto window.GV via GV.register("approval-voting", fn).
 * GV.render("approval-voting", {}) → primary instance: the options accordion.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   variant : "accordion" | "results"    (default "accordion")
 *     "accordion" → .gv-voteoptions accordion of collapsible vote option rows.
 *                   Renders inside .gv-phasebody.gv-phasebody--full.
 *     "results"   → "Voting closed" heading + .gv-tally summary card + .gv-voteresults
 *                   ranked cards. Renders inside .gv-phasebody.gv-phasebody--full.
 *
 *   — variant "accordion" props —
 *   options : Array of { id, title, body, expanded }
 *             Default = three HEAD options; first is expanded, rest collapsed.
 *             id       : string — value for aria-controls / panel id (e.g. "opt-1")
 *             title    : string — .gv-voteoption__title text
 *             body     : string — paragraph content inside the panel
 *             expanded : boolean — aria-expanded state (default false; first item true)
 *
 *   — variant "results" props —
 *   closedLabel   : string   heading text         (default "Voting closed")
 *   tallyTitle    : string   tally card h3 text   (default "Final tally")
 *   tallyCaption  : string   raw HTML for caption (default HEAD caption)
 *   tallyCount    : string   big count number     (default "4")
 *   tallySub      : string   sub-label text       (default "people submitted their votes online")
 *   results       : Array of { rank, title, pct, pctRaw, fillWidth, commentCount, href }
 *                   Default = three HEAD result cards in rank order.
 *                   rank         : string   rank badge text (e.g. "#1")
 *                   title        : string   result card title
 *                   pct          : string   percentage line text (e.g. "50% • 2 votes")
 *                   fillWidth    : string   inline width for .gv-voteresult__fill (e.g. "50%")
 *                   commentCount : string | number   omit or 0 → no comment chip
 *                   href         : string   card href (default "#")
 *
 * MARKUP ONLY — accordion toggle behaviour is wired in the demo's own <script>.
 */
GV.register("approval-voting", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant = props.variant !== undefined ? props.variant : "accordion";

  /* ════════════════════════════════════════════════════════
     variant "accordion" — collapsible options list
     ════════════════════════════════════════════════════════ */
  if (variant === "accordion") {
    var DEFAULT_OPTIONS = [
      {
        id: "opt-1",
        title: "Option 1: Embrace the Past, Illuminate the Future",
        body: "Restore the historic monuments and headstones while adding subtle\n              low-impact lighting along the main paths, so the cemetery stays a place\n              of quiet reflection after dark without altering its character.",
        expanded: true
      },
      {
        id: "opt-2",
        title: "Option 2: Bridging History and Innovation",
        body: "Pair preservation with a small visitor centre and a digital\n              memorial archive, letting residents explore the cemetery’s stories\n              online while protecting the grounds themselves.",
        expanded: false
      },
      {
        id: "opt-3",
        title: "Option 3: A Living Legacy",
        body: "Convert the surrounding grounds into a community memorial garden\n              with native planting and gathering spaces, keeping the cemetery active\n              and cared-for by the people who live around it.",
        expanded: false
      }
    ];

    var options = props.options !== undefined ? props.options : DEFAULT_OPTIONS;

    var rows = options.map(function (opt) {
      var isOpen = opt.expanded ? true : false;
      return (
        '<div class="gv-voteoption">' +
          '<button class="gv-voteoption__head" aria-expanded="' + (isOpen ? "true" : "false") + '" aria-controls="' + esc(opt.id) + '">' +
            '<h3 class="gv-voteoption__title">' + esc(opt.title) + '</h3>' +
            '<span class="gv-voteoption__chevron"><span data-gv-icon="chevron-right"></span></span>' +
          '</button>' +
          '<div class="gv-voteoption__panel' + (isOpen ? " is-open" : "") + '" id="' + esc(opt.id) + '" role="region">' +
            '<p>' + esc(opt.body) + '</p>' +
          '</div>' +
        '</div>'
      );
    }).join("\n        ");

    return (
      '<div class="gv-phasebody gv-phasebody--full">' +
        '<div class="gv-voteoptions">' +
          '\n        ' + rows + '\n      ' +
        '</div>' +
      '</div>'
    );
  }

  /* ════════════════════════════════════════════════════════
     variant "results" — Final tally + ranked result cards
     ════════════════════════════════════════════════════════ */
  var closedLabel  = props.closedLabel  !== undefined ? props.closedLabel  : "Voting closed";
  var tallyTitle   = props.tallyTitle   !== undefined ? props.tallyTitle   : "Final tally";
  var tallyCaption = props.tallyCaption !== undefined ? props.tallyCaption :
    'Voting closed on <strong>April 20, 2026.</strong>\n          Participants could <strong>vote for 2 options.</strong>';
  var tallyCount   = props.tallyCount   !== undefined ? props.tallyCount   : "4";
  var tallySub     = props.tallySub     !== undefined ? props.tallySub     : "people submitted their votes online";

  var DEFAULT_RESULTS = [
    { rank: "#1", title: "Bridging History and Innovation",       pct: "50% • 2 votes", fillWidth: "50%",  commentCount: "1", href: "#" },
    { rank: "#2", title: "Embrace the Past, Illuminate the Future", pct: "25% • 1 vote",  fillWidth: "25%",  commentCount: "",  href: "#" },
    { rank: "#2", title: "A Living Legacy",                        pct: "25% • 1 vote",  fillWidth: "25%",  commentCount: "",  href: "#" }
  ];

  var results = props.results !== undefined ? props.results : DEFAULT_RESULTS;

  var cards = results.map(function (r) {
    var href = r.href !== undefined ? r.href : "#";
    var commentChip = (r.commentCount !== undefined && r.commentCount !== "" && r.commentCount !== 0)
      ? '<span class="gv-react__comment"><span data-gv-icon="comment" aria-hidden="true"></span><span>' + esc(String(r.commentCount)) + '</span></span>'
      : "";
    return (
      '<a class="gv-voteresult" href="' + esc(href) + '">' +
        '<div class="gv-voteresult__thumb">' +
          '<span data-gv-icon="idea" aria-hidden="true"></span>' +
          '<span class="gv-voteresult__rank">' + esc(r.rank) + '</span>' +
        '</div>' +
        '<div class="gv-voteresult__body">' +
          '<h5 class="gv-voteresult__title">' + esc(r.title) + '</h5>' +
          '<p class="gv-voteresult__pct">' + esc(r.pct) + '</p>' +
          '<div class="gv-voteresult__track"><div class="gv-voteresult__fill" style="width: ' + esc(r.fillWidth) + ';"></div></div>' +
          '<div class="gv-voteresult__foot">' +
            '<button class="gv-btn text" type="button"><u>Read more</u></button>' +
            commentChip +
          '</div>' +
        '</div>' +
      '</a>'
    );
  }).join("\n\n        ");

  return (
    '<div class="gv-phasebody gv-phasebody--full">' +
      '<h2 class="gv-title h2" style="margin: 0 0 16px;">' + esc(closedLabel) + '</h2>' +
      '<div class="gv-tally">' +
        '<h3 class="gv-tally__title">' + esc(tallyTitle) + '</h3>' +
        '<p class="gv-tally__caption">' + tallyCaption + '</p>' +
        '<p class="gv-tally__count">' + esc(tallyCount) + '</p>' +
        '<p class="gv-tally__sub">' + esc(tallySub) + '</p>' +
      '</div>' +
      '\n\n      <!-- ranked result cards -->' +
      '<div class="gv-voteresults">' +
        '\n        ' + cards + '\n      ' +
      '</div>' +
    '</div>'
  );
});

/* ── attachment ─────────────────────────────────────────────────────────── */
/* attachment.js — canonical instance renderer for the file-attachment download row.
 *
 * Props (with defaults matching the primary/first HEAD instance):
 *   items : Array<{ name: string, href: string, size: string }>
 *           (default = the three St Louis policy-memo rows from the HEAD demo)
 *
 * Each item renders as a .gv-attachment row inside a .gv-attachments list.
 * The wrapper (.gv-attachments) is always rendered; pass a one-item array
 * for the single-row variant.
 *
 * GV.render("attachment", {}) → reproduces the PRIMARY instance:
 *   <div class="gv-attachments"> … 3 St Louis rows … </div>
 */
GV.register("attachment", function (props) {
  props = props || {};
  var esc = GV.esc;

  var items = props.items !== undefined ? props.items : [
    { name: "10_7_25 - Policy Memo - Opening Reflection or Prayer.pdf",    href: "#", size: "(663.3 KB)" },
    { name: "10_14_25 - Policy Memo - Sidewalk Repair Cost-Sharing.pdf",   href: "#", size: "(412.8 KB)" },
    { name: "10_21_25 - Policy Memo - Neighborhood Traffic Calming.pdf",   href: "#", size: "(1.2 MB)" }
  ];

  var rows = items.map(function (item) {
    return (
      '<div class="gv-attachment">' +
        '<span class="gv-attachment__icon" data-gv-icon="paperclip" aria-hidden="true"></span>' +
        '<a class="gv-attachment__name" href="' + esc(item.href || "#") + '" download>' + esc(item.name) + '</a>' +
        '<span class="gv-attachment__size">' + esc(item.size) + '</span>' +
      '</div>'
    );
  }).join("\n        ");

  return (
    '<div class="gv-attachments">\n        ' +
    rows +
    '\n      </div>'
  );
});

/* ── avatar-overflow-bubble ─────────────────────────────────────────────────────────── */
/* avatar-overflow-bubble.js — canonical instance renderer for the avatar overflow-count bubble.
 * Registered onto window.GV via GV.register("avatar-overflow-bubble", fn).
 * GV.render("avatar-overflow-bubble", {}) reproduces the PRIMARY instance exactly:
 *   .gv-bubbles (large/hero, 38px) with 4 blank .av spans, .count.bubble "19.8k",
 *   and a .gv-bubbles__label "19,813 users".
 *
 * Props (defaults = primary HEAD instance):
 *   size        {string}   — size modifier: "" (large/hero 38px) | "sm" (28px) | "xs" (20px)
 *                            default: ""
 *   avatarCount {number}   — number of blank .av spans to render
 *                            default: 4
 *   count       {string}   — overflow count text in .count.bubble
 *                            default: "19.8k"
 *   label       {string}   — optional .gv-bubbles__label text; omitted when ""
 *                            default: "19,813 users"
 *   testId      {string}   — data-testid on the .count.bubble span; omitted when ""
 *                            default: "userCountBubbleInner"
 *
 * Variants:
 *   {}                                                       → primary (large, 4 av, "19.8k", label)
 *   { avatarCount:3, count:"7443", label:"", testId:"" }    → numeric, no label
 *   { size:"sm", avatarCount:3, count:"+24", label:"", testId:"" }  → small card stack
 *   { size:"xs", avatarCount:2, count:"+9", label:"59 participants", testId:"" } → extra-small Wien row
 */
GV.register("avatar-overflow-bubble", function (props) {
  props = props || {};
  var esc = GV.esc;

  var size        = props.size        !== undefined ? props.size        : "";
  var avatarCount = props.avatarCount !== undefined ? props.avatarCount : 4;
  var count       = props.count       !== undefined ? props.count       : "19.8k";
  var label       = props.label       !== undefined ? props.label       : "19,813 users";
  var testId      = props.testId      !== undefined ? props.testId      : "userCountBubbleInner";

  var cls = "gv-bubbles" + (size ? " " + esc(size) : "");

  var avSpans = "";
  for (var i = 0; i < avatarCount; i++) {
    avSpans += '<span class="av"></span>';
  }

  var testIdAttr = testId ? ' data-testid="' + esc(testId) + '"' : "";
  var countSpan = '<span class="count bubble"' + testIdAttr + ">" + esc(count) + "</span>";

  var labelSpan = label ? '<span class="gv-bubbles__label">' + esc(label) + "</span>" : "";

  return '<div class="' + cls + '">' + avSpans + countSpan + labelSpan + "</div>";
});

/* ── avatar ─────────────────────────────────────────────────────────── */
/* avatar.js — canonical instance renderer for the avatar stack component.
 * Registered onto window.GV via GV.register("avatar", fn).
 * GV.render("avatar", {}) reproduces the primary demo instance exactly.
 *
 * Props:
 *   avatars {string[]}  — initials/overflow tokens for each .av span
 *                         default: ["AM","KP","JR","+5"]
 *   count   {string}    — participant count label in the .count span
 *                         default: "128 participants"
 *   margin  {string}    — inline margin on .gv-avatars ('' = no inline style)
 *                         default: "0"  (matches HEAD's style="margin:0")
 */
GV.register("avatar", function (props) {
  props = props || {};
  var esc = GV.esc;

  var avatars = props.avatars !== undefined ? props.avatars : ["AM", "KP", "JR", "+5"];
  var count   = props.count   !== undefined ? props.count   : "128 participants";
  var margin  = props.margin  !== undefined ? props.margin  : "0";

  var styleAttr = margin !== "" ? ' style="margin:' + esc(margin) + '"' : "";

  var avSpans = avatars.map(function (a) {
    return '<span class="av">' + esc(a) + "</span>";
  }).join("");

  var countSpan = count !== "" ? '<span class="count">' + esc(count) + "</span>" : "";

  return '<div class="gv-avatars"' + styleAttr + ">" + avSpans + countSpan + "</div>";
});

/* ── badge ─────────────────────────────────────────────────────────── */
/* badge.js — canonical instance renderer for the badge / status-label / spinner group.
 *
 * Props (with defaults matching the primary/first HEAD instance):
 *   variant  : "status" | "badge"   (default "status")
 *   label    : string               (default "Published")
 *   modifier : "" | "outlined" | "inverse"  (default "")
 *   bg       : CSS value for --bg (status) or background-color (badge inverse)
 *              default "var(--gv-success)"
 *   color    : inline color for .gv-badge  (default "var(--gv-teal-500)")
 *
 * Byte-faithful to HEAD: tags, class order, inline style format, and static
 * text are identical. Only copy/colour values become props.
 *
 * GV.render("badge", {}) → reproduces the PRIMARY instance:
 *   <span class="gv-status-label" style="--bg: var(--gv-success)">Published</span>
 */
GV.register("badge", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant  = props.variant  !== undefined ? props.variant  : "status";
  var label    = props.label    !== undefined ? props.label    : "Published";
  var modifier = props.modifier !== undefined ? props.modifier : "";
  var bg       = props.bg       !== undefined ? props.bg       : "var(--gv-success)";
  var color    = props.color    !== undefined ? props.color    : "var(--gv-teal-500)";

  if (variant === "status") {
    /* gv-status-label: uses CSS custom property --bg for fill.
       outlined variant carries no --bg inline style (Draft). */
    var cls = "gv-status-label" + (modifier ? " " + esc(modifier) : "");
    var styleAttr = (modifier !== "outlined" && bg)
      ? ' style="--bg: ' + bg + '"'
      : "";
    return '<span class="' + cls + '"' + styleAttr + ">" + esc(label) + "</span>";
  }

  /* variant === "badge": gv-badge, optional "inverse" modifier.
     inverse uses background-color + color:#fff inline.
     plain uses color only. */
  var badgeCls = "gv-badge" + (modifier ? " " + esc(modifier) : "");
  var badgeStyle;
  if (modifier === "inverse") {
    badgeStyle = ' style="background-color: ' + bg + '; color: #fff"';
  } else {
    badgeStyle = ' style="color: ' + color + '"';
  }
  return '<span class="' + badgeCls + '"' + badgeStyle + ">" + esc(label) + "</span>";
});

/* ── banner ─────────────────────────────────────────────────────────── */
/* banner.js — canonical instance renderer for .gv-banner.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("banner", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance from HEAD):
 *
 *   ariaLabel   string   accessible label for the <section>   "Project banner"
 *   stickerText string   rotated campaign sticker text        "HAVE YOUR SAY"
 *                        Pass null/false to suppress the sticker entirely.
 *
 * The __art SVG is the canonical teal-gradient illustration (concentric rings +
 * bar-chart blocks) lifted verbatim from HEAD. It is decorative (aria-hidden).
 * Swap it by passing an `artSvg` string (raw SVG markup); if omitted the HEAD
 * default renders.
 *
 * Single instance from HEAD components/banner/index.html:
 *   GV.render("banner", {}) → primary, sticker "HAVE YOUR SAY"
 */
GV.register("banner", function (props) {
  props = props || {};
  var esc = GV.esc;

  var ariaLabel   = props.ariaLabel   != null ? props.ariaLabel   : "Project banner";
  var stickerText = props.stickerText !== undefined ? props.stickerText : "HAVE YOUR SAY";

  var defaultSvg =
    '<svg viewBox="0 0 1150 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
      '<g fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="2">' +
        '<circle cx="930" cy="80" r="120" />' +
        '<circle cx="930" cy="80" r="190" />' +
        '<circle cx="930" cy="80" r="260" />' +
      '</g>' +
      '<g fill="#ffffff" fill-opacity="0.16">' +
        '<rect x="80" y="210" width="120" height="60" rx="6" />' +
        '<rect x="220" y="180" width="120" height="90" rx="6" />' +
        '<rect x="360" y="150" width="120" height="120" rx="6" />' +
      '</g>' +
    '</svg>';

  var artSvg = props.artSvg != null ? props.artSvg : defaultSvg;

  var sticker = stickerText
    ? '<span class="gv-banner__sticker">' + esc(stickerText) + '</span>'
    : '';

  return (
    '<section class="gv-banner" aria-label="' + esc(ariaLabel) + '">' +
      '<div class="gv-banner__art">' +
        artSvg +
        sticker +
      '</div>' +
    '</section>'
  );
});

/* ── bo-analysis ─────────────────────────────────────────────────────────── */
/* bo-analysis.js — canonical instance renderer for the back-office AI analysis
 * (sensemaking) kit. One source of truth: edit here and every linked demo updates.
 *
 *   GV.render("bo-analysis", { part: "<name>", ... }) → canonical HTML string.
 *
 * Source-grounded on HEAD: components/bo-analysis/index.html. BO surface — uses the
 * neutral BO palette (.gv-bo-* classes), never tenant-themed. MARKUP ONLY (no behaviour).
 *
 * The demo is a kit of distinct-but-related AI-analysis pieces from the Input
 * manager / sensemaking back office. They share the same .gv-bo-ai* family, so they
 * live in ONE renderer selected by `part`. Every part defaults to the exact primary
 * HEAD markup; pass props to vary copy / state / repeated items.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   part   string  which piece to render. One of:
 *            "banner"      — sensemaking banner (DEFAULT)
 *            "aibar"       — single AI action bar (Auto-tag)
 *            "aibar-split" — split header (two cells)
 *            "tagrail"     — tag rail + auto-tag chips nav
 *            "notice"      — a single AI notice
 *            "aicard"      — AI insight card (generated summary)
 *            "aiempty"     — empty summary panel
 *            "tagmeters"   — tag meters + tagged-input row group
 *            "insightcard" — view-all button + insight card
 *            "matrix"      — auto-insights cross-tab matrix
 *            "aimodal"     — "How to work with AI" intro dialog
 *            "aiactions"   — AI actions + generated answer
 *
 *   — part "banner" —
 *   icon     string  default: "stars"
 *   text     string  default: "Explore AI-powered summaries and view individual submissions."
 *   ctaLabel string  default: "Open AI analysis &rarr;"  (raw HTML entity preserved)
 *   ctaHref  string  default: "#"
 *
 *   — part "aibar" —
 *   icon     string  default: "stars"
 *   label    string  default: "Auto-tag"
 *
 *   — part "aibar-split" —
 *   cells    Array<{icon,label}>  default: Summarize / Ask a question
 *
 *   — part "tagrail" —
 *   items    Array<{label, count, active?, tag?}>  default: the 3 HEAD rows
 *            tag:true wraps `label` in a .gv-bo-autotag chip.
 *
 *   — part "notice" —
 *   state    "locked" | "warn"  default: "locked"
 *   icon     string  default: "info-outline" (locked) / "alert-circle" (warn)
 *   text     string  default: the matching HEAD copy
 *
 *   — part "aicard" —
 *   icon     string  default: "stars"
 *   head     string  default: "AI summary"
 *   body     string  default: the HEAD bike-lanes summary
 *   metaLeft string  default: "18 / 24 inputs"
 *   metaRight string default: "generated 2 hours ago"
 *   actions  Array<{icon,label}>  default: the 4 HEAD iconbtns
 *
 *   — part "aiempty" —
 *   html     string  default: the HEAD copy (contains <br>; rendered raw)
 *
 *   — part "tagmeters" —
 *   meters   Array<{label, width, num}>  default: the 2 HEAD meters
 *   items    Array<{label, barWidth, num}>  default: the 1 HEAD tagged-input row
 *
 *   — part "insightcard" —
 *   viewAllIcon  string  default: "eye"
 *   viewAllLabel string  default: "View all insights"
 *   active       boolean default: true
 *   title        string  default: "Interactive project list (with search and map)"
 *   date         string  default: "8/20/2024"
 *   reactions    Array<{icon,count}>  default: the 4 HEAD reactions
 *   tags         Array<{label}>  default: 1 HEAD tag (chip + close icon)
 *
 *   — part "matrix" —
 *   gridTemplate string  default: "120px repeat(3,minmax(64px,1fr))"
 *   cols     string[]  default: ["Marketing","GS","Dev"]
 *   rowLabel string    default: "Input management"
 *   cells    Array<{state, num, delta}>  default: the 3 HEAD cells
 *
 *   — part "aimodal" —
 *   icon     string  default: "stars"
 *   title    string  default: "How to work with AI"
 *   body     string  default: the two HEAD <p> paragraphs (rendered raw)
 *   ctaLabel string  default: "I understand"
 *
 *   — part "aiactions" —
 *   actions  Array<{icon,label}>  default: Summarize / Ask a question
 *   prompt   string  default: "generate 25 trade-off questions for this ideation phase"
 *   promptIcon string default: "question-bubble"
 *   answer   string  default: the HEAD generated answer
 */

GV.register("bo-analysis", function (props) {
  props = props || {};
  var esc = GV.esc;
  var part = props.part || "banner";

  function icon(name) { return '<span class="gv-icon" data-gv-icon="' + esc(name) + '"></span>'; }

  /* ── banner ─────────────────────────────────────────────────────────── */
  if (part === "banner") {
    var bIcon = props.icon != null ? props.icon : "stars";
    var bText = props.text != null ? props.text : "Explore AI-powered summaries and view individual submissions.";
    var bCta  = props.ctaLabel != null ? props.ctaLabel : "Open AI analysis &rarr;";
    var bHref = props.ctaHref != null ? props.ctaHref : "#";
    return (
      '<div class="gv-bo-banner gv-bo-banner--ai">' +
        icon(bIcon) +
        '<div>' + esc(bText) + '</div>' +
        '<a class="gv-bo-banner__cta" href="' + esc(bHref) + '">' + bCta + '</a>' +
      '</div>'
    );
  }

  /* ── aibar (single) ─────────────────────────────────────────────────── */
  if (part === "aibar") {
    var abIcon = props.icon != null ? props.icon : "stars";
    var abLabel = props.label != null ? props.label : "Auto-tag";
    return '<div class="gv-bo-aibar">' + icon(abIcon) + ' ' + esc(abLabel) + '</div>';
  }

  /* ── aibar-split ────────────────────────────────────────────────────── */
  if (part === "aibar-split") {
    var splitCells = props.cells || [
      { icon: "stars",           label: "Summarize" },
      { icon: "question-bubble", label: "Ask a question" },
    ];
    return (
      '<div class="gv-bo-aibar gv-bo-aibar--split">' +
        splitCells.map(function (c) {
          return '<button class="gv-bo-aibar__cell">' + icon(c.icon) + ' ' + esc(c.label) + '</button>';
        }).join('') +
      '</div>'
    );
  }

  /* ── tagrail ────────────────────────────────────────────────────────── */
  if (part === "tagrail") {
    var trItems = props.items || [
      { label: "All inputs",          count: "6", active: true },
      { label: "Inputs without tags", count: "6" },
      { label: "Example tag 1",       count: "0", tag: true },
    ];
    return (
      '<nav class="gv-bo-tagrail">' +
        trItems.map(function (it) {
          var cls = 'gv-bo-tagrail__item' + (it.active ? ' is-active' : '');
          var inner = it.tag
            ? '<span class="gv-bo-autotag">' + esc(it.label) + '</span>'
            : esc(it.label);
          return '<a class="' + cls + '">' + inner + ' <span class="gv-bo-tagrail__count">' + esc(it.count) + '</span></a>';
        }).join('') +
      '</nav>'
    );
  }

  /* ── notice ─────────────────────────────────────────────────────────── */
  if (part === "notice") {
    var nState = props.state != null ? props.state : "locked";
    var nIsWarn = nState === "warn";
    var nCls = nIsWarn ? 'is-warn' : 'is-locked';
    var nIcon = props.icon != null ? props.icon : (nIsWarn ? "alert-circle" : "info-outline");
    var nText = props.text != null ? props.text
      : (nIsWarn ? "AI can make mistakes. Please verify important information."
                 : "Auto insights are not available for projects with less than 30 participants.");
    return '<div class="gv-bo-ainotice ' + nCls + '">' + icon(nIcon) + ' ' + esc(nText) + '</div>';
  }

  /* ── aicard ─────────────────────────────────────────────────────────── */
  if (part === "aicard") {
    var cIcon = props.icon != null ? props.icon : "stars";
    var cHead = props.head != null ? props.head : "AI summary";
    var cBody = props.body != null ? props.body : "Residents broadly support more bike lanes near the park, with recurring concern about evening lighting and pedestrian crossings on the east entrance.";
    var cMetaL = props.metaLeft != null ? props.metaLeft : "18 / 24 inputs";
    var cMetaR = props.metaRight != null ? props.metaRight : "generated 2 hours ago";
    var cActions = props.actions || [
      { icon: "filter-2", label: "Restore filters" },
      { icon: "copy",     label: "Copy" },
      { icon: "flag",     label: "Rate" },
      { icon: "delete",   label: "Delete" },
    ];
    return (
      '<div class="gv-bo-aicard">' +
        '<div class="gv-bo-aicard__head">' + icon(cIcon) + ' ' + esc(cHead) + '</div>' +
        '<div class="gv-bo-aicard__body">' + esc(cBody) + '</div>' +
        '<div class="gv-bo-aicard__foot"><span>' + esc(cMetaL) + '</span><span>' + esc(cMetaR) + '</span></div>' +
        '<div class="gv-bo-aicard__actions">' +
          cActions.map(function (a) {
            return '<button class="gv-iconbtn" aria-label="' + esc(a.label) + '">' + icon(a.icon) + '</button>';
          }).join('') +
        '</div>' +
      '</div>'
    );
  }

  /* ── aiempty ────────────────────────────────────────────────────────── */
  if (part === "aiempty") {
    var eHtml = props.html != null ? props.html
      : "Your text summaries will be displayed here, but you currently do not have any yet.<br><br>Click the Auto-summarize button above to get started.";
    return '<div class="gv-bo-aiempty">' + eHtml + '</div>';
  }

  /* ── tagmeters ──────────────────────────────────────────────────────── */
  if (part === "tagmeters") {
    var tmMeters = props.meters || [
      { label: "All inputs",          width: "100%", num: "48" },
      { label: "Inputs without tags", width: "31%",  num: "15" },
    ];
    var tmItems = props.items || [
      { label: "Input management", barWidth: "28px", num: "3" },
    ];
    return (
      tmMeters.map(function (m) {
        return (
          '<div class="gv-bo-tagmeter">' +
            '<div class="gv-bo-tagmeter__label">' + esc(m.label) + '</div>' +
            '<div class="gv-bo-tagmeter__row"><div class="gv-bo-tagmeter__track"><div class="gv-bo-tagmeter__fill" style="width:' + esc(m.width) + '"></div></div><span class="gv-bo-tagmeter__num">' + esc(m.num) + '</span></div>' +
          '</div>'
        );
      }).join('') +
      tmItems.map(function (it) {
        return (
          '<div class="gv-bo-tagitem">' +
            '<div class="gv-bo-tagitem__row"><span class="gv-bo-tagitem__check"></span><span class="gv-bo-autotag">' + esc(it.label) + '</span><span class="gv-bo-tagitem__opts">' + icon("dots-horizontal") + '</span></div>' +
            '<div class="gv-bo-tagitem__meter"><div class="gv-bo-tagitem__bar" style="width:' + esc(it.barWidth) + '"></div><span class="gv-bo-tagitem__num">' + esc(it.num) + '</span></div>' +
          '</div>'
        );
      }).join('')
    );
  }

  /* ── insightcard ────────────────────────────────────────────────────── */
  if (part === "insightcard") {
    var icViewIcon = props.viewAllIcon != null ? props.viewAllIcon : "eye";
    var icViewLabel = props.viewAllLabel != null ? props.viewAllLabel : "View all insights";
    var icActive = props.active != null ? props.active : true;
    var icTitle = props.title != null ? props.title : "Interactive project list (with search and map)";
    var icDate = props.date != null ? props.date : "8/20/2024";
    var icReacts = props.reactions || [
      { icon: "vote-up",   count: "1" },
      { icon: "vote-down", count: "0" },
      { icon: "email",     count: "0" },
      { icon: "comments",  count: "1" },
    ];
    var icTags = props.tags || [
      { label: "Project list/map" },
    ];
    return (
      '<button class="gv-bo-viewall" type="button">' + icon(icViewIcon) + ' ' + esc(icViewLabel) + '</button>' +
      '<div class="gv-bo-insightcard' + (icActive ? ' is-active' : '') + '">' +
        '<div class="gv-bo-insightcard__head">' +
          '<div class="gv-bo-insightcard__title">' + esc(icTitle) + '</div>' +
          '<div class="gv-bo-insightcard__date">' + esc(icDate) + '</div>' +
        '</div>' +
        '<div class="gv-bo-insightcard__react">' +
          icReacts.map(function (r) {
            return '<span>' + icon(r.icon) + ' ' + esc(r.count) + '</span>';
          }).join('') +
        '</div>' +
        '<div class="gv-bo-insightcard__tags">' +
          icTags.map(function (t) {
            return '<span class="gv-bo-autotag">' + esc(t.label) + ' <span class="gv-icon" data-gv-icon="close" style="width:12px;height:12px"></span></span>';
          }).join('') +
        '</div>' +
      '</div>'
    );
  }

  /* ── matrix ─────────────────────────────────────────────────────────── */
  if (part === "matrix") {
    var mGrid = props.gridTemplate != null ? props.gridTemplate : "120px repeat(3,minmax(64px,1fr))";
    var mCols = props.cols || ["Marketing", "GS", "Dev"];
    var mRow = props.rowLabel != null ? props.rowLabel : "Input management";
    var mCells = props.cells || [
      { state: "neg", num: "0", delta: "-100%" },
      { state: "neg", num: "1", delta: "-43%" },
      { state: "pos", num: "2", delta: "+353%" },
    ];
    return (
      '<div class="gv-bo-matrix" style="grid-template-columns:' + esc(mGrid) + '">' +
        '<div class="gv-bo-matrix__corner"></div>' +
        mCols.map(function (c) { return '<div class="gv-bo-matrix__colhead">' + esc(c) + '</div>'; }).join('') +
        '<div class="gv-bo-matrix__rowhead"><span class="gv-bo-autotag">' + esc(mRow) + '</span></div>' +
        mCells.map(function (cell) {
          return '<div class="gv-bo-matrix__cell is-' + esc(cell.state) + '"><span class="gv-bo-matrix__num">' + esc(cell.num) + '</span><span class="gv-bo-matrix__delta">' + esc(cell.delta) + '</span></div>';
        }).join('') +
      '</div>'
    );
  }

  /* ── aimodal ────────────────────────────────────────────────────────── */
  if (part === "aimodal") {
    var moIcon = props.icon != null ? props.icon : "stars";
    var moTitle = props.title != null ? props.title : "How to work with AI";
    var moBody = props.body != null ? props.body
      : "<p>We recommend using AI-generated summaries as a starting point for understanding large datasets, but not as the final word.</p>" +
        "<p><strong>Hallucinations:</strong> While rare, the AI might occasionally generate information not present in the original dataset.</p>";
    var moCta = props.ctaLabel != null ? props.ctaLabel : "I understand";
    return (
      '<div class="gv-modal" style="max-width:none">' +
        '<div class="gv-modal__header">' +
          '<span class="gv-icon gv-bo-aimodal__icon" data-gv-icon="' + esc(moIcon) + '"></span>' +
          '<h2 class="gv-modal__title">' + esc(moTitle) + '</h2>' +
        '</div>' +
        '<div class="gv-modal__body gv-bo-aimodal__body" style="max-height:160px">' +
          moBody +
        '</div>' +
        '<div class="gv-modal__footer">' +
          '<button class="gv-bo-aimodal__cta" type="button">' + esc(moCta) + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  /* ── aiactions ──────────────────────────────────────────────────────── */
  if (part === "aiactions") {
    var aaActions = props.actions || [
      { icon: "stars",           label: "Summarize" },
      { icon: "question-bubble", label: "Ask a question" },
    ];
    var aaPromptIcon = props.promptIcon != null ? props.promptIcon : "question-bubble";
    var aaPrompt = props.prompt != null ? props.prompt : "generate 25 trade-off questions for this ideation phase";
    var aaAnswer = props.answer != null ? props.answer : 'Here are 25 trade-off questions, phrased for "agree/unsure/disagree" responses, based on the most recurring topics from the phase.';
    return (
      '<div class="gv-bo-aiactions">' +
        aaActions.map(function (a) {
          return '<button class="gv-bo-aiactions__btn" type="button">' + icon(a.icon) + ' ' + esc(a.label) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="gv-bo-aiqa">' +
        '<div class="gv-bo-aiqa__prompt">' + icon(aaPromptIcon) + ' ' + esc(aaPrompt) + '</div>' +
        '<div class="gv-bo-aiqa__body">' + esc(aaAnswer) + '</div>' +
      '</div>'
    );
  }

  throw new Error('GV bo-analysis: unknown part "' + part + '"');
});

/* ── bo-app-shell ─────────────────────────────────────────────────────────── */
/* bo-app-shell.js — canonical instance renderer for the back-office Project Editor chrome.
 * One source of truth: edit here and every linked demo/prototype updates.
 * GV.render("bo-app-shell", props) → canonical HTML string.
 *
 * Source-grounded on HEAD: components/bo-app-shell/index.html ("Project Editor chrome").
 * BO surface — uses the fixed neutral BO palette via .gv-bo (NEVER tenant-themed).
 *
 * Structure (byte-faithful to HEAD): .gv-bo > .gv-bo-main containing
 *   • a project top bar (.gv-bo-topbar): title + meta row + action buttons
 *   • the project tab row (.gv-bo-tabs)
 *   • a content frame where a page mounts (.gv-bo-main, raw-HTML `content` prop)
 * The sidebar navigation is a SEPARATE component (GV.render("sidebar")) that sits
 * in the outer .gv-bo-shell grid — it is NOT part of this chrome, so it is not
 * rendered here (matches HEAD, which contains no sidebar markup).
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   title       string   project title
 *                        default: "Let's Reimagine Dorothea Dix Park"
 *
 *   meta        Array<{icon, label}>   the meta row under the title
 *                        default: the four HEAD items (lock/Everyone, eye/Public,
 *                        group/170 project participants, check-circle/Published · Active)
 *
 *   actions     raw HTML string   the .gv-bo-topbar__actions content
 *                        default: preview iconbtn + Share + Published buttons (HEAD)
 *
 *   tabs        Array<{label, active?, new?, href?}>   the project tab row
 *                        default: the six HEAD tabs (Timeline active, "360 Input" NEW)
 *
 *   content     raw HTML string   the page that mounts in .gv-bo-main
 *                        default: HEAD's stub block
 */

var BO_SHELL_META = [
  { icon: "lock",         label: "Everyone" },
  { icon: "eye",          label: "Public" },
  { icon: "group",        label: "170 project participants" },
  { icon: "check-circle", label: "Published · Active" },
];

var BO_SHELL_TABS = [
  { label: "General" },
  { label: "Timeline", active: true },
  { label: "Audience" },
  { label: "Messaging" },
  { label: "Events" },
  { label: "360 Input", new: true },
];

var BO_SHELL_ACTIONS =
  '<button class="gv-iconbtn" aria-label="Preview project"><span data-gv-icon="eye"></span></button>' +
  '<button class="gv-btn secondary-outlined"><span data-gv-icon="share"></span><span class="gv-btn__label">Share</span></button>' +
  '<button class="gv-btn admin-dark"><span data-gv-icon="check"></span><span class="gv-btn__label">Published</span></button>';

var BO_SHELL_CONTENT =
  '<div class="bo-content-stub">' +
    '<div class="bo-stub-block">page content mounts in <code>.gv-bo-main</code></div>' +
  '</div>';

GV.register("bo-app-shell", function (props) {
  props = props || {};
  var esc = GV.esc;

  var title   = props.title   != null ? props.title   : "Let's Reimagine Dorothea Dix Park";
  var meta    = props.meta    || BO_SHELL_META;
  var actions = props.actions != null ? props.actions : BO_SHELL_ACTIONS;
  var tabs    = props.tabs    || BO_SHELL_TABS;
  var content = props.content != null ? props.content : BO_SHELL_CONTENT;

  var metaHtml = meta.map(function (m) {
    return '<span class="gv-bo-meta__item"><span class="gv-icon" data-gv-icon="' + esc(m.icon) + '"></span>' + esc(m.label) + '</span>';
  }).join("\n                  ");

  var tabsHtml = tabs.map(function (t) {
    var cls = "gv-bo-tab" + (t.active ? " is-active" : "");
    var badge = t.new ? '<span class="gv-bo-tab__new">NEW</span>' : "";
    return '<a class="' + cls + '" href="' + esc(t.href || "#") + '">' + esc(t.label) + badge + '</a>';
  }).join("\n              ");

  return (
    '<div class="gv-bo">\n' +
    '        <div class="gv-bo-main">\n' +
    '\n' +
    '          <!-- Project top bar -->\n' +
    '          <header class="gv-bo-topbar">\n' +
    '            <div class="gv-bo-topbar__row">\n' +
    '              <div>\n' +
    '                <h1 class="gv-bo-topbar__title">' + esc(title) + '</h1>\n' +
    '                <div class="gv-bo-meta">\n' +
    '                  ' + metaHtml + '\n' +
    '                </div>\n' +
    '              </div>\n' +
    '              <div class="gv-bo-topbar__actions">\n' +
    '                ' + actions + '\n' +
    '              </div>\n' +
    '            </div>\n' +
    '\n' +
    '            <!-- Project tabs -->\n' +
    '            <nav class="gv-bo-tabs" aria-label="Project">\n' +
    '              ' + tabsHtml + '\n' +
    '            </nav>\n' +
    '          </header>\n' +
    '\n' +
    '          <!-- Page mounts here -->\n' +
    '          ' + content + '\n' +
    '        </div>\n' +
    '      </div>'
  );
});

/* ── bo-menu ─────────────────────────────────────────────────────────── */
/* bo-menu.js — canonical instance renderer for the BO menu / notification flyout.
 *
 * Two variants share the same .gv-bo-menu surface:
 *
 *   variant: "exports"  (default)
 *     .gv-bo-menu with .gv-bo-menu__item rows (icon + label, href, download).
 *     Default items = the real Input-manager "Export" rows, byte-faithful to HEAD.
 *
 *   variant: "flyout"
 *     .gv-bo-menu.is-flyout — 260px notification panel.
 *     Rows are .gv-bo-notifflyout__item (.is-unread marks latest unread).
 *     Default items = HEAD's 4 notification rows, byte-faithful.
 *
 * Props:
 *   variant    : "exports" | "flyout"               (default "exports")
 *   ariaLabel  : string                              (default per variant)
 *   items      : Array of item objects               (defaults = HEAD's exact items)
 *
 *   For variant "exports", each item:
 *     { icon: string, label: string, href: string, download: bool }
 *   For variant "flyout", each item:
 *     { icon: string, body: string, time: string, unread: bool, href: string }
 *
 * GV.render("bo-menu", {}) → primary (exports) instance exactly matching HEAD.
 * GV.render("bo-menu", { variant: "flyout" }) → flyout instance matching HEAD.
 *
 * Byte-faithful to HEAD: tags, class order, attribute order, inline-style format,
 * and static text are identical. Dynamic copy/state → props (defaults = HEAD values).
 */
GV.register("bo-menu", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant = props.variant !== undefined ? props.variant : "exports";

  /* ── Exports dropdown ── */
  if (variant === "exports") {
    var ariaLabel = props.ariaLabel !== undefined ? props.ariaLabel : "Export";
    var items = props.items !== undefined ? props.items : [
      { icon: "download", label: "Export all posts (.xslx)",    href: "#", download: true },
      { icon: "download", label: "Export all comments (.xslx)", href: "#", download: true }
    ];
    var rows = items.map(function (it) {
      return '<a class="gv-bo-menu__item" role="menuitem" href="' + esc(it.href || "#") + '"' +
        (it.download ? " download" : "") +
        '><span class="gv-bo-menu__icon" data-gv-icon="' + esc(it.icon) + '"></span>' +
        esc(it.label) + "</a>";
    }).join("");
    return '<div class="gv-bo-menu" role="menu" aria-label="' + esc(ariaLabel) + '">' +
      rows + "</div>";
  }

  /* ── Notification flyout ── */
  if (variant === "flyout") {
    var ariaLabel = props.ariaLabel !== undefined ? props.ariaLabel : "Notifications";
    var items = props.items !== undefined ? props.items : [
      { icon: "survey",         unread: true,  body: "<i>Resident satisfaction survey</i> will enter a new phase on 5/8/2025", time: "1 year ago", href: "#" },
      { icon: "comment",        unread: false, body: "<i>Anna Becker</i> commented on your input <i>Bike lane on Oak St.</i>",  time: "1 year ago", href: "#" },
      { icon: "vote-up",        unread: false, body: "Your proposal <i>Riverside park clean-up</i> reached its threshold",      time: "1 year ago", href: "#" },
      { icon: "admin-projects", unread: false, body: "<i>Downtown revitalisation</i> will enter a new phase on 3/2/2025",       time: "1 year ago", href: "#" }
    ];
    var rows = items.map(function (n) {
      return '<a class="gv-bo-notifflyout__item' + (n.unread ? " is-unread" : "") +
        '" role="menuitem" href="' + esc(n.href || "#") + '">' +
        '<span class="gv-bo-notifflyout__icon" data-gv-icon="' + esc(n.icon) + '"></span>' +
        "<span>" + (n.body || "") + '<span class="gv-bo-notifflyout__time">' + esc(n.time) + "</span></span></a>";
    }).join("");
    return '<div class="gv-bo-menu is-flyout" role="menu" aria-label="' + esc(ariaLabel) + '">' +
      rows + "</div>";
  }

  return ""; /* unknown variant */
});

/* ── bo-templatecard ─────────────────────────────────────────────────────────── */
/* bo-templatecard.js — canonical instance renderers for .gv-bo-templatecard and .gv-bo-facetgroup.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("bo-templatecard", props) → canonical HTML string.
 * GV.render("bo-facetgroup",   props) → canonical HTML string.
 *
 * Source-grounded on r1-px-projects-new-template (HEAD: components/bo-templatecard/index.html).
 * BO surface — uses neutral BO palette (.gv-bo-* classes), never tenant-themed.
 *
 * ── bo-templatecard ──────────────────────────────────────────────────────────
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   variant     "single" | "gallery"
 *               "single"   — render ONE card (default)
 *               "gallery"  — render a .cardgrid wrapping N cards (for demo chrome)
 *
 *   — variant "single" (default) —
 *   img         string   CSS url(...) value for __img background-image
 *               default: url('https://images.unsplash.com/photo-1486325212027-8081e485255e?w=560&q=70&auto=format&fit=crop')
 *   title       string   heading text   default: "Spatial plan"
 *   desc        string   body copy      default: "Collect contributions regarding your new spacial plan and align residents around the vision."
 *   btn1Label   string   first action   default: "Use template"
 *   btn2Label   string   second action  default: "More details"
 *
 *   — variant "gallery" —
 *   templates   Array<{img, title, desc, btn1Label?, btn2Label?}>
 *               default: the three primary HEAD cards
 *
 * ── bo-facetgroup ─────────────────────────────────────────────────────────────
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   variant     "single" | "rail"
 *               "single"   — render ONE facet group (default)
 *               "rail"     — render N groups (for demo chrome)
 *
 *   — variant "single" —
 *   label       string   group heading           default: "Departments"
 *   open        boolean  aria-expanded state     default: true
 *   opts        string[] option lines            default: ["Urban planning","Mobility","Environment"]
 *
 *   — variant "rail" —
 *   facets      Array<{label, open?, opts}>
 *               default: the three primary HEAD groups
 */

var IMG  = "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=560&q=70&auto=format&fit=crop";
var IMG2 = "https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=560&q=70&auto=format&fit=crop";
var IMG3 = "https://images.unsplash.com/photo-1542621334-a254cf47733d?w=560&q=70&auto=format&fit=crop";

var DEFAULT_TEMPLATES = [
  { img: IMG,  title: "Spatial plan",          desc: "Collect contributions regarding your new spacial plan and align residents around the vision." },
  { img: IMG2, title: "Participatory budget",  desc: "Let residents allocate a portion of the municipal budget across competing proposals." },
  { img: IMG3, title: "Mobility consultation", desc: "Gather ideas and feedback on cycling, parking and public-transport priorities." },
];

var DEFAULT_FACETS = [
  { label: "Departments",          open: true,  opts: ["Urban planning", "Mobility", "Environment"] },
  { label: "Purposes",             open: false, opts: ["Collect input", "Prioritise", "Inform"] },
  { label: "Participation levels", open: false, opts: ["Consult", "Involve", "Collaborate"] },
];

GV.register("bo-templatecard", function (props) {
  props = props || {};
  var esc = GV.esc;
  var variant = props.variant || "single";

  function renderCard(t) {
    var img      = t.img      != null ? t.img      : IMG;
    var title    = t.title    != null ? t.title    : "Spatial plan";
    var desc     = t.desc     != null ? t.desc     : "Collect contributions regarding your new spacial plan and align residents around the vision.";
    var btn1     = t.btn1Label != null ? t.btn1Label : "Use template";
    var btn2     = t.btn2Label != null ? t.btn2Label : "More details";
    return (
      '<div class="gv-bo-templatecard">' +
        '<div class="gv-bo-templatecard__img" style="background-image:url(\'' + esc(img) + '\')"></div>' +
        '<h3 class="gv-bo-templatecard__title">' + esc(title) + '</h3>' +
        '<p class="gv-bo-templatecard__desc">' + esc(desc) + '</p>' +
        '<div class="gv-bo-templatecard__actions">' +
          '<button type="button" class="gv-btn secondary-outlined">' + esc(btn1) + '</button>' +
          '<button type="button" class="gv-btn admin-dark">' + esc(btn2) + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  if (variant === "gallery") {
    var templates = props.templates || DEFAULT_TEMPLATES;
    return templates.map(function (t) { return renderCard(t); }).join("");
  }

  /* default: single card */
  return renderCard({
    img:       props.img,
    title:     props.title,
    desc:      props.desc,
    btn1Label: props.btn1Label,
    btn2Label: props.btn2Label,
  });
});

GV.register("bo-facetgroup", function (props) {
  props = props || {};
  var esc = GV.esc;
  var variant = props.variant || "single";

  function renderGroup(f) {
    var label  = f.label != null ? f.label : "Departments";
    var open   = f.open  != null ? f.open  : true;
    var opts   = f.opts  || ["Urban planning", "Mobility", "Environment"];
    return (
      '<div class="gv-bo-facetgroup">' +
        '<button type="button" class="gv-bo-facetgroup__head" aria-expanded="' + esc(String(open)) + '">' +
          '<span>' + esc(label) + '</span>' +
          '<span class="gv-bo-facetgroup__chev" data-gv-icon="chevron-down"></span>' +
        '</button>' +
        '<div class="gv-bo-facetgroup__body"' + (open ? '' : ' hidden') + '>' +
          opts.map(function (o) { return '<div class="facetline">' + esc(o) + '</div>'; }).join('') +
        '</div>' +
      '</div>'
    );
  }

  if (variant === "rail") {
    var facets = props.facets || DEFAULT_FACETS;
    return facets.map(function (f) { return renderGroup(f); }).join("");
  }

  /* default: single group */
  return renderGroup({
    label: props.label,
    open:  props.open,
    opts:  props.opts,
  });
});

/* ── button ─────────────────────────────────────────────────────────── */
/* button.js — canonical instance renderer for the button component.
 *
 * Props (with defaults matching the primary HEAD instance):
 *   variant    : "primary" | "primary-outlined" | "secondary" | "white" |
 *                "text" | "delete" | "admin-dark"   (default "primary")
 *   label      : string               (default "Primary")
 *   size       : "" | "m" | "l" | "xl"  (default "" → no size class)
 *   icon       : glyph string (e.g. "plus") → prepends icon span (default "")
 *   disabled   : boolean              (default false)
 *   processing : boolean              (default false → no spinner)
 *
 * Label-wrap rule (derived byte-for-byte from HEAD's 13 buttons):
 *   Wrap text in <span class="gv-btn__label"> ONLY when:
 *     - icon is set (icon button always wraps label), OR
 *     - processing is true (spinner button always wraps label), OR
 *     - variant === "primary" AND NOT disabled AND NOT size AND NOT processing
 *       (the plain default primary wraps its label; sized/disabled primaries do not).
 *   All other cases: bare text node.
 *
 * GV.render("button") → <button class="gv-btn primary"><span class="gv-btn__label">Primary</span></button>
 */
GV.register("button", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant    = props.variant    !== undefined ? props.variant    : "primary";
  var label      = props.label      !== undefined ? props.label      : "Primary";
  var size       = props.size       !== undefined ? props.size       : "";
  var icon       = props.icon       !== undefined ? props.icon       : "";
  var disabled   = props.disabled   ? true : false;
  var processing = props.processing ? true : false;

  /* Build class list */
  var cls = "gv-btn " + esc(variant);
  if (size)       cls += " size-" + esc(size);
  if (processing) cls += " processing";

  /* Decide label wrapping (see rule above) */
  var wrapLabel = icon || processing || (variant === "primary" && !disabled && !size);
  var labelNode = wrapLabel
    ? '<span class="gv-btn__label">' + esc(label) + "</span>"
    : esc(label);

  /* Build inner content */
  var inner = "";
  if (icon) {
    inner += '<span data-gv-icon="' + esc(icon) + '" aria-hidden="true"></span>';
  }
  inner += labelNode;
  if (processing) {
    inner += '<span class="gv-spinner sm"></span>';
  }

  var disabledAttr = disabled ? " disabled" : "";

  return '<button class="' + cls + '"' + disabledAttr + ">" + inner + "</button>";
});

/* ── card ─────────────────────────────────────────────────────────── */
/* card.js — canonical instance renderer for .gv-card.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("card", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance):
 *
 *   variant   "default" | "meta" | "actions"
 *             "default"  — title + body + status-label + primary button  (card 1)
 *             "meta"     — title + body + divider + icon + meta text      (card 2)
 *             "actions"  — title + body + icon buttons                    (card 3)
 *
 *   title     string   heading text                 default per variant
 *   body      string   paragraph copy               default per variant
 *
 *   — variant "default" —
 *   statusLabel  string   status chip text          "Published"
 *   statusColor  string   --bg CSS value            "var(--gv-success)"
 *   btnLabel     string   primary button label      "Open"
 *
 *   — variant "meta" —
 *   metaIcon  string   data-gv-icon value           "calendar"
 *   metaText  string   meta line text               "Closes in 12 days"
 *
 *   — variant "actions" —
 *   (no extra props — icon buttons are canonical)
 */
GV.register("card", function (props) {
  props = props || {};
  var esc = GV.esc;
  var variant = props.variant || "default";

  if (variant === "meta") {
    var title    = props.title   != null ? props.title   : "Budget 2026";
    var body     = props.body    != null ? props.body    : "Cards hold any content — text, status, controls. They are the base surface for components.";
    var metaIcon = props.metaIcon != null ? props.metaIcon : "calendar";
    var metaText = props.metaText != null ? props.metaText : "Closes in 12 days";
    return (
      '<div class="gv-card">' +
        '<h3 class="gv-title h3" style="margin:0 0 8px">' + esc(title) + '</h3>' +
        '<p class="gv-text bodyM gv-text--secondary" style="margin:0 0 14px">' + esc(body) + '</p>' +
        '<hr class="gv-divider" style="margin:0 0 14px" />' +
        '<p class="gv-text bodyS gv-text--secondary" style="margin:0">' +
          '<span data-gv-icon="' + esc(metaIcon) + '" aria-hidden="true"></span> ' + esc(metaText) +
        '</p>' +
      '</div>'
    );
  }

  if (variant === "actions") {
    var title = props.title != null ? props.title : "Bike lanes";
    var body  = props.body  != null ? props.body  : "128 residents have shared input on this consultation so far.";
    return (
      '<div class="gv-card">' +
        '<h3 class="gv-title h3" style="margin:0 0 8px">' + esc(title) + '</h3>' +
        '<p class="gv-text bodyM gv-text--secondary" style="margin:0 0 14px">' + esc(body) + '</p>' +
        '<div class="row">' +
          '<button class="gv-iconbtn" aria-label="Like"><span data-gv-icon="vote-up"></span></button>' +
          '<button class="gv-iconbtn" aria-label="Comment"><span data-gv-icon="comment"></span></button>' +
          '<button class="gv-iconbtn" aria-label="Share"><span data-gv-icon="share"></span></button>' +
        '</div>' +
      '</div>'
    );
  }

  /* default */
  var title       = props.title       != null ? props.title       : "Park redesign";
  var body        = props.body        != null ? props.body        : "A plain surface card — a padded, rounded container with the standard border and shadow.";
  var statusLabel = props.statusLabel != null ? props.statusLabel : "Published";
  var statusColor = props.statusColor != null ? props.statusColor : "var(--gv-success)";
  var btnLabel    = props.btnLabel    != null ? props.btnLabel    : "Open";
  return (
    '<div class="gv-card">' +
      '<h3 class="gv-title h3" style="margin:0 0 8px">' + esc(title) + '</h3>' +
      '<p class="gv-text bodyM gv-text--secondary" style="margin:0 0 14px">' + esc(body) + '</p>' +
      '<div class="row">' +
        '<span class="gv-status-label" style="--bg: ' + esc(statusColor) + '">' + esc(statusLabel) + '</span>' +
        '<button class="gv-btn primary size-m">' + esc(btnLabel) + '</button>' +
      '</div>' +
    '</div>'
  );
});

/* ── checkbox-radio ─────────────────────────────────────────────────────────── */
/* checkbox-radio.js — canonical instance renderer for checkbox, radio, and toggle controls.
 *
 * Three visual variants share this renderer:
 *   variant: "checkbox" | "radio" | "toggle"   (default "checkbox")
 *
 * Props per variant:
 *
 *   checkbox / radio:
 *     checked  : boolean  (default true  for "checkbox"; irrelevant when rendering a group)
 *     disabled : boolean  (default false)
 *     label    : string   (default "Checked" for checkbox, "Option A" for radio)
 *     name     : string   radio group name attr (default "g-r"; only used for radio)
 *
 *   toggle:
 *     checked  : boolean  (default true)
 *     disabled : boolean  (default false)
 *     label    : string   (default "On")
 *
 * GV.render("checkbox-radio", {}) → reproduces the PRIMARY instance:
 *   <label class="gv-checkbox"><input type="checkbox" checked /><span class="box"><span class="check">✓</span></span> Checked</label>
 *
 * Byte-faithful to HEAD. Tags, class order, inner spans, and static text are
 * identical to the HEAD source. Only dynamic values become props.
 */
GV.register("checkbox-radio", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant  = props.variant  !== undefined ? props.variant  : "checkbox";
  var checked  = props.checked  !== undefined ? props.checked  : true;
  var disabled = props.disabled !== undefined ? props.disabled : false;
  var name     = props.name     !== undefined ? props.name     : "g-r";

  var checkedAttr  = checked  ? " checked"  : "";
  var disabledAttr = disabled ? " disabled" : "";

  if (variant === "radio") {
    var label = props.label !== undefined ? props.label : "Option A";
    return '<label class="gv-radio"><input type="radio" name="' + esc(name) + '"' + checkedAttr + disabledAttr + ' /><span class="circle"></span> ' + esc(label) + "</label>";
  }

  if (variant === "toggle") {
    var label = props.label !== undefined ? props.label : "On";
    return '<label class="gv-toggle"><input type="checkbox"' + checkedAttr + disabledAttr + ' /><span class="track"></span><span class="label">' + esc(label) + "</span></label>";
  }

  /* default: variant === "checkbox" */
  var label = props.label !== undefined ? props.label : "Checked";
  return '<label class="gv-checkbox"><input type="checkbox"' + checkedAttr + disabledAttr + ' /><span class="box"><span class="check">✓</span></span> ' + esc(label) + "</label>";
});

/* ── community-monitor ─────────────────────────────────────────────────────────── */
/* community-monitor.js — canonical instance renderer for the Community Monitor
 * "City at a glance" satisfaction module.
 * Registered onto window.GV via GV.register("community-monitor", fn).
 * GV.render("community-monitor", {}) → primary instance: the open monitor modal
 * from HEAD verbatim (overlay + .size-monitor card + horizontal 5-emoji sentiment
 * scale + intro + "Takes 2 minutes" footer).
 *
 * The component is the full reusable .gv-modal-overlay block — the standard modal
 * shell (.gv-modal.size-monitor, 460px card) wrapping the .gv-monitor body and the
 * new horizontal .gv-sentiment-scale variant. Demo chrome (.demo / .stage / .notes /
 * the open button) is NOT part of the component.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance byte-faithfully):
 *
 *   overlayId : string  id="" + data-modal-overlay anchor on the overlay element
 *                       (default "monitor-overlay") — used by the demo JS to find it.
 *   open      : boolean  whether the overlay carries the is-open class
 *                        (default true — HEAD ships it open).
 *   questionId: string  id="" on the question <p>, paired with the card's
 *                       aria-labelledby + the scale's aria-labelledby
 *                       (default "monitor-q").
 *   question  : string  the satisfaction question / .gv-monitor__question copy
 *                       (default "City as a place to live").
 *   intro     : string  the .gv-monitor__intro paragraph copy
 *                       (default "This ongoing survey tracks how you feel about
 *                        governance and public services.").
 *   duration  : string  the .gv-monitor__duration label
 *                       (default "Takes 2 minutes").
 *   closeLabel: string  aria-label on the round close button (default "Close window").
 *
 *   options   : Array of { glyph, cap, label, pressed }  — the sentiment-scale columns.
 *               Default = the five HEAD options in order (Very poor … Excellent).
 *               glyph   : string  the emoji glyph, emitted as raw HTML so an HTML
 *                                  numeric entity (default, e.g. "&#128547;") or a
 *                                  literal emoji char both render. Not esc()'d.
 *               cap     : string  the __cap caption under the face.
 *               label   : string  full aria-label on the __opt button
 *                                  (e.g. "1 out of 5, Very poor"). Falls back to
 *                                  "<n> out of <total>, <cap>" when omitted.
 *               pressed : boolean  aria-pressed state (default false — none selected).
 *
 * The two inline SVGs (round close X, clock for the duration) are preserved verbatim
 * from HEAD. Single-select interaction is wired in the demo's own <script>.
 * MARKUP ONLY.
 */
GV.register("community-monitor", function (props) {
  props = props || {};
  var esc = GV.esc;

  var overlayId  = props.overlayId  !== undefined ? props.overlayId  : "monitor-overlay";
  var open       = props.open       !== undefined ? props.open       : true;
  var questionId = props.questionId !== undefined ? props.questionId : "monitor-q";
  var question   = props.question   !== undefined ? props.question   : "City as a place to live";
  var intro      = props.intro      !== undefined ? props.intro
    : "This ongoing survey tracks how you feel about\n            governance and public services.";
  var duration   = props.duration   !== undefined ? props.duration   : "Takes 2 minutes";
  var closeLabel = props.closeLabel !== undefined ? props.closeLabel : "Close window";

  var DEFAULT_OPTIONS = [
    { glyph: "&#128547;", cap: "Very poor", label: "1 out of 5, Very poor" },
    { glyph: "&#128577;", cap: "Poor",      label: "2 out of 5, Poor" },
    { glyph: "&#128528;", cap: "Fair",      label: "3 out of 5, Fair" },
    { glyph: "&#128578;", cap: "Good",      label: "4 out of 5, Good" },
    { glyph: "&#128512;", cap: "Excellent", label: "5 out of 5, Excellent" }
  ];
  var options = props.options !== undefined ? props.options : DEFAULT_OPTIONS;

  var opts = options.map(function (o, i) {
    var label = o.label !== undefined
      ? o.label
      : (i + 1) + " out of " + options.length + ", " + (o.cap || "");
    var pressed = o.pressed ? "true" : "false";
    return (
      '<button class="gv-sentiment-scale__opt" type="button" aria-pressed="' + pressed + '"\n' +
      '                    aria-label="' + esc(label) + '">\n' +
      '              <span class="gv-sentiment-scale__face is-emoji">\n' +
      '                <span class="gv-sentiment-scale__glyph" aria-hidden="true">' + o.glyph + '</span>\n' +
      '              </span>\n' +
      '              <span class="gv-sentiment-scale__cap">' + esc(o.cap) + '</span>\n' +
      '            </button>'
    );
  }).join("\n            ");

  var openCls = open ? " is-open" : "";

  return (
    '<div class="gv-modal-overlay' + openCls + '" id="' + esc(overlayId) + '" data-modal-overlay>\n' +
    '      <div class="gv-modal size-monitor" role="dialog" aria-modal="true" aria-labelledby="' + esc(questionId) + '">\n' +
    '        <button class="gv-modal__close round" type="button" aria-label="' + esc(closeLabel) + '" data-close-modal>\n' +
    '          <svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">\n' +
    '            <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L13.41,12L19,6.41Z"></path>\n' +
    '          </svg>\n' +
    '        </button>\n' +
    '\n' +
    '        <div class="gv-modal__body">\n' +
    '          <p class="gv-monitor__question" id="' + esc(questionId) + '">' + esc(question) + '</p>\n' +
    '\n' +
    '          <div class="gv-sentiment-scale" role="group" aria-labelledby="' + esc(questionId) + '" data-monitor-scale>\n' +
    '            ' + opts + '\n' +
    '          </div>\n' +
    '\n' +
    '          <p class="gv-monitor__intro">' + esc(intro) + '</p>\n' +
    '\n' +
    '          <div class="gv-monitor__footer">\n' +
    '            <span class="gv-monitor__duration">\n' +
    '              <svg viewBox="0 0 14 14" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor">\n' +
    '                <path d="M7 13.667a6.492 6.492 0 0 1-2.6-.525 6.732 6.732 0 0 1-2.117-1.425A6.732 6.732 0 0 1 .857 9.6 6.492 6.492 0 0 1 .332 7c0-.922.175-1.789.525-2.6a6.732 6.732 0 0 1 1.425-2.117c.6-.6 1.306-1.075 2.117-1.425a6.492 6.492 0 0 1 2.6-.525c.922 0 1.789.175 2.6.525.81.35 1.516.825 2.116 1.425.6.6 1.075 1.306 1.425 2.117.35.811.525 1.678.525 2.6 0 .922-.175 1.789-.525 2.6a6.732 6.732 0 0 1-1.425 2.117c-.6.6-1.305 1.075-2.116 1.425a6.492 6.492 0 0 1-2.6.525Zm.633-7.184V3.667a.633.633 0 0 0-.184-.467A.633.633 0 0 0 7 3a.633.633 0 0 0-.466.2.633.633 0 0 0-.184.467V6.75c0 .089.017.172.05.25.034.078.084.15.15.217l2.134 2.133a.616.616 0 0 0 .458.183.642.642 0 0 0 .458-.183.633.633 0 0 0 .184-.467.633.633 0 0 0-.184-.466L7.633 6.483Z"/>\n' +
    '              </svg>\n' +
    '              <span>' + esc(duration) + '</span>\n' +
    '            </span>\n' +
    '          </div>\n' +
    '        </div>\n' +
    '      </div>\n' +
    '    </div>'
  );
});

/* ── content-builder-render ─────────────────────────────────────────────────────────── */
/* content-builder-render.js — canonical instance renderer for the FRONT-OFFICE
 * Content-Builder render layer: a .gv-cb-frame holding a stack of .gv-cb-row
 * (cols-1/2/3) of generic cells — .gv-cb-textbox / .gv-cb-image / .gv-cb-whitespace.
 * This is what the back-office editor OUTPUTS onto a live page; every other FO
 * widget mounts INTO these cells. Source-grounded on Copenhagen.
 *
 * GV.render("content-builder-render") → reproduces the PRIMARY HEAD frame:
 * cols-1 full-width centred text-box + a small white-space row.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   rows  Array of row objects, each:
 *           cols   number   1 | 2 | 3   → "cols-N" class on the row
 *                           default: row's own shape
 *           html   string   raw inner HTML of the .gv-cb-row (the cells)
 *
 *         default: the two rows of the primary HEAD frame (a cols-1 centred
 *         text-box, then a cols-1 small white-space row).
 *
 * Cell helpers (so consumers compose rows from canonical cells, never markup):
 *
 *   GV.render("content-builder-render", { rows: [...] })
 *   GV.contentBuilderCell.textbox(proseHtml, alignClass)
 *   GV.contentBuilderCell.image(slotHtml)
 *   GV.contentBuilderCell.whitespace(sizeClass)
 *   GV.contentBuilderCell.col(innerHtml)
 *
 * The three named frames from HEAD are exposed as FRAMES presets:
 *   GV.render("content-builder-render", GV.contentBuilderFrames.cols1)  // primary
 *   GV.render("content-builder-render", GV.contentBuilderFrames.cols2)
 *   GV.render("content-builder-render", GV.contentBuilderFrames.cols3)
 */
GV.register("content-builder-render", function (props) {
  props = props || {};
  var esc = GV.esc;

  // ── canonical white-space cell builder (the only cell the primary frame needs;
  //    the full set of reusable cell builders is on GV.contentBuilderCell). ──
  function whitespace(sizeClass) {
    return '<div class="gv-cb-whitespace' + (sizeClass ? " " + sizeClass : "") + '"></div>';
  }

  // ── primary HEAD frame: cols-1 centred full-width text-box + small white-space.
  //    Laid out to match HEAD's exact line structure (textbox + prose on own
  //    lines); cell builders above are the reusable form for composed variants. ──
  var DEFAULT_ROWS = [
    {
      cols: 1,
      html:
        '\n      <div class="gv-cb-textbox">\n' +
        '        <div class="gv-prose ql-align-center">\n' +
        "          <h2>A centred full-width text block</h2>\n" +
        "          <p>The text-box self-centres to the 1200px content measure (margin 0 auto), with 24px 0 padding.</p>\n" +
        "        </div>\n" +
        "      </div>\n    "
    },
    {
      cols: 1,
      html: whitespace("is-small")
    }
  ];

  var rows = props.rows !== undefined ? props.rows : DEFAULT_ROWS;

  var rowsHtml = rows.map(function (row) {
    return '<div class="gv-cb-row cols-' + esc(row.cols) + '">' + (row.html != null ? row.html : "") + "</div>";
  }).join("\n    ");

  return '<div class="gv-cb-frame">\n    ' + rowsHtml + "\n  </div>";
});

/* ── shared cell helpers + frame presets, exposed on GV so demos/prototypes
     compose rows from canonical cells rather than re-authoring .gv-cb-* markup.
     These reproduce HEAD's three named frames byte-faithfully. ── */
GV.contentBuilderCell = {
  textbox: function (proseHtml, alignClass) {
    var cls = "gv-prose" + (alignClass ? " " + alignClass : "");
    return '<div class="gv-cb-textbox"><div class="' + cls + '">' + proseHtml + "</div></div>";
  },
  image: function (slotHtml) {
    return '<div class="gv-cb-image">' + (slotHtml != null ? slotHtml : '<div class="ph">Image</div>') + "</div>";
  },
  whitespace: function (sizeClass) {
    return '<div class="gv-cb-whitespace' + (sizeClass ? " " + sizeClass : "") + '"></div>';
  },
  col: function (innerHtml) {
    return '<div class="gv-cb-col">' + innerHtml + "</div>";
  }
};

GV.contentBuilderFrames = {
  // primary — identical to GV.render("content-builder-render") with no props
  cols1: {
    rows: [
      {
        cols: 1,
        html:
          '\n      <div class="gv-cb-textbox"><div class="gv-prose ql-align-center">\n' +
          "          <h2>A centred full-width text block</h2>\n" +
          "          <p>The text-box self-centres to the 1200px content measure (margin 0 auto), with 24px 0 padding.</p>\n" +
          "        </div></div>\n    "
      },
      { cols: 1, html: '<div class="gv-cb-whitespace is-small"></div>' }
    ]
  },
  // cols-2 — image + text-box (588 + 24 gap + 588)
  cols2: {
    rows: [
      {
        cols: 2,
        html:
          '\n      <div class="gv-cb-col"><div class="gv-cb-image"><div class="ph" style="aspect-ratio:1/1">Image</div></div></div>\n' +
          '      <div class="gv-cb-col"><div class="gv-cb-textbox"><div class="gv-prose"><h2 style="font-size:var(--gv-fs-l)">A two-column row</h2><p>Two columns share the 1200 measure with a 24px gap, rendering 588px each.</p></div></div></div>\n    '
      }
    ]
  },
  // cols-3 — three equal columns (flex gap 24, max 1200)
  cols3: {
    rows: [
      {
        cols: 3,
        html:
          '\n      <div class="gv-cb-col"><div class="gv-cb-image"><div class="ph">Image</div></div><div class="gv-cb-textbox"><div class="gv-prose"><p>Column one.</p></div></div></div>\n' +
          '      <div class="gv-cb-col"><div class="gv-cb-image"><div class="ph">Image</div></div><div class="gv-cb-textbox"><div class="gv-prose"><p>Column two.</p></div></div></div>\n' +
          '      <div class="gv-cb-col"><div class="gv-cb-image"><div class="ph">Image</div></div><div class="gv-cb-textbox"><div class="gv-prose"><p>Column three.</p></div></div></div>\n    '
      }
    ]
  }
};

/* ── cookie-modal ─────────────────────────────────────────────────────────── */
/* cookie-modal.js — canonical instance renderer for the cookie-consent modal.
 * Registered onto window.GV via GV.register("cookie-modal", fn).
 * GV.render("cookie-modal", {}) → primary instance matching HEAD exactly.
 *
 * Source-grounded on Stadt Wien (primary #FF5A64).
 * Shell = .gv-modal-overlay → .gv-modal[role="dialog"][aria-modal].
 * Content = .gv-cookie__* + .gv-modal__footer 3-action row.
 * No top-right close button — a consent prompt blocks until answered.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   id          : string   id="" on the overlay element  (default "cookie-overlay")
 *   titleId     : string   id="" on <h1> title           (default "cookie-modal-title")
 *   title       : string   modal heading text            (default "Your cookie settings")
 *   body        : string   paragraph before the policy link
 *                          (default "Accepting cookies helps us improve this platform.")
 *   policyLabel : string   anchor text for the policy link
 *                          (default "Read our cookie policy")
 *   policyHref  : string   href for the policy link      (default "#")
 *   manageLabel : string   left ghost-button label       (default "Manage preferences")
 *   rejectLabel : string   first primary button label    (default "Reject")
 *   acceptLabel : string   second primary button label   (default "Accept")
 *   open        : boolean  adds "is-open" class on the overlay  (default true)
 *
 * MARKUP ONLY — no open/close behaviour. The demo wires that in its own <script>.
 */
GV.register("cookie-modal", function (props) {
  props = props || {};
  var esc = GV.esc;

  var id          = props.id          !== undefined ? props.id          : "cookie-overlay";
  var titleId     = props.titleId     !== undefined ? props.titleId     : "cookie-modal-title";
  var title       = props.title       !== undefined ? props.title       : "Your cookie settings";
  var body        = props.body        !== undefined ? props.body        : "Accepting cookies helps us improve this platform.";
  var policyLabel = props.policyLabel !== undefined ? props.policyLabel : "Read our cookie policy";
  var policyHref  = props.policyHref  !== undefined ? props.policyHref  : "#";
  var manageLabel = props.manageLabel !== undefined ? props.manageLabel : "Manage preferences";
  var rejectLabel = props.rejectLabel !== undefined ? props.rejectLabel : "Reject";
  var acceptLabel = props.acceptLabel !== undefined ? props.acceptLabel : "Accept";
  var open        = props.open        !== undefined ? props.open        : true;

  var overlayClass = "gv-modal-overlay" + (open ? " is-open" : "");

  return (
    '<div class="' + overlayClass + '" id="' + esc(id) + '" data-modal-overlay>' +
      '<div class="gv-modal" role="dialog" aria-modal="true" aria-labelledby="' + esc(titleId) + '">' +
        '<div class="gv-cookie__content">' +
          '<span class="gv-cookie__icon" data-gv-icon="cookie"></span>' +
          '<h1 class="gv-cookie__title" id="' + esc(titleId) + '">' + esc(title) + '</h1>' +
          '<p class="gv-cookie__body">' + esc(body) +
            ' <a class="gv-cookie__link" href="' + esc(policyHref) + '" target="_blank" rel="noopener">' + esc(policyLabel) + '</a>.' +
          '</p>' +
        '</div>' +
        '<div class="gv-modal__footer">' +
          '<button class="gv-btn text gv-cookie__manage" type="button" data-cy="e2e-manage-preferences-btn" data-close-modal>' + esc(manageLabel) + '</button>' +
          '<button class="gv-btn primary" type="button" data-close-modal>' + esc(rejectLabel) + '</button>' +
          '<button class="gv-btn primary" type="button" data-cy="e2e-accept-cookies-btn" data-close-modal>' + esc(acceptLabel) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
});

/* ── cta-banner ─────────────────────────────────────────────────────────── */
/* cta-banner.js — canonical instance renderer for the CTA banner component.
 *
 * Props (with defaults matching the PRIMARY HEAD instance):
 *   label     : string   — button text               (default "Take the survey")
 *   href      : string   — button link                (default "#")
 *   btnClass  : string   — .gv-btn modifier class     (default "primary-inverse")
 *   ariaLabel : string   — <section aria-label>       (default "Call to action")
 *   dataCy    : boolean  — add data-cy="e2e-cta-banner-button" to the cta div
 *                          (default true — HEAD's first/primary instance carries it)
 *
 * GV.render("cta-banner", {}) → reproduces the PRIMARY instance exactly:
 *   <section class="gv-cta-banner" aria-label="Call to action">
 *     <div class="gv-cta-banner__inner">
 *       <div class="gv-cta-banner__cta" data-cy="e2e-cta-banner-button">
 *         <a class="gv-btn primary-inverse e2e-cta-banner-button" href="#">Take the survey</a>
 *       </div>
 *     </div>
 *   </section>
 *
 * Theming: the banner fill follows --gv-tenant-primary; override --gv-cta-banner-bg
 * to pin a one-off colour. Button uses .primary-inverse (white on primary fill) by default.
 */
GV.register("cta-banner", function (props) {
  props = props || {};
  var esc = GV.esc;

  var label     = props.label     !== undefined ? props.label     : "Take the survey";
  var href      = props.href      !== undefined ? props.href      : "#";
  var btnClass  = props.btnClass  !== undefined ? props.btnClass  : "primary-inverse";
  var ariaLabel = props.ariaLabel !== undefined ? props.ariaLabel : "Call to action";
  var dataCy    = props.dataCy    !== undefined ? props.dataCy    : true;

  var cyAttr = dataCy ? ' data-cy="e2e-cta-banner-button"' : "";
  /* The primary instance also adds e2e-cta-banner-button as an extra class on the <a>.
     Only when dataCy is true (i.e. primary instance). */
  var extraCls = dataCy ? " e2e-cta-banner-button" : "";

  return (
    '<section class="gv-cta-banner" aria-label="' + esc(ariaLabel) + '">' +
      '<div class="gv-cta-banner__inner">' +
        '<div class="gv-cta-banner__cta"' + cyAttr + '>' +
          '<a class="gv-btn ' + esc(btnClass) + extraCls + '" href="' + esc(href) + '">' + esc(label) + '</a>' +
        '</div>' +
      '</div>' +
    '</section>'
  );
});

/* ── divider ─────────────────────────────────────────────────────────── */
/* divider.js — canonical instance renderer for the divider component.
 * Registered onto window.GV via GV.register("divider", fn).
 * GV.render("divider", {}) reproduces the PRIMARY instance exactly:
 *   <hr class="gv-divider" style="margin:16px 0" />
 *
 * Props:
 *   variant : "rule" | "or"   (default "rule")
 *     "rule" → <hr class="gv-divider"> — hairline horizontal separator
 *     "or"   → <div class="gv-or"><span>…label…</span></div> — centred label with flanking rules
 *   label   : string           (default "Or")   — text shown in the "or" variant only
 *   margin  : string | null    (default "16px 0") — inline margin on the rule element;
 *                               null → no inline style (uses CSS default var(--gv-space-4) 0)
 *   marginTop : string | null  (default null for "rule"; "14px" for "or") — inline
 *               margin-top on the or element; null → no inline style
 *
 * Byte-faithful to HEAD: tags, class names, inline style format, and static text are
 * identical. Only the copy and inline margin values are parameterised.
 */
GV.register("divider", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant   = props.variant   !== undefined ? props.variant   : "rule";
  var label     = props.label     !== undefined ? props.label     : "Or";
  var margin    = props.margin    !== undefined ? props.margin    : "16px 0";
  var marginTop = props.marginTop !== undefined ? props.marginTop : null;

  if (variant === "or") {
    /* "or" default: style="margin-top:14px" (HEAD) */
    var mt = marginTop !== null ? marginTop : "14px";
    var styleAttr = mt ? ' style="margin-top:' + esc(mt) + '"' : "";
    return '<div class="gv-or"' + styleAttr + '><span>' + esc(label) + "</span></div>";
  }

  /* variant === "rule" (default): hairline <hr> */
  var ruleStyle = margin !== null ? ' style="margin:' + esc(margin) + '"' : "";
  return "<hr class=\"gv-divider\"" + ruleStyle + " />";
});

/* ── event-card-bordered ─────────────────────────────────────────────────────────── */
/* event-card-bordered.js — canonical instance renderer for the bordered EventsWidget card grid.
 *
 * Captures the shared EventsWidget treatment (Copenhagen / Linz / Falkirk): each event in a
 * bordered white card (1px #CCC, 6px radius) with a 3-tier stacked date chip and an #F4F6F8
 * "Date & time" info panel. Skins per ?theme= (CPH #000C2E is the capture tenant default).
 *
 * Props (all optional — defaults reproduce the primary HEAD instance exactly):
 *
 *   cards   Array of card objects (default = the 2 Copenhagen cards from HEAD)
 *           Each card object:
 *             title        string   event title text (linked)           [required]
 *             href         string   title/CTA link                      default "#"
 *             hasMedia     boolean  show .gv-event-card__media block    default true
 *             day          string   date chip day number                e.g. "18"
 *             month        string   date chip month abbreviation        e.g. "jun"
 *             year         string   date chip year band                 e.g. "2026"
 *             rows         Array of { icon: string, html: string }      info-panel rows
 *             ctaLabel     string   register button label               default "Registrer dig"
 *             ctaDisabled  boolean  aria-disabled + tabindex=-1 on CTA  default false
 *
 * GV.render("event-card-bordered")           → 2-card Copenhagen primary grid (HEAD §1)
 * GV.render("event-card-bordered", {cards})  → imageless/closed variant or custom grid
 */
GV.register("event-card-bordered", function (props) {
  props = props || {};
  var esc = GV.esc;

  var DEFAULT_CARDS = [
    {
      title: "Test din idé — kom til online møde om københavnerforslag",
      href: "#",
      hasMedia: true,
      day: "18",
      month: "jun",
      year: "2026",
      rows: [
        { icon: "clock",           html: "18 Jun 2026 · 17:00 – 18:00" },
        { icon: "link",            html: '<a href="#">Online møde</a>' },
        { icon: "user",            html: "24 tilmeldte" }
      ],
      ctaLabel: "Registrer dig",
      ctaDisabled: false
    },
    {
      title: "Højmosen: fredning, fugle og naturudvikling (Brønshøj-Husum)",
      href: "#",
      hasMedia: true,
      day: "21",
      month: "jun",
      year: "2026",
      rows: [
        { icon: "clock",           html: "21 Jun 2026 · 10:00 – 12:30" },
        { icon: "location-simple", html: "Højmosen, Husum" },
        { icon: "user",            html: "41 tilmeldte" }
      ],
      ctaLabel: "Registrer dig",
      ctaDisabled: false
    }
  ];

  var cards = (props.cards !== undefined) ? props.cards : DEFAULT_CARDS;

  function renderCard(card) {
    var hasMedia = card.hasMedia !== false; /* default true */
    var mediaBlock = hasMedia
      ? '<div class="gv-event-card__media" aria-hidden="true"><span data-gv-icon="calendar"></span></div>'
      : "";
    var articleClass = "gv-event-card bordered" + (hasMedia ? "" : " is-imageless");
    var href = card.href != null ? card.href : "#";

    var chip =
      '<span class="gv-event-datechip--stacked" aria-hidden="true">' +
        '<span class="gv-event-datechip__top">' +
          '<span class="gv-event-datechip__day">' + esc(card.day || "") + "</span>" +
          '<span class="gv-event-datechip__month">' + esc(card.month || "") + "</span>" +
        "</span>" +
        '<span class="gv-event-datechip__year">' + esc(card.year || "") + "</span>" +
      "</span>";

    var rows = (card.rows || []).map(function (row) {
      return (
        '<p class="gv-event-card__row">' +
          '<span data-gv-icon="' + esc(row.icon) + '"></span> ' + row.html +
        "</p>"
      );
    }).join("\n              ");

    var ctaDisabled = card.ctaDisabled ? ' aria-disabled="true" role="button" tabindex="-1"' : ' href="' + esc(href) + '"';
    var ctaTag = card.ctaDisabled ? "a" : "a";
    var cta =
      '<' + ctaTag + ' class="gv-btn primary full"' + ctaDisabled + (card.ctaDisabled ? "" : "") + ">" +
        esc(card.ctaLabel != null ? card.ctaLabel : "Registrer dig") +
      "</" + ctaTag + ">";

    return (
      "<article class=\"" + articleClass + "\">\n" +
      (hasMedia ? "          " + mediaBlock + "\n" : "") +
      "          <div class=\"gv-event-card__body\">\n" +
      "            <div class=\"gv-event-card__titlerow\">\n" +
      "              <h3 class=\"gv-event-card__title\"><a href=\"" + esc(href) + "\">" + esc(card.title || "") + "</a></h3>\n" +
      "              " + chip + "\n" +
      "            </div>\n" +
      "            <div class=\"gv-event-info-panel\">\n" +
      "              " + rows + "\n" +
      "            </div>\n" +
      "            " + cta + "\n" +
      "          </div>\n" +
      "        </article>"
    );
  }

  var cardsHtml = cards.map(renderCard).join("\n\n        ");

  return (
    '<div class="gv-events__grid">\n\n        ' +
    cardsHtml +
    "\n\n      </div>"
  );
});

/* ── event-card ─────────────────────────────────────────────────────────── */
/* event-card.js — canonical instance renderer for the event-card component.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("event-card", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance: upcoming events grid):
 *
 *   variant  "grid" | "empty"
 *            "grid"  — .gv-events__grid wrapping one or more .gv-event-card articles (default)
 *            "empty" — .gv-events__empty state (no events scheduled)
 *
 *   cards    Array of card objects (used for variant "grid")
 *            Each card:
 *              title        {string}   heading link text              [required]
 *              dateM        {string}   month label for date chip      e.g. "Jun"
 *              dateD        {string}   day label for date chip        e.g. "18"
 *              dateY        {string}   year label for date chip       e.g. "2026"
 *              rsvp         {string}   RSVP flag text ("Going"); omit/falsy to hide
 *              rows         Array of { icon, text, href } — meta rows
 *                             icon  data-gv-icon value (clock / location-simple / link / user)
 *                             text  display text
 *                             href  optional — wraps text in <a href>
 *              ctaLabel     {string}   CTA button label               default "Register"
 *              ctaHref      {string}   CTA button href                default "#"
 *            default = the three upcoming Westmere event cards from HEAD
 *
 * GV.render("event-card")          → primary (upcoming grid, 3 cards, first has RSVP)
 * GV.render("event-card", { variant:"empty" }) → empty state
 * GV.render("event-card", { cards:[…] }) → custom grid
 *
 * Variants demonstrated in HEAD:
 *   {}                             → primary grid (3 upcoming cards)
 *   { cards: [pastCard] }          → past event (no registrant row, "Read more" CTA)
 *   { variant: "empty" }           → empty state
 */
GV.register("event-card", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant = props.variant || "grid";

  /* ── empty state ── */
  if (variant === "empty") {
    return (
      '<div class="gv-events__empty">' +
        '<span data-gv-icon="calendar" aria-hidden="true"></span>' +
        '<p class="gv-text bodyM">No upcoming or ongoing events are currently scheduled.</p>' +
      '</div>'
    );
  }

  /* ── grid (default) ── */
  var DEFAULT_CARDS = [
    {
      title:    "Community session: bringing online & offline participation together",
      dateM:    "Jun",
      dateD:    "18",
      dateY:    "2026",
      rsvp:     "Going",
      rows: [
        { icon: "clock",   text: "18 Jun 2026 · 11:00 – 12:00" },
        { icon: "link",    text: "Online meeting", href: "#" },
        { icon: "user",    text: "2 registrants" }
      ],
      ctaLabel: "Register",
      ctaHref:  "#"
    },
    {
      title:    "Main Street walk & talk: see the plans on site",
      dateM:    "Jun",
      dateD:    "25",
      dateY:    "2026",
      rows: [
        { icon: "clock",           text: "25 Jun 2026 · 17:30 – 19:00" },
        { icon: "location-simple", text: "Market Square, City Hall" },
        { icon: "user",            text: "41 registrants" }
      ],
      ctaLabel: "Register",
      ctaHref:  "#"
    },
    {
      title:    "Participatory budget: info & Q&A session",
      dateM:    "Jul",
      dateD:    "02",
      dateY:    "2026",
      rows: [
        { icon: "clock", text: "2 Jul 2026 · 18:00 – 19:30" },
        { icon: "link",  text: "Online meeting", href: "#" },
        { icon: "user",  text: "7 registrants" }
      ],
      ctaLabel: "Register",
      ctaHref:  "#"
    }
  ];

  var cards = props.cards !== undefined ? props.cards : DEFAULT_CARDS;

  var cardsHtml = cards.map(function (card) {
    var rsvpHtml = card.rsvp
      ? '<span class="gv-event-card__rsvp">' + esc(card.rsvp) + '</span>'
      : '';

    var rowsHtml = (card.rows || []).map(function (row) {
      var inner = row.href
        ? '<a href="' + esc(row.href) + '">' + esc(row.text) + '</a>'
        : esc(row.text);
      return '<p class="gv-event-card__row"><span data-gv-icon="' + esc(row.icon) + '"></span> ' + inner + '</p>';
    }).join('');

    return (
      '<article class="gv-event-card">' +
        '<div class="gv-event-card__media" aria-hidden="true">' +
          '<span data-gv-icon="calendar"></span>' +
          '<span class="gv-event-card__date">' +
            '<span class="m">' + esc(card.dateM) + '</span>' +
            '<span class="d">' + esc(card.dateD) + '</span>' +
            '<span class="y">' + esc(card.dateY) + '</span>' +
          '</span>' +
          rsvpHtml +
        '</div>' +
        '<div class="gv-event-card__body">' +
          '<h3 class="gv-event-card__title"><a href="' + esc(card.ctaHref || '#') + '">' + esc(card.title) + '</a></h3>' +
          '<div class="gv-event-card__meta">' +
            rowsHtml +
          '</div>' +
          '<a class="gv-btn primary full" href="' + esc(card.ctaHref || '#') + '">' + esc(card.ctaLabel || 'Register') + '</a>' +
        '</div>' +
      '</article>'
    );
  }).join('');

  return '<div class="gv-events__grid">' + cardsHtml + '</div>';
});

/* ── fo-linz-monitorband ─────────────────────────────────────────────────────────── */
/* fo-linz-monitorband.js — canonical instance renderer for the fo-linz-monitorband component.
 *
 * Source-grounded on Linz partizipation.linz.at (capture fo-linz-monitorband,
 * tenant-primary #604596). The community-monitor band: a tinted strip (rgba of
 * tenant-primary) with title, lead text, a media slot (defaults to a sentiment-
 * card artwork), and a CTA button with an OPTIONAL duration meta line.
 *
 * Two reusable blocks are registered:
 *
 *   "fo-linz-monitorband"        — the full gv-monitorband section (primary instance)
 *   "fo-linz-monitorband-event"  — the stacked-chip bordered event card (B4 confirm)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Props for "fo-linz-monitorband":
 *
 *   title       string  — <h2> heading text
 *                         default "Wie geht es Ihnen in Linz?"
 *   lead        string  — paragraph below the heading
 *                         default "Eine laufende Umfrage darüber, wie zufrieden Sie
 *                                  mit Lebensqualität, öffentlichen Diensten und
 *                                  Verwaltung in unserer Stadt sind."
 *   ctaLabel    string  — primary button copy
 *                         default "An der Umfrage teilnehmen"
 *   ctaHref     string  — button href
 *                         default "#"
 *   duration    string  — optional duration meta text; omit / falsy to hide the line
 *                         default "Dauer 2 Minuten"
 *   titleId     string  — id on the <h2> (for aria-labelledby)
 *                         default "linz-band-title"
 *   ariaLabel   string  — aria-labelledby fallback label (only used if titleId omitted)
 *                         default "linz-band-title"
 *   mediaHtml   string  — raw HTML for the __media slot; falsy = default sqp artwork
 *                         default: the sentiment emoji-card illustration from HEAD
 *
 * GV.render("fo-linz-monitorband", {}) → primary HEAD instance exactly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Props for "fo-linz-monitorband-event":
 *
 *   title       string  — event title
 *                         default "Bürger:innen-Versammlung Innenstadt"
 *   day         string  — date chip day    default "24"
 *   month       string  — date chip month  default "jun"
 *   year        string  — date chip year   default "2026"
 *   row         string  — single info row text
 *                         default "18:00 – 20:00 · Altes Rathaus, Linz"
 *
 * GV.render("fo-linz-monitorband-event", {}) → primary HEAD bordered event exactly.
 *
 * Theming: tint, CTA, meta and chip all derive from --gv-tenant-primary;
 * nothing brand-coloured is hardcoded. Pass ?theme= (or override that one var) to reskin.
 */

/* ── 1. Monitor band ── */
GV.register("fo-linz-monitorband", function (props) {
  props = props || {};
  var esc = GV.esc;

  var title     = props.title    !== undefined ? props.title    : "Wie geht es Ihnen in Linz?";
  var lead      = props.lead     !== undefined ? props.lead     : "Eine laufende Umfrage darüber, wie zufrieden Sie mit Lebensqualität, öffentlichen Diensten und Verwaltung in unserer Stadt sind.";
  var ctaLabel  = props.ctaLabel !== undefined ? props.ctaLabel : "An der Umfrage teilnehmen";
  var ctaHref   = props.ctaHref  !== undefined ? props.ctaHref  : "#";
  var duration  = props.duration !== undefined ? props.duration : "Dauer 2 Minuten";
  var titleId   = props.titleId  !== undefined ? props.titleId  : "linz-band-title";

  /* Default media: the page-local sentiment emoji-card illustration from HEAD.
     The sqp-* classes are page-local (non-gv-*) artwork defined in the demo <style>;
     they are passed through verbatim so the demo can supply its own styles. */
  var defaultMedia =
    '<div class="sqp" role="img" aria-label="Beispiel einer Sentiment-Umfragefrage">' +
      '<div class="sqp__card">' +
        '<span class="sqp__line"></span>' +
        '<span class="sqp__line sqp__line--short"></span>' +
        '<div class="sqp__faces">' +
          '<span class="sqp__face">😣</span>' +
          '<span class="sqp__face">🙁</span>' +
          '<span class="sqp__face">😐</span>' +
          '<span class="sqp__face sqp__face--sel">🙂</span>' +
          '<span class="sqp__face">😄</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  var mediaHtml = props.mediaHtml !== undefined ? props.mediaHtml : defaultMedia;

  var durationHtml = duration
    ? '<p class="gv-monitorband__ctameta gv-monitorband__ctameta--duration">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
          '<path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm.75 4.5v5.55l3.7 2.2-.76 1.28-4.44-2.64V6.5h1.5Z"/>' +
        '</svg>' +
        '<span>' + esc(duration) + '</span>' +
      '</p>'
    : "";

  return (
    '<section class="gv-monitorband" aria-labelledby="' + esc(titleId) + '">' +
      '<div class="gv-monitorband__inner">' +
        '<div class="gv-monitorband__text">' +
          '<h2 class="gv-monitorband__title" id="' + esc(titleId) + '">' + esc(title) + '</h2>' +
          '<p class="gv-monitorband__lead">' + esc(lead) + '</p>' +
        '</div>' +
        '<div class="gv-monitorband__media">' +
          mediaHtml +
        '</div>' +
        '<div class="gv-monitorband__cta">' +
          '<button class="gv-btn primary" type="button">' + esc(ctaLabel) + '</button>' +
          durationHtml +
        '</div>' +
      '</div>' +
    '</section>'
  );
});

/* ── 2. Stacked-chip bordered event card (B4 year-band confirmation) ── */
GV.register("fo-linz-monitorband-event", function (props) {
  props = props || {};
  var esc = GV.esc;

  var title = props.title !== undefined ? props.title : "Bürger:innen-Versammlung Innenstadt";
  var day   = props.day   !== undefined ? props.day   : "24";
  var month = props.month !== undefined ? props.month : "jun";
  var year  = props.year  !== undefined ? props.year  : "2026";
  var row   = props.row   !== undefined ? props.row   : "18:00 – 20:00 · Altes Rathaus, Linz";

  return (
    '<article class="gv-event-card bordered is-imageless">' +
      '<div class="gv-event-card__body">' +
        '<div class="gv-event-card__titlerow">' +
          '<h3 class="gv-event-card__title">' + esc(title) + '</h3>' +
          '<span class="gv-event-datechip--stacked" aria-hidden="true">' +
            '<span class="gv-event-datechip__top">' +
              '<span class="gv-event-datechip__day">' + esc(day) + '</span>' +
              '<span class="gv-event-datechip__month">' + esc(month) + '</span>' +
            '</span>' +
            '<span class="gv-event-datechip__year">' + esc(year) + '</span>' +
          '</span>' +
        '</div>' +
        '<div class="gv-event-info-panel">' +
          '<p class="gv-event-card__row">' + esc(row) + '</p>' +
        '</div>' +
      '</div>' +
    '</article>'
  );
});

/* ── folder-card ─────────────────────────────────────────────────────────── */
/* folder-card.js — canonical instance renderer for .gv-pcard.boxed.folder.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("folder-card", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance):
 *
 *   thumb     string   CSS class suffix for the hero gradient swatch
 *                      e.g. "ocean" → class="gv-pcard__thumb--ocean"
 *                      default: "ocean"
 *
 *   count     number   number of child projects shown in the count badge
 *                      default: 2
 *
 *   title     string   folder heading text
 *                      default: "BOA President's Office"
 *
 *   href      string   link href for the title anchor
 *                      default: "#"
 *
 *   desc      string   description preview text
 *                      default: "The projects in this folder are city-wide or have been
 *                               proposed by the President of the Board of Aldermen—Megan E. Green."
 *
 *   pile      Array<{more?: string}>   child-project preview items.
 *             Each entry with no `more` key → renders a <span class="gv-pcard__fthumb">.
 *             An entry with a `more` string value → renders <span class="gv-pcard__fmore">+N</span>.
 *             default: [{}, {}, {more: "+5"}]   (2 thumbs + overflow chip)
 */
GV.register("folder-card", function (props) {
  props = props || {};
  var esc = GV.esc;

  var thumb = props.thumb != null ? props.thumb : "ocean";
  var count = props.count != null ? props.count : 2;
  var title = props.title != null ? props.title : "BOA President's Office";
  var href  = props.href  != null ? props.href  : "#";
  var desc  = props.desc  != null ? props.desc  :
    "The projects in this folder are city-wide or have been\n              proposed by the President of the Board of Aldermen—Megan E. Green.";
  var pile  = props.pile  != null ? props.pile  : [{}, {}, { more: "+5" }];

  var pileHtml = pile.map(function (item) {
    if (item.more != null) {
      return '<span class="gv-pcard__fmore">' + esc(item.more) + '</span>';
    }
    return '<span class="gv-pcard__fthumb"></span>';
  }).join("\n            ");

  return (
    '<article class="gv-pcard boxed folder">\n' +
    '          <div class="gv-pcard__fmedia">\n' +
    '            <div class="gv-pcard__thumb--' + esc(thumb) + '" style="width:100%;height:100%"></div>\n' +
    '            <span class="gv-pcard__count" aria-label="' + esc(count) + ' projects in this folder">\n' +
    '              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/></svg>\n' +
    '              <span class="e2e-folder-card-numberofprojects">' + esc(count) + '</span>&nbsp;projects\n' +
    '            </span>\n' +
    '          </div>\n' +
    '          <div class="gv-pcard__fbody">\n' +
    '            <h3 class="gv-pcard__title"><a href="' + esc(href) + '">' + esc(title) + '</a></h3>\n' +
    '            <div class="gv-pcard__fdesc">' + esc(desc) + '</div>\n' +
    '          </div>\n' +
    '          <div class="gv-pcard__fpile" aria-hidden="true">\n' +
    '            ' + pileHtml + '\n' +
    '          </div>\n' +
    '        </article>'
  );
});

/* ── footer-logos ─────────────────────────────────────────────────────────── */
/* footer-logos.js — canonical instance renderer for the GoVocal footer logo band,
 * the optional brand-tinted header nav, and the dual-auth signed-out header.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("footer-logos", props) → canonical HTML string.
 *
 * Source-grounded on Luxembourg (zesumme-vereinfachen.lu, capture fo-lux-footer-logos)
 * and cross-checked against Linz.
 *
 * Props (all optional — defaults reproduce the PRIMARY instance from HEAD):
 *
 *   variant  "footer-row" | "footer-solo" | "header-tinted"
 *            "footer-row"     — .gv-footer__logos.row (tenant + partner logo)
 *                               above .gv-footer with powered-by line     (PRIMARY)
 *            "footer-solo"    — .gv-footer__logos (single tenant logo)
 *                               above .gv-footer, powered-by suppressed
 *            "header-tinted"  — .gv-header with .gv-nav.tinted and
 *                               .gv-auth-dual (dual signed-out CTAs)
 *
 *   ── variant "footer-row" ──
 *   partnerLabel  string   text inside the cap span                            "GOVERNMENT"
 *   partnerClass  string   extra class on the cap span                         "gv-footer__logos-cap"
 *
 *   ── variant "footer-row" / "footer-solo" (shared) ──
 *   poweredLabel     string   "Powered by" prose                               "Généré par"
 *   poweredHref      string   Go Vocal marketing URL                           "https://govocal.com/"
 *   poweredAlt       string   <img> alt text                                   "Go Vocal"
 *   poweredAriaLabel string   accessible label on powered-by <a>
 *                             "Go Vocal (anciennement CitizenLab)"
 *   logoSrc          string   path to govocal-logo.svg (relative to page)
 *                             "../../skills/govocal-ui/govocal-logo.svg"
 *   cookiesLabel     string   label for the Cookies Settings button            "Paramètres des cookies"
 *
 *   ── variant "header-tinted" ──
 *   navItems      array    primary nav links [{label, href, current}]          see HEAD defaults
 *   loginLabel    string   filled log-in button label                          "Se connecter"
 *   registerLabel string   inverse register button label                       "S'inscrire"
 *   searchLabel   string   icon-button aria-label                              "Rechercher"
 *   lang          string   current language token in the switcher              "FR"
 *   langs         array    language options [{label, href}]                    see HEAD defaults
 *   mobileSearchLabel string  text for the mobile search link                 "Rechercher"
 *   mobileMenuLabel   string  aria-label on the hamburger <summary>
 *                             "Afficher le menu de navigation mobile"
 *   mobileAriaLabel   string  aria-label on mobile <nav>
 *                             "Navigation principale (mobile)"
 *
 * GV.render("footer-logos", {}) → "footer-row" (primary, Luxembourg defaults)
 *
 * Link order is byte-faithful to HEAD:
 *   footer-row  — Conditions · Confidentialité · Cookies · Accessibilité · [btn] · Plan du site
 *   footer-solo — Conditions · Confidentialité · [btn] · Plan du site
 */
GV.register("footer-logos", function (props) {
  props = props || {};
  var esc = GV.esc;
  var variant = props.variant || "footer-row";

  /* ── shared powered-by defaults ── */
  var poweredLabel     = props.poweredLabel     !== undefined ? props.poweredLabel     : "Généré par";
  var poweredHref      = props.poweredHref      !== undefined ? props.poweredHref      : "https://govocal.com/";
  var poweredAlt       = props.poweredAlt       !== undefined ? props.poweredAlt       : "Go Vocal";
  var poweredAriaLabel = props.poweredAriaLabel !== undefined ? props.poweredAriaLabel : "Go Vocal (anciennement CitizenLab)";
  var logoSrc          = props.logoSrc          !== undefined ? props.logoSrc          : "../../skills/govocal-ui/govocal-logo.svg";
  var cookiesLabel     = props.cookiesLabel     !== undefined ? props.cookiesLabel     : "Paramètres des cookies";

  /* ════════════════════════════════════════════════════════════════════════
     variant: "footer-row" (PRIMARY)
     .gv-footer__logos.row — tenant logo (data-gv-logo) + partner cap mark
     .gv-footer — legal nav + powered-by line
     HEAD link order: Conditions · Confidentialité · Cookies · Accessibilité
                      · [cookies btn] · Plan du site
     ════════════════════════════════════════════════════════════════════════ */
  if (variant === "footer-row") {
    var partnerLabel = props.partnerLabel !== undefined ? props.partnerLabel : "GOVERNMENT";
    var partnerClass = props.partnerClass !== undefined ? props.partnerClass : "gv-footer__logos-cap";

    return (
      '<div class="gv-footer__logos row">' +
        '<a href="#" aria-label="Home" data-gv-logo></a>' +
        '<span class="' + esc(partnerClass) + '" aria-hidden="true">' + esc(partnerLabel) + '</span>' +
      '</div>' +
      '<footer class="gv-footer">' +
        '<div class="gv-footer__inner">' +
          '<nav class="gv-footer__links" aria-label="Secondary">' +
            '<ul>' +
              '<li><a href="#">Conditions générales</a></li>' +
              '<li><a href="#">Politique de confidentialité</a></li>' +
              '<li><a href="#">Politique de cookies</a></li>' +
              '<li><a href="#">Accessibilité : partiellement conforme</a></li>' +
              '<li><button type="button">' + esc(cookiesLabel) + '</button></li>' +
              '<li><a href="#">Plan du site</a></li>' +
            '</ul>' +
          '</nav>' +
          '<div class="gv-footer__powered">' +
            '<span>' + esc(poweredLabel) + '</span>' +
            '<a href="' + esc(poweredHref) + '" target="_blank" rel="noopener" aria-label="' + esc(poweredAriaLabel) + '">' +
              '<img class="gv-powered-logo" src="' + esc(logoSrc) + '" alt="' + esc(poweredAlt) + '" />' +
            '</a>' +
          '</div>' +
        '</div>' +
      '</footer>'
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
     variant: "footer-solo"
     .gv-footer__logos — single tenant logo only (no partner mark)
     .gv-footer — minimal legal nav, powered-by suppressed
     HEAD link order: Conditions · Confidentialité · [cookies btn] · Plan du site
     ════════════════════════════════════════════════════════════════════════ */
  if (variant === "footer-solo") {
    return (
      '<div class="gv-footer__logos">' +
        '<a href="#" aria-label="Home" data-gv-logo></a>' +
      '</div>' +
      '<footer class="gv-footer">' +
        '<div class="gv-footer__inner">' +
          '<nav class="gv-footer__links" aria-label="Secondary">' +
            '<ul>' +
              '<li><a href="#">Conditions générales</a></li>' +
              '<li><a href="#">Politique de confidentialité</a></li>' +
              '<li><button type="button">' + esc(cookiesLabel) + '</button></li>' +
              '<li><a href="#">Plan du site</a></li>' +
            '</ul>' +
          '</nav>' +
        '</div>' +
      '</footer>'
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
     variant: "header-tinted"
     .gv-header.sticky — brand-tinted primary nav + dual signed-out auth CTAs
     + signed-out language switcher + mobile hamburger panel
     ════════════════════════════════════════════════════════════════════════ */
  if (variant === "header-tinted") {
    var defaultNav = [
      { label: "Accueil",          href: "#", current: true },
      { label: "Tous les projets", href: "#" },
      { label: "FAQ",              href: "#" },
      { label: "À propos",    href: "#" }
    ];
    var navItems      = props.navItems      !== undefined ? props.navItems      : defaultNav;
    var loginLabel    = props.loginLabel    !== undefined ? props.loginLabel    : "Se connecter";
    var registerLabel = props.registerLabel !== undefined ? props.registerLabel : "S’inscrire";
    var searchLabel   = props.searchLabel   !== undefined ? props.searchLabel   : "Rechercher";
    var lang          = props.lang          !== undefined ? props.lang          : "FR";
    var defaultLangs  = [
      { label: "Français", href: "#" },
      { label: "Deutsch",       href: "#" },
      { label: "English",       href: "#" }
    ];
    var langs               = props.langs               !== undefined ? props.langs               : defaultLangs;
    var mobileSearchLabel   = props.mobileSearchLabel   !== undefined ? props.mobileSearchLabel   : "Rechercher";
    var mobileMenuLabel     = props.mobileMenuLabel     !== undefined ? props.mobileMenuLabel     : "Afficher le menu de navigation mobile";
    var mobileAriaLabel     = props.mobileAriaLabel     !== undefined ? props.mobileAriaLabel     : "Navigation principale (mobile)";

    var desktopNavItems = navItems.map(function (item) {
      var cur = item.current ? ' aria-current="page"' : "";
      return '<li><a class="gv-nav__link" href="' + esc(item.href || "#") + '"' + cur + '>' + esc(item.label) + '</a></li>';
    }).join("");

    var mobileNavLinks = navItems.map(function (item) {
      var cur = item.current ? ' aria-current="page"' : "";
      return '<a href="' + esc(item.href || "#") + '"' + cur + '>' + esc(item.label) + '</a>';
    }).join("");

    var langItems = langs.map(function (l) {
      return '<a href="' + esc(l.href || "#") + '">' + esc(l.label) + '</a>';
    }).join("");

    return (
      '<header class="gv-header sticky">' +
        '<div class="gv-header__inner">' +
          '<a class="gv-brand" href="#" data-gv-logo aria-label="Home" aria-current="page"></a>' +

          '<nav class="gv-nav tinted" aria-label="Primary">' +
            '<ul class="gv-nav__list">' + desktopNavItems + '</ul>' +
          '</nav>' +

          '<div class="gv-header__actions">' +
            '<button class="gv-iconbtn gv-desktop-only" aria-label="' + esc(searchLabel) + '">' +
              '<span data-gv-icon="search"></span>' +
            '</button>' +

            '<div class="gv-auth-dual gv-desktop-only">' +
              '<button class="gv-btn primary">' + esc(loginLabel) + '</button>' +
              '<button class="gv-btn primary-inverse">' + esc(registerLabel) + '</button>' +
            '</div>' +

            '<details class="gv-nav__dd right gv-desktop-only gv-mobile-inline">' +
              '<summary class="gv-lang">' + esc(lang) +
                '<svg class="gv-nav__chev" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
                  '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>' +
              '</summary>' +
              '<div class="gv-nav__menu">' + langItems + '</div>' +
            '</details>' +

            '<details class="gv-nav-m">' +
              '<summary aria-label="' + esc(mobileMenuLabel) + '">' +
                '<svg class="gv-nav-m__bars" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
                  '<path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z"/>' +
                '</svg>' +
                '<svg class="gv-nav-m__x" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
                  '<path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>' +
                '</svg>' +
              '</summary>' +
              '<nav class="gv-nav-m__panel" aria-label="' + esc(mobileAriaLabel) + '">' +
                '<span class="gv-nav-m__logo" data-gv-logo aria-hidden="true"></span>' +
                mobileNavLinks +
                '<a class="gv-nav-m__search" href="#"><span data-gv-icon="search" aria-hidden="true"></span> ' + esc(mobileSearchLabel) + '</a>' +
                '<button class="gv-btn primary full" style="margin-top:14px">' + esc(loginLabel) + '</button>' +
                '<button class="gv-btn primary-outlined full" style="margin-top:10px">' + esc(registerLabel) + '</button>' +
              '</nav>' +
            '</details>' +
          '</div>' +
        '</div>' +
      '</header>'
    );
  }

  /* fallback — unknown variant */
  return "";
});

/* ── footer ─────────────────────────────────────────────────────────── */
/* footer.js — canonical instance renderer for .gv-footer.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("footer", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   links   Array<{ label: string, href: string, isCookieBtn: boolean }>
 *           The legal-nav items. One entry with isCookieBtn:true renders as a
 *           <button> (opens the cookie dialog); all others render as <a>.
 *           Default: the six HEAD items (German locale, same order).
 *
 *   poweredByText  string  The label before the Go Vocal wordmark.
 *                          Default: "Ermöglicht durch"
 *
 *   logoSrc  string  Path to govocal-logo.svg.
 *                    Default: "../../skills/govocal-ui/govocal-logo.svg"
 *
 *   logoHref  string  URL the wordmark links to.
 *                     Default: "https://govocal.com/"
 *
 *   logoAlt   string  Visible alt text for the wordmark image.
 *                     Default: "Go Vocal"
 *
 *   logoAriaLabel  string  Full accessible label on the <a> wrapping the logo.
 *                          Default: "Go Vocal (ehemals CitizenLab)"
 *
 *   navAriaLabel  string  aria-label on the <nav> landmark.
 *                         Default: "Secondary"
 *
 * GV.render("footer", {}) → primary instance (German locale, six links, Go Vocal wordmark).
 */
GV.register("footer", function (props) {
  props = props || {};
  var esc = GV.esc;

  var DEFAULT_LINKS = [
    { label: "Nutzungsbedingungen",          href: "#" },
    { label: "Impressum & Datenschutz", href: "#" },
    { label: "Cookierichtlinie",             href: "#" },
    { label: "Richtlinie zur Barrierefreiheit", href: "#" },
    { label: "Cookie-Einstellungen",         href: "#", isCookieBtn: true },
    { label: "Sitemap",                      href: "#" },
  ];

  var links          = props.links         != null ? props.links         : DEFAULT_LINKS;
  var poweredByText  = props.poweredByText  != null ? props.poweredByText  : "Ermöglicht durch";
  var logoSrc        = props.logoSrc        != null ? props.logoSrc        : "../../skills/govocal-ui/govocal-logo.svg";
  var logoHref       = props.logoHref       != null ? props.logoHref       : "https://govocal.com/";
  var logoAlt        = props.logoAlt        != null ? props.logoAlt        : "Go Vocal";
  var logoAriaLabel  = props.logoAriaLabel  != null ? props.logoAriaLabel  : "Go Vocal (ehemals CitizenLab)";
  var navAriaLabel   = props.navAriaLabel   != null ? props.navAriaLabel   : "Secondary";

  var items = links.map(function (it) {
    if (it.isCookieBtn) {
      return "<li><button type=\"button\">" + esc(it.label) + "</button></li>";
    }
    return "<li><a href=\"" + esc(it.href || "#") + "\">" + esc(it.label) + "</a></li>";
  }).join("");

  return (
    '<footer class="gv-footer">' +
      '<div class="gv-footer__inner">' +
        '<nav class="gv-footer__links" aria-label="' + esc(navAriaLabel) + '">' +
          '<ul>' + items + '</ul>' +
        '</nav>' +
        '<div class="gv-footer__powered">' +
          '<span>' + esc(poweredByText) + '</span>' +
          '<a href="' + esc(logoHref) + '" target="_blank" rel="noopener" aria-label="' + esc(logoAriaLabel) + '">' +
            '<img class="gv-powered-logo" src="' + esc(logoSrc) + '" alt="' + esc(logoAlt) + '" />' +
          '</a>' +
        '</div>' +
      '</div>' +
    '</footer>'
  );
});

/* ── header-nav ─────────────────────────────────────────────────────────── */
/* header-nav.js — canonical instance renderer for the FO site header + navigation.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("header-nav", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the signed-out primary instance):
 *
 *   state        "signed-out" | "signed-in"
 *                "signed-out" — logo, desktop nav, search icon, "Anmelden" CTA, hamburger
 *                "signed-in"  — logo, desktop nav, search icon, notification badge,
 *                               account dropdown (open), language switcher, hamburger
 *                Default: "signed-out"
 *
 *   sticky       boolean   add "sticky" class to <header>   default true
 *   e2eId        string    id attr on <header>               default "e2e-navbar" (signed-out only)
 *
 *   — nav links (shared) —
 *   navItems     array of { label, href, active?, dropdown?: [{ label, href }] }
 *                Default (signed-out): Willkommen (active), Beteiligungsprojekte (dropdown ×4),
 *                                      Mitmachen, Netiquette, Mehr (dropdown overflow ×3)
 *                Default (signed-in):  Willkommen (active), Beteiligungsprojekte, Mitmachen
 *
 *   mobileLinks  array of { label, href, active? }   nav links in the mobile drawer
 *                Default matches navItems flat list (HEAD's exact items)
 *
 *   homeLabel    string  aria-label on the brand link   default "Startseite"
 *
 *   — signed-out only —
 *   ctaLabel     string  primary button label           default "Anmelden"
 *
 *   — signed-in only —
 *   notifCount   number | ""  notification badge count  default 3
 *   notifLabel   string       aria-label for notif btn  default "Benachrichtigungen, 3 ungelesen"
 *   accountOpen  boolean      account dropdown starts open  default true
 *   account      { name, initial, href, adminHref, activityHref, settingsHref }
 *                Default: { name:"Rob", initial:"R" }
 *   accountMenu  array of { label, icon, href?, type? }  account menu items
 *                Default: Plattform verwalten, Meine Aktivität, Meine Einstellungen, Abmelden
 *   languages    array of { label, href }   language switcher options
 *                Default: Deutsch, English, Français
 *   currentLang  string   current language abbreviation  default "DE"
 *
 * GV.render("header-nav") → primary (signed-out) header, sticky, id="e2e-navbar".
 * GV.render("header-nav", { state: "signed-in" }) → logged-in header, account open.
 */
GV.register("header-nav", function (props) {
  props = props || {};
  var esc = GV.esc;

  var state = props.state || "signed-out";
  var sticky = props.sticky !== false;
  var homeLabel = props.homeLabel != null ? props.homeLabel : "Startseite";

  /* ── Chevron SVG (reused for dropdown toggles) ── */
  var CHEV = '<svg class="gv-nav__chev" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  /* ── Hamburger / close SVGs ── */
  var BARS_SVG = '<svg class="gv-nav-m__bars" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z"/>' +
    '</svg>';
  var X_SVG = '<svg class="gv-nav-m__x" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>' +
    '</svg>';

  /* ─────────────────────────────────────────────────────────────
     SIGNED-OUT (primary)
     ───────────────────────────────────────────────────────────── */
  if (state === "signed-out") {
    var ctaLabel = props.ctaLabel != null ? props.ctaLabel : "Anmelden";
    var e2eId    = props.e2eId    != null ? props.e2eId    : "e2e-navbar";

    /* Desktop nav defaults — exact items from HEAD */
    var navItems = props.navItems != null ? props.navItems : [
      { label: "Willkommen", href: "#", active: true },
      {
        label: "Beteiligungsprojekte",
        href: "#",
        dropdown: [
          { label: "Zukunft Taborstraße",        href: "#" },
          { label: "Wiener Klimateam",            href: "#" },
          { label: "Partizipatives Budget 2026",  href: "#" },
          { label: "Neugestaltung Praterstraße",  href: "#" }
        ]
      },
      { label: "Mitmachen",  href: "#" },
      { label: "Netiquette", href: "#" },
      {
        label: "Mehr",
        href: "#",
        overflow: true,   /* renders "Mehr" with ··· icon instead of chevron */
        dropdown: [
          { label: "Über die Plattform", href: "#" },
          { label: "Häufige Fragen",     href: "#" },
          { label: "Kontakt",            href: "#" }
        ]
      }
    ];

    /* Mobile drawer flat link list defaults */
    var mobileLinks = props.mobileLinks != null ? props.mobileLinks : [
      { label: "Willkommen",          href: "#", active: true },
      { label: "Beteiligungsprojekte", href: "#" },
      { label: "Mitmachen",           href: "#" },
      { label: "Netiquette",          href: "#" },
      { label: "Mehr",                href: "#" }
    ];

    /* Build desktop <li> items */
    var liHtml = navItems.map(function (item) {
      var activeAttr = item.active ? ' aria-current="page"' : "";
      if (!item.dropdown) {
        return "<li><a class=\"gv-nav__link\" href=\"" + esc(item.href || "#") + "\"" + activeAttr + ">" + esc(item.label) + "</a></li>";
      }
      /* Dropdown item */
      var ddCls = "gv-nav__dd" + (item.overflow || item.right ? " right" : "");
      var toggle;
      if (item.overflow) {
        /* "Mehr" uses ··· dots icon instead of chevron */
        toggle = "<summary class=\"gv-nav__link\">" + esc(item.label) +
          " <svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\">" +
          "<circle cx=\"5\" cy=\"12\" r=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><circle cx=\"19\" cy=\"12\" r=\"2\"/>" +
          "</svg></summary>";
      } else {
        toggle = "<summary class=\"gv-nav__link\"" + activeAttr + ">" + esc(item.label) + " " + CHEV + "</summary>";
      }
      var menuLinks = item.dropdown.map(function (d) {
        return "<a href=\"" + esc(d.href || "#") + "\">" + esc(d.label) + "</a>";
      }).join("");
      return "<li><details class=\"" + esc(ddCls) + "\">" + toggle +
        "<div class=\"gv-nav__menu\">" + menuLinks + "</div>" +
        "</details></li>";
    }).join("");

    /* Build mobile drawer links */
    var mobileLinkHtml = mobileLinks.map(function (lk) {
      var activeAttr = lk.active ? ' aria-current="page"' : "";
      return "<a href=\"" + esc(lk.href || "#") + "\"" + activeAttr + ">" + esc(lk.label) + "</a>";
    }).join("");

    var headerCls = "gv-header" + (sticky ? " sticky" : "");
    var idAttr    = e2eId ? ' id="' + esc(e2eId) + '"' : "";

    return (
      "<header" + idAttr + " class=\"" + headerCls + "\">" +
        "<div class=\"gv-header__inner\">" +
          "<a class=\"gv-brand\" href=\"#\" data-gv-logo aria-label=\"" + esc(homeLabel) + "\" aria-current=\"page\"></a>" +
          "<nav class=\"gv-nav\" aria-label=\"Primäre\">" +
            "<ul class=\"gv-nav__list\">" + liHtml + "</ul>" +
          "</nav>" +
          "<div class=\"gv-header__actions\">" +
            "<button class=\"gv-iconbtn gv-desktop-only\" aria-label=\"Suche\">" +
              "<span data-gv-icon=\"search\"></span>" +
            "</button>" +
            "<button class=\"gv-btn primary gv-desktop-only\" style=\"padding:8px 18px;line-height:20px\">" +
              esc(ctaLabel) +
            "</button>" +
            "<details class=\"gv-nav-m\">" +
              "<summary aria-label=\"Mobiles Navigationsmenü anzeigen\">" +
                BARS_SVG + X_SVG +
              "</summary>" +
              "<nav class=\"gv-nav-m__panel\" aria-label=\"Hauptnavigation (mobil)\">" +
                "<span class=\"gv-nav-m__logo\" data-gv-logo aria-hidden=\"true\"></span>" +
                mobileLinkHtml +
                "<a class=\"gv-nav-m__search\" href=\"#\"><span data-gv-icon=\"search\" aria-hidden=\"true\"></span> Suche</a>" +
                "<button class=\"gv-btn primary full\">" + esc(ctaLabel) + "</button>" +
              "</nav>" +
            "</details>" +
          "</div>" +
        "</div>" +
      "</header>"
    );
  }

  /* ─────────────────────────────────────────────────────────────
     SIGNED-IN
     ───────────────────────────────────────────────────────────── */
  var notifCount = props.notifCount != null ? props.notifCount : 3;
  var notifLabel = props.notifLabel != null
    ? props.notifLabel
    : "Benachrichtigungen, " + notifCount + " ungelesen";
  var accountOpen = props.accountOpen !== false;  /* default open (HEAD shows it open) */
  var account = props.account || { name: "Rob", initial: "R" };
  var accountMenu = props.accountMenu != null ? props.accountMenu : [
    { label: "Plattform verwalten", icon: "shield",      href: "#" },
    { label: "Meine Aktivität",     icon: "user-circle", href: "#" },
    { label: "Meine Einstellungen", icon: "cogs",        href: "#" },
    { label: "Abmelden",            icon: "power",       type: "button" }
  ];
  var languages = props.languages != null ? props.languages : [
    { label: "Deutsch",  href: "#" },
    { label: "English",  href: "#" },
    { label: "Français", href: "#" }
  ];
  var currentLang = props.currentLang != null ? props.currentLang : "DE";

  /* Desktop nav defaults for signed-in (3 items, no overflow) */
  var navItemsIn = props.navItems != null ? props.navItems : [
    { label: "Willkommen",          href: "#", active: true },
    { label: "Beteiligungsprojekte", href: "#" },
    { label: "Mitmachen",           href: "#" }
  ];

  /* Mobile drawer flat links for signed-in */
  var mobileLinksIn = props.mobileLinks != null ? props.mobileLinks : [
    { label: "Willkommen",          href: "#", active: true },
    { label: "Beteiligungsprojekte", href: "#" },
    { label: "Mitmachen",           href: "#" },
    { label: "Plattform verwalten", href: "#" },
    { label: "Meine Aktivität",     href: "#" }
  ];

  var liHtmlIn = navItemsIn.map(function (item) {
    var activeAttr = item.active ? ' aria-current="page"' : "";
    return "<li><a class=\"gv-nav__link\" href=\"" + esc(item.href || "#") + "\"" + activeAttr + ">" + esc(item.label) + "</a></li>";
  }).join("");

  /* Account menu items */
  var acctMenuHtml = accountMenu.map(function (it) {
    if (it.type === "button") {
      return "<button type=\"button\">" + esc(it.label) +
        " <span data-gv-icon=\"" + esc(it.icon) + "\"></span></button>";
    }
    return "<a href=\"" + esc(it.href || "#") + "\">" + esc(it.label) +
      " <span data-gv-icon=\"" + esc(it.icon) + "\"></span></a>";
  }).join("");

  /* Language options */
  var langOptHtml = languages.map(function (lg) {
    return "<a href=\"" + esc(lg.href || "#") + "\">" + esc(lg.label) + "</a>";
  }).join("");

  /* Mobile drawer links */
  var mobileLinkInHtml = mobileLinksIn.map(function (lk) {
    var activeAttr = lk.active ? ' aria-current="page"' : "";
    return "<a href=\"" + esc(lk.href || "#") + "\"" + activeAttr + ">" + esc(lk.label) + "</a>";
  }).join("");

  /* Notification badge */
  var notifBadge = notifCount
    ? "<span class=\"gv-iconbtn__badge\" aria-hidden=\"true\">" + esc(String(notifCount)) + "</span>"
    : "";

  var headerClsIn = "gv-header" + (sticky ? " sticky" : "");
  var acctOpenAttr = accountOpen ? " open" : "";

  return (
    "<header class=\"" + headerClsIn + "\">" +
      "<div class=\"gv-header__inner\">" +
        "<a class=\"gv-brand\" href=\"#\" data-gv-logo aria-label=\"" + esc(homeLabel) + "\" aria-current=\"page\"></a>" +
        "<nav class=\"gv-nav\" aria-label=\"Primäre\">" +
          "<ul class=\"gv-nav__list\">" + liHtmlIn + "</ul>" +
        "</nav>" +
        "<div class=\"gv-header__actions\">" +
          "<button class=\"gv-iconbtn gv-desktop-only\" aria-label=\"Suche\">" +
            "<span data-gv-icon=\"search\"></span>" +
          "</button>" +
          "<button class=\"gv-iconbtn\" aria-label=\"" + esc(notifLabel) + "\">" +
            "<span data-gv-icon=\"notification\"></span>" +
            notifBadge +
          "</button>" +
          "<details class=\"gv-nav__dd right gv-account-dd gv-desktop-only gv-mobile-inline\"" + acctOpenAttr + ">" +
            "<summary class=\"gv-account\" aria-haspopup=\"menu\">" +
              "<span class=\"gv-account__name\">" + esc(account.name || "") + "</span>" +
              "<span class=\"gv-avatar\">" + esc(account.initial || "") + "</span>" +
              CHEV +
            "</summary>" +
            "<div class=\"gv-nav__menu gv-nav__menu--account\">" + acctMenuHtml + "</div>" +
          "</details>" +
          "<details class=\"gv-nav__dd right gv-desktop-only gv-mobile-inline\">" +
            "<summary class=\"gv-lang\">" + esc(currentLang) + " " + CHEV + "</summary>" +
            "<div class=\"gv-nav__menu\">" + langOptHtml + "</div>" +
          "</details>" +
          "<details class=\"gv-nav-m\">" +
            "<summary aria-label=\"Mobiles Navigationsmenü anzeigen\">" +
              BARS_SVG + X_SVG +
            "</summary>" +
            "<nav class=\"gv-nav-m__panel\" aria-label=\"Hauptnavigation (mobil)\">" +
              "<span class=\"gv-nav-m__logo\" data-gv-logo aria-hidden=\"true\"></span>" +
              mobileLinkInHtml +
              "<a class=\"gv-nav-m__search\" href=\"#\"><span data-gv-icon=\"search\" aria-hidden=\"true\"></span> Suche</a>" +
              "<button class=\"gv-btn primary-outlined full\" style=\"margin-top:14px\">Abmelden</button>" +
            "</nav>" +
          "</details>" +
        "</div>" +
      "</div>" +
    "</header>"
  );
});

/* ── hero ─────────────────────────────────────────────────────────── */
/* hero.js — canonical instance renderer for .gv-hero.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("hero", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance from HEAD):
 *
 *   variant   "placeholder" | "photo" | "switcher"
 *             "placeholder" — no image, tenant gradient, avatars + CTA + credit  (instance 1)
 *             "photo"       — full-bleed photo via --gv-hero-image, no avatars    (instance 2)
 *             "switcher"    — full-width layout with signed-out + signed-in bands  (instance 3)
 *
 *   — all variants —
 *   title        string   hero heading                      "Wien mitgestalten"
 *   lead         string   subtitle/lead copy                "Die Beteiligungsplattform der Stadt Wien"
 *   ctaLabel     string   CTA link label                    "Mehr zum aktuellen Projekt"
 *   ctaHref      string   CTA link href                     "#"
 *   imageUrl     string   photo URL (variant "photo" / "switcher")
 *
 *   — variant "placeholder" only —
 *   avatarCount  number   how many .av spans to render      4
 *   avatarLabel  string   aria-label on .gv-avatars         "15,4 Tausend Teilnehmende"
 *   countLabel   string   visible count pill text           "15.4k"
 *   credit       string   banner credit line                "Banner: © Stadt Wien"
 *                         Pass null/false to suppress.
 *
 *   — variant "switcher" only —
 *   layout      string    layout class suffix              "full"   ("full"|"tworow"|"fixed")
 *   auth        string    initial auth state               "out"    ("out"|"in")
 *   outTitle    string    signed-out heading               "Wien mitgestalten"
 *   outLead     string    signed-out lead                  "Die Beteiligungsplattform der Stadt Wien"
 *   outAvatarLabel string signed-out avatars aria-label    "15,4 Tausend Teilnehmende"
 *   outCountLabel  string signed-out count pill            "15.4k"
 *   outBtnLabel string    signed-out button label          "Registrieren"
 *   inTitle     string    signed-in heading                "Willkommen zurück, Robin"
 *   inLead      string    signed-in lead                   "Ihre gefolgten Projekte haben Neuigkeiten."
 *   inBtnLabel  string    signed-in button label           "Zum Hafen-Masterplan"
 *
 * Three instances from HEAD:
 *   GV.render("hero", {})                    → placeholder (primary)
 *   GV.render("hero", {variant:"photo"})     → photo hero
 *   GV.render("hero", {variant:"switcher"})  → full-width + signed-out state (homepage default)
 */
GV.register("hero", function (props) {
  props = props || {};
  var esc = GV.esc;
  var variant = props.variant || "placeholder";

  /* shared arrow SVG used in CTA */
  var arrowSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">' +
      '<path d="M5 12h14M13 6l6 6-6 6"/>' +
    '</svg>';

  /* ── VARIANT: placeholder (no photo) — primary instance ── */
  if (variant === "placeholder") {
    var title       = props.title       != null ? props.title       : "Wien mitgestalten";
    var lead        = props.lead        != null ? props.lead        : "Die Beteiligungsplattform der Stadt Wien";
    var ctaLabel    = props.ctaLabel    != null ? props.ctaLabel    : "Mehr zum aktuellen Projekt";
    var ctaHref     = props.ctaHref     != null ? props.ctaHref     : "#";
    var avatarCount = props.avatarCount != null ? props.avatarCount : 4;
    var avatarLabel = props.avatarLabel != null ? props.avatarLabel : "15,4 Tausend Teilnehmende";
    var countLabel  = props.countLabel  != null ? props.countLabel  : "15.4k";
    var credit      = props.credit !== undefined ? props.credit     : "Banner: © Stadt Wien";

    var avSpans = "";
    for (var i = 0; i < avatarCount; i++) { avSpans += '<span class="av"></span>'; }

    var creditHtml = credit
      ? '<span class="gv-hero__credit">' + esc(credit) + '</span>'
      : '';

    return (
      '<section class="gv-hero">' +
        '<div class="gv-hero__inner">' +
          '<h1 class="gv-hero__title">' + esc(title) + '</h1>' +
          '<p class="gv-hero__lead">' + esc(lead) + '</p>' +
          '<div class="gv-avatars" aria-label="' + esc(avatarLabel) + '">' +
            avSpans +
            '<span class="count">' + esc(countLabel) + '</span>' +
          '</div>' +
        '</div>' +
        '<a class="gv-hero__cta" href="' + esc(ctaHref) + '">' + esc(ctaLabel) + ' ' + arrowSvg + '</a>' +
        creditHtml +
      '</section>'
    );
  }

  /* ── VARIANT: photo — hero with full-bleed image ── */
  if (variant === "photo") {
    var title    = props.title    != null ? props.title    : "Wien mitgestalten";
    var lead     = props.lead     != null ? props.lead     : "Die Beteiligungsplattform der Stadt Wien";
    var ctaLabel = props.ctaLabel != null ? props.ctaLabel : "Mehr zum aktuellen Projekt";
    var ctaHref  = props.ctaHref  != null ? props.ctaHref  : "#";
    var imageUrl = props.imageUrl != null ? props.imageUrl : "https://images.unsplash.com/photo-1516550893923-42d28e5677af?w=1400&q=60";

    return (
      '<section class="gv-hero" style="--gv-hero-image:url(\'' + esc(imageUrl) + '\')">' +
        '<div class="gv-hero__inner">' +
          '<h1 class="gv-hero__title">' + esc(title) + '</h1>' +
          '<p class="gv-hero__lead">' + esc(lead) + '</p>' +
        '</div>' +
        '<a class="gv-hero__cta" href="' + esc(ctaHref) + '">' + esc(ctaLabel) + ' ' + arrowSvg + '</a>' +
      '</section>'
    );
  }

  /* ── VARIANT: switcher — full-width layout with signed-out / signed-in content bands ── */
  /* This renders one <section> containing BOTH .banner-content bands; the demo's JS
     controls which is visible via the parent stage's [data-auth] attribute. The homepage
     drops in whichever single configured state it needs. */
  var layout       = props.layout       != null ? props.layout       : "full";
  var imageUrl     = props.imageUrl     != null ? props.imageUrl     : "https://images.unsplash.com/photo-1516550893923-42d28e5677af?w=1400&q=60";

  var outTitle      = props.outTitle     != null ? props.outTitle     : "Wien mitgestalten";
  var outLead       = props.outLead      != null ? props.outLead      : "Die Beteiligungsplattform der Stadt Wien";
  var outAvatarLabel = props.outAvatarLabel != null ? props.outAvatarLabel : "15,4 Tausend Teilnehmende";
  var outCountLabel  = props.outCountLabel  != null ? props.outCountLabel  : "15.4k";
  var outBtnLabel   = props.outBtnLabel  != null ? props.outBtnLabel  : "Registrieren";

  var inTitle      = props.inTitle      != null ? props.inTitle      : "Willkommen zurück, Robin";
  var inLead       = props.inLead       != null ? props.inLead       : "Ihre gefolgten Projekte haben Neuigkeiten.";
  var inBtnLabel   = props.inBtnLabel   != null ? props.inBtnLabel   : "Zum Hafen-Masterplan";

  var TESTIDS = { full: "full-width-banner-layout", tworow: "two-row-layout", fixed: "fixed-ratio-layout" };
  var testid = TESTIDS[layout] || "full-width-banner-layout";

  return (
    '<section class="gv-hero signed-out centered layout-' + esc(layout) + '" id="switchHero" data-testid="' + esc(testid) + '"' +
      ' style="--gv-hero-image:url(\'' + esc(imageUrl) + '\')">' +
      '<div class="gv-hero__media"><img src="' + esc(imageUrl) + '" alt="" /></div>' +
      '<div class="gv-hero__inner">' +
        '<!-- non-registered: avatars + sign-up -->' +
        '<div class="banner-content" data-when="out">' +
          '<h1 class="gv-hero__title">' + esc(outTitle) + '</h1>' +
          '<p class="gv-hero__lead">' + esc(outLead) + '</p>' +
          '<div class="gv-avatars" aria-label="' + esc(outAvatarLabel) + '">' +
            '<span class="av"></span><span class="av"></span><span class="av"></span><span class="av"></span>' +
            '<span class="count">' + esc(outCountLabel) + '</span>' +
          '</div>' +
          '<div class="gv-hero__actions"><button type="button" class="gv-btn primary-inverse">' + esc(outBtnLabel) + '</button></div>' +
        '</div>' +
        '<!-- registered: no avatars, own CTA -->' +
        '<div class="banner-content" data-when="in">' +
          '<h1 class="gv-hero__title">' + esc(inTitle) + '</h1>' +
          '<p class="gv-hero__lead">' + esc(inLead) + '</p>' +
          '<div class="gv-hero__actions"><button type="button" class="gv-btn primary-inverse">' + esc(inBtnLabel) + '</button></div>' +
        '</div>' +
      '</div>' +
    '</section>'
  );
});

/* ── homepage-featured-row ─────────────────────────────────────────────────────────── */
/* homepage-featured-row.js — canonical instance renderer.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("homepage-featured-row", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance from HEAD):
 *
 *   heading    {string}  Section h2 text                     "We want to hear from you"
 *   headingId  {string}  id on the <h2> for aria-labelledby  "featured-h"
 *
 *   cards      {Array}   Array of card objects (3 by default, matching HEAD).
 *              Each card:
 *                title      {string}  <h3> link text (including method prefix)
 *                href       {string}  card link href             default "#"
 *                thumbHtml  {string}  raw inner HTML for .gv-pcard__thumb (injected
 *                                    verbatim — lets callers pass any image/div).
 *                                    Default = placeholder divs matching HEAD art.
 *                avatars    {Array}   Array of { bg } objects for avatar bubbles.
 *                                    Each { bg } is a background CSS value (colour,
 *                                    url(), gradient…).
 *                                    Default = the three HEAD greys.
 *                overflowCount {string|number}  "+N" overflow label   default per card
 *                participantLabel {string}   "N participants" text    default per card
 *
 * GV.render("homepage-featured-row")          → primary (3-card row, HEAD defaults)
 * GV.render("homepage-featured-row", { heading: "Join us", cards: […] }) → custom
 */
GV.register("homepage-featured-row", function (props) {
  props = props || {};
  var esc = GV.esc;

  var heading   = props.heading   != null ? props.heading   : "We want to hear from you";
  var headingId = props.headingId != null ? props.headingId : "featured-h";

  var DEFAULT_CARDS = [
    {
      title:            "Ideation: Let’s Reimagine our Central Park",
      href:             "#",
      thumbHtml:        '<div class="ph ph-1"></div>',
      avatars:          [{ bg: "#7a8b99" }, { bg: "#9aa7b2" }, { bg: "#b6c0c8" }],
      overflowCount:    "+42",
      participantLabel: "45 participants"
    },
    {
      title:            "Survey: Redesigning Coffman Park",
      href:             "#",
      thumbHtml:        '<div class="ph ph-2"></div>',
      avatars:          [{ bg: "#7a8b99" }, { bg: "#9aa7b2" }, { bg: "#b6c0c8" }],
      overflowCount:    "+18",
      participantLabel: "21 participants"
    },
    {
      title:            "The Big Conversation",
      href:             "#",
      thumbHtml:        '<div class="ph ph-3"></div>',
      avatars:          [{ bg: "#7a8b99" }, { bg: "#9aa7b2" }, { bg: "#b6c0c8" }],
      overflowCount:    "+9",
      participantLabel: "12 participants"
    }
  ];

  var cards = props.cards !== undefined ? props.cards : DEFAULT_CARDS;

  var cardsHtml = cards.map(function (card) {
    var thumbHtml = card.thumbHtml != null ? card.thumbHtml : "";
    var href      = card.href      != null ? card.href      : "#";
    var avatars   = Array.isArray(card.avatars) ? card.avatars : [];

    var avsHtml = avatars.map(function (av) {
      return '<span class="av" style="background:' + esc(av.bg) + ';"></span>';
    }).join("");

    var overflowHtml = card.overflowCount != null
      ? '<span class="count">' + esc(card.overflowCount) + "</span>"
      : "";

    var labelHtml = card.participantLabel != null
      ? '<span class="gv-bubbles__label">' + esc(card.participantLabel) + "</span>"
      : "";

    return (
      '<article class="gv-pcard featured">' +
        '<div class="gv-pcard__thumb">' + thumbHtml + "</div>" +
        '<h3 class="gv-pcard__title"><a href="' + esc(href) + '">' + esc(card.title) + "</a></h3>" +
        '<div class="gv-bubbles xs" aria-hidden="true">' +
          avsHtml +
          overflowHtml +
          labelHtml +
        "</div>" +
      "</article>"
    );
  }).join("");

  return (
    '<section aria-labelledby="' + esc(headingId) + '">' +
      '<h2 id="' + esc(headingId) + '" class="gv-title h2" style="margin-bottom:16px;">' + esc(heading) + "</h2>" +
      '<div class="gv-featured-row">' +
        cardsHtml +
      "</div>" +
    "</section>"
  );
});

/* ── homepage-survey-band ─────────────────────────────────────────────────────────── */
/* homepage-survey-band.js — canonical instance renderer for .gv-monitorband.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("homepage-survey-band", props) → canonical HTML string.
 *
 * Source-grounded on wietsedemo /en homepage:
 *   .gv-monitorband (3-zone tinted flex card — text · media · CTA)
 *   tinted fill via --gv-tenant-primary-lighten90, 32px padding, 16px gap, 16px radius.
 *   Distinct from .gv-ctaband (centered single-column) — its own variant, no base mutated.
 *
 * Props (all optional — defaults reproduce the PRIMARY HEAD instance exactly):
 *
 *   title       : string   — <h2> heading text
 *                            (default "Help us serve you better")
 *   lead        : string   — <p> lede copy below the title
 *                            (default "Ongoing survey about how feel about quality of
 *                             life, public services, and governance in our city.")
 *   ctaLabel    : string   — primary button text               (default "Take the survey")
 *   ctaHref     : string   — button href (renders <a> if set, <button> otherwise)
 *                            (default undefined → <button>)
 *   ctaMeta     : string   — small meta line beside the CTA    (default "Takes 2 minutes")
 *                            Pass null/false to suppress the meta line entirely.
 *   titleId     : string   — id on <h2> for aria-labelledby   (default "survey-band-title")
 *   ariaLabel   : string   — NOT used directly (section uses aria-labelledby);
 *                            kept for forward-compat, ignored when titleId is set.
 *   showMedia   : boolean  — render the .gv-monitorband__media zone (default true)
 *                            The media content is the sqp artwork (page-local reconstruction
 *                            of the live SentimentQuestionPreview.png illustration).
 *                            Pass false to suppress the media column entirely.
 *
 * Single instance in HEAD — GV.render("homepage-survey-band", {}) reproduces it exactly.
 *
 * Theming: tint and CTA fill follow --gv-tenant-primary.
 * Override --gv-tenant-primary (or use ?theme=) to re-skin the whole band.
 */
GV.register("homepage-survey-band", function (props) {
  props = props || {};
  var esc = GV.esc;

  var title     = props.title     !== undefined ? props.title     : "Help us serve you better";
  var lead      = props.lead      !== undefined ? props.lead      : "Ongoing survey about how feel about quality of life, public services, and governance in our city.";
  var ctaLabel  = props.ctaLabel  !== undefined ? props.ctaLabel  : "Take the survey";
  var ctaHref   = props.ctaHref   !== undefined ? props.ctaHref   : undefined;
  var ctaMeta   = props.ctaMeta   !== undefined ? props.ctaMeta   : "Takes 2 minutes";
  var titleId   = props.titleId   !== undefined ? props.titleId   : "survey-band-title";
  var showMedia = props.showMedia !== undefined ? props.showMedia : true;

  var ctaBtn = ctaHref
    ? '<a class="gv-btn primary" href="' + esc(ctaHref) + '">' + esc(ctaLabel) + '</a>'
    : '<button class="gv-btn primary" type="button">' + esc(ctaLabel) + '</button>';

  var ctaMetaHtml = ctaMeta
    ? '<p class="gv-monitorband__ctameta">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
          '<path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm.75 4.5v5.55l3.7 2.2-.76 1.28-4.44-2.64V6.5h1.5Z"/>' +
        '</svg>' +
        '<span>' + esc(ctaMeta) + '</span>' +
      '</p>'
    : '';

  /* The __media zone: page-local reconstruction of the live SentimentQuestionPreview.png.
     Uses no .gv-* class and no brand hex — it inherits --gv-tenant-primary so it re-themes.
     The sqp__* classes are scoped to this zone and carry their own inline styles in the
     demo's <style> block; they are not govocal-ui.css primitives. */
  var mediaHtml = showMedia
    ? '<div class="gv-monitorband__media">' +
        '<div class="sqp" role="img" aria-label="Example of a sentiment survey question">' +
          '<div class="sqp__card">' +
            '<span class="sqp__line"></span>' +
            '<span class="sqp__line sqp__line--short"></span>' +
            '<div class="sqp__faces">' +
              '<span class="sqp__face">&#x1F623;</span>' +
              '<span class="sqp__face">&#x1F641;</span>' +
              '<span class="sqp__face">&#x1F610;</span>' +
              '<span class="sqp__face sqp__face--sel">&#x1F642;<span class="sqp__check" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="10" height="10" fill="#fff" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' +
              '</span></span>' +
              '<span class="sqp__face">&#x1F604;</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    : '';

  return (
    '<section class="gv-monitorband" aria-labelledby="' + esc(titleId) + '">' +
      '<div class="gv-monitorband__inner">' +
        '<div class="gv-monitorband__text">' +
          '<h2 class="gv-monitorband__title" id="' + esc(titleId) + '">' + esc(title) + '</h2>' +
          '<p class="gv-monitorband__lead">' + esc(lead) + '</p>' +
        '</div>' +
        mediaHtml +
        '<div class="gv-monitorband__cta">' +
          ctaBtn +
          ctaMetaHtml +
        '</div>' +
      '</div>' +
    '</section>'
  );
});

/* ── icon ─────────────────────────────────────────────────────────── */
/* icon.js — canonical instance renderers for the icon glyph cell + icon button.
 *
 * Registered onto window.GV via GV.register("icon", fn) and GV.register("iconbtn", fn).
 *
 * ── icon (glyph cell) ──────────────────────────────────────────────────────────
 * Renders one labelled glyph cell from the base/icon glyph grid.
 * Props:
 *   name  {string}  — glyph name passed to data-gv-icon  (default "search")
 *
 * Output:
 *   <div class="cell">
 *     <span class="g" data-gv-icon="search" aria-hidden="true"></span>
 *     <span class="n">search</span>
 *   </div>
 *
 * ── iconbtn (icon button) ──────────────────────────────────────────────────────
 * Renders a single .gv-iconbtn with a labelled glyph inside.
 * Props:
 *   name      {string}  — glyph name              (default "search")
 *   ariaLabel {string}  — accessible button label  (default "Search")
 *
 * Output:
 *   <button class="gv-iconbtn" aria-label="Search">
 *     <span data-gv-icon="search"></span>
 *   </button>
 *
 * GV.render("icon", {})     → glyph cell for "search"
 * GV.render("iconbtn", {})  → icon button for "search"
 */
GV.register("icon", function (props) {
  props = props || {};
  var esc = GV.esc;
  var name = props.name !== undefined ? props.name : "search";
  return '<div class="cell">' +
    '<span class="g" data-gv-icon="' + esc(name) + '" aria-hidden="true"></span>' +
    '<span class="n">' + esc(name) + '</span>' +
    '</div>';
});

GV.register("iconbtn", function (props) {
  props = props || {};
  var esc = GV.esc;
  var name      = props.name      !== undefined ? props.name      : "search";
  var ariaLabel = props.ariaLabel !== undefined ? props.ariaLabel : "Search";
  return '<button class="gv-iconbtn" aria-label="' + esc(ariaLabel) + '">' +
    '<span data-gv-icon="' + esc(name) + '"></span>' +
    '</button>';
});

/* ── idea-card ─────────────────────────────────────────────────────────── */
/* idea-card.js — canonical instance renderer for .gv-ideacard.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("idea-card", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance):
 *
 *   thumb      {string|null}  URL for the thumbnail image.
 *                             If null/falsy, renders an icon placeholder instead.
 *                             default: "https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=320&h=320&fit=crop"
 *   thumbIcon  {string}       data-gv-icon value used when thumb is falsy.
 *                             default: "vote-up"
 *   thumbAlt   {string}       alt text for the thumbnail image.
 *                             default: "" (decorative)
 *   href       {string}       link target for the card title.
 *                             default: "#"
 *   title      {string}       heading text.
 *                             default: "Cycle route network"
 *   avatar     {string}       two-letter initials for the avatar chip.
 *                             default: "EW"
 *   author     {string}       author display name.
 *                             default: "Eddy Walker"
 *   time       {string}       relative time label.
 *                             default: "2 years ago"
 *   excerpt    {string}       body copy beneath the author line.
 *                             default: "Connect the park to the existing bike lanes with a safe, separated cycle route so families can ride here without using busy roads."
 *   likes      {number|string}  like count.  default: 47
 *   dislikes   {number|string}  dislike count. default: 3
 *   comments   {number|string}  comment count. default: 3
 *
 * GV.render("idea-card")                     → primary (photo thumb, Eddy Walker card)
 * GV.render("idea-card", { thumb: null })    → no-photo variant (icon thumb)
 */
GV.register("idea-card", function (props) {
  props = props || {};
  var esc = GV.esc;

  var thumb     = props.thumb     !== undefined ? props.thumb     : "https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=320&h=320&fit=crop";
  var thumbIcon = props.thumbIcon !== undefined ? props.thumbIcon : "vote-up";
  var thumbAlt  = props.thumbAlt  !== undefined ? props.thumbAlt  : "";
  var href      = props.href      !== undefined ? props.href      : "#";
  var title     = props.title     !== undefined ? props.title     : "Cycle route network";
  var avatar    = props.avatar    !== undefined ? props.avatar    : "EW";
  var author    = props.author    !== undefined ? props.author    : "Eddy Walker";
  var time      = props.time      !== undefined ? props.time      : "2 years ago";
  var excerpt   = props.excerpt   !== undefined ? props.excerpt   : "Connect the park to the existing bike lanes with a safe, separated cycle route so families can ride here without using busy roads.";
  var likes     = props.likes     !== undefined ? props.likes     : 47;
  var dislikes  = props.dislikes  !== undefined ? props.dislikes  : 3;
  var comments  = props.comments  !== undefined ? props.comments  : 3;

  var thumbHtml = thumb
    ? '<img src="' + esc(thumb) + '" alt="' + esc(thumbAlt) + '" loading="lazy" />'
    : '<span data-gv-icon="' + esc(thumbIcon) + '" aria-hidden="true"></span>';

  return (
    '<article class="gv-ideacard e2e-idea-card">' +
      '<div class="gv-ideacard__thumb">' + thumbHtml + '</div>' +
      '<div class="gv-ideacard__body">' +
        '<h3 class="gv-ideacard__title e2e-idea-card-title"><a href="' + esc(href) + '">' + esc(title) + '</a></h3>' +
        '<div class="gv-ideacard__head">' +
          '<span class="gv-ideacard__avatar" aria-hidden="true">' + esc(avatar) + '</span>' +
          '<div>' +
            '<div class="gv-ideacard__meta">' +
              '<span class="gv-ideacard__author e2e-username">' + esc(author) + '</span>' +
              '<span class="gv-ideacard__sep" aria-hidden="true">&bull;</span>' +
              '<span class="gv-ideacard__time">' + esc(time) + '</span>' +
            '</div>' +
            '<p class="gv-ideacard__excerpt">' + esc(excerpt) + '</p>' +
          '</div>' +
        '</div>' +
        '<footer class="gv-ideacard__foot">' +
          '<div class="gv-react e2e-reaction-controls">' +
            '<button class="gv-react__btn" aria-label="Like"><span data-gv-icon="vote-up"></span></button>' +
            '<span class="gv-react__count">' + esc(likes) + '</span>' +
            '<button class="gv-react__btn" aria-label="Dislike"><span data-gv-icon="vote-down"></span></button>' +
            '<span class="gv-react__count">' + esc(dislikes) + '</span>' +
          '</div>' +
          '<span class="gv-react__comment e2e-ideacard-comment-count"><span data-gv-icon="comments"></span>' + esc(comments) + '</span>' +
        '</footer>' +
      '</div>' +
    '</article>'
  );
});

/* ── idea-feed ─────────────────────────────────────────────────────────── */
/* idea-feed.js — canonical instance renderer for the ideation feed layout.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("idea-feed", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance exactly):
 *
 *   countLabel   string    heading above the list          "3 ideas"
 *   mapEnabled   boolean   reveal the List/Map viewseg     false
 *
 *   ideas        Array<{   array of idea card objects (defaults = HEAD's 3 cards)
 *     thumb      string    img src, or null for icon fallback
 *     thumbAlt   string    alt text for thumb image         ""
 *     title      string    card heading
 *     href       string    link target                      "#"
 *     initials   string    avatar initials (2 chars)
 *     author     string    author display name
 *     time       string    relative time string
 *     excerpt    string    short description paragraph
 *     likes      number    like count
 *     dislikes   number    dislike count
 *     comments   number    comment count
 *     status     string    status label text
 *     statusMod  string    BEM modifier class for status    "" (accepted/green)
 *                          e.g. "is-implemented" | "is-considered" | "is-rejected"
 *   }>
 *
 *   sidebar      object    filter sidebar content (defaults = HEAD's sidebar)
 *     sortActive string    id of active sort option         "most-liked"
 *     statusFilters Array<{ label, count, active }>
 *     topicFilters  Array<{ label, count }>
 *
 *   filtersId    string    id on the aside (for aria-controls) "e2e-project-sidebar"
 */

GV.register("idea-feed", function (props) {
  props = props || {};
  var esc = GV.esc;

  /* ── defaults ─────────────────────────────────────────────────────────── */
  var countLabel = props.countLabel != null ? props.countLabel : "3 ideas";
  var mapEnabled = props.mapEnabled != null ? props.mapEnabled : false;
  var filtersId  = props.filtersId  != null ? props.filtersId  : "e2e-project-sidebar";

  var defaultIdeas = [
    {
      thumb:     "https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=320&h=320&fit=crop",
      thumbAlt:  "",
      title:     "Cycle route network",
      href:      "#",
      initials:  "EW",
      author:    "Eddy Walker",
      time:      "2 years ago",
      excerpt:   "Connect the park to the existing bike lanes with a safe, separated cycle route so families can ride here without using busy roads.",
      likes:     47,
      dislikes:  3,
      comments:  3,
      status:    "Accepted",
      statusMod: ""
    },
    {
      thumb:     "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=320&h=320&fit=crop",
      thumbAlt:  "",
      title:     "Save the trees on Washington Boulevard",
      href:      "#",
      initials:  "GC",
      author:    "Gerry Camillery",
      time:      "3 years ago",
      excerpt:   "The trees are set to be cut down to widen the road. We propose an alternative plan that keeps the green canopy intact.",
      likes:     88,
      dislikes:  5,
      comments:  2,
      status:    "Implemented",
      statusMod: "is-implemented"
    },
    {
      thumb:     null,
      thumbAlt:  "",
      title:     "More benches along the riverfront",
      href:      "#",
      initials:  "MR",
      author:    "Maria Rossi",
      time:      "5 months ago",
      excerpt:   "Add a row of benches between the bridge and the boathouse so older residents can rest on their walk.",
      likes:     19,
      dislikes:  0,
      comments:  1,
      status:    "Under consideration",
      statusMod: "is-considered"
    }
  ];

  var defaultSidebar = {
    sortActive: "most-liked",
    statusFilters: [
      { label: "All",                 count: 44, active: true  },
      { label: "Under consideration", count: 2,  active: false },
      { label: "Accepted",            count: 1,  active: false }
    ],
    topicFilters: [
      { label: "Recreation",           count: 8  },
      { label: "Nature & environment", count: 12 },
      { label: "Mobility",             count: 6  }
    ]
  };

  var ideas   = props.ideas   != null ? props.ideas   : defaultIdeas;
  var sidebar = props.sidebar != null ? props.sidebar : defaultSidebar;

  /* ── sort options (fixed list matching HEAD) ───────────────────────────── */
  var sortActive = (sidebar.sortActive != null) ? sidebar.sortActive : "most-liked";
  var sortOptions = [
    { id: "most-liked",    icon: "idea",       label: "Most liked"    },
    { id: "most-discussed",icon: "comments",   label: "Most discussed"},
    { id: "trending",      icon: "trend-up",   label: "Trending"      },
    { id: "random",        icon: "refresh",    label: "Random"        },
    { id: "new",           icon: "clock",      label: "New"           },
    { id: "old",           icon: "clock-solid",label: "Old"           }
  ];

  /* ── helpers ───────────────────────────────────────────────────────────── */
  function renderThumb(idea) {
    if (idea.thumb) {
      return '<div class="gv-ideacard__thumb"><img src="' + esc(idea.thumb) + '" alt="' + esc(idea.thumbAlt || "") + '" loading="lazy" /></div>';
    }
    return '<div class="gv-ideacard__thumb"><span data-gv-icon="vote-up" aria-hidden="true"></span></div>';
  }

  function renderCard(idea) {
    var statusCls = "gv-ideacard__status e2e-status" + (idea.statusMod ? " " + esc(idea.statusMod) : "");
    return (
      '<article class="gv-ideacard e2e-idea-card">' +
        renderThumb(idea) +
        '<div class="gv-ideacard__body">' +
          '<h3 class="gv-ideacard__title e2e-idea-card-title"><a href="' + esc(idea.href || "#") + '">' + esc(idea.title) + '</a></h3>' +
          '<div class="gv-ideacard__head">' +
            '<span class="gv-ideacard__avatar" aria-hidden="true">' + esc(idea.initials) + '</span>' +
            '<div>' +
              '<div class="gv-ideacard__meta">' +
                '<span class="gv-ideacard__author e2e-username">' + esc(idea.author) + '</span>' +
                '<span class="gv-ideacard__sep" aria-hidden="true">&bull;</span>' +
                '<span class="gv-ideacard__time">' + esc(idea.time) + '</span>' +
              '</div>' +
              '<p class="gv-ideacard__excerpt">' + esc(idea.excerpt) + '</p>' +
            '</div>' +
          '</div>' +
          '<footer class="gv-ideacard__foot">' +
            '<div class="gv-react gv-react--labeled e2e-reaction-controls">' +
              '<button class="gv-react__btn e2e-ideacard-like-button" aria-label="Like"><span data-gv-icon="vote-up"></span><span class="gv-react__label">Like</span><span class="gv-react__count">' + esc(String(idea.likes != null ? idea.likes : 0)) + '</span></button>' +
              '<button class="gv-react__btn" aria-label="Dislike"><span data-gv-icon="vote-down"></span><span class="gv-react__label">Dislike</span><span class="gv-react__count">' + esc(String(idea.dislikes != null ? idea.dislikes : 0)) + '</span></button>' +
            '</div>' +
            '<span class="gv-react__comment e2e-ideacard-comment-count"><span data-gv-icon="comments"></span>' + esc(String(idea.comments != null ? idea.comments : 0)) + '</span>' +
            '<span class="' + statusCls + '">' + esc(idea.status) + '</span>' +
          '</footer>' +
        '</div>' +
      '</article>'
    );
  }

  function renderSort(opts, active) {
    return opts.map(function (o) {
      var isA = o.id === active;
      return '<button class="gv-feedfilter__btn' + (isA ? " is-active" : "") + '" type="button">' +
        '<span class="gv-feedfilter__icon" data-gv-icon="' + esc(o.icon) + '" aria-hidden="true"></span>' +
        esc(o.label) +
        '</button>';
    }).join("");
  }

  function renderStatusFilters(filters) {
    if (!filters || !filters.length) return "";
    return filters.map(function (f) {
      return '<button class="gv-feedfilter__btn' + (f.active ? " is-active" : "") + '" type="button">' +
        esc(f.label) +
        (f.count != null ? ' <span class="gv-feedfilter__count">' + esc(String(f.count)) + '</span>' : "") +
        '</button>';
    }).join("");
  }

  function renderTopicFilters(filters) {
    if (!filters || !filters.length) return "";
    return filters.map(function (f) {
      return '<button class="gv-feedfilter__btn" type="button">' +
        esc(f.label) +
        (f.count != null ? ' <span class="gv-feedfilter__count">' + esc(String(f.count)) + '</span>' : "") +
        '</button>';
    }).join("");
  }

  /* ── viewseg (optional map toggle) ────────────────────────────────────── */
  var viewseg = (
    '<div class="gv-viewseg" role="tablist" aria-label="View ideas as">' +
      '<button class="gv-viewseg__tab" role="tab" aria-selected="true"><span data-gv-icon="menu" aria-hidden="true"></span>List</button>' +
      '<button class="gv-viewseg__tab" role="tab" aria-selected="false"><span data-gv-icon="map" aria-hidden="true"></span>Map</button>' +
    '</div>'
  );

  /* ── assemble ──────────────────────────────────────────────────────────── */
  var feedHeadAttr = mapEnabled ? ' data-map-enabled' : '';

  var html =
    '<div class="feed-head"' + feedHeadAttr + '>' +
      '<h2 class="gv-feed__count">' + esc(countLabel) + '</h2>' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<button class="gv-filters-btn" type="button" aria-expanded="false" aria-controls="' + esc(filtersId) + '">' +
          '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16M7 12h10M10 19h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
          'Filters' +
        '</button>' +
        viewseg +
      '</div>' +
    '</div>' +
    '<div class="gv-feed">' +
      '<div class="gv-feed__col">' +
        '<div class="gv-idealist">' +
          ideas.map(renderCard).join("") +
        '</div>' +
      '</div>' +
      '<aside class="gv-feedfilter" id="' + esc(filtersId) + '" aria-label="Filter ideas">' +
        '<div>' +
          '<p class="gv-feedfilter__label">Search posts</p>' +
          '<input class="gv-input" type="search" placeholder="Search" aria-label="Search posts" />' +
        '</div>' +
        '<div>' +
          '<p class="gv-feedfilter__label">SORT BY</p>' +
          '<div class="gv-feedfilter__group gv-feedfilter__group--sort">' +
            renderSort(sortOptions, sortActive) +
          '</div>' +
        '</div>' +
        (sidebar.statusFilters && sidebar.statusFilters.length ? (
          '<div>' +
            '<p class="gv-feedfilter__label">STATUS</p>' +
            '<div class="gv-feedfilter__group">' +
              renderStatusFilters(sidebar.statusFilters) +
            '</div>' +
          '</div>'
        ) : '') +
        (sidebar.topicFilters && sidebar.topicFilters.length ? (
          '<div>' +
            '<p class="gv-feedfilter__label">TOPICS</p>' +
            '<div class="gv-feedfilter__group">' +
              renderTopicFilters(sidebar.topicFilters) +
            '</div>' +
          '</div>'
        ) : '') +
      '</aside>' +
    '</div>';

  return html;
});

/* ── input ─────────────────────────────────────────────────────────── */
/* input.js — canonical instance renderer for the input field group component.
 *
 * Covers the .field wrapper (label + control + optional error message) for all
 * three control types found in the HEAD demo: text/email inputs, textareas,
 * and selects. One source of truth — edit here and every linked demo updates.
 *
 * Props (all optional — defaults reproduce the primary instance):
 *
 *   type        : "input" | "textarea" | "select"  (default "input")
 *                 Controls which element is rendered. "input" covers all
 *                 <input> variants (text, email, password, …).
 *   inputType   : string   HTML type attr for <input>       (default "email")
 *   label       : string   <label> text                     (default "Email")
 *   id          : string   id attr (wires label for=)       (default "gv-input-1")
 *   placeholder : string   placeholder attr                 (default "you@example.com")
 *   value       : string   value attr / textarea content    (default "")
 *   disabled    : boolean  disabled attr                    (default false)
 *   error       : string   error message (also adds .error + aria-invalid)
 *                          (default "" — no error state)
 *   options     : array    for type "select": [{value, label, selected, disabled, hidden, cls}]
 *                          (default = the Sort-by set from HEAD)
 *   ariaLabel   : string   aria-label attr (select only, when label duplicates)
 *                          (default matches label)
 *
 * GV.render("input") → primary instance: email input, label "Email", placeholder "you@example.com"
 */
GV.register("input", function (props) {
  props = props || {};
  var esc = GV.esc;

  var type        = props.type        !== undefined ? props.type        : "input";
  var inputType   = props.inputType   !== undefined ? props.inputType   : "email";
  var label       = props.label       !== undefined ? props.label       : "Email";
  var id          = props.id          !== undefined ? props.id          : "gv-input-1";
  var placeholder = props.placeholder !== undefined ? props.placeholder : "you@example.com";
  var value       = props.value       !== undefined ? props.value       : "";
  var disabled    = props.disabled    ? true : false;
  var error       = props.error       !== undefined ? props.error       : "";
  var ariaLabel   = props.ariaLabel   !== undefined ? props.ariaLabel   : label;

  /* Default options for select — byte-faithful to HEAD's Sort-by field */
  var defaultOptions = [
    { value: "", label: "Choose…", cls: "placeholder", selected: true, disabled: true, hidden: true },
    { label: "Most recent" },
    { label: "Most discussed" },
    { label: "Trending" }
  ];
  var options = props.options !== undefined ? props.options : defaultOptions;

  /* ── label ── */
  var html = '<label class="gv-label" for="' + esc(id) + '">' + esc(label) + '</label>';

  /* ── control ── */
  if (type === "textarea") {
    var placeholderAttr = placeholder ? ' placeholder="' + esc(placeholder) + '"' : "";
    var disabledAttr    = disabled ? " disabled" : "";
    html += '<textarea class="gv-textarea" id="' + esc(id) + '"' +
            placeholderAttr + disabledAttr + ">" +
            (value ? esc(value) : "") + "</textarea>";

  } else if (type === "select") {
    var disabledAttr = disabled ? " disabled" : "";
    var ariaAttr     = ariaLabel ? ' aria-label="' + esc(ariaLabel) + '"' : "";
    var optionsHtml  = options.map(function (opt) {
      var cls      = opt.cls      ? ' class="' + esc(opt.cls) + '"' : "";
      var val      = opt.value    !== undefined ? ' value="' + esc(opt.value) + '"' : "";
      var sel      = opt.selected ? " selected" : "";
      var dis      = opt.disabled ? " disabled" : "";
      var hid      = opt.hidden   ? " hidden"   : "";
      return "<option" + cls + val + sel + dis + hid + ">" + esc(opt.label || "") + "</option>";
    }).join("");
    /* HEAD attribute order: id, [disabled], aria-label
     * The non-disabled select has aria-label first; the disabled one has disabled first.
     * Mirror exactly: when disabled, disabled precedes aria-label. */
    var selectAttrs = disabled ? disabledAttr + ariaAttr : ariaAttr + disabledAttr;
    html += '<div class="gv-select"><select id="' + esc(id) + '"' + selectAttrs + ">" +
            optionsHtml + "</select></div>";

  } else {
    /* input (default)
     * Attribute order matches HEAD exactly:
     *   class, id, type, placeholder, [disabled], value, [aria-invalid]
     * The disabled input in HEAD has `disabled` before `value`; the error input
     * has `value` then `aria-invalid` (no disabled). Mirror that ordering. */
    var typeAttr        = inputType ? ' type="' + esc(inputType) + '"' : "";
    var placeholderAttr = placeholder ? ' placeholder="' + esc(placeholder) + '"' : "";
    var valueAttr       = value ? ' value="' + esc(value) + '"' : "";
    var disabledAttr    = disabled ? " disabled" : "";
    var errorCls        = error ? " error" : "";
    var ariaInvalid     = error ? ' aria-invalid="true"' : "";
    /* disabled precedes value (HEAD order); aria-invalid trails value */
    html += '<input class="gv-input' + errorCls + '" id="' + esc(id) + '"' +
            typeAttr + placeholderAttr + disabledAttr + valueAttr + ariaInvalid + " />";
  }

  /* ── error message ── */
  if (error) {
    html += '<p class="gv-error-text">⚠ ' + esc(error) + "</p>";
  }

  return '<div class="field">' + html + "</div>";
});

/* ── issue-canvas ─────────────────────────────────────────────────────────── */
/* issue-canvas.js — canonical instance renderer for .gv-issuecanvas.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("issue-canvas", props) → canonical HTML string.
 *
 * The dotted-grid Perspectives canvas: floats pastel sticky-note ideas in a
 * masonry pile (default) or centres one raised note (detail), with a floating
 * "Add an idea" CTA pinned bottom-right.
 *
 * Props (all optional — defaults reproduce the PRIMARY pile instance exactly):
 *
 *   id        {string}   id on the root .gv-issuecanvas. default: "issueCanvas"
 *   detail    {boolean}  true → .is-detail layout (one raised note, no __pile).
 *                        default: false (the masonry pile)
 *   addLabel  {string}   floating CTA button label. default: "Add an idea"
 *
 *   notes     Array<{    sticky notes (defaults = HEAD's 4 pile notes / 1 detail note)
 *     colour   string    pastel modifier: "lavender"|"mint"|"pink"|"grey"
 *     raised   boolean   adds .is-raised (the elevated detail card). default false
 *     style    string    inline style on the note button, e.g. "height: 290px"
 *     author   string    author display name. default "Anonymous"
 *     emoji    string    corner emoji chip. default "🌱"
 *     title    string    card heading
 *     excerpt  string    body copy under the title
 *     likes    number    up-vote count
 *     dislikes number    down-vote count. default 0
 *   }>
 *
 * GV.render("issue-canvas")                → primary pile (4 notes + CTA)
 * GV.render("issue-canvas", { detail: true }) → detail (1 raised lavender note)
 */
GV.register("issue-canvas", function (props) {
  props = props || {};
  var esc = GV.esc;

  var detail   = props.detail   !== undefined ? props.detail   : false;
  var id       = props.id       !== undefined ? props.id       : "issueCanvas";
  var addLabel = props.addLabel !== undefined ? props.addLabel : "Add an idea";

  var PILE_NOTES = [
    { colour: "lavender", style: "height: 290px", author: "Anonymous",          emoji: "🌱", title: "Reproductive Healthcare Access", excerpt: "We should solve women's reproductive rights. I work in women's health and have friends who've needed services and medical care that is banned.", likes: 13, dislikes: 0 },
    { colour: "mint",     style: "height: 310px", author: "Jonathan Kongstad",   emoji: "🚧", title: "Roads & transit can't keep up",   excerpt: "Infrastructure has not kept pace with overall population growth. Congestion is getting worse every year and public transit barely reaches the new neighbourhoods on the edge of town.", likes: 17, dislikes: 0 },
    { colour: "pink",     style: "height: 300px", author: "Bill Berman",         emoji: "📚", title: "Black history and its erasure",    excerpt: "I take issue with how local history is taught — important parts of our community's story are being left out of the curriculum. We owe the next generation an honest, complete account.", likes: 18, dislikes: 0 },
    { colour: "grey",     style: "height: 280px", author: "Lise Dawson",         emoji: "🗳️", title: "Getting voters to the polls",      excerpt: "Since people are able to vote by mail now, turnout should be higher than it is. We need to make registration easier and remind residents that local elections are the ones that affect them most.", likes: 17, dislikes: 0 }
  ];

  var DETAIL_NOTES = [
    { colour: "lavender", raised: true, style: "min-height: 400px", author: "Anonymous", emoji: "🌱", title: "Reproductive Healthcare Access", excerpt: "We should solve women's reproductive rights. I work in women's health and have friends who've needed services & medical care that is banned. People in our region deserve safe, legal access close to home — not a long, expensive trip to another state when they're already in a difficult situation.", likes: 13, dislikes: 0 }
  ];

  var notes = props.notes !== undefined ? props.notes : (detail ? DETAIL_NOTES : PILE_NOTES);

  function sticky(n) {
    n = n || {};
    var raised = n.raised !== undefined ? n.raised : false;
    var cls = "gv-sticky" + (raised ? " is-raised" : "") + (n.colour ? " " + esc(n.colour) : "");
    var styleAttr = n.style ? ' style="' + esc(n.style) + '"' : "";
    var author   = n.author   !== undefined ? n.author   : "Anonymous";
    var emoji    = n.emoji    !== undefined ? n.emoji    : "🌱";
    var likes    = n.likes    !== undefined ? n.likes    : 0;
    var dislikes = n.dislikes !== undefined ? n.dislikes : 0;
    return (
      '<button type="button" class="' + cls + '" data-cy="e2e-sticky-note"' + styleAttr + '>' +
        '<span class="gv-sticky__author">' +
          '<span class="av"></span>' +
          '<span class="gv-sticky__authorname">' + esc(author) + '</span>' +
          '<span class="gv-sticky__emoji" aria-hidden="true">' + emoji + '</span>' +
        '</span>' +
        '<span class="gv-sticky__title">' + esc(n.title) + '</span>' +
        '<span class="gv-sticky__excerpt">' + esc(n.excerpt) + '</span>' +
        '<span class="gv-sticky__react e2e-reaction-controls neutral">' +
          '<button type="button" class="gv-sticky__reactbtn e2e-ideacard-dislike-button"><span data-gv-icon="vote-down" aria-hidden="true"></span><span class="gv-sr-only">Dislike</span><b>' + esc(dislikes) + '</b></button>' +
          '<button type="button" class="gv-sticky__reactbtn e2e-ideacard-like-button"><span data-gv-icon="vote-up" aria-hidden="true"></span><span class="gv-sr-only">Like</span><b>' + esc(likes) + '</b></button>' +
        '</span>' +
      '</button>'
    );
  }

  var cta =
    '<div class="gv-issuecanvas__add">' +
      '<button type="button" class="gv-btn primary"><span data-gv-icon="plus" aria-hidden="true"></span> ' + esc(addLabel) + '</button>' +
    '</div>';

  var rootCls = "gv-issuecanvas" + (detail ? " is-detail" : "");
  var idAttr = id ? ' id="' + esc(id) + '"' : "";

  var view;
  if (detail) {
    view = '<div class="gv-issuecanvas__view">' + notes.map(sticky).join("") + '</div>';
  } else {
    view =
      '<div class="gv-issuecanvas__view">' +
        '<div class="gv-issuecanvas__pile">' + notes.map(sticky).join("") + '</div>' +
      '</div>';
  }

  return '<div class="' + rootCls + '"' + idAttr + '>' + view + cta + '</div>';
});

/* ── login-modal ─────────────────────────────────────────────────────────── */
/* login-modal.js — canonical instance renderer for the login / auth modal.
 * Registered onto window.GV via GV.register("login-modal", fn).
 * GV.render("login-modal", {}) → primary instance: open overlay, "Before you participate"
 * heading, email input + Continue, Or divider, Continue with Google.
 *
 * This component combines the .gv-modal-overlay shell with the GoVocal "Before you
 * participate" authentication body: email-first with a primary Continue button, a
 * .gv-or divider, and a white full-width Google button. Mirrors the live
 * #modal-portal / .modalcontent + authentication flow.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance exactly):
 *
 *   id          : string   id="" on the overlay element          (default "auth-overlay")
 *   titleId     : string   id="" on the <h1> title               (default "auth-modal-heading")
 *   title       : string   modal heading text                     (default "Before you participate")
 *   intro       : string   paragraph above the form               (default "Enter your email address to continue.")
 *   emailLabel  : string   <label> text for email field           (default "Email")
 *   emailId     : string   id/name for the email <input>          (default "email")
 *   placeholder : string   placeholder on the email input         (default "you@example.com")
 *   submitLabel : string   text on the primary submit button      (default "Continue")
 *   orLabel     : string   text inside the .gv-or divider        (default "Or")
 *   googleLabel : string   text on the Google button              (default "Continue with Google")
 *   open        : boolean  adds "is-open" class on the overlay   (default true)
 *
 * MARKUP ONLY — no open/close behaviour. The demo wires that in its own <script>.
 */
GV.register("login-modal", function (props) {
  props = props || {};
  var esc = GV.esc;

  var id          = props.id          !== undefined ? props.id          : "auth-overlay";
  var titleId     = props.titleId     !== undefined ? props.titleId     : "auth-modal-heading";
  var title       = props.title       !== undefined ? props.title       : "Before you participate";
  var intro       = props.intro       !== undefined ? props.intro       : "Enter your email address to continue.";
  var emailLabel  = props.emailLabel  !== undefined ? props.emailLabel  : "Email";
  var emailId     = props.emailId     !== undefined ? props.emailId     : "email";
  var placeholder = props.placeholder !== undefined ? props.placeholder : "you@example.com";
  var submitLabel = props.submitLabel !== undefined ? props.submitLabel : "Continue";
  var orLabel     = props.orLabel     !== undefined ? props.orLabel     : "Or";
  var googleLabel = props.googleLabel !== undefined ? props.googleLabel : "Continue with Google";
  var open        = props.open        !== undefined ? props.open        : true;

  var overlayClass = "gv-modal-overlay" + (open ? " is-open" : "");

  /* ── Google G SVG (inline, byte-faithful to HEAD) ── */
  var googleSvg =
    '<svg viewBox="0 0 533.5 544.3" width="20" height="20" aria-hidden="true" style="flex:0 0 auto;">' +
      '<path fill="#4285f4" d="M533.5 278.4c0-18.5-1.5-37.1-4.7-55.3H272.1v104.8h147c-6.1 33.8-25.7 63.7-54.4 82.7v68h87.7c51.5-47.4 81.1-117.4 81.1-200.2z"></path>' +
      '<path fill="#34a853" d="M272.1 544.3c73.4 0 135.3-24.1 180.4-65.7l-87.7-68c-24.4 16.6-55.9 26-92.6 26-71 0-131.2-47.9-152.8-112.3H28.9v70.1c46.2 91.9 140.3 149.9 243.2 149.9z"></path>' +
      '<path fill="#fbbc04" d="M119.3 324.3c-11.4-33.8-11.4-70.4 0-104.2V150H28.9c-38.6 76.9-38.6 167.5 0 244.4l90.4-70.1z"></path>' +
      '<path fill="#ea4335" d="M272.1 107.7c38.8-.6 76.3 14 104.4 40.8l77.7-77.7C405 24.6 339.7-.8 272.1 0 169.2 0 75.1 58 28.9 150l90.4 70.1c21.5-64.5 81.8-112.4 152.8-112.4z"></path>' +
    '</svg>';

  /* ── close button (inline SVG, byte-faithful to HEAD) ── */
  var closeBtn =
    '<button class="gv-modal__close round" type="button" aria-label="Close window" data-close-modal>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L13.41,12L19,6.41Z"></path>' +
      '</svg>' +
    '</button>';

  /* ── modal body ── */
  var body =
    '<span class="gv-sr-only">Authentication</span>' +
    '<p class="auth-intro">' + esc(intro) + '</p>' +
    '<form novalidate>' +
      '<div style="margin-bottom: 18px;">' +
        '<label class="gv-label" for="' + esc(emailId) + '">' + esc(emailLabel) + '</label>' +
        '<input class="gv-input" id="' + esc(emailId) + '" name="' + esc(emailId) + '" type="email"' +
               ' autocomplete="email" required placeholder="' + esc(placeholder) + '" aria-invalid="false" />' +
      '</div>' +
      '<button class="gv-btn primary" type="submit">' +
        '<span class="gv-btn__label">' + esc(submitLabel) + '</span>' +
      '</button>' +
    '</form>' +
    '<div class="gv-or" aria-hidden="true"><span>' + esc(orLabel) + '</span></div>' +
    '<button class="gv-btn white full" type="button">' +
      googleSvg +
      '<span class="gv-btn__label">' + esc(googleLabel) + '</span>' +
    '</button>';

  return (
    '<div class="' + overlayClass + '" id="' + esc(id) + '" data-modal-overlay>' +
      '<div class="gv-modal size-s" role="dialog" aria-modal="true" aria-labelledby="' + esc(titleId) + '">' +
        '<div class="gv-modal__header">' +
          '<h1 class="gv-modal__title" id="' + esc(titleId) + '">' + esc(title) + '</h1>' +
        '</div>' +
        closeBtn +
        '<div class="gv-modal__body">' + body + '</div>' +
      '</div>' +
    '</div>'
  );
});

/* ── modal ─────────────────────────────────────────────────────────── */
/* modal.js — canonical instance renderer for the modal / overlay component.
 * Registered onto window.GV via GV.register("modal", fn).
 * GV.render("modal", {}) → primary instance: bare .gv-modal (static preview card).
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   variant    : "static" | "overlay"   (default "static")
 *     "static"  → bare .gv-modal card (no overlay scrim, no role/aria attrs).
 *                 Used for in-page static previews.
 *     "overlay" → .gv-modal-overlay wrapping .gv-modal[role="dialog"][aria-modal].
 *                 The live interactive layer opened/closed by JS.
 *
 *   id         : string   id="" on the overlay element (default "g-overlay")
 *                          — used by JS to find the overlay; "overlay" variant only.
 *   titleId    : string   id="" on the <h*> title (default "g-modal-title" for static,
 *                          "g-ov-title" for overlay). Paired with aria-labelledby.
 *   titleTag   : string   heading element for the modal title ("h3" default for static,
 *                          "h2" default for overlay).
 *   title      : string   modal heading text     (default "Dialog title")
 *
 *   body       : string   raw HTML string for .gv-modal__body content.
 *                          Defaults reproduce HEAD exactly per variant.
 *
 *   actions    : Array    action buttons rendered inside .gv-modal__body after body HTML.
 *                          Each item: { label, variant, dataClose }
 *                          Only used when body is not overridden explicitly.
 *                          (The overlay default includes one "Got it" primary button.)
 *
 * MARKUP ONLY — no open/close behaviour. The demo wires that in its own <script>.
 */
GV.register("modal", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant  = props.variant  !== undefined ? props.variant  : "static";
  var isOverlay = variant === "overlay";

  /* ── defaults differ by variant ── */
  var defaultTitle   = "Dialog title";
  var defaultTitleId = isOverlay ? "g-ov-title" : "g-modal-title";
  var defaultTitleTag = isOverlay ? "h2" : "h3";

  var title    = props.title    !== undefined ? props.title    : defaultTitle;
  var titleId  = props.titleId  !== undefined ? props.titleId  : defaultTitleId;
  var titleTag = props.titleTag !== undefined ? props.titleTag : defaultTitleTag;

  /* ── body HTML defaults (byte-faithful to HEAD per variant) ── */
  var defaultBody;
  if (isOverlay) {
    defaultBody =
      '<p class="gv-text bodyM" style="margin:0 0 18px">Press Esc or click the scrim to close.</p>' +
      '<button class="gv-btn primary" type="button" data-close-modal>Got it</button>';
  } else {
    defaultBody =
      '<p class="gv-text bodyM" style="margin:0 0 14px">Body content goes here.</p>' +
      '<div class="gv-or"><span>Or</span></div>' +
      '<p class="gv-text bodyS gv-text--secondary" style="margin:14px 0 0">The <code>.gv-or</code> labelled divider splits choices.</p>';
  }
  var body = props.body !== undefined ? props.body : defaultBody;

  /* ── close button ── */
  var closeDataAttr = isOverlay ? " data-close-modal" : "";
  var closeBtn =
    '<button class="gv-modal__close" type="button" aria-label="Close window"' + closeDataAttr + '>' +
      '<span data-gv-icon="close"></span>' +
    '</button>';

  /* ── .gv-modal card ── */
  var dialogAttrs = "";
  if (isOverlay) {
    dialogAttrs =
      ' role="dialog" aria-modal="true" aria-labelledby="' + esc(titleId) + '"';
  }

  var modalCard =
    '<div class="gv-modal"' + dialogAttrs + '>' +
      '<div class="gv-modal__header">' +
        '<' + esc(titleTag) + ' class="gv-modal__title" id="' + esc(titleId) + '">' +
          esc(title) +
        '</' + esc(titleTag) + '>' +
      '</div>' +
      closeBtn +
      '<div class="gv-modal__body">' + body + '</div>' +
    '</div>';

  /* ── overlay variant: wrap in .gv-modal-overlay ── */
  if (isOverlay) {
    var overlayId = props.id !== undefined ? props.id : "g-overlay";
    return '<div class="gv-modal-overlay" id="' + esc(overlayId) + '">' + modalCard + '</div>';
  }

  /* ── static variant: bare .gv-modal ── */
  return modalCard;
});

/* ── participation-bar ─────────────────────────────────────────────────────────── */
/* participation-bar.js — canonical instance renderer for the participation bar.
 *
 * The sticky project-page action bar: a participation status on the left and a
 * primary on-color CTA (anchor) on the right. Pairs with govocal-partbar.js for
 * sticky / docking behaviour and the .gv-partbar CSS in govocal-ui.css.
 *
 * Props (with defaults matching the primary HEAD instance):
 *   status   : string   left-hand status text           (default "Open for participation")
 *   ctaLabel : string   CTA button label text           (default "Submit your idea")
 *   ctaHref  : string   CTA href                        (default "#ideas")
 *   ctaIcon  : string   glyph name appended to CTA      (default "arrow-right")
 *
 * GV.render("participation-bar", {}) → byte-faithful to the HEAD primary instance:
 *   <div class="gv-partbar">
 *     <div class="gv-partbar__inner">
 *       <span class="gv-partbar__status">Open for participation</span>
 *       <a class="gv-btn on-color" href="#ideas">Submit your idea <span data-gv-icon="arrow-right" aria-hidden="true"></span></a>
 *     </div>
 *   </div>
 */
GV.register("participation-bar", function (props) {
  props = props || {};
  var esc = GV.esc;

  var status   = props.status   !== undefined ? props.status   : "Open for participation";
  var ctaLabel = props.ctaLabel !== undefined ? props.ctaLabel : "Submit your idea";
  var ctaHref  = props.ctaHref  !== undefined ? props.ctaHref  : "#ideas";
  var ctaIcon  = props.ctaIcon  !== undefined ? props.ctaIcon  : "arrow-right";

  var iconSpan = ctaIcon
    ? ' <span data-gv-icon="' + esc(ctaIcon) + '" aria-hidden="true"></span>'
    : "";

  return (
    '<div class="gv-partbar">' +
      '<div class="gv-partbar__inner">' +
        '<span class="gv-partbar__status">' + esc(status) + '</span>' +
        '<a class="gv-btn on-color" href="' + esc(ctaHref) + '">' + esc(ctaLabel) + iconSpan + '</a>' +
      '</div>' +
    '</div>'
  );
});

/* ── participation-box ─────────────────────────────────────────────────────────── */
/* participation-box.js — canonical instance renderer for the Participation Box.
 *
 * The resident-facing project CTA block (.gv-pbox): a stack of full-width method
 * buttons (.gv-pbox__actions) above an always-bottom participant row
 * (.gv-participants.gv-pbox__people). When the project has no active methods it
 * collapses to a single .gv-pbox__empty notice. Styling flows in from the linked
 * canonical CSS (.gv-pbox / .gv-btn / .gv-participants in govocal-ui.css).
 *
 * Mirrored in the back-office Content Builder ("Participation Box" widget) and on
 * the project page. This renderer faithfully lifts the DEMO's hand-authored .gv-*
 * markup — it does NOT rewire to GVWidgets.
 *
 * Props (defaults = the PRIMARY HEAD instance "One method + extra"):
 *   actions  {array|null}  — method buttons, top to bottom. Each item:
 *                              { label, variant, href }
 *                                label   button text
 *                                variant .gv-btn modifier(s) (default "primary")
 *                                href    anchor href (default "#")
 *                            All buttons get the `full` modifier (full-width stack).
 *                            default: [
 *                              { label:"View 82 proposals",            variant:"primary" },
 *                              { label:"Ask the budget team anything",  variant:"secondary-outlined" },
 *                            ]
 *   nobtns   {boolean}      — hide the action stack (.gv-pbox--nobtns). default: false
 *   people   {object|null}  — participant row; null/false hides it. Fields:
 *                              { avatars, count, info, infoTitle }
 *                                avatars   number of blank .av bubbles (default 3)
 *                                count     .gv-pcount text          (default "+19 participants")
 *                                info      show the .gv-pinfo icon   (default true)
 *                                infoTitle .gv-pinfo title attr
 *                                          (default "Real-time participant count.")
 *                            default: { } → 3 avatars, "+19 participants", info on
 *   nopeople {boolean}      — hide the participant row (.gv-pbox--nopeople). default: false
 *   empty    {string}       — when set (non-empty), render ONLY the .gv-pbox__empty
 *                             notice with this text and ignore actions/people.
 *                             default: "" (not empty)
 *
 * Variants:
 *   {}                                          → primary (1 method + extra, people+info)
 *   { actions:[{label:"Participate · 3 ways",variant:"primary"}],
 *     people:{ info:false } }                   → three+ methods collapsed
 *   { empty:"No active methods" }               → no active methods
 */
GV.register("participation-box", function (props) {
  props = props || {};
  var esc = GV.esc;

  var empty = props.empty !== undefined ? props.empty : "";
  if (empty) {
    return (
      '<div class="gv-pbox">' +
        '<div class="gv-pbox__empty">' + esc(empty) + '</div>' +
      '</div>'
    );
  }

  var nobtns   = props.nobtns   !== undefined ? props.nobtns   : false;
  var nopeople = props.nopeople !== undefined ? props.nopeople : false;

  var actions = props.actions !== undefined ? props.actions : [
    { label: "View 82 proposals",           variant: "primary" },
    { label: "Ask the budget team anything", variant: "secondary-outlined" },
  ];

  var people = props.people !== undefined ? props.people : {};

  var cls = "gv-pbox" +
    (nobtns ? " gv-pbox--nobtns" : "") +
    (nopeople ? " gv-pbox--nopeople" : "");

  var html = '<div class="' + cls + '">';

  if (!nobtns && actions && actions.length) {
    var btns = actions.map(function (a) {
      var variant = a.variant !== undefined ? a.variant : "primary";
      var href = a.href !== undefined ? a.href : "#";
      return '<a class="gv-btn ' + esc(variant) + ' full" href="' + esc(href) + '">' +
        esc(a.label) + '</a>';
    }).join("");
    html += '<div class="gv-pbox__actions">' + btns + '</div>';
  }

  if (!nopeople && people) {
    var avatars   = people.avatars   !== undefined ? people.avatars   : 3;
    var count     = people.count     !== undefined ? people.count     : "+19 participants";
    var info      = people.info      !== undefined ? people.info      : true;
    var infoTitle = people.infoTitle !== undefined ? people.infoTitle : "Real-time participant count.";

    var avSpans = "";
    for (var i = 0; i < avatars; i++) { avSpans += '<span class="av"></span>'; }

    html += '<div class="gv-participants gv-pbox__people">' +
      '<span class="gv-avatars on-light" aria-hidden="true">' + avSpans + '</span>' +
      '<span class="gv-pcount">' + esc(count) + '</span>' +
      (info ? '<span class="gv-icon gv-pinfo" data-gv-icon="info-solid" aria-hidden="true" title="' + esc(infoTitle) + '"></span>' : "") +
    '</div>';
  }

  html += '</div>';
  return html;
});

/* ── phase-timeline ─────────────────────────────────────────────────────────── */
/* phase-timeline.js — canonical instance renderer for .gv-phases.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("phase-timeline", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance exactly):
 *
 *   title      string   heading in the bar              "Phases"
 *   titleId    string   id on the <h2>                  "phT"
 *   stepperId  string   id on the stepper div           "stepper"
 *   panelId    string   id on the panel div             "panel"
 *
 *   phases     Array    ordered phase objects:
 *                        { label, date, desc }
 *                       defaults = the 10 HEAD phases verbatim.
 *
 *   current    number   0-based index of the live/active phase  9
 *                       Controls which step carries .current and
 *                       .gv-pstep__dot; also sets aria-selected.
 *
 *   viewing    number   0-based index of the phase whose info is
 *                       shown in the panel on first render.       9
 *                       (equals `current` by default, matching HEAD)
 *
 * GV.render("phase-timeline") → primary: 10 phases, current = viewing = 9
 */
GV.register("phase-timeline", function (props) {
  props = props || {};
  var esc = GV.esc;

  var title     = props.title     != null ? props.title     : "Phases";
  var titleId   = props.titleId   != null ? props.titleId   : "phT";
  var stepperId = props.stepperId != null ? props.stepperId : "stepper";
  var panelId   = props.panelId   != null ? props.panelId   : "panel";

  var DEFAULT_PHASES = [
    {
      label: "Problem framing",
      date:  "Jan 15 – Feb 28, 2025",
      desc:  "The project team shares background research and the problem statement with the community. Residents can read the brief and sign up to be notified when participation opens.",
    },
    {
      label: "Community ideation",
      date:  "Mar 1 – Apr 15, 2025",
      desc:  "Residents submit ideas on how to address the core challenge. Ideas can be commented on and liked by other participants. The team reviews submissions weekly.",
    },
    {
      label: "Idea prioritization vote",
      date:  "Apr 16 – May 10, 2025",
      desc:  "The most-supported ideas from the ideation phase go to a community vote. Each participant gets 5 votes to allocate across the shortlisted proposals.",
    },
    {
      label: "Needs assessment survey",
      date:  "May 15 – Jun 1, 2025",
      desc:  "A targeted survey collects demographic data and lived-experience insights to ensure the final plan reflects the full diversity of the community.",
    },
    {
      label: "Co-design workshop",
      date:  "Jun 10 – Jun 30, 2025",
      desc:  "Small working groups of residents and staff collaborate on detailed design options. Outputs from each group feed directly into the draft development plan.",
    },
    {
      label: "Draft plan review",
      date:  "Jul 1 – Jul 31, 2025",
      desc:  "The draft plan is published for community review. Residents can leave comments on specific sections. The team will publish a summary of all feedback received.",
    },
    {
      label: "Public consultation",
      date:  "Aug 1 – Sep 15, 2025",
      desc:  "A formal public consultation survey collects structured feedback on the draft plan’s key decisions before it is submitted for council approval.",
    },
    {
      label: "Final vote",
      date:  "Sep 16 – Oct 5, 2025",
      desc:  "Residents cast a binding community vote on the final plan options. The winning option will be adopted and submitted to the planning authority.",
    },
    {
      label: "Product Circle meets",
      date:  "Oct 6 – Oct 20, 2025",
      desc:  "The internal product circle reviews all community input and finalises the development brief. Meeting minutes will be published within 5 business days.",
    },
    {
      label: "Development plan announced",
      date:  "Oct 21, 2025 – No end date",
      desc:  "With the consultation rounds complete, the project team shares the development plan that came out of the process — what was prioritised, why, and the timeline for delivery.",
    },
  ];

  var phases  = props.phases  != null ? props.phases  : DEFAULT_PHASES;
  var current = props.current != null ? props.current : 9;
  var viewing = props.viewing != null ? props.viewing : current;

  /* ── stepper tabs ── */
  var stepperItems = phases.map(function (ph, i) {
    var isCurrent  = i === current;
    var isViewing  = i === viewing;
    var cls = "gv-phase" + (isCurrent ? " current" : "");
    var dot = isCurrent ? '<span class="gv-pstep__dot"></span>' : "";
    return (
      '<button class="' + cls + '" role="tab"' +
        ' aria-selected="' + (isViewing ? "true" : "false") + '"' +
        ' title="' + esc(ph.label) + '">' +
        '<span class="gv-pstep">' + dot + (i + 1) + '</span>' +
        '<span class="gv-phase__label">' + esc(ph.label) + '</span>' +
      '</button>'
    );
  }).join("");

  /* ── panel (initial content = viewing phase) ── */
  var pv = phases[viewing] || phases[0] || { label: "", date: "", desc: "" };

  return (
    '<section class="gv-phases" aria-labelledby="' + esc(titleId) + '">' +
      '<div class="gv-phases__bar">' +
        '<h2 id="' + esc(titleId) + '">' + esc(title) + '</h2>' +
        '<div class="gv-phases__nav">' +
          '<button class="gv-pnav" id="navPrev" aria-label="Previous phase">' +
            '<span data-gv-icon="chevron-left"></span>' +
          '</button>' +
          '<button class="gv-pnav" id="navCurrent" aria-label="Go to current phase">' +
            '<span class="gv-dotmark"></span>' +
          '</button>' +
          '<button class="gv-pnav" id="navNext" aria-label="Next phase">' +
            '<span data-gv-icon="chevron-right"></span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="gv-stepper" role="tablist" aria-label="Project phases" id="' + esc(stepperId) + '">' +
        stepperItems +
      '</div>' +
      '<div class="gv-phasepanel" role="tabpanel" id="' + esc(panelId) + '">' +
        '<div class="gv-phasepanel__head">' +
          '<span class="gv-phasepanel__num" id="panelNum" aria-hidden="true">' + (viewing + 1) + '</span>' +
          '<div>' +
            '<h3 class="gv-phasepanel__name" id="panelName">' + esc(pv.label) + '</h3>' +
            '<p class="gv-phasepanel__date" id="panelDate">' + esc(pv.date) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="gv-phasepanel__desc" id="panelDesc"><p>' + esc(pv.desc) + '</p></div>' +
      '</div>' +
    '</section>'
  );
});

/* ── poll ─────────────────────────────────────────────────────────── */
/* poll.js — canonical instance renderer for the poll component.
 * Registered onto window.GV via GV.register("poll", fn).
 * GV.render("poll", {}) → primary instance: the three-question poll form from HEAD.
 *
 * Props (all optional — defaults reproduce the primary HEAD instance verbatim):
 *
 *   id       : string   value for the form's id attr and the partbar href anchor
 *                       (default "poll")
 *   ariaLabel: string   aria-label on the <form>
 *                       (default "Poll")
 *   questions: Array of { label, type, name, options }
 *              Default = the three HEAD questions in order.
 *              label   : string   legend text for the question
 *              type    : "radio" | "checkbox"   (default "radio")
 *              name    : string   input name attr (e.g. "q1")
 *              options : Array of strings — each answer label
 *
 *   sendLabel  : string   submit button text (default "Send")
 *   sendDisabled : boolean  whether Send is disabled (default true)
 *
 * MARKUP ONLY — the voting interaction (enable Send when answered, etc.) is
 * wired in the demo's own <script>.
 */
GV.register("poll", function (props) {
  props = props || {};
  var esc = GV.esc;

  var id         = props.id        !== undefined ? props.id        : "poll";
  var ariaLabel  = props.ariaLabel !== undefined ? props.ariaLabel : "Poll";
  var sendLabel  = props.sendLabel  !== undefined ? props.sendLabel  : "Send";
  var sendDisabled = props.sendDisabled !== undefined ? props.sendDisabled : true;

  var DEFAULT_QUESTIONS = [
    {
      label: "Select your age range",
      type: "radio",
      name: "q1",
      options: ["Under 25", "25-45", "45-65", "65 and Above"]
    },
    {
      label: "Do you support closing river-side streets to through traffic on weekends?",
      type: "radio",
      name: "q2",
      options: ["Strongly support", "Somewhat support", "Neutral", "Oppose"]
    },
    {
      label: "Which improvements would you use? (Select all that apply)",
      type: "checkbox",
      name: "q3",
      options: ["Protected bike lanes", "Wider pavements", "More benches & greenery", "Better lighting"]
    }
  ];

  var questions = props.questions !== undefined ? props.questions : DEFAULT_QUESTIONS;

  var fieldsets = questions.map(function (q, i) {
    var qNum = i + 1;
    var type = q.type !== undefined ? q.type : "radio";
    var isCheckbox = type === "checkbox";

    var opts = (q.options || []).map(function (opt) {
      if (isCheckbox) {
        return (
          '<label class="gv-checkbox e2e-poll-option"><input type="checkbox" name="' + esc(q.name) + '"><span class="box" aria-hidden="true">✓</span> ' + esc(opt) + '</label>'
        );
      }
      return (
        '<label class="gv-radio e2e-poll-option"><input type="radio" name="' + esc(q.name) + '"><span class="circle" aria-hidden="true"></span> ' + esc(opt) + '</label>'
      );
    }).join("\n          ");

    var roleAttr = isCheckbox ? "" : ' role="radiogroup"';

    return (
      '<fieldset class="gv-poll__question e2e-poll-question">' +
        '<div class="gv-poll__qhead">' +
          '<span class="gv-poll__num" aria-hidden="true">' + qNum + '</span>' +
          '<legend class="gv-poll__label">' + esc(q.label) + '</legend>' +
        '</div>' +
        '<div class="gv-poll__options"' + roleAttr + '>' +
          '\n          ' + opts + '\n        ' +
        '</div>' +
      '</fieldset>'
    );
  }).join("\n\n      ");

  var disabledAttr = sendDisabled ? " disabled" : "";

  return (
    '<form class="gv-poll e2e-poll-form" id="' + esc(id) + '" aria-label="' + esc(ariaLabel) + '">' +
      '\n\n      ' + fieldsets + '\n\n      ' +
      '<div class="gv-poll__send e2e-send-poll">' +
        '<button type="submit" class="gv-btn primary full"' + disabledAttr + '>' + esc(sendLabel) + '</button>' +
      '</div>' +
    '\n    </form>'
  );
});

/* ── project-card ─────────────────────────────────────────────────────────── */
/* project-card.js — canonical instance renderer for the project-card component.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("project-card", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance: boxed grid):
 *
 *   variant   "boxed-grid" | "rail" | "rail-wide" | "rail-square"
 *             "boxed-grid"  — .gv-pgrid wrapping .gv-pcard.boxed articles (default)
 *             "rail"        — .gv-rail wrapping plain .gv-pcard articles (time + CTA)
 *             "rail-wide"   — .gv-rail wrapping .gv-pcard.wide articles (people + desc)
 *             "rail-square" — .gv-rail wrapping .gv-pcard.square articles (done/time + CTA)
 *
 *   cards     Array of card objects. Shape depends on variant:
 *
 *   --- "boxed-grid" card props ---
 *     title       {string}   heading link text                           [required]
 *     href        {string}   card link href                              default "#"
 *     desc        {string}   paragraph below title; omit to hide
 *     thumb       {string}   <img src> path; omit for no <img>
 *     thumbAlt    {string}   <img alt>                                   default ""
 *     layout      {string}   "standard" | "feature" | "folder"          default "standard"
 *                            "feature"  — adds .horizontal.feature.span-3 (full-width hero)
 *                            "folder"   — adds no span class (single column)
 *     span        {string}   "half" | "3" | "" — span class suffix      default "half"
 *                            (ignored when layout is "feature")
 *     topLeft     {object}   left slot in .gv-pcard__top:
 *                              type "contributions" → <span class="gv-poststat"><b>N</b>&nbsp;contributions</span>
 *                              type "time"          → clock meta + optional progress bar
 *                              type "projects"      → folder meta "<span class="gv-pcard__meta">N projects</span>"
 *                              type "status"        → <span class="gv-status-label MODIFIER">Label</span>
 *                              type "closed"        → (no topLeft; closed count goes in foot)
 *                            fields: type, count, label, modifier, progressPct, timeLabel
 *     topRight    {object}   right slot: { type: "cta"|"folder-icon", label, href }
 *     foot        {object}   footer slot:
 *                              type "avatars"       → .gv-bubbles with ariaLabel + N avatar spans
 *                              type "closed-count"  → <span class="gv-poststat closed"><b>N</b>&nbsp;contributions</span>
 *                            fields: type, ariaLabel, count, avatarCount, label
 *     cta         {object}   primary CTA button in body { label, href } (feature card only)
 *     bubbles     {object}   avatar stack in body { ariaLabel, avatarCount } (feature card only)
 *
 *   --- "rail" / "rail-square" card props ---
 *     title       {string}   heading link text                           [required]
 *     href        {string}   card link href                              default "#"
 *     thumbStyle  {string}   inline style for .gv-pcard__thumb placeholder (background, etc.)
 *     thumbContent {string}  text/HTML rendered inside the thumb div    default ""
 *     metaType    {string}   "time" | "done"                            default "time"
 *     metaLabel   {string}   meta text (e.g. "6 weeks left", "vor 7 Wochen")
 *     ctaLabel    {string}   CTA link text                              default "Learn more"
 *     ctaHref     {string}   CTA link href                              default "#"
 *
 *   --- "rail-wide" card props ---
 *     title       {string}   heading link text                           [required]
 *     href        {string}   card link href                              default "#"
 *     thumbStyle  {string}   inline style for .gv-pcard__thumb placeholder
 *     thumbContent {string}  text/HTML rendered inside the thumb div    default ""
 *     metaLabel   {string}   people-count text (e.g. "111 Teilnehmende")
 *     desc        {string}   description paragraph
 *
 * GV.render("project-card")                    → primary (boxed grid, 5 cards from HEAD)
 * GV.render("project-card", { variant:"rail" })        → survey rail (4 cards)
 * GV.render("project-card", { variant:"rail-wide" })   → wide rail  (2 cards)
 * GV.render("project-card", { variant:"rail-square" }) → square rail (2 cards)
 *
 * Variants demonstrated in HEAD:
 *   {}                          → boxed grid (feature + 2× standard/survey/folder/finished)
 *   { variant:"rail" }         → rail, time meta + CTA (Wien survey cards)
 *   { variant:"rail-wide" }    → rail, people meta + desc (Wien wide cards)
 *   { variant:"rail-square" }  → rail, done/time meta + CTA (Wien square cards)
 */
GV.register("project-card", function (props) {
  props = props || {};
  var esc = GV.esc;

  var variant = props.variant || "boxed-grid";

  /* ══════════════════════════════════════════════════════════════════════
     SVG HELPERS (inlined — same glyphs used in HEAD, no data-gv-icon here
     because these are purpose-specific structural glyphs, not icon-font slots)
     ══════════════════════════════════════════════════════════════════════ */
  var SVG_CLOCK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_PEOPLE = '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 11a3 3 0 100-6 3 3 0 000 6Zm6 0a3 3 0 100-6 3 3 0 000 6Zm-6 1.5c-2.7 0-6 1.35-6 4V18h8v-1.5c0-1 .35-1.9 1-2.6-.9-.25-1.95-.4-3-.4Zm6 0c-.35 0-.75 0-1.15.05C15.15 14.3 16 15.3 16 16.5V18h5v-1.5c0-2.65-3.3-4-6-4Z"/></svg>';
  var SVG_DONE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20Zm-1 14l-4-4 1.4-1.4L11 13.2l4.6-4.6L17 10l-6 6Z"/></svg>';
  var SVG_FOLDER = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/></svg>';

  /* ══════════════════════════════════════════════════════════════════════
     VARIANT: BOXED GRID (default)
     Reproduces the .gv-pgrid.gv-pgrid--feat block from HEAD verbatim.
     ══════════════════════════════════════════════════════════════════════ */
  if (variant === "boxed-grid") {

    var DEFAULT_BOXED_CARDS = [
      /* Featured horizontal card (full-width hero) */
      {
        layout:    "feature",
        title:     "The big downtown survey",
        href:      "#",
        desc:      "What does downtown need to become more liveable? Tell us which places, routes and ideas matter most to you.",
        thumb:     "../../pages/homepage/img/feat-downtown.webp",
        thumbAlt:  "Harbour and downtown waterfront",
        cta:       { label: "Take the survey", href: "#" },
        bubbles:   { ariaLabel: "248 participants", avatarCount: 3, label: "248 participants" }
      },
      /* Standard: contributions left + outlined CTA right; avatars foot */
      {
        layout: "standard",
        span:   "half",
        title:  "A square for everyone",
        href:   "#",
        desc:   "How can Market Square become a popular meeting point in the neighbourhood?",
        thumb:  "../../pages/homepage/img/done-square.webp",
        thumbAlt: "People and cyclists crossing Market Square",
        topLeft:  { type: "contributions", count: "122" },
        topRight: { type: "cta", label: "Learn more", href: "#" },
        foot:     { type: "avatars", ariaLabel: "122 participants", avatarCount: 3, label: "122 participants" }
      },
      /* Survey: time + progress left + outlined CTA right; avatars foot */
      {
        layout: "standard",
        span:   "half",
        title:  "The future of Station Road",
        href:   "#",
        thumb:  "../../pages/homepage/img/street.webp",
        thumbAlt: "A tree-lined stretch of Station Road",
        topLeft:  { type: "time", timeLabel: "6 weeks left", progressPct: 18 },
        topRight: { type: "cta", label: "Take the survey", href: "#" },
        foot:     { type: "avatars", ariaLabel: "57 participants", avatarCount: 3, label: "57 participants" }
      },
      /* Folder: "N projects" left + folder icon right; avatars foot */
      {
        layout: "folder",
        title:  "City climate teams",
        href:   "#",
        desc:   "Wanted: your ideas for a better climate across the city's districts.",
        thumb:  "../../pages/homepage/img/folder-climate.webp",
        thumbAlt: "A leafy city park — the climate teams' green spaces",
        topLeft:  { type: "projects", label: "3 projects" },
        topRight: { type: "folder-icon" },
        foot:     { type: "avatars", ariaLabel: "346 participants", avatarCount: 3, label: "346 participants" }
      },
      /* Finished: status pill left + report CTA right; closed count foot */
      {
        layout: "folder",
        title:  "Old Town renewal",
        href:   "#",
        desc:   "Participation has closed. Read which proposals are being put into action.",
        thumb:  "../../pages/homepage/img/done-oldtown.webp",
        thumbAlt: "A renewed Old Town street",
        topLeft:  { type: "status", modifier: "finished", label: "Finished" },
        topRight: { type: "cta", label: "Read the report", href: "#" },
        foot:     { type: "closed-count", count: "503" }
      }
    ];

    var boxedCards = props.cards !== undefined ? props.cards : DEFAULT_BOXED_CARDS;

    function renderTopLeft(tl) {
      if (!tl) return "";
      if (tl.type === "contributions") {
        return '<span class="gv-poststat"><b>' + esc(tl.count) + '</b>&nbsp;contributions</span>';
      }
      if (tl.type === "time") {
        var prog = (tl.progressPct !== undefined)
          ? '<div class="gv-progress" role="progressbar" aria-valuenow="' + esc(tl.progressPct) + '" aria-valuemin="0" aria-valuemax="100" aria-label="Time elapsed"><div class="gv-progress__fill" style="width:' + esc(tl.progressPct) + '%"></div></div>'
          : "";
        return '<div class="gv-pcard__topprog">' +
          '<span class="gv-pcard__meta time">' + SVG_CLOCK + " " + esc(tl.timeLabel || "") + "</span>" +
          prog +
          "</div>";
      }
      if (tl.type === "projects") {
        return '<span class="gv-pcard__meta">' + esc(tl.label || "") + "</span>";
      }
      if (tl.type === "status") {
        return '<span class="gv-status-label ' + esc(tl.modifier || "") + '">' + esc(tl.label || "") + "</span>";
      }
      return "";
    }

    function renderTopRight(tr) {
      if (!tr) return "";
      if (tr.type === "cta") {
        return '<a class="gv-btn primary-outlined" href="' + esc(tr.href || "#") + '">' + esc(tr.label || "") + "</a>";
      }
      if (tr.type === "folder-icon") {
        return '<span class="gv-pcard__topicon" role="img" aria-label="Project folder">' + SVG_FOLDER + "</span>";
      }
      return "";
    }

    function renderFoot(foot) {
      if (!foot) return "";
      if (foot.type === "avatars") {
        var avs = "";
        for (var i = 0; i < (foot.avatarCount || 3); i++) { avs += '<span class="av"></span>'; }
        return '<div class="gv-pcard__foot">' +
          '<div class="gv-bubbles" aria-label="' + esc(foot.ariaLabel || "") + '">' +
          avs + '<span class="gv-bubbles__label">' + esc(foot.label || "") + "</span>" +
          "</div></div>";
      }
      if (foot.type === "closed-count") {
        return '<div class="gv-pcard__foot">' +
          '<span class="gv-poststat closed"><b>' + esc(foot.count) + '</b>&nbsp;contributions</span>' +
          "</div>";
      }
      return "";
    }

    var articlesHtml = boxedCards.map(function (card) {
      var layout = card.layout || "standard";
      var isFeature = layout === "feature";

      /* article class */
      var spanCls = "";
      if (!isFeature) {
        var sp = card.span !== undefined ? card.span : "half";
        spanCls = sp ? " span-" + esc(sp) : "";
      }
      var articleCls = "gv-pcard boxed" +
        (isFeature ? " horizontal feature span-3" : spanCls);

      /* thumb */
      var thumbInner = card.thumb
        ? '<img src="' + esc(card.thumb) + '" alt="' + esc(card.thumbAlt || "") + '" loading="lazy" />'
        : "";
      var thumbHtml = '<div class="gv-pcard__thumb">' + thumbInner + "</div>";

      if (isFeature) {
        /* Feature card: body LEFT, thumb RIGHT */
        var avs = "";
        for (var i = 0; i < ((card.bubbles && card.bubbles.avatarCount) || 3); i++) {
          avs += '<span class="av"></span>';
        }
        var bubblesHtml = card.bubbles
          ? '<div class="gv-bubbles" aria-label="' + esc(card.bubbles.ariaLabel || "") + '" style="margin-top:18px">' +
              avs + '<span class="gv-bubbles__label">' + esc(card.bubbles.label || "") + "</span></div>"
          : "";
        var ctaHtml = card.cta
          ? '<div><a class="gv-btn primary" href="' + esc(card.cta.href || "#") + '">' + esc(card.cta.label || "") + "</a></div>"
          : "";
        return '<article class="' + articleCls + '">' +
          '<div class="gv-pcard__body">' +
            '<h3 class="gv-pcard__title"><a href="' + esc(card.href || "#") + '">' + esc(card.title) + "</a></h3>" +
            (card.desc ? '<p class="gv-pcard__desc">' + esc(card.desc) + "</p>" : "") +
            ctaHtml +
            bubblesHtml +
          "</div>" +
          thumbHtml +
          "</article>";
      }

      /* Standard/folder card: top meta row + thumb + body */
      var topHtml = (card.topLeft || card.topRight)
        ? '<div class="gv-pcard__top">' + renderTopLeft(card.topLeft) + renderTopRight(card.topRight) + "</div>"
        : "";
      return '<article class="' + articleCls + '">' +
        topHtml +
        thumbHtml +
        '<div class="gv-pcard__body">' +
          '<h3 class="gv-pcard__title"><a href="' + esc(card.href || "#") + '">' + esc(card.title) + "</a></h3>" +
          (card.desc ? '<p class="gv-pcard__desc">' + esc(card.desc) + "</p>" : "") +
          '<div class="gv-pcard__spacer"></div>' +
          renderFoot(card.foot) +
        "</div>" +
        "</article>";
    }).join("");

    return '<div class="gv-pgrid gv-pgrid--feat">' + articlesHtml + "</div>";
  }

  /* ══════════════════════════════════════════════════════════════════════
     VARIANT: RAIL (plain cards, time meta + CTA)
     Reproduces the Wien survey rail from HEAD verbatim.
     ══════════════════════════════════════════════════════════════════════ */
  if (variant === "rail") {

    var DEFAULT_RAIL_CARDS = [
      {
        thumbStyle:   "background:#eef0e8",
        thumbContent: '<span style="background:#0a7a4f;color:#fff;border-radius:14px 14px 14px 2px;padding:12px 14px;font-size:13px;max-width:80%">GESUNDE<br>BLINDENGASSE</span>',
        title:        "Gesunde Blindengasse",
        href:         "#",
        metaType:     "time",
        metaLabel:    "Ein Tag verbleibend",
        ctaLabel:     "Umfrage ausfüllen",
        ctaHref:      "#"
      },
      {
        thumbStyle:   "background:linear-gradient(135deg,#9fb0a3,#cdd6cd)",
        thumbContent: "",
        title:        "Gellertplatz für alle",
        href:         "#",
        metaType:     "time",
        metaLabel:    "noch 3 Wochen",
        ctaLabel:     "Umfrage ausfüllen",
        ctaHref:      "#"
      },
      {
        thumbStyle:   "background:linear-gradient(135deg,#b7423a,#d98a5a)",
        thumbContent: "DIE GROSSE<br>MEIDLING-UMFRAGE",
        title:        "Die große Meidling-Umfrage",
        href:         "#",
        metaType:     "time",
        metaLabel:    "noch 4 Wochen",
        ctaLabel:     "Umfrage ausfüllen",
        ctaHref:      "#"
      },
      {
        thumbStyle:   "background:linear-gradient(135deg,#9a9a9a,#c7c2bd)",
        thumbContent: "",
        title:        "Supergrätzl Favoriten",
        href:         "#",
        metaType:     "time",
        metaLabel:    "noch 5 Wochen",
        ctaLabel:     "Umfrage ausfüllen",
        ctaHref:      "#"
      }
    ];

    var railCards = props.cards !== undefined ? props.cards : DEFAULT_RAIL_CARDS;

    var railHtml = railCards.map(function (card) {
      var metaIcon = card.metaType === "done" ? SVG_DONE : SVG_CLOCK;
      var metaCls = "gv-pcard__meta " + (card.metaType || "time");
      return '<article class="gv-pcard">' +
        '<div class="gv-pcard__thumb" style="' + esc(card.thumbStyle || "") + '">' +
          (card.thumbContent || "") +
        '</div>' +
        '<h3 class="gv-pcard__title"><a href="' + esc(card.href || "#") + '">' + esc(card.title) + "</a></h3>" +
        '<span class="' + metaCls + '">' + metaIcon + " " + esc(card.metaLabel || "") + "</span>" +
        '<a class="gv-pcard__cta" href="' + esc(card.ctaHref || "#") + '">' + esc(card.ctaLabel || "Learn more") + "</a>" +
        "</article>";
    }).join("");

    return '<div class="gv-rail">' + railHtml + "</div>";
  }

  /* ══════════════════════════════════════════════════════════════════════
     VARIANT: RAIL-WIDE (people count + description)
     Reproduces the .gv-pcard.wide rail from HEAD verbatim.
     ══════════════════════════════════════════════════════════════════════ */
  if (variant === "rail-wide") {

    var DEFAULT_WIDE_CARDS = [
      {
        thumbStyle:   "background:linear-gradient(135deg,#9a9a9a,#c7c2bd)",
        thumbContent: "",
        title:        "Supergrätzl Favoriten",
        href:         "#",
        metaLabel:    "111 Teilnehmende",
        desc:         "Das erste Wiener Supergrätzl ist fertig! Jetzt ist Ihre Meinung gefragt."
      },
      {
        thumbStyle:   "background:linear-gradient(135deg,#2b5cab,#f2c200)",
        thumbContent: "MITMACH-BUDGET",
        title:        "Mitmach-Budget Brigittenau 2026",
        href:         "#",
        metaLabel:    "16 Teilnehmende",
        desc:         "Brigittenauer Mitmachbudget."
      }
    ];

    var wideCards = props.cards !== undefined ? props.cards : DEFAULT_WIDE_CARDS;

    var wideHtml = wideCards.map(function (card) {
      return '<article class="gv-pcard wide">' +
        '<div class="gv-pcard__thumb" style="' + esc(card.thumbStyle || "") + '">' +
          (card.thumbContent || "") +
        '</div>' +
        '<h3 class="gv-pcard__title"><a href="' + esc(card.href || "#") + '">' + esc(card.title) + "</a></h3>" +
        '<span class="gv-pcard__meta people">' + SVG_PEOPLE + " " + esc(card.metaLabel || "") + "</span>" +
        (card.desc ? '<p class="gv-pcard__desc">' + esc(card.desc) + "</p>" : "") +
        "</article>";
    }).join("");

    return '<div class="gv-rail">' + wideHtml + "</div>";
  }

  /* ══════════════════════════════════════════════════════════════════════
     VARIANT: RAIL-SQUARE (1:1 cards, done/time meta + CTA)
     Reproduces the .gv-pcard.square rail from HEAD verbatim.
     ══════════════════════════════════════════════════════════════════════ */
  if (variant === "rail-square") {

    var DEFAULT_SQUARE_CARDS = [
      {
        thumbStyle:   "background:#f3e2a6;color:#7a5e12;font-size:14px;padding:12px",
        thumbContent: "Alt-Ottakring wie neu!",
        title:        "Alt-Ottakring wie neu!",
        href:         "#",
        metaType:     "done",
        metaLabel:    "vor 7 Wochen",
        ctaLabel:     "Mehr erfahren",
        ctaHref:      "#"
      },
      {
        thumbStyle:   "background:#ece9e2;color:#a32a1c;font-size:15px;padding:12px",
        thumbContent: "GRÄTZL<br>LABOR",
        title:        "Grätzllabor Innere Stadt",
        href:         "#",
        metaType:     "time",
        metaLabel:    "Kein Enddatum",
        ctaLabel:     "Mehr erfahren",
        ctaHref:      "#"
      }
    ];

    var squareCards = props.cards !== undefined ? props.cards : DEFAULT_SQUARE_CARDS;

    var squareHtml = squareCards.map(function (card) {
      var metaIcon = card.metaType === "done" ? SVG_DONE : SVG_CLOCK;
      var metaCls = "gv-pcard__meta " + (card.metaType || "time");
      return '<article class="gv-pcard square">' +
        '<div class="gv-pcard__thumb" style="' + esc(card.thumbStyle || "") + '">' +
          (card.thumbContent || "") +
        '</div>' +
        '<h3 class="gv-pcard__title"><a href="' + esc(card.href || "#") + '">' + esc(card.title) + "</a></h3>" +
        '<span class="' + metaCls + '">' + metaIcon + " " + esc(card.metaLabel || "") + "</span>" +
        '<a class="gv-pcard__cta" href="' + esc(card.ctaHref || "#") + '">' + esc(card.ctaLabel || "Learn more") + "</a>" +
        "</article>";
    }).join("");

    return '<div class="gv-rail">' + squareHtml + "</div>";
  }

  /* Unrecognised variant — fall through to empty string */
  return "";
});

/* ── proposal-threshold ─────────────────────────────────────────────────────────── */
/* LINKED INSTANCE — proposal-threshold renderer.
 * GV.render("proposal-threshold", props) -> canonical HTML.
 * Do NOT edit markup in any demo; edit here and it flows everywhere.
 *
 * Props:
 *   count  {number}  votes cast           default: 132
 *   target {number}  threshold target     default: 300
 *
 * Derived: fill% = Math.min(100, Math.round(count/target*100))
 * Wrapped in .gv-ideacard__foot exactly as the real proposal card stacks it.
 */
GV.register("proposal-threshold", function (props) {
  props = props || {};
  var esc = GV.esc;
  var count  = props.count  != null ? props.count  : 132;
  var target = props.target != null ? props.target : 300;
  var fill   = Math.min(100, Math.round(count / target * 100));
  var label  = esc(count) + " votes out of " + esc(target);
  return (
    '<div class="gv-ideacard__foot">' +
      '<div class="gv-threshold">' +
        '<div class="gv-threshold__head">' +
          '<span class="gv-threshold__icon" data-gv-icon="vote-up" aria-hidden="true"></span>' +
          '<span class="gv-threshold__count"><b>' + esc(count) + '</b><span class="gv-threshold__sep"> / </span>' + esc(target) + '</span>' +
        '</div>' +
        '<span class="gv-threshold__bar" role="progressbar" aria-valuenow="' + esc(fill === 100 ? target : count) + '" aria-valuemin="0" aria-valuemax="' + esc(target) + '" aria-label="' + label + '">' +
          '<span class="gv-threshold__fill" style="width:' + fill + '%"></span>' +
        '</span>' +
      '</div>' +
    '</div>'
  );
});

/* ── signed-out-hero ─────────────────────────────────────────────────────────── */
/* signed-out-hero.js — canonical instance renderer for .gv-hero.signed-out.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("signed-out-hero", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce instance 1, the primary, from HEAD):
 *
 *   layout      "full" | "canvas" | "left" | "tworow" | "fixed"
 *               "full"    — centered overlay, photo via --gv-hero-image      (instance 1 / primary)
 *               "canvas"  — centered overlay, no photo (fallback #EDEFF0)    (instance 2)
 *               "left"    — left-aligned overlay, photo via --gv-hero-image  (instance 3)
 *               "tworow"  — .layout-tworow, <gv-hero__media> img + white row (instance 4)
 *               "fixed"   — .layout-fixed, centered overlay, photo, no avs  (instance 5)
 *               Default: "full"
 *
 *   title       string   heading text
 *               Default: "Welcome to the St. Louis Board of Aldermen's public engagement page."
 *
 *   lead        string   subtitle / lead copy
 *               Default: "Sign up and let your voice be heard!"
 *
 *   ctaLabel    string   button label
 *               Default: "Sign up"
 *
 *   imageUrl    string   photo URL (used by layouts "full", "left", "tworow", "fixed")
 *               Default (full/tworow): "https://images.unsplash.com/photo-1569959220744-ff553533f492?w=1600&q=60"
 *               Default (left/fixed):  "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=1600&q=60"
 *               Pass null/false to suppress the image (renders like "canvas").
 *
 *   avatarCount number   how many .av spans to render   (not used by "fixed" layout)
 *               Default: 4 (full/canvas), 3 (left/tworow)
 *
 *   avatarLabel string   aria-label on .gv-avatars
 *               Default: "4,000+ participants" (full), "1,200+ participants" (canvas/tworow),
 *                        "850+ participants" (left)
 *
 *   countLabel  string   visible count pill text
 *               Default: "4k" (full), "1.2k" (canvas/tworow), "850" (left)
 *
 *   testId      string   value for data-testid (only "full"/"tworow"/"fixed" carry one in HEAD)
 *               Default: per layout (see TESTIDS below)
 *
 *   id          string   id attribute on <section> (only "canvas" carries one in HEAD: "cp-canvas";
 *               inner div gets id = id + "-inner" for canvas, matching "cp-inner")
 *               Default: undefined (no id) except "canvas" → "cp-canvas"
 *
 * Five instances from HEAD:
 *   GV.render("signed-out-hero", {})                         → full (primary, St Louis photo)
 *   GV.render("signed-out-hero", { layout: "canvas" })       → fallback canvas, no photo
 *   GV.render("signed-out-hero", { layout: "left" })         → left-aligned, photo
 *   GV.render("signed-out-hero", { layout: "tworow" })       → two-row, media + white band
 *   GV.render("signed-out-hero", { layout: "fixed" })        → fixed-ratio strip, photo, no avs
 */
GV.register("signed-out-hero", function (props) {
  props = props || {};
  var esc = GV.esc;

  var layout = props.layout || "full";

  /* ── Per-layout defaults ── */
  var DEFAULTS = {
    full:   { title: "Welcome to the St. Louis Board of Aldermen’s public engagement page.",
              lead: "Sign up and let your voice be heard!",
              ctaLabel: "Sign up",
              imageUrl: "https://images.unsplash.com/photo-1569959220744-ff553533f492?w=1600&q=60",
              avatarCount: 4, avatarLabel: "4,000+ participants", countLabel: "4k" },
    canvas: { title: "Have your say on what happens in your city",
              lead: "Join the conversation and shape local decisions.",
              ctaLabel: "Sign up",
              imageUrl: null,
              avatarCount: 3, avatarLabel: "1,200+ participants", countLabel: "1.2k" },
    left:   { title: "A platform for everyone",
              lead: "Discover projects, share ideas, and follow what’s happening.",
              ctaLabel: "Sign up",
              imageUrl: "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=1600&q=60",
              avatarCount: 3, avatarLabel: "850+ participants", countLabel: "850" },
    tworow: { title: "Welcome to our participation platform",
              lead: "Scroll below to see the projects we’re working on.",
              ctaLabel: "Sign up",
              imageUrl: "https://images.unsplash.com/photo-1569959220744-ff553533f492?w=1600&q=60",
              avatarCount: 3, avatarLabel: "1,200+ participants", countLabel: "1.2k" },
    fixed:  { title: "Have your say on what happens in your city",
              lead: "Join the conversation and shape local decisions.",
              ctaLabel: "Sign up",
              imageUrl: "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=1600&q=60",
              avatarCount: 0, avatarLabel: "", countLabel: "" }
  };
  var d = DEFAULTS[layout] || DEFAULTS.full;

  var title       = props.title       != null ? props.title       : d.title;
  var lead        = props.lead        != null ? props.lead        : d.lead;
  var ctaLabel    = props.ctaLabel    != null ? props.ctaLabel    : d.ctaLabel;
  var imageUrl    = props.imageUrl    !== undefined ? props.imageUrl : d.imageUrl;
  var avatarCount = props.avatarCount != null ? props.avatarCount : d.avatarCount;
  var avatarLabel = props.avatarLabel != null ? props.avatarLabel : d.avatarLabel;
  var countLabel  = props.countLabel  != null ? props.countLabel  : d.countLabel;

  /* ── data-testid (only some layouts carry one in HEAD) ── */
  var TESTIDS = { full: "full-width-banner-layout", tworow: "two-row-layout", fixed: "fixed-ratio-layout" };
  var testId = props.testId != null ? props.testId : (TESTIDS[layout] || null);
  var testIdAttr = testId ? ' data-testid="' + esc(testId) + '"' : "";

  /* ── id (only canvas carries one in HEAD) ── */
  var idProp = props.id != null ? props.id : (layout === "canvas" ? "cp-canvas" : null);
  var idAttr = idProp ? ' id="' + esc(idProp) + '"' : "";
  /* In HEAD the canvas inner div has the fixed id "cp-inner" (not derived from outer id). */
  var innerIdAttr = (layout === "canvas" && idProp) ? ' id="cp-inner"' : "";

  /* ── Section class list ── */
  var cls = "gv-hero signed-out";
  if (layout === "full" || layout === "canvas" || layout === "tworow" || layout === "fixed") {
    cls += " centered";
  }
  if (layout === "tworow") cls += " layout-tworow";
  if (layout === "fixed")  cls += " layout-fixed";

  /* ── Image style (inline --gv-hero-image; absent for canvas + tworow uses <img> not bg) ── */
  var styleAttr = "";
  if (imageUrl && layout !== "tworow") {
    styleAttr = ' style="--gv-hero-image:url(\'' + esc(imageUrl) + '\')"';
  }

  /* ── Avatar cluster ── */
  var avatarsHtml = "";
  if (avatarCount > 0) {
    var avSpans = "";
    for (var i = 0; i < avatarCount; i++) { avSpans += '<span class="av"></span>'; }
    avatarsHtml =
      '<div class="gv-avatars" aria-label="' + esc(avatarLabel) + '">' +
        avSpans +
        '<span class="count">' + esc(countLabel) + '</span>' +
      '</div>';
  }

  /* ── Media row (tworow only) ── */
  var mediaHtml = "";
  if (layout === "tworow" && imageUrl) {
    mediaHtml = '<div class="gv-hero__media"><img src="' + esc(imageUrl) + '" alt="" /></div>';
  }

  return (
    '<section class="' + cls + '"' + idAttr + testIdAttr + styleAttr + '>' +
      mediaHtml +
      '<div class="gv-hero__inner"' + innerIdAttr + '>' +
        '<h1 class="gv-hero__title">' + esc(title) + '</h1>' +
        '<p class="gv-hero__lead">' + esc(lead) + '</p>' +
        avatarsHtml +
        '<div class="gv-hero__actions">' +
          '<button type="button" class="gv-btn primary-inverse">' + esc(ctaLabel) + '</button>' +
        '</div>' +
      '</div>' +
    '</section>'
  );
});

/* ── spotlight-carousel ─────────────────────────────────────────────────────────── */
/* spotlight-carousel.js — canonical instance renderer.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("spotlight-carousel", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance from HEAD):
 *
 *   title      {string}  Visible h2 text + aria-label on the section
 *                        default: "Open engagements"
 *   ariaLabel  {string}  Override for aria-label on the <section> and rail group
 *                        default: same as title
 *
 *   slides     {Array}   Array of slide objects. Defaults = the 5 HEAD cards.
 *              Each slide:
 *                title    {string}  <h3> link text               default per slide
 *                href     {string}  card link href               default "#"
 *                status   {string}  status line text             default "No end date"
 *                statusIcon {string} data-gv-icon value          default "clock-solid"
 *                more     {string}  "Learn more" label           default "Learn more"
 *                thumbHtml  {string} raw inner HTML for .gv-pcard__thumb
 *                                   Pass an <img …> for a photo thumb. Default = "".
 *                thumbClass {string} extra BEM modifier class on .gv-pcard__thumb
 *                                   e.g. "gv-pcard__thumb--forest" for CSS gradient
 *                                   thumbs. Defaults reproduce HEAD (empty for photo
 *                                   cards, modifier class for placeholder cards).
 *
 * GV.render("spotlight-carousel")               → primary (5-card, HEAD defaults)
 * GV.render("spotlight-carousel", { title: "Projects", slides: […] }) → custom
 */
GV.register("spotlight-carousel", function (props) {
  props = props || {};
  var esc = GV.esc;

  var title     = props.title     != null ? props.title     : "Open engagements";
  var ariaLabel = props.ariaLabel != null ? props.ariaLabel : title;

  var DEFAULT_SLIDES = [
    {
      title:     "Active travel route",
      href:      "#",
      status:    "No end date",
      statusIcon: "clock-solid",
      more:      "Learn more",
      thumbHtml: '<img src="../../pages/homepage/img/done-oldtown.webp" alt="A restored cobbled street" loading="lazy" />'
    },
    {
      title:     "Town centre vision",
      href:      "#",
      status:    "No end date",
      statusIcon: "clock-solid",
      more:      "Learn more",
      thumbHtml: '<img src="../../pages/homepage/img/done-square.webp" alt="Market square with people" loading="lazy" />'
    },
    {
      title:     "Green spaces plan",
      href:      "#",
      status:    "No end date",
      statusIcon: "clock-solid",
      more:      "Learn more",
      thumbHtml: '<img src="../../pages/homepage/img/done-youth.webp" alt="Community workshop" loading="lazy" />'
    },
    {
      title:      "Cycling network consultation",
      href:       "#",
      status:     "No end date",
      statusIcon: "clock-solid",
      more:       "Learn more",
      thumbHtml:  "",
      thumbClass: "gv-pcard__thumb--forest"
    },
    {
      title:      "River corridor study",
      href:       "#",
      status:     "No end date",
      statusIcon: "clock-solid",
      more:       "Learn more",
      thumbHtml:  "",
      thumbClass: "gv-pcard__thumb--ocean"
    }
  ];

  var slides = props.slides !== undefined ? props.slides : DEFAULT_SLIDES;

  var slidesHtml = slides.map(function (slide) {
    var href       = slide.href       != null ? slide.href       : "#";
    var status     = slide.status     != null ? slide.status     : "No end date";
    var statusIcon = slide.statusIcon != null ? slide.statusIcon : "clock-solid";
    var more       = slide.more       != null ? slide.more       : "Learn more";
    var thumbHtml  = slide.thumbHtml  != null ? slide.thumbHtml  : "";
    var thumbCls   = slide.thumbClass ? " " + slide.thumbClass   : "";

    return (
      '<article class="gv-pcard light compact">' +
        '<div class="gv-pcard__thumb' + thumbCls + '">' + thumbHtml + '</div>' +
        '<div class="gv-pcard__body">' +
          '<h3 class="gv-pcard__title"><a href="' + esc(href) + '">' + esc(slide.title) + '</a></h3>' +
          '<span class="gv-pcard__status">' +
            '<span data-gv-icon="' + esc(statusIcon) + '" aria-hidden="true"></span>' +
            esc(status) +
          '</span>' +
          '<span class="gv-pcard__more">' + esc(more) + '</span>' +
        '</div>' +
      '</article>'
    );
  }).join('');

  return (
    '<section class="gv-carousel" role="region" aria-roledescription="carousel" aria-label="' + esc(ariaLabel) + '">' +
      '<div class="gv-carousel__head">' +
        '<h2 class="gv-title h2 gv-carousel__title">' + esc(title) + '</h2>' +
        '<div class="gv-carousel__controls">' +
          '<button type="button" class="gv-carousel__scroll disabled" aria-disabled="true"' +
                  ' data-gv-carousel-prev aria-label="Scroll left">' +
            '<span data-gv-icon="chevron-left" aria-hidden="true"></span>' +
          '</button>' +
          '<button type="button" class="gv-carousel__scroll"' +
                  ' data-gv-carousel-next aria-label="Scroll right">' +
            '<span data-gv-icon="chevron-right" aria-hidden="true"></span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="gv-sr-only gv-carousel__skip" data-gv-carousel-skip>Press escape to skip carousel</button>' +
      '<div class="gv-rail rail--fade-right" tabindex="0" role="group"' +
           ' aria-label="' + esc(ariaLabel) + ', scroll for more" data-gv-carousel-rail>' +
        slidesHtml +
      '</div>' +
    '</section>'
  );
});

/* ── spotlight ─────────────────────────────────────────────────────────── */
/* spotlight.js — canonical instance renderer for .gv-spotlight.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("spotlight", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance from HEAD):
 *
 *   headingId    string   id on the <h2> for aria-labelledby       "spot-heading"
 *   title        string   project name heading                      "A greener Main Street"
 *   lead         string   lead paragraph                            (see default below)
 *   ctaLabel     string   primary CTA button label                  "Take the survey"
 *   ctaHref      string   primary CTA href                          "#"
 *
 *   — participant bubbles —
 *   avatarCount  number   how many .av spans to render              3
 *   avatarLabel  string   aria-label on .gv-bubbles                 "145 participants"
 *   bubbleLabel  string   visible __label text beside bubbles       "145 participants"
 *
 *   — optional progress bar (omitted by default) —
 *   progress     number   0-100 fill percentage; omit to hide bar   undefined
 *   progressLabel string  aria-label on .gv-progress                "Time elapsed"
 *
 *   — media tile —
 *   mediaUrl     string   image src; omit for placeholder tile      undefined
 *   mediaAlt     string   alt text when mediaUrl is set             ""
 *   chip         string   campaign chip text; omit to hide          undefined
 *                         Supports <br> in the default (kept literal); pass your
 *                         own with \n which we render as <br>.
 *
 * Two instances from HEAD:
 *   GV.render("spotlight", {})
 *     → primary: placeholder tile, avatar bubbles, no chip, no progress bar
 *   GV.render("spotlight", { headingId:"spot-heading-2", title:"Participatory budget 2026",
 *     lead:"Decide how we spend €500,000…", ctaLabel:"Submit a proposal",
 *     progress:62, avatarLabel:"86 participants", bubbleLabel:"86 participants",
 *     chip:"€500,000\nyour call" })
 *     → campaign: placeholder + chip over media, progress bar, then bubbles
 */
GV.register("spotlight", function (props) {
  props = props || {};
  var esc = GV.esc;

  var headingId    = props.headingId   != null ? props.headingId   : "spot-heading";
  var title        = props.title       != null ? props.title       : "A greener Main Street";
  var lead         = props.lead        != null ? props.lead        : "How do we make Main Street cooler, greener and healthier? Share your ideas\n              in our survey — participation closes in just a few days.";
  var ctaLabel     = props.ctaLabel    != null ? props.ctaLabel    : "Take the survey";
  var ctaHref      = props.ctaHref     != null ? props.ctaHref     : "#";
  var avatarCount  = props.avatarCount != null ? props.avatarCount : 3;
  var avatarLabel  = props.avatarLabel != null ? props.avatarLabel : "145 participants";
  var bubbleLabel  = props.bubbleLabel != null ? props.bubbleLabel : "145 participants";
  var mediaUrl     = props.mediaUrl    != null ? props.mediaUrl    : null;
  var mediaAlt     = props.mediaAlt    != null ? props.mediaAlt    : "";

  /* progress bar (optional) */
  var progress      = props.progress      != null ? props.progress      : null;
  var progressLabel = props.progressLabel != null ? props.progressLabel : "Time elapsed";

  /* campaign chip over media (optional) */
  var chip = props.chip != null ? props.chip : null;

  /* build .av spans */
  var avSpans = "";
  for (var i = 0; i < avatarCount; i++) { avSpans += '<span class="av"></span>'; }

  /* progress bar HTML (between actions and bubbles when present) */
  var progressHtml = "";
  if (progress != null) {
    progressHtml =
      '<div class="gv-progress" role="progressbar"' +
        ' aria-valuenow="' + esc(progress) + '"' +
        ' aria-valuemin="0" aria-valuemax="100"' +
        ' aria-label="' + esc(progressLabel) + '"' +
        ' style="margin-top:18px">' +
        '<div class="gv-progress__fill" style="width:' + esc(progress) + '%"></div>' +
      '</div>';
  }

  /* bubble margin: 14px when progress bar precedes, 18px otherwise */
  var bubbleMargin = progress != null ? "14px" : "18px";

  /* media tile */
  var mediaHtml;
  if (mediaUrl) {
    mediaHtml =
      '<div class="gv-spotlight__media" aria-hidden="true">' +
        '<img src="' + esc(mediaUrl) + '" alt="' + esc(mediaAlt) + '" />' +
        (chip ? '<span class="gv-spotlight__chip">' + esc(chip).replace(/\n/g, "<br>") + '</span>' : '') +
      '</div>';
  } else {
    mediaHtml =
      '<div class="gv-spotlight__media gv-spotlight__media--placeholder" aria-hidden="true">' +
        (chip ? '<span class="gv-spotlight__chip">' + esc(chip).replace(/\n/g, "<br>") + '</span>' : '') +
      '</div>';
  }

  return (
    '<section class="gv-spotlight" aria-labelledby="' + esc(headingId) + '">' +
      '<div class="gv-spotlight__inner">' +
        '<div>' +
          '<h2 class="gv-spotlight__title" id="' + esc(headingId) + '">' + esc(title) + '</h2>' +
          '<p class="gv-spotlight__lead">' + esc(lead) + '</p>' +
          '<div class="gv-spotlight__actions">' +
            '<a class="gv-btn primary size-m" href="' + esc(ctaHref) + '">' + esc(ctaLabel) + '</a>' +
          '</div>' +
          progressHtml +
          '<div class="gv-bubbles" aria-label="' + esc(avatarLabel) + '" style="margin-top:' + bubbleMargin + '">' +
            avSpans +
            '<span class="gv-bubbles__label">' + esc(bubbleLabel) + '</span>' +
          '</div>' +
        '</div>' +
        mediaHtml +
      '</div>' +
    '</section>'
  );
});

/* ── status-label ─────────────────────────────────────────────────────────── */
/* status-label.js — canonical instance renderer for the status-label component.
 *
 * Props (with defaults matching the primary/first HEAD instance):
 *   modifier : "" | "outlined"   (default "" → filled pill)
 *   bg       : CSS value for --bg custom property (default "var(--gv-success)")
 *              Ignored when modifier is "outlined" (Draft has no --bg inline style).
 *   label    : string            (default "Published")
 *
 * Three instances from HEAD base/status-label/index.html:
 *   1. Published → { modifier: "",         bg: "var(--gv-success)",                                  label: "Published" }
 *   2. Pending   → { modifier: "",         bg: "color-mix(in srgb, var(--gv-orange-500) 72%, #000)", label: "Pending"   }
 *   3. Draft     → { modifier: "outlined",                                                            label: "Draft"     }
 *
 * GV.render("status-label", {}) → primary instance:
 *   <span class="gv-status-label" style="--bg: var(--gv-success)">Published</span>
 */
GV.register("status-label", function (props) {
  props = props || {};
  var esc = GV.esc;

  var modifier = props.modifier !== undefined ? props.modifier : "";
  var bg       = props.bg       !== undefined ? props.bg       : "var(--gv-success)";
  var label    = props.label    !== undefined ? props.label    : "Published";

  var cls = "gv-status-label" + (modifier ? " " + esc(modifier) : "");
  /* outlined variant carries no --bg inline style (matches Draft in HEAD) */
  var styleAttr = (modifier !== "outlined" && bg)
    ? ' style="--bg: ' + bg + '"'
    : "";

  return '<span class="' + cls + '"' + styleAttr + ">" + esc(label) + "</span>";
});

/* ── sticky-note ─────────────────────────────────────────────────────────── */
/* sticky-note.js — canonical instance renderer for .gv-sticky.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("sticky-note", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance):
 *
 *   colour      {string}         pastel colour modifier class on .gv-sticky.
 *                                one of: "lavender" | "mint" | "pink" | "grey"
 *                                default: "lavender"
 *   raised      {boolean}        adds .is-raised for the elevated detail-card state.
 *                                default: false
 *   raisedStyle {string}         inline style on the root button when raised is true;
 *                                e.g. "min-height: 400px". default: "min-height: 400px"
 *   anonymous   {boolean}        true = no .av span and no __authorname; only the
 *                                corner emoji chip is rendered in __author.
 *                                default: true
 *   authorName  {string}         author display name (ignored when anonymous=true).
 *                                default: ""
 *   emoji       {string}         emoji shown in the corner __emoji chip.
 *                                default: "🌱"
 *   title       {string}         card heading text.
 *                                default: "Reproductive Healthcare Access"
 *   excerpt     {string}         body copy under the title.
 *                                default: "We should solve women's reproductive rights. I work in women's health and have friends who've needed services and medical care that is banned."
 *   likes       {number|string}  up-vote count.  default: 13
 *   dislikes    {number|string}  down-vote count. default: 0
 *
 * GV.render("sticky-note")                          → primary (lavender, resting, anonymous)
 * GV.render("sticky-note", { colour: "mint", anonymous: false, authorName: "Jonathan Kongstad", emoji: "🚧", title: "Roads & transit can't keep up", excerpt: "Infrastructure has not kept pace with overall population growth. Congestion is getting worse every year and public transit barely reaches the new neighbourhoods on the edge of town.", likes: 17, dislikes: 0 })
 * GV.render("sticky-note", { raised: true })        → raised (lavender, elevated, anonymous)
 */
GV.register("sticky-note", function (props) {
  props = props || {};
  var esc = GV.esc;

  var colour      = props.colour      !== undefined ? props.colour      : "lavender";
  var raised      = props.raised      !== undefined ? props.raised      : false;
  var raisedStyle = props.raisedStyle !== undefined ? props.raisedStyle : "min-height: 400px";
  var anonymous   = props.anonymous   !== undefined ? props.anonymous   : true;
  var authorName  = props.authorName  !== undefined ? props.authorName  : "";
  var emoji       = props.emoji       !== undefined ? props.emoji       : "🌱";
  var title       = props.title       !== undefined ? props.title       : "Reproductive Healthcare Access";
  var excerpt     = props.excerpt     !== undefined ? props.excerpt     : "We should solve women's reproductive rights. I work in women's health and have friends who've needed services and medical care that is banned.";
  var likes       = props.likes       !== undefined ? props.likes       : 13;
  var dislikes    = props.dislikes    !== undefined ? props.dislikes    : 0;

  var cls = "gv-sticky" + (raised ? " is-raised" : "") + (colour ? " " + esc(colour) : "");
  var styleAttr = raised ? ' style="' + esc(raisedStyle) + '"' : "";

  var authorHtml;
  if (anonymous) {
    authorHtml =
      '<span class="gv-sticky__author">' +
        '<span class="gv-sticky__emoji" aria-hidden="true">' + emoji + '</span>' +
      '</span>';
  } else {
    authorHtml =
      '<span class="gv-sticky__author">' +
        '<span class="av"></span>' +
        '<span class="gv-sticky__authorname">' + esc(authorName) + '</span>' +
        '<span class="gv-sticky__emoji" aria-hidden="true">' + emoji + '</span>' +
      '</span>';
  }

  return (
    '<button type="button" class="' + cls + '" data-cy="e2e-sticky-note"' + styleAttr + '>' +
      authorHtml +
      '<span class="gv-sticky__title">' + esc(title) + '</span>' +
      '<span class="gv-sticky__excerpt">' + esc(excerpt) + '</span>' +
      '<span class="gv-sticky__react e2e-reaction-controls neutral">' +
        '<button type="button" class="gv-sticky__reactbtn e2e-ideacard-dislike-button">' +
          '<span data-gv-icon="vote-down" aria-hidden="true"></span>' +
          '<span class="gv-sr-only">Dislike</span>' +
          '<b>' + esc(dislikes) + '</b>' +
        '</button>' +
        '<button type="button" class="gv-sticky__reactbtn e2e-ideacard-like-button">' +
          '<span data-gv-icon="vote-up" aria-hidden="true"></span>' +
          '<span class="gv-sr-only">Like</span>' +
          '<b>' + esc(likes) + '</b>' +
        '</button>' +
      '</span>' +
    '</button>'
  );
});

/* ── survey-band ─────────────────────────────────────────────────────────── */
/* survey-band.js — canonical instance renderer for the survey-band component.
 *
 * The tenant-primary participation CTA strip on a project page survey phase:
 * a live-status dot on the left, an on-color "Take the survey" button on the right.
 *
 * Props (with defaults matching the PRIMARY HEAD instance):
 *   statusText : string  — text beside the live dot   (default "Open for participation")
 *   ctaLabel   : string  — button / CTA copy           (default "Take the survey")
 *   href       : string  — CTA link target             (default "#survey")
 *   ariaLabel  : string  — <div role="region"> label   (default "Survey participation status")
 *
 * GV.render("survey-band", {}) → reproduces the PRIMARY HEAD instance exactly:
 *   <div class="gv-surveyband" role="region" aria-label="Survey participation status">
 *     <div class="gv-surveyband__inner">
 *       <span class="gv-surveyband__status"><span class="gv-surveyband__dot" aria-hidden="true"></span> Open for participation</span>
 *       <a class="gv-btn on-color gv-surveyband__cta" href="#survey">Take the survey <span data-gv-icon="arrow-right" aria-hidden="true"></span></a>
 *     </div>
 *   </div>
 *
 * Theming: the band fill follows --gv-tenant-primary; the CTA uses .gv-btn.on-color
 * so it reads against the tinted strip in any city theme.
 */
GV.register("survey-band", function (props) {
  props = props || {};
  var esc = GV.esc;

  var statusText = props.statusText !== undefined ? props.statusText : "Open for participation";
  var ctaLabel   = props.ctaLabel   !== undefined ? props.ctaLabel   : "Take the survey";
  var href       = props.href       !== undefined ? props.href       : "#survey";
  var ariaLabel  = props.ariaLabel  !== undefined ? props.ariaLabel  : "Survey participation status";

  return (
    '<div class="gv-surveyband" role="region" aria-label="' + esc(ariaLabel) + '">' +
      '<div class="gv-surveyband__inner">' +
        '<span class="gv-surveyband__status">' +
          '<span class="gv-surveyband__dot" aria-hidden="true"></span>' +
          ' ' + esc(statusText) +
        '</span>' +
        '<a class="gv-btn on-color gv-surveyband__cta" href="' + esc(href) + '">' +
          esc(ctaLabel) + ' <span data-gv-icon="arrow-right" aria-hidden="true"></span>' +
        '</a>' +
      '</div>' +
    '</div>'
  );
});

/* ── survey-fields ─────────────────────────────────────────────────────────── */
/* survey-fields.js — canonical instance renderer for the GoVocal survey / input-form
 * field widgets (the opt-in "survey kit" field markup). Registered onto window.GV via
 * GV.register("survey-fields", fn).
 *
 * ONE renderer, a `type` prop selecting the field VARIANT. Byte-faithful to what the
 * shared engine GVSurvey.field() (govocal-survey.js) emits for each field type — this
 * renderer is the markup half of that engine, lifted as a linked instance. It pairs
 * with govocal-survey.css for styling and govocal-survey.js for the runtime behaviour
 * (rating fill, ranking reorder, drag) — the demo keeps loading govocal-survey.js.
 *
 * GV.render("survey-fields", {}) → the PRIMARY instance: the HEAD `select` field
 *   "How often do you visit the park?" with its five options, verbatim.
 *
 * ── Props (all optional — defaults reproduce the HEAD primary field) ───────────────
 *   type     : field variant. One of:
 *                "text" · "multiline_text" · "number" · "date" ·
 *                "select" · "multiselect" · "rating" · "linear_scale" ·
 *                "sentiment" · "ranking" · "multiselect_image" · "matrix" ·
 *                "map" · "file_upload" · "shapefile_upload"
 *              (default "select")
 *   label    : question label (default = the primary field's label per type)
 *   desc     : optional helper text under the label (omitted when absent)
 *   required : boolean. When false (default) the "(optional)" pill renders.
 *   gate     : boolean. data-gate="1" marks a field as required-to-advance (default false).
 *   uid      : integer. Starting value for the internal nid() counter that names
 *              radio groups / input ids (f1, f2, …). Each nid() pre-increments, so the
 *              first id minted in this field is "f"+(uid+1). Lets a demo reproduce the
 *              exact id sequence the engine would emit when rendering many fields in a
 *              row. (default 0 → first id "f1")
 *
 *   type-specific:
 *     select / multiselect / ranking : options  (Array<string>)
 *     rating                         : max      (Number, default 5)
 *     linear_scale                   : max (default 7) · minLabel · maxLabel
 *     sentiment                      : faces (Array<string>) · labels (Array<string>)
 *     multiselect_image              : images   (Array<{src,label}>)
 *     matrix                         : scale (Array<string>) · statements (Array<string>)
 *     map                            : shape    ("point" | "line" | "polygon", default "point")
 *
 * MARKUP ONLY — the rating-fill / ranking-reorder / drag behaviours are wired in the
 * demo's own <script> (or by GVSurvey.mount in the page runner).
 */
GV.register("survey-fields", function (props) {
  props = props || {};
  var esc = GV.esc;

  /* Local nid() mirroring govocal-survey.js: a pre-incrementing counter producing
   * "f1", "f2", … . Seeded from props.uid so a demo can recreate the engine's exact
   * id sequence across a list of fields. */
  var uid = props.uid !== undefined ? props.uid : 0;
  function nid() { return "f" + (++uid); }

  var type = props.type !== undefined ? props.type : "select";

  /* qShell — the .sv-q wrapper shared by every field type (govocal-survey.js qShell). */
  function qShell(label, desc, gate, required, inner) {
    var opt = required ? "" : '<span class="sv-q__optional">(optional)</span>';
    var d = desc ? '<p class="sv-q__desc">' + esc(desc) + "</p>" : "";
    return '<div class="sv-q" data-gate="' + (gate ? 1 : 0) + '">' +
      '<div class="sv-q__label">' + esc(label) + opt + "</div>" + d +
      '<div class="sv-q__control">' + inner + "</div></div>";
  }

  var label    = props.label;
  var desc     = props.desc;
  var gate     = props.gate     !== undefined ? props.gate     : false;
  var required = props.required !== undefined ? props.required : false;

  function def(v, d) { return v !== undefined ? v : d; }

  function shell(lbl, dsc, inner) {
    return qShell(def(label, lbl), def(desc, dsc), gate, required, inner);
  }

  /* ── plain inputs ──────────────────────────────────────────────────────── */
  if (type === "text") {
    return shell("What’s the first word that comes to mind?", undefined,
      '<input class="gv-input" type="text" placeholder="Type your answer" />');
  }
  if (type === "multiline_text") {
    return shell("What improvements would you like to see?", undefined,
      '<textarea class="gv-textarea" placeholder="Type your answer"></textarea>');
  }
  if (type === "number") {
    return shell("How many in your household visit the park?", undefined,
      '<input class="gv-input" type="number" inputmode="numeric" placeholder="0" style="max-width:160px" />');
  }
  if (type === "date") {
    return shell("When did you last visit the park?", undefined,
      '<input class="gv-input" type="date" style="max-width:200px" />');
  }

  /* ── select (PRIMARY) ──────────────────────────────────────────────────── */
  if (type === "select") {
    var sOptions = def(props.options, ["Daily", "A few times a week", "Weekly", "Rarely", "Never"]);
    var n = nid();
    var cards = sOptions.map(function (o, i) {
      return '<label class="sv-optcard">' +
        '<span class="gv-radio"><input type="radio" name="' + n + '" value="' + i + '" /><span class="circle"></span></span>' +
        '<span class="sv-optcard__txt">' + esc(o) + "</span></label>";
    }).join("");
    return shell("How often do you visit the park?", undefined, cards);
  }

  if (type === "multiselect") {
    var mOptions = def(props.options, ["Walking", "Picnicking", "Playing sports", "Dog walking"]);
    var mCards = mOptions.map(function (o, i) {
      return '<label class="sv-optcard">' +
        '<span class="gv-checkbox"><input type="checkbox" value="' + i + '" /><span class="box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span></span>' +
        '<span class="sv-optcard__txt">' + esc(o) + "</span></label>";
    }).join("");
    return shell("What activities do you enjoy?", "Select all that apply", mCards);
  }

  /* ── rating (stars) ────────────────────────────────────────────────────── */
  if (type === "rating") {
    var rMax = def(props.max, 5);
    var rLabel = def(label, "Rate your overall experience");
    var star = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
    var rn = nid();
    var rh = '<div class="sv-rating" role="radiogroup" aria-label="' + esc(rLabel) + '">';
    for (var i = 1; i <= rMax; i++) {
      rh += '<input type="radio" name="' + rn + '" id="' + rn + "-" + i + '" value="' + i + '" />' +
        '<label for="' + rn + "-" + i + '" data-val="' + i + '" aria-label="' + i + " of " + rMax + '">' + star + "</label>";
    }
    return qShell(rLabel, def(desc, "(1 = very poor, 5 = excellent)"), gate, required, rh + "</div>");
  }

  /* ── linear_scale ──────────────────────────────────────────────────────── */
  if (type === "linear_scale") {
    var lMax = def(props.max, 7);
    var lLabel = def(label, "How important is sustainability?");
    var minLabel = def(props.minLabel, "not important");
    var maxLabel = def(props.maxLabel, "extremely important");
    var ln = nid();
    var btns = "";
    for (var j = 1; j <= lMax; j++) {
      btns += '<input type="radio" name="' + ln + '" id="' + ln + "-" + j + '" value="' + j + '" /><label for="' + ln + "-" + j + '">' + j + "</label>";
    }
    var ends = (minLabel || maxLabel)
      ? '<div class="sv-scale__ends"><span>' + esc(minLabel || "") + "</span><span>" + esc(maxLabel || "") + "</span></div>" : "";
    return qShell(lLabel, def(desc, "(1 = not important, 7 = extremely important)"), gate, required,
      '<div class="sv-scale" role="radiogroup" aria-label="' + esc(lLabel) + '">' + btns + "</div>" + ends);
  }

  /* ── sentiment ─────────────────────────────────────────────────────────── */
  if (type === "sentiment") {
    var faces = def(props.faces, ["😣", "🙁", "😐", "🙂", "😄"]);
    var labels = def(props.labels, ["Very bad", "Bad", "Ok", "Good", "Very good"]);
    var senLabel = def(label, "How do you feel about current safety?");
    var sn = nid();
    var items = faces.map(function (face, i) {
      return '<input type="radio" name="' + sn + '" id="' + sn + "-" + i + '" value="' + (i + 1) + '" />' +
        '<label for="' + sn + "-" + i + '"><span class="face" aria-hidden="true">' + face + '</span><span class="slabel">' + esc(labels[i]) + "</span></label>";
    }).join("");
    return qShell(senLabel, desc, gate, required,
      '<div class="sv-sentiment" role="radiogroup" aria-label="' + esc(senLabel) + '">' + items + "</div>");
  }

  /* ── ranking ───────────────────────────────────────────────────────────── */
  if (type === "ranking") {
    var rkOptions = def(props.options, ["Nature & biodiversity", "Play & recreation", "Safety & lighting", "Public restrooms"]);
    var N = rkOptions.length;
    var rkOpts = rkOptions.map(function (o, i) {
      var sel = '<select class="sv-rank__select" aria-label="Rank for ' + esc(o) + '"><option value="">–</option>';
      for (var r = 1; r <= N; r++) sel += '<option value="' + r + '">' + r + "</option>";
      sel += "</select>";
      return '<li draggable="true" data-i="' + i + '">' + sel +
        '<span class="sv-rank__txt">' + esc(o) + "</span>" +
        '<span class="sv-rank__handle" aria-hidden="true" title="Drag to reorder"><svg viewBox="0 0 24 24"><path d="M9 5h2v2H9V5m4 0h2v2h-2V5M9 11h2v2H9v-2m4 0h2v2h-2v-2m-4 6h2v2H9v-2m4 0h2v2h-2v-2"/></svg></span></li>';
    }).join("");
    return qShell(def(label, "Rank these features by importance"), def(desc, "(1 = most important)"), gate, required,
      '<ul class="sv-rank">' + rkOpts + "</ul>");
  }

  /* ── multiselect_image ─────────────────────────────────────────────────── */
  if (type === "multiselect_image") {
    var images = def(props.images, [
      { src: "img/playground-wooden.jpeg", label: "Natural wooden play structures" },
      { src: "img/playground-modern.jpeg", label: "Colorful rubberized modern sets" }
    ]);
    var imn = nid();
    var zoom = '<span class="sv-imgcard__zoom" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15 3h6v6h-2V6.41l-3.29 3.3-1.42-1.42L17.59 5H15V3M3 15h2v2.59l3.29-3.3 1.42 1.42L6.41 19H9v2H3v-6z"/></svg></span>';
    var imgCards = images.map(function (im, i) {
      return '<label class="sv-imgcard">' +
        '<span class="sv-imgcard__media"><img src="' + esc(im.src) + '" alt="' + esc(im.label) + '" />' + zoom + "</span>" +
        '<span class="sv-imgcard__foot">' +
        '<span class="gv-checkbox"><input type="checkbox" name="' + imn + '" value="' + i + '" /><span class="box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span></span>' +
        '<span class="label">' + esc(im.label) + "</span></span></label>";
    }).join("");
    return qShell(def(label, "Which playground style do you prefer?"), def(desc, "(Select one image)"), gate, required,
      '<div class="sv-imggrid">' + imgCards + "</div>");
  }

  /* ── matrix (statements × scale) ───────────────────────────────────────── */
  if (type === "matrix") {
    var scale = def(props.scale, ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"]);
    var statements = def(props.statements, [
      "The park should prioritize quiet natural areas.",
      "I’d prefer a fenced playground for safety.",
      "The park should host community events."
    ]);
    var head = "<tr><th></th>" + scale.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("") + "</tr>";
    var rows = statements.map(function (st) {
      var n = "mx" + nid();
      var cells = scale.map(function (s, c) {
        return '<td><label><input type="radio" name="' + n + '" value="' + (c + 1) + '" aria-label="' + esc(st) + " — " + esc(s) + '" /><span class="cell"><span class="dot"></span></span></label></td>';
      }).join("");
      return '<tr data-mxrow="1"><th scope="row">' + esc(st) + "</th>" + cells + "</tr>";
    }).join("");
    var table = '<table class="sv-matrix"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table>";
    var mob = statements.map(function (st) {
      var n = "mxm" + nid();
      var mbtns = scale.map(function (s, c) { return '<input type="radio" name="' + n + '" id="' + n + "-" + c + '" value="' + (c + 1) + '" /><label for="' + n + "-" + c + '">' + (c + 1) + "</label>"; }).join("");
      return '<div data-mxrow="1"><div class="stmt">' + esc(st) + '</div><div class="sv-scale" role="radiogroup" aria-label="' + esc(st) + '">' + mbtns + "</div></div>";
    }).join("");
    return qShell(def(label, "Please rate the following aspects"), desc, gate, required,
      table + '<div class="sv-matrix-mobile">' + mob + "</div>");
  }

  /* ── map ───────────────────────────────────────────────────────────────── */
  if (type === "map") {
    var shape = def(props.shape, "point");
    var tools =
      '<div class="sv-map__zoom"><button type="button" aria-label="Zoom in">+</button><button type="button" aria-label="Zoom out">−</button></div>' +
      '<div class="sv-map__tools">' +
      '<button type="button" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62A7.45 7.45 0 0 1 12.5 11c3.04 0 5.63 1.98 6.54 4.73l2.37-.78A9.01 9.01 0 0 0 12.5 8z"/></svg></button>' +
      '<button type="button" aria-label="Find my location"><svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14"/></svg></button>' +
      "</div>" +
      '<div class="sv-map__draw" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg></div>';
    var hint = '<p class="sv-map__hint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7h2v2h-2V7m0 4h2v6h-2v-6m1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20"/></svg> Click on the map to draw. Then, drag on points to move them.</p>';
    return qShell(def(label, "Where would you like new bicycle storage?"), def(desc, "Highlight a specific area on the map."), gate, required,
      hint + '<div class="sv-map" role="img" aria-label="Interactive map (' + esc(shape) + ' drawing)">' + tools + "</div>");
  }

  /* ── file_upload / shapefile_upload ────────────────────────────────────── */
  if (type === "file_upload" || type === "shapefile_upload") {
    var shapefile = type === "shapefile_upload";
    var cloud = '<svg viewBox="0 0 24 24"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14a6 6 0 0 0 6 6h13a5 5 0 0 0 .35-9.96M14 13v4h-4v-4H7l5-5 5 5z"/></svg>';
    var sub = shapefile ? "Esri shapefile (.zip containing .shp, .shx, .dbf)" : "PDF, PNG, JPG, DOCX — up to 50MB";
    var dLabel = shapefile ? "Upload your Esri shapefile" : "Share any related documents or photos";
    var dDesc = shapefile ? "For planners / GIS professionals." : "Upload files here";
    return qShell(def(label, dLabel), def(desc, dDesc), gate, required,
      '<div class="sv-drop" role="button" tabindex="0">' + cloud + '<span class="sv-drop__main"><b>Click to upload</b> or drag and drop</span><span class="sv-drop__sub">' + sub + "</span></div>");
  }

  return "";
});

/* ── theme-card ─────────────────────────────────────────────────────────── */
/* theme-card.js — canonical instance renderer for the Perspectives theme-card list.
 *
 * One source of truth: edit here and every linked demo updates.
 * GV.render("theme-card", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance exactly):
 *
 *   items   Array<{       list of ranked category cards (defaults = HEAD's 4 cards)
 *     active   boolean    add .is-active to this card    false (true on first by default)
 *     swatch   string     CSS colour for --gv-themecard-swatch (pastel bg of count badge)
 *     emoji    string     emoji glyph (rendered in .gv-themecard__emoji, aria-hidden)
 *     name     string     category display name
 *     count    number     response count shown in the badge
 *     desc     string     description paragraph
 *     barWidth string     CSS width value for the share bar fill   e.g. "85%"
 *     barColor string     CSS colour for --gv-themecard-bar (bar fill)
 *   }>
 *
 * GV.render("theme-card", {}) → reproduces the primary instance:
 *   four cards, first is .is-active, matching HEAD's copy/colours exactly.
 */
GV.register("theme-card", function (props) {
  props = props || {};
  var esc = GV.esc;

  var defaultItems = [
    {
      active:   true,
      swatch:   "rgb(255, 212, 216)",
      emoji:    "🚧",
      name:     "Infrastructure & Transportation",
      count:    57,
      desc:     "Concerns about road conditions, traffic congestion, public transit, and the inability of existing infrastructure to keep pace with population growth and development.",
      barWidth: "85%",
      barColor: "rgb(229, 147, 156)"
    },
    {
      active:   false,
      swatch:   "rgb(255, 235, 214)",
      emoji:    "💼",
      name:     "Economic Opportunity & Wages",
      count:    32,
      desc:     "Issues around low wages, lack of well-paying jobs, economic inequality, workforce development, and the need for better economic investment in communities.",
      barWidth: "56%",
      barColor: "rgb(229, 184, 140)"
    },
    {
      active:   false,
      swatch:   "rgb(221, 226, 243)",
      emoji:    "🏠",
      name:     "Housing & Cost of Living",
      count:    27,
      desc:     "Challenges related to rising housing costs, affordability, availability of homes, and the broader cost-of-living pressures facing residents.",
      barWidth: "48%",
      barColor: "rgb(163, 172, 207)"
    },
    {
      active:   false,
      swatch:   "rgb(208, 243, 231)",
      emoji:    "🩺",
      name:     "Healthcare & Public Health",
      count:    21,
      desc:     "Access to affordable healthcare, reproductive services, mental-health support, and stronger public-health provision across the region.",
      barWidth: "38%",
      barColor: "rgb(139, 207, 181)"
    }
  ];

  var items = props.items != null ? props.items : defaultItems;

  function renderCard(item) {
    var cls = "gv-themecard" + (item.active ? " is-active" : "");
    return (
      '<button type="button" class="' + cls + '" data-cy="e2e-topic-item"' +
        ' style="--gv-themecard-swatch: ' + esc(item.swatch) + '">' +
        '<span class="gv-themecard__main">' +
          '<span class="gv-themecard__head">' +
            '<span class="gv-themecard__name">' +
              '<span class="gv-themecard__emoji" aria-hidden="true">' + item.emoji + '</span>' +
              esc(item.name) +
            '</span>' +
            '<span class="gv-themecard__count">' + esc(String(item.count)) + '</span>' +
          '</span>' +
          '<span class="gv-themecard__desc">' + esc(item.desc) + '</span>' +
          '<span class="gv-themecard__bar">' +
            '<i style="width: ' + esc(item.barWidth) + '; --gv-themecard-bar: ' + esc(item.barColor) + '"></i>' +
          '</span>' +
        '</span>' +
      '</button>'
    );
  }

  return items.map(renderCard).join("\n");
});

/* ── twocol-accordion ─────────────────────────────────────────────────────────── */
/* twocol-accordion.js — canonical instance renderer for the two-column
 * image-left + (heading + intro + FAQ accordion) right Content-Builder section.
 *
 * GV.render("twocol-accordion") → reproduces the full .gv-cb-frame block
 * from HEAD verbatim (St Louis "Board of Aldermen about + FAQ" section).
 *
 * Props (all optional — defaults reproduce the primary HEAD instance):
 *
 *   heading  string   <h2> text in the right column
 *             default: "The Board of Aldermen is listening!"
 *
 *   intro    string   intro paragraph text beneath the heading
 *             default: "The Board of Aldermen's public engagement platform…"
 *
 *   items    Array of { q: string, body: string, open: boolean }
 *             default: the three St Louis FAQ items from HEAD, first item open
 *
 *   imageSlot string  raw HTML to place inside .gv-cb-image
 *             default: <div class="ph">Image</div>  (demo stand-in)
 */
GV.register("twocol-accordion", function (props) {
  props = props || {};
  var esc = GV.esc;

  var heading = props.heading != null
    ? props.heading
    : "The Board of Aldermen is listening!";

  var intro = props.intro != null
    ? props.intro
    : "The Board of Aldermen’s public engagement platform makes it easier for residents to share ideas with elected officials, connect with other residents, and stay up-to-date on policies and projects taking shape in St. Louis.";

  var imageSlot = props.imageSlot != null
    ? props.imageSlot
    : '<div class="ph">Image</div>';

  var DEFAULT_ITEMS = [
    {
      q: "What is Speak Up, St. Louis?",
      body: "Speak Up is where residents and the Board of Aldermen meet online. Browse active projects, react to and comment on ideas, take part in surveys, and follow the policies moving through City Hall — all in one place.",
      open: true
    },
    {
      q: "Who can take part?",
      body: "Anyone can read along. To post an idea, react, or answer a survey you’ll be asked to create a free account so the team knows your contribution comes from a real resident.",
      open: false
    },
    {
      q: "What happens to my contribution?",
      body: "Every contribution is read by the project team and grouped with similar input. Aldermen use what’s shared here to shape the policies and projects they bring forward, and project updates are posted back to participants as each phase opens.",
      open: false
    }
  ];

  var items = props.items !== undefined ? props.items : DEFAULT_ITEMS;

  var itemsHtml = items.map(function (item) {
    var openAttr = item.open ? " open" : "";
    return (
      '<details class="gv-acc__item"' + openAttr + ">" +
        '<summary class="gv-acc__head">' +
          '<span class="gv-acc__q">' + esc(item.q) + "</span>" +
          '<span class="gv-acc__chev" data-gv-icon="chevron-right" aria-hidden="true"></span>' +
        "</summary>" +
        '<div class="gv-acc__body"><p>' + esc(item.body) + "</p></div>" +
      "</details>"
    );
  }).join("\n              ");

  return (
    '<div class="gv-cb-frame">\n' +
    '  <div class="gv-cb-row cols-2">\n' +
    '\n' +
    '    <!-- LEFT: image cell -->\n' +
    '    <div class="gv-cb-col">\n' +
    '      <div class="gv-cb-image">' + imageSlot + '</div>\n' +
    '    </div>\n' +
    '\n' +
    '    <!-- RIGHT: rich-text column (heading + intro + accordion) -->\n' +
    '    <div class="gv-cb-col">\n' +
    '      <div class="gv-cb-textbox">\n' +
    '        <div class="gv-prose">\n' +
    '          <h2>' + esc(heading) + '</h2>\n' +
    '          <p>' + esc(intro) + '</p>\n' +
    '\n' +
    '          <div class="gv-accordion">\n' +
    '              ' + itemsHtml + '\n' +
    '          </div>\n' +
    '\n' +
    '        </div>\n' +
    '      </div>\n' +
    '    </div>\n' +
    '\n' +
    '  </div>\n' +
    '</div>'
  );
});

/* ── typography ─────────────────────────────────────────────────────────── */
/* typography.js — canonical instance renderer for a type-scale specimen row.
 * Registered onto window.GV via GV.register("typography", fn).
 * GV.render("typography", {}) reproduces the PRIMARY instance (Title h1 — 30) exactly.
 *
 * The "component" is ONE specimen row: a tagged element with the right .gv-* classes,
 * sample text, and an inline margin. The demo iterates the full scale by mounting each
 * row with its own props.
 *
 * Props (all optional — defaults reproduce the h1 primary instance):
 *
 *   tag        : string  — HTML tag name                  (default "h1")
 *   className  : string  — space-separated class list     (default "gv-title h1")
 *   text       : string  — visible specimen text          (default "Title h1 — 30")
 *   margin     : string  — inline margin value            (default "0 0 8px")
 *   extraClass : string  — additional class appended to className  (default "")
 *                          convenience for modifier classes like "gv-text--secondary"
 *
 * Byte-faithful to HEAD: class names, inline style format, sample text, and tag are
 * identical. Nothing is hardcoded beyond what appears in HEAD.
 */
GV.register("typography", function (props) {
  props = props || {};
  var esc = GV.esc;

  var tag        = props.tag        !== undefined ? props.tag        : "h1";
  var className  = props.className  !== undefined ? props.className  : "gv-title h1";
  var text       = props.text       !== undefined ? props.text       : "Title h1 — 30";
  var margin     = props.margin     !== undefined ? props.margin     : "0 0 8px";
  var extraClass = props.extraClass !== undefined ? props.extraClass : "";

  var fullClass = className + (extraClass ? " " + extraClass : "");
  var styleAttr = margin ? ' style="margin:' + esc(margin) + '"' : "";

  return "<" + esc(tag) + ' class="' + esc(fullClass) + '"' + styleAttr + ">" +
    esc(text) +
    "</" + esc(tag) + ">";
});

/* ── volunteer-cause ─────────────────────────────────────────────────────────── */
/* volunteer-cause.js — canonical instance renderer for .gv-cause.
 * One source of truth: edit here and every linked demo updates.
 * GV.render("volunteer-cause", props) → canonical HTML string.
 *
 * Props (all optional — defaults reproduce the primary instance: sign-up state):
 *
 *   title            string   heading text
 *                             default: "Volunteer residential care centers 'Out and about with residents'"
 *   img              string   image src URL
 *                             default: "https://images.unsplash.com/photo-1599058917212-d750089bc07e?w=600&h=300&fit=crop"
 *   participantLabel string   text shown in both the media badge and the body count
 *                             default: "1 participant"
 *   descParagraphs   Array    array of paragraph HTML strings rendered in .gv-cause__desc
 *                             default: the three paragraphs from the primary HEAD instance
 *                             (plain strings; may contain inline HTML like <strong>…</strong>)
 *   signedUp         boolean  false → "I want to participate" button (default)
 *                             true  → "I withdraw my offer to volunteer" button (.is-in)
 *   btnLabel         string   CTA button label; defaults per signedUp state if omitted
 *
 * Variants demonstrated in HEAD:
 *   {}                         → primary: default sign-up state, 1 participant
 *   { signedUp: true, … }     → signed-up / withdraw state
 *
 * GV.render("volunteer-cause")             → primary (sign-up, 1 participant)
 * GV.render("volunteer-cause", { signedUp: true, … }) → withdraw state
 */
GV.register("volunteer-cause", function (props) {
  props = props || {};
  var esc = GV.esc;

  var title = props.title != null
    ? props.title
    : "Volunteer residential care centers ‘Out and about with residents’";

  var img = props.img != null
    ? props.img
    : "https://images.unsplash.com/photo-1599058917212-d750089bc07e?w=600&h=300&fit=crop";

  var participantLabel = props.participantLabel != null
    ? props.participantLabel
    : "1 participant";

  var DEFAULT_DESC = [
    "<p>You take the residents of the residential care center outside for a walk or do some shopping together.</p>",
    "<p><strong>WHAT DO WE EXPECT?</strong></p>",
    "<p>Do you like being outside and can you drive a wheelchair? And do you have a socially sensitive heart for older people?</p>"
  ];

  var descParagraphs = props.descParagraphs !== undefined
    ? props.descParagraphs
    : DEFAULT_DESC;

  var signedUp = props.signedUp ? true : false;

  var defaultBtnLabel = signedUp ? "I withdraw my offer to volunteer" : "I want to participate";
  var btnLabel = props.btnLabel != null ? props.btnLabel : defaultBtnLabel;

  var descHtml = descParagraphs.join("");
  var btnClass = "gv-btn volunteer" + (signedUp ? " is-in" : "");

  return (
    '<article class="gv-cause">' +
      '<div class="gv-cause__media">' +
        '<img class="gv-cause__img" alt="" src="' + esc(img) + '" />' +
        '<span class="gv-cause__badge"><span data-gv-icon="volunteer"></span>' + esc(participantLabel) + '</span>' +
      '</div>' +
      '<div class="gv-cause__body">' +
        '<h3 class="gv-cause__title">' + esc(title) + '</h3>' +
        '<span class="gv-cause__count">' + esc(participantLabel) + '</span>' +
        '<div class="gv-cause__desc">' +
          descHtml +
        '</div>' +
        '<div class="gv-cause__cta">' +
          '<button class="' + esc(btnClass) + '" type="button"><span data-gv-icon="volunteer"></span>' + esc(btnLabel) + '</button>' +
        '</div>' +
      '</div>' +
    '</article>'
  );
});

/* ── voting ─────────────────────────────────────────────────────────── */
/* voting.js — canonical instance renderer for the project-page embedded events section.
 *
 * NOTE: the component folder is named `voting`, but the faithful-lift HEAD source for
 * components/voting/index.html is the PROJECT-PAGE EMBEDDED EVENTS SECTION — the
 * "Upcoming and ongoing events" + "Past events" sections a project page renders below
 * the phase body. This renderer reproduces that block byte-faithfully and is keyed to
 * the component name "voting" per the Augur registry contract.
 *
 * Pure assembly over canonical primitives: the `.gv-project-events` scaffold (container +
 * per-heading `.gv-project-events__sec`, divider rule, plain empty-state line) wrapping the
 * shared `.gv-events-page__sectionhead` (h2 + optional `.gv-eventfilters` Date pill), then
 * either a `.gv-project-events__empty` line or a `.gv-events__grid` of `.gv-event-card`s.
 * Re-skins per ?theme= (default tenant-primary #112D7E, the wietsedemo capture).
 *
 * Props (all optional — defaults reproduce the primary HEAD instance exactly):
 *
 *   id        string   container id        default "e2e-events-section-project-page"
 *   sections  Array of section objects (default = the 2 HEAD sections)
 *             Each section object:
 *               heading      string   the h2 text                              [required]
 *               dateFilter   boolean  show the FO Date filter pill on the right  default false
 *               filterId     string   id on the .gv-eventfilters wrapper        default "e2e-event-date-filter"
 *               empty        string   plain empty-state line text (when no cards)
 *               cards        Array of event-card objects (renders a .gv-events__grid)
 *                 Each card object:
 *                   title        string   event title (linked)                  [required]
 *                   href         string   title/CTA link                        default "#"
 *                   hasMedia     boolean  show the .gv-event-card__media block   default true
 *                   month        string   date chip month abbreviation          e.g. "Feb"
 *                   day          string   date chip day number                  e.g. "22"
 *                   year         string   date chip year                        e.g. "2026"
 *                   rows         Array of { icon: string, html: string }        meta rows
 *                   ctaLabel     string   CTA button label                      default "Read more"
 *
 * GV.render("voting")                 → primary HEAD section (Upcoming/ongoing empty + Past grid)
 * GV.render("voting", {sections})     → custom set of project-page event sections
 */
GV.register("voting", function (props) {
  props = props || {};
  var esc = GV.esc;

  var DEFAULT_SECTIONS = [
    {
      heading: "Upcoming and ongoing events",
      dateFilter: true,
      filterId: "e2e-event-date-filter",
      empty: "No upcoming or ongoing events are currently scheduled."
    },
    {
      heading: "Past events",
      dateFilter: false,
      cards: [
        {
          title: "Presentation of final Main Square design",
          href: "#",
          hasMedia: true,
          month: "Feb",
          day: "22",
          year: "2026",
          rows: [
            { icon: "clock", html: "22 Feb 2026 · 17:30 – 19:30 CET" },
            { icon: "user",  html: "3 registrants" }
          ],
          ctaLabel: "Read more"
        }
      ]
    }
  ];

  var id = props.id != null ? props.id : "e2e-events-section-project-page";
  var sections = (props.sections !== undefined) ? props.sections : DEFAULT_SECTIONS;

  function renderCard(card) {
    var hasMedia = card.hasMedia !== false; /* default true */
    var href = card.href != null ? card.href : "#";
    var media = hasMedia
      ? "              <div class=\"gv-event-card__media\">\n" +
        "                <span data-gv-icon=\"calendar\" aria-hidden=\"true\"></span>\n" +
        "              </div>\n"
      : "";

    var rows = (card.rows || []).map(function (row) {
      return "                  <p class=\"gv-event-card__row\"><span data-gv-icon=\"" +
        esc(row.icon) + "\"></span> " + row.html + "</p>";
    }).join("\n");

    return (
      "            <article class=\"e2e-event-card gv-event-card bordered has-panel\">\n" +
      media +
      "              <div class=\"gv-event-card__body\">\n" +
      "                <div class=\"gv-event-card__titlerow\">\n" +
      "                  <h3 class=\"gv-event-card__title\"><a href=\"" + esc(href) + "\">" + esc(card.title || "") + "</a></h3>\n" +
      "                  <span class=\"gv-event-card__date is-beside\"><span class=\"m\">" + esc(card.month || "") + "</span><span class=\"d\">" + esc(card.day || "") + "</span><span class=\"y\">" + esc(card.year || "") + "</span></span>\n" +
      "                </div>\n" +
      "                <div class=\"gv-event-card__meta\">\n" +
      rows + "\n" +
      "                </div>\n" +
      "                <a class=\"gv-btn primary\" href=\"" + esc(href) + "\">" + esc(card.ctaLabel != null ? card.ctaLabel : "Read more") + "</a>\n" +
      "              </div>\n" +
      "            </article>"
    );
  }

  function renderSection(sec) {
    var filter = sec.dateFilter
      ? "\n\n            <!-- FO filter pill (Date). Click toggles aria-expanded (chevron flip). -->\n" +
        "            <div class=\"gv-eventfilters\" id=\"" + esc(sec.filterId != null ? sec.filterId : "e2e-event-date-filter") + "\">\n" +
        "              <div class=\"gv-filter\">\n" +
        "                <button type=\"button\" class=\"gv-filter-pill\" aria-haspopup=\"listbox\" aria-expanded=\"false\" aria-label=\"Date\">\n" +
        "                  Date\n" +
        "                  <svg viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z\"></path></svg>\n" +
        "                </button>\n" +
        "              </div>\n" +
        "            </div>\n          "
      : "\n          ";

    var body;
    if (sec.cards) {
      body =
        "\n\n          <div class=\"gv-events__grid\">\n" +
        sec.cards.map(renderCard).join("\n") + "\n" +
        "          </div>";
    } else {
      body =
        "\n\n          <!-- Live state: no upcoming/ongoing events scheduled (plain line, not the dashed box) -->\n" +
        "          <p class=\"gv-project-events__empty\">" + esc(sec.empty || "") + "</p>";
    }

    return (
      "        <section class=\"gv-project-events__sec\">\n" +
      "          <div class=\"gv-events-page__sectionhead\">\n" +
      "            <h2 class=\"gv-events-page__section\">" + esc(sec.heading || "") + "</h2>" +
      filter +
      "</div>\n" +
      "          <hr class=\"gv-project-events__rule\" aria-hidden=\"true\" />" +
      body + "\n" +
      "        </section>"
    );
  }

  var secHtml = sections.map(renderSection).join("\n\n");

  return (
    "<div id=\"" + esc(id) + "\" class=\"gv-project-events\">\n\n" +
    secHtml +
    "\n\n      </div>"
  );
});

/* ── shorthands: GV.<name>(props) for every registered component (skips names
   already on the API and non-identifier/hyphenated names — use GV.render('a-b', p)
   for those). One source of truth stays GV.render / GV.mount. ── */
(function () {
  Object.keys(GV.components).forEach(function (n) {
    if (GV[n] || /[^A-Za-z0-9_$]/.test(n)) return;
    GV[n] = function (props) { return GV.render(n, props); };
  });
})();

/* ── declarative instances (Augur Phase 4) ───────────────────────────────────
 * A prototype drops a LINKED component in declaratively, instead of writing its own
 * mount script:
 *   <div data-gv-instance="participation-box" data-gv-props='{"actions":[…]}'></div>
 * GV.mountAll() renders every such node from the canonical registry on load, so the
 * instance tracks the master (edit the renderer → every prototype reflows on reload).
 * Props are JSON in data-gv-props (use a single-quoted attribute so the JSON keeps
 * its double quotes). This is also what makes `npm run detach` deterministic: the
 * detach CLI reads the same attributes, runs GV.render(name, props) in node, freezes
 * the output inline, and stamps data-gv-detached — which makes mountAll SKIP the node
 * (a detached instance is a local fork; it must not be re-rendered from canonical).
 * Idempotent: a node is mounted at most once (__gvMounted). Library demos use the
 * imperative GV.mount(...) and carry no data-gv-instance, so they're untouched. ── */
GV.mountAll = function (root) {
  root = (root && root.querySelectorAll) ? root : document;
  var nodes = root.querySelectorAll("[data-gv-instance]:not([data-gv-detached])");
  Array.prototype.forEach.call(nodes, function (el) {
    if (el.__gvMounted) return;
    var name = el.getAttribute("data-gv-instance");
    var props = {};
    var raw = el.getAttribute("data-gv-props");
    if (raw) { try { props = JSON.parse(raw); } catch (e) { if (window.console) console.warn("GV.mountAll: bad data-gv-props on", el, e); return; } }
    try { el.innerHTML = GV.render(name, props); el.__gvMounted = 1; GV.hydrate(el); }
    catch (e) { if (window.console) console.warn("GV.mountAll: " + e.message, el); }
  });
  return root;
};
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { GV.mountAll(); });
  else GV.mountAll(); // defer script: DOM already parsed
}
