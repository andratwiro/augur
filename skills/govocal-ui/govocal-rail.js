/* govocal-rail.js — scroll-aware edge fades for .gv-rail carousels.
   At rest the first card sits flush with the section title (no left fade); a left
   fade appears once scrolled, and the right fade drops at the end. Pairs with the
   .rail--fade-left / .rail--fade-right rules in govocal-ui.css. */
(function () {
  function update(rail) {
    var max = rail.scrollWidth - rail.clientWidth;
    var x = rail.scrollLeft;
    var overflowing = max > 1;
    rail.classList.toggle('rail--fade-left', overflowing && x > 1);
    rail.classList.toggle('rail--fade-right', overflowing && x < max - 1);
  }
  function init(root) {
    (root || document).querySelectorAll('.gv-rail').forEach(function (rail) {
      if (rail.dataset.railbound !== undefined) return;
      rail.dataset.railbound = '';
      update(rail);
      rail.addEventListener('scroll', function () { update(rail); }, { passive: true });
    });
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', function () { init(); });
  // re-measure after async content (web fonts, avatar faces) shifts widths
  window.addEventListener('load', function () { init(); document.querySelectorAll('.gv-rail').forEach(update); });
  window.addEventListener('resize', function () { document.querySelectorAll('.gv-rail').forEach(update); });
  window.GVRail = { init: init, update: update };
})();
