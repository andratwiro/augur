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

  var api = { render: render, mount: mount, hydrate: hydrate, register: register, components: registry };
  // shorthands: GV.sidebar(props), etc. (one per registered component)
  api.sidebar = sidebar;
  return api;
})();
