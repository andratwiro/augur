/* ══════════════════════════════════════════════════════════════════════════
   BLUE RAIL — v3 COMMITS to Option 1 (TOOLTIP): a readable global rail.
   Two fixes only, applied permanently (no switcher):
     • CONTRAST — inactive icons go from canon's too-dim --gv-blue-400 to a
       readable slate on navy; the active item stays teal.
     • CONTEXT  — on hover, the item's existing label flies out to the right as a
       small dark tooltip (reusing .gv-bo-nav__label / the brand "To platform"
       text), so there's no need for the dev's permanent open/close arrow.
   Prototype-local, DETACHED FROM CANON (assets/govocal-bo.css → .gv-bo-side is
   untouched). The full 5-option explorer lives in parallel-editor-builder-v2 as
   the backup/lab.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  var CSS = `
  /* Contrast: a readable inactive icon (canon's --gv-blue-400 is too dim on navy). */
  .gv-bo-side .gv-bo-nav__icon { color: #b7c2d2; }
  .gv-bo-side .gv-bo-nav__item.is-active .gv-bo-nav__icon { color: var(--gv-teal-400); }
  .gv-bo-side .gv-bo-nav__item:hover .gv-bo-nav__icon { color: #fff; }

  /* Context: the existing label flies out to the right as a dark tooltip on hover. */
  .gv-bo-side { overflow: visible; }
  .gv-bo-side .gv-bo-nav__item:hover > .gv-bo-nav__label,
  .gv-bo-side .gv-bo-side__brand:hover > .gv-bo-side__brandtext {
    display: block; position: absolute; left: calc(100% + 12px); top: 50%; transform: translateY(-50%);
    background: #1a1f2c; color: #fff; padding: 6px 11px; border-radius: 7px;
    font-size: 12.5px; font-weight: 600; line-height: 1; white-space: nowrap;
    box-shadow: 0 8px 22px rgba(0,0,0,.32); z-index: 70; pointer-events: none;
  }
  .gv-bo-side .gv-bo-nav__item:hover > .gv-bo-nav__label::before,
  .gv-bo-side .gv-bo-side__brand:hover > .gv-bo-side__brandtext::before {
    content: ""; position: absolute; right: 100%; top: 50%; transform: translateY(-50%);
    border: 5px solid transparent; border-right-color: #1a1f2c;
  }
  `;
  function build() {
    if (document.getElementById('v3-rail-tooltip')) return;
    var s = document.createElement('style');
    s.id = 'v3-rail-tooltip';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
