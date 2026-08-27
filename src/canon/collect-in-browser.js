/**
 * canon — collect evidence from a product you are ALREADY SIGNED IN TO.
 *
 * Paste this whole file into your browser's developer console, on a page of your own
 * product, while you are logged in. It reads what the page actually renders and prints
 * an `observation` — the same object `augur canon collect <url>` produces for a public
 * page, so everything downstream is identical whichever way you got here.
 *
 * WHY IT RUNS IN YOUR BROWSER. The people who need a design system extracted hold a
 * login, not repo access, and their product is behind that login. Nothing here leaves
 * the page: no request is made, no credential is read, no cookie is touched. It walks
 * the DOM you are looking at, asks the browser what colour and size each element ended
 * up, and counts. You can read every line of it before you paste it.
 *
 * WHAT COMES OUT is evidence, not a design system: ranked colours (weighted by how much
 * of the screen they actually cover, which is the signal a stylesheet cannot give you),
 * font stacks, the sizes and gaps in use, the radii, the shadows, whatever custom
 * properties the product already declares, and the class families that are candidate
 * components. Deciding which grey is the hairline and which colour is the one hot ink is
 * the next step, and it is not this file's job.
 *
 * Run it on three or four DIFFERENT screens and keep all of them — a login page is not
 * a design system. `augur canon collect --merge` folds them together.
 */
