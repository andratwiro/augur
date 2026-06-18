/* govocal-partbar.js — participation-bar dock behaviour (canonical).

   Responsive docking, mirroring the live product:
   • MOBILE (≤760px): the bar docks to the BOTTOM of the viewport as soon as the bottom
     of the viewport makes contact with the bottom of the bar, and stays docked as you
     scroll further down; it releases back to its inline home when you scroll back up.
   • DESKTOP (>760px): the bar sticks to the TOP, just under the sticky header, once its
     top reaches the upper edge of the viewport. This is handled natively by CSS
     position:sticky (see the @media (min-width:761px) block in govocal-ui.css) — sticky
     reserves the bar's space, so no JS docking is needed; this script only toggles
     .is-stuck so a drop shadow appears while the bar is pinned.

   On MOBILE no space is reserved at the bar's inline home (the content below it is
   off-screen at the dock moment, so letting it collapse leaves NO visible gap). A
   trailing spacer only adds enough scroll room for the page-end content to clear the
   docked bar.

   Drop-in: include this script on any page that renders .gv-partbar; it self-wires on
   DOMContentLoaded. Pairs with the .gv-partbar CSS (.is-docked = mobile bottom dock,
   position:sticky + .is-stuck = desktop top dock). */
(function () {
  var MOBILE = '(max-width: 760px)';

  function initBar(bar) {
    if (bar.__gvPartbar) return;
    bar.__gvPartbar = true;

    // 0-height marker left at the bar's inline home, so we can tell where the bar's
    // home sits relative to the viewport while it is detached (mobile) or pinned (desktop).
    var anchor = document.createElement('div');
    anchor.setAttribute('aria-hidden', 'true');
    anchor.className = 'gv-partbar__anchor';
    anchor.style.cssText = 'height:0;margin:0;padding:0;border:0;';
    bar.parentNode.insertBefore(anchor, bar);

    // Trailing spacer (end of body) — gives the last content room to clear the fixed
    // bar while docked on mobile. Height 0 until docked; unused on desktop (sticky
    // reserves its own space).
    var spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.className = 'gv-partbar__tail';
    spacer.style.cssText = 'height:0;';
    document.body.appendChild(spacer);

    var header = document.querySelector('.gv-header.sticky');
    var docked = false;   // mobile bottom-dock state
    var barH = 0;

    function clearMobile() {
      if (docked) { docked = false; bar.classList.remove('is-docked'); spacer.style.height = '0px'; }
    }

    function update() {
      var vh = window.innerHeight || document.documentElement.clientHeight;
      // Only engage on a genuinely scrollable page — short demo pages keep the bar inline.
      var scrollable = (document.documentElement.scrollHeight - vh) > 4;

      if (window.matchMedia(MOBILE).matches) {
        // ── MOBILE: dock to the BOTTOM ───────────────────────────────────────────
        bar.classList.remove('is-stuck');                          // shed any desktop state
        if (!docked) barH = bar.offsetHeight;                      // stable height from flow state
        var homeBottom = anchor.getBoundingClientRect().top + barH; // where the bar's bottom sits in flow
        if (!docked) {
          if (scrollable && homeBottom <= vh + 0.5) {              // bottom of screen reached bottom of bar
            docked = true;
            bar.classList.add('is-docked');
            spacer.style.height = barH + 'px';
          }
        } else if (homeBottom > vh + 0.5) {                        // scrolled back up above the home
          clearMobile();
        }
      } else {
        // ── DESKTOP: stick to the TOP (CSS position:sticky pins it) ──────────────
        clearMobile();                                             // shed any mobile dock state
        var topOffset = header ? header.offsetHeight : 0;          // sticky header height (bar pins beneath it)
        var stuck = scrollable && anchor.getBoundingClientRect().top <= topOffset + 0.5;
        bar.classList.toggle('is-stuck', stuck);                   // drop shadow only while pinned
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
    // Re-evaluate when crossing the mobile/desktop breakpoint (cleans up the other mode).
    if (window.matchMedia(MOBILE).addEventListener) {
      window.matchMedia(MOBILE).addEventListener('change', onScroll);
    }
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
