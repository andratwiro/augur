/* GoVocal back-office shared sidebar chrome (page-local helper, not a canonical asset).
   Renders the persistent admin sidebar into <nav class="gv-bo-side" data-active="<key>">,
   linking every BO reference page to its siblings so the set is clickable. Pure assembly:
   it only USES the canonical .gv-bo-* classes — it defines no styles and copies no asset. */
(function () {
  var TOP = [
    ["dashboard",   "Dashboard",         "admin-dashboard",   "../bo-dashboard/"],
    ["projects",    "Projects",          "admin-projects",    "../bo-projects/"],
    ["input",       "Input manager",     "admin-input",       "../bo-input-manager/"],
    ["users",       "Users",             "admin-users",       "../bo-users/"],
    ["messaging",   "Messaging",         "admin-messaging",   "../bo-messaging/"],
    ["reporting",   "Reporting",         "admin-reporting",   "../bo-reporting/"],
    ["community",   "Community monitor", "admin-community",   "../bo-community-monitor/"],
    ["inspiration", "Inspiration hub",   "admin-inspiration", "../bo-inspiration-hub/"],
  ];
  var BOTTOM = [
    ["tools",         "Tools",        "admin-tools",         "../bo-tools/"],
    ["pages",         "Pages & menu", "admin-pages",         "../bo-pages-menu/"],
    ["settings",      "Settings",     "admin-settings",      "../bo-settings/"],
    ["notifications", "Notifications","admin-notifications", "../bo-notifications/", "29"],
  ];

  function item(active, def) {
    var key = def[0], label = def[1], icon = def[2], href = def[3], count = def[4];
    var on = key === active ? " is-active" : "";
    var badge = count ? '<span class="gv-bo-count">' + count + "</span>" : "";
    return '<a class="gv-bo-nav__item' + on + '" href="' + href + '">' +
      '<span class="gv-bo-nav__icon" data-gv-icon="' + icon + '"></span>' +
      '<span class="gv-bo-nav__label">' + label + "</span>" + badge + "</a>";
  }

  function render(el) {
    var active = el.getAttribute("data-active") || "";
    el.innerHTML =
      '<a class="gv-bo-side__brand" href="../homepage/">' +
        '<span class="gv-bo-side__logo"><span data-gv-icon="admin-back" style="color:#fff"></span></span> To platform</a>' +
      '<div class="gv-bo-nav">' + TOP.map(function (d) { return item(active, d); }).join("") + "</div>" +
      '<div class="gv-bo-nav gv-bo-nav--bottom">' +
        BOTTOM.map(function (d) { return item(active, d); }).join("") +
        '<a class="gv-bo-nav__item" href="#"><span class="gv-bo-avatar" data-gv-icon="user"></span>' +
          '<span class="gv-bo-nav__label">Go Vocal Admin<span class="gv-bo-nav__sub">Administrator</span></span>' +
          '<span class="gv-bo-chev" data-gv-icon="chevron-right"></span></a>' +
        '<a class="gv-bo-nav__item" href="#"><span class="gv-bo-nav__icon" style="color:var(--gv-green-400)" data-gv-icon="admin-support"></span>' +
          '<span class="gv-bo-nav__label">Support</span><span class="gv-bo-chev" data-gv-icon="chevron-right"></span></a>' +
      "</div>";
  }

  document.querySelectorAll(".gv-bo-side[data-active]").forEach(render);
  if (window.GVIcons) window.GVIcons.render(document.body);
})();