(function () {
  "use strict";

  var MAX_ELEMENTS = 12000;

  var COLOR_PROPS = ["color", "backgroundColor", "borderTopColor", "borderRightColor",
    "borderBottomColor", "borderLeftColor", "outlineColor", "fill", "stroke"];
  /* A border colour on an edge that draws no border is the browser's default, not the
     product's decision. Counting it puts the user-agent grey of every <table> near the
     top of the evidence, wearing exactly the profile a hairline colour has — seen on
     border properties and nothing else — which is the one tell the mapping relies on. */
  var BORDER_SIDE = {
    borderTopColor: "borderTop", borderRightColor: "borderRight",
    borderBottomColor: "borderBottom", borderLeftColor: "borderLeft",
  };
  var SPACE_PROPS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "marginTop", "marginRight", "marginBottom", "marginLeft", "rowGap", "columnGap"];

  function Tally() { this.m = {}; }
  Tally.prototype.add = function (value, where, prop, area) {
    if (!value || value === "none" || value === "normal" || value === "auto" || value === "0px") return;
    if (value === "rgba(0, 0, 0, 0)" || value === "transparent") return;
    var e = this.m[value];
    if (!e) e = this.m[value] = { value: value, count: 0, area: 0, props: {}, where: [] };
    e.count++;
    e.area += area || 0;
    e.props[prop] = 1;
    if (e.where.length < 4 && where && e.where.indexOf(where) < 0) e.where.push(where);
  };
  Tally.prototype.ranked = function (byArea) {
    var out = [];
    for (var k in this.m) if (Object.prototype.hasOwnProperty.call(this.m, k)) out.push(this.m[k]);
    out.sort(function (a, b) {
      if (byArea && b.area !== a.area) return b.area - a.area;
      return b.count - a.count || (a.value < b.value ? -1 : 1);
    });
    return out.slice(0, 60).map(function (e) {
      return { value: e.value, count: e.count, area: Math.round(e.area), props: Object.keys(e.props).slice(0, 6), where: e.where };
    });
  };

  /* A short, readable description of where a value was seen: tag plus its own classes. */
  function whereOf(el) {
    var cls = (el.getAttribute && el.getAttribute("class")) || "";
    return (el.tagName || "?").toLowerCase() + (cls ? "." + cls.trim().split(/\s+/).slice(0, 2).join(".") : "");
  }

  var colors = new Tally(), fontStacks = new Tally(), fontSizes = new Tally();
  var lineHeights = new Tally(), fontWeights = new Tally(), spacings = new Tally();
  var radii = new Tally(), shadows = new Tally(), motions = new Tally();
  var fams = {};
  var elements = 0;

  var all = document.querySelectorAll("body *");
  for (var i = 0; i < all.length && i < MAX_ELEMENTS; i++) {
    var el = all[i];
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    if (!cs || cs.display === "none" || cs.visibility === "hidden") continue;
    var rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    elements++;
    var area = Math.min(rect.width * rect.height, 4000000);
    var where = whereOf(el);
    var hasText = false;
    for (var n = 0; n < el.childNodes.length; n++) {
      if (el.childNodes[n].nodeType === 3 && el.childNodes[n].nodeValue.trim()) { hasText = true; break; }
    }
    for (var c = 0; c < COLOR_PROPS.length; c++) {
      var prop = COLOR_PROPS[c];
      var side = BORDER_SIDE[prop];
      if (side && (cs[side + "Style"] === "none" || parseFloat(cs[side + "Width"]) === 0)) continue;
      /* Text colour is weighted by the ink it puts on the page, not by the box: a huge
         container inheriting a colour it never paints would otherwise outrank the body. */
      var weight = prop === "color" ? (hasText ? Math.min(area, 40000) : 0) : area;
      if (weight) colors.add(cs[prop], where, prop, weight);
    }
    fontStacks.add(cs.fontFamily, where, "font-family", hasText ? area : 0);
    if (hasText) {
      fontSizes.add(cs.fontSize, where, "font-size", area);
      lineHeights.add(cs.lineHeight, where, "line-height", area);
      fontWeights.add(cs.fontWeight, where, "font-weight", area);
    }
    for (var s = 0; s < SPACE_PROPS.length; s++) spacings.add(cs[SPACE_PROPS[s]], where, "spacing", 1);
    radii.add(cs.borderTopLeftRadius, where, "border-radius", area);
    shadows.add(cs.boxShadow, where, "box-shadow", area);
    if (cs.transitionDuration && cs.transitionDuration !== "0s") {
      motions.add(cs.transitionDuration + " " + cs.transitionTimingFunction, where, "transition", 1);
    }
    var list = el.classList;
    for (var q = 0; list && q < list.length; q++) {
      var name = list[q];
      if (!/^[a-zA-Z][\w-]{2,}$/.test(name)) continue;
      var parts = name.split(/[-_]/);
      if (parts.length < 2) continue;
      var root = parts.slice(0, 2).join("-");
      var f = fams[root] || (fams[root] = { root: root, uses: 0, members: {} });
      f.uses++;
      f.members[name] = 1;
    }
  }

  /* Custom properties the product already declares. A cross-origin stylesheet throws on
     .cssRules and there is nothing to be done about it — skip it and say so, rather than
     failing the whole collection over a stylesheet on a CDN. */
  var props = {}, blockedSheets = 0, readSheets = 0;
  function eatRules(rules) {
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      if (rule.style) {
        for (var k = 0; k < rule.style.length; k++) {
          var nm = rule.style[k];
          if (nm.slice(0, 2) === "--" && props[nm] === undefined) props[nm] = rule.style.getPropertyValue(nm).trim();
        }
      }
      if (rule.cssRules) eatRules(rule.cssRules);
    }
  }
  for (var t = 0; t < document.styleSheets.length; t++) {
    try { eatRules(document.styleSheets[t].cssRules); readSheets++; }
    catch (e) { blockedSheets++; }
  }

  var famList = [];
  for (var key in fams) if (Object.prototype.hasOwnProperty.call(fams, key)) {
    var mem = Object.keys(fams[key].members);
    if (fams[key].uses > 1) famList.push({ root: key, uses: fams[key].uses, members: mem.slice(0, 10) });
  }
  famList.sort(function (a, b) { return b.members.length - a.members.length || b.uses - a.uses; });

  var propList = [];
  for (var pk in props) if (Object.prototype.hasOwnProperty.call(props, pk)) propList.push({ name: pk, value: props[pk] });
  propList.sort(function (a, b) { return a.name < b.name ? -1 : 1; });

  var observation = {
    observationVersion: 1,
    source: {
      url: location.href,
      collectedAt: new Date().toISOString(),
      how: "browser",
      pages: [location.href],
      title: document.title,
      viewport: innerWidth + "x" + innerHeight,
      blockedSheets: blockedSheets,
    },
    stats: { sheets: readSheets, rules: 0, declarations: 0, elements: elements },
    colors: colors.ranked(true),
    fontStacks: fontStacks.ranked(true),
    fontSizes: fontSizes.ranked(true),
    lineHeights: lineHeights.ranked(true),
    fontWeights: fontWeights.ranked(true),
    spacings: spacings.ranked(false),
    radii: radii.ranked(true),
    shadows: shadows.ranked(true),
    motions: motions.ranked(false),
    customProperties: propList,
    classFamilies: famList.slice(0, 40),
  };

  var json = JSON.stringify(observation, null, 2);
  try { window.__augurObservation = observation; } catch (e) { /* sandboxed page */ }

  /* Three ways out, because a console differs by browser and by how locked down the page
     is. The file download is the one that always works; the rest are conveniences. */
  try {
    var name = "observation-" + location.hostname.replace(/[^a-z0-9]+/gi, "-") + "-" + Date.now() + ".json";
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    console.log("canon: saved " + name + " to your downloads — move it into your canon folder.");
  } catch (e) {
    console.log("canon: could not download; copy the JSON printed below.");
  }
  try { if (typeof copy === "function") { copy(json); console.log("canon: also copied to your clipboard."); } } catch (e) { /* not a console */ }

  console.log("canon: " + elements + " elements, " + observation.colors.length + " colours, "
    + observation.fontStacks.length + " font stacks, " + propList.length + " custom properties"
    + (blockedSheets ? ", " + blockedSheets + " stylesheet(s) unreadable (cross-origin — computed styles still counted)" : "")
    + ". It is on window.__augurObservation too.");
  console.log("canon: run this on three or four DIFFERENT screens and keep every file. One page is not a design system.");

  return observation;
})();
