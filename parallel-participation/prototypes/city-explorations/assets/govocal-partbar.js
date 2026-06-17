/* govocal-partbar.js — participation-bar dock behaviour (canonical).

   The .gv-partbar sits inline in the page flow (e.g. between the project context
   and the phase content). As soon as the BOTTOM of the viewport makes contact with
   the BOTTOM of the bar, it docks to the footer (position:fixed, bottom:0) and stays
   docked as you scroll further down; it releases back to its inline home when you
   scroll back up above it.

   No space is reserved at the bar's inline home — the content below it is off-screen
   at the dock moment, so letting it collapse leaves NO visible gap. A trailing spacer
   only adds enough scroll room for the page-end content to clear the docked footer.

   Drop-in: include this script on any page that renders .gv-partbar; it self-wires on
   DOMContentLoaded. Pairs with the .gv-partbar / .gv-partbar.is-docked CSS. */
(function () {
  function initBar(bar) {
    if (bar.__gvPartbar) return;
    bar.__gvPartbar = true;

    // 0-height marker left at the bar's inline home, so we can tell when the home
    // scrolls back into reach while the bar is detached (docked).
    var anchor = document.createElement('div');
    anchor.setAttribute('aria-hidden', 'true');
    anchor.className = 'gv-partbar__anchor';
    anchor.style.cssText = 'height:0;margin:0;padding:0;border:0;';
    bar.parentNode.insertBefore(anchor, bar);

    // Trailing spacer (end of body) — gives the last content room to clear the
    // fixed footer while docked. Height 0 until docked.
    var spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.className = 'gv-partbar__tail';
    spacer.style.cssText = 'height:0;';
    document.body.appendChild(spacer);

    var docked = false;
    var barH = 0;

    function update() {
      if (!docked) barH = bar.offsetHeight;                       // stable height from flow state
      var vh = window.innerHeight || document.documentElement.clientHeight;
      // Only dock on a genuinely scrollable page — short demo pages keep the bar inline.
      var scrollable = (document.documentElement.scrollHeight - vh) > 4;
      var homeBottom = anchor.getBoundingClientRect().top + barH; // where the bar's bottom sits in flow
      if (!docked) {
        if (scrollable && homeBottom <= vh + 0.5) {               // bottom of screen reached bottom of bar
          docked = true;
          bar.classList.add('is-docked');
          spacer.style.height = barH + 'px';
        }
      } else if (homeBottom > vh + 0.5) {                         // scrolled back up above the home
        docked = false;
        bar.classList.remove('is-docked');
        spacer.style.height = '0px';
      }
    }

    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; update(); });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
  }

  function initAll() {
    var bars = document.querySelectorAll('.gv-partbar');
    for (var i = 0; i < bars.length; i++) initBar(bars[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  window.GVPartbar = { init: initAll };
})();
