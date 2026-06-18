/* ══════════════════════════════════════════════════════════════════════════
   BLUE RAIL EXPLORER — backup/lab (v2). DETACHED FROM CANON.
   v3 ships Option 1 (Tooltip); this keeps all five treatments behind a top-centre
   chip so the alternatives stay comparable. Self-contained: injects its own <style>
   + chip and wires it up, so index.html needs only one <script src> include. Canon
   (assets/govocal-bo.css → .gv-bo-side) is untouched.

   Premise: while editing a project you don't NAVIGATE the global rail items —
   admins/PMs know what's there — so every option KEEPS them and fixes the two real
   faults: icon CONTRAST and on-hover LABEL/context. Five takes:
     1 Tooltip          — brighter icons + a label flyout on hover  (← v3 ships this)
     2 Hover drawer     — rail expands to a labelled drawer on hover
     3 Always-labelled  — a small caption under each icon, no hover needed
     4 Recede & wake    — dim/dormant in project context, full contrast on hover
     5 Grouped & accent — lit active w/ accent bar, group divider, tooltip
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  var CSS = `
  /* Shared: a readable inactive icon (canon's --gv-blue-400 is too dim on navy). */
  .gv-bo-side[data-railopt] .gv-bo-nav__icon { color: #b7c2d2; }
  .gv-bo-side[data-railopt] .gv-bo-nav__item.is-active .gv-bo-nav__icon { color: var(--gv-teal-400); }

  /* Shared tooltip (options 1, 4, 5): the existing label flies out to the right as a
     dark chip on hover — reusing .gv-bo-nav__label / brand text, no new markup. */
  .gv-bo-side[data-railopt="1"], .gv-bo-side[data-railopt="4"], .gv-bo-side[data-railopt="5"] { overflow: visible; }
  .gv-bo-side[data-railopt="1"] .gv-bo-nav__item:hover > .gv-bo-nav__label,
  .gv-bo-side[data-railopt="4"] .gv-bo-nav__item:hover > .gv-bo-nav__label,
  .gv-bo-side[data-railopt="5"] .gv-bo-nav__item:hover > .gv-bo-nav__label,
  .gv-bo-side[data-railopt="1"] .gv-bo-side__brand:hover > .gv-bo-side__brandtext,
  .gv-bo-side[data-railopt="4"] .gv-bo-side__brand:hover > .gv-bo-side__brandtext,
  .gv-bo-side[data-railopt="5"] .gv-bo-side__brand:hover > .gv-bo-side__brandtext {
    display: block; position: absolute; left: calc(100% + 12px); top: 50%; transform: translateY(-50%);
    background: #1a1f2c; color: #fff; padding: 6px 11px; border-radius: 7px;
    font-size: 12.5px; font-weight: 600; line-height: 1; white-space: nowrap;
    box-shadow: 0 8px 22px rgba(0,0,0,.32); z-index: 70; pointer-events: none;
  }
  .gv-bo-side[data-railopt="1"] .gv-bo-nav__item:hover > .gv-bo-nav__label::before,
  .gv-bo-side[data-railopt="4"] .gv-bo-nav__item:hover > .gv-bo-nav__label::before,
  .gv-bo-side[data-railopt="5"] .gv-bo-nav__item:hover > .gv-bo-nav__label::before {
    content: ""; position: absolute; right: 100%; top: 50%; transform: translateY(-50%);
    border: 5px solid transparent; border-right-color: #1a1f2c;
  }
  .gv-bo-side[data-railopt="1"] .gv-bo-nav__item:hover .gv-bo-nav__icon,
  .gv-bo-side[data-railopt="5"] .gv-bo-nav__item:hover .gv-bo-nav__icon { color: #fff; }

  /* 2 · HOVER DRAWER — narrow rail expands to a labelled drawer on hover (overlays
     the canvas, no reflow). Replaces the dev's manual open/close arrow. */
  .gv-bo-side[data-railopt="2"] { transition: width .18s ease, box-shadow .18s ease; }
  .gv-bo-side[data-railopt="2"]:hover { width: 224px; z-index: 60; box-shadow: 10px 0 30px rgba(0,0,0,.30); }
  .gv-bo-side[data-railopt="2"]:hover .gv-bo-nav__item { padding: 0 8px 0 16px; justify-content: flex-start; }
  .gv-bo-side[data-railopt="2"]:hover .gv-bo-nav__item.is-active { margin: 0; }
  .gv-bo-side[data-railopt="2"]:hover .gv-bo-nav__label,
  .gv-bo-side[data-railopt="2"]:hover .gv-bo-side__brandtext,
  .gv-bo-side[data-railopt="2"]:hover .gv-bo-chev { display: block; }
  .gv-bo-side[data-railopt="2"]:hover .gv-bo-side__brand { padding: 0 16px; justify-content: flex-start; gap: 10px; }

  /* 3 · ALWAYS-LABELLED — a small caption under every icon, always on. No hover
     needed; zero ambiguity for a first-timer. Quiet enough to recede. */
  .gv-bo-side[data-railopt="3"] .gv-bo-nav__item { flex-direction: column; height: auto; gap: 3px; padding: 7px 2px; justify-content: center; }
  .gv-bo-side[data-railopt="3"] .gv-bo-nav__item.is-active { margin: 0 8px; }
  .gv-bo-side[data-railopt="3"] .gv-bo-nav__label {
    display: block; font-size: 9px; line-height: 1.12; text-align: center;
    color: #9fabbb; white-space: normal; max-width: 70px; overflow: hidden;
  }
  .gv-bo-side[data-railopt="3"] .gv-bo-nav__sub, .gv-bo-side[data-railopt="3"] .gv-bo-chev { display: none; }

  /* 4 · RECEDE & WAKE — in project context the global rail is dormant (dim) EXCEPT
     the active item; the whole rail wakes to full contrast + tooltips on hover/focus. */
  .gv-bo-side[data-railopt="4"] .gv-bo-nav__icon { color: rgba(255,255,255,.30); transition: color .15s ease; }
  .gv-bo-side[data-railopt="4"] .gv-bo-nav__item.is-active .gv-bo-nav__icon { color: var(--gv-teal-400); }
  .gv-bo-side[data-railopt="4"]:hover .gv-bo-nav__icon { color: #e6ebf2; }
  .gv-bo-side[data-railopt="4"]:hover .gv-bo-nav__item.is-active .gv-bo-nav__icon { color: var(--gv-teal-400); }

  /* 5 · GROUPED & ACCENT — brighter icons, a left accent bar + light wash on the
     active item (not the heavy black chip), a hairline between the primary group and
     the utility cluster, plus the shared tooltip. */
  .gv-bo-side[data-railopt="5"] .gv-bo-nav__item.is-active { margin: 0; border-radius: 0; background: rgba(255,255,255,.10); }
  .gv-bo-side[data-railopt="5"] .gv-bo-nav__item.is-active::before {
    content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px;
    border-radius: 0 3px 3px 0; background: var(--gv-teal-400);
  }
  .gv-bo-side[data-railopt="5"] .gv-bo-nav--bottom { border-top: 1px solid rgba(255,255,255,.08); margin-top: auto; padding-top: 12px; }

  /* The "Blue rail" explorer chip (top-centre) — clones the icon-chip pattern. */
  .rail-chip { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 60;
    display: flex; flex-direction: column; align-items: center; gap: 5px; pointer-events: none;
    font-family: var(--gv-font-family, 'Public Sans', system-ui, sans-serif); }
  .rail-chip__name { pointer-events: auto; font-size: 10.5px; font-weight: 700; color: #1a1f2c; background: #fff;
    padding: 4px 11px; border-radius: 999px; border: 1px solid #e3e7ee; box-shadow: 0 6px 20px rgba(20,25,40,.12); }
  .rail-chip__name .k { color: #5b6573; letter-spacing: .06em; text-transform: uppercase; margin-right: 7px; }
  .rail-chip__name .w { color: #5b6573; font-weight: 500; }
  .rail-chip__row { pointer-events: auto; display: inline-flex; gap: 3px; padding: 3px 5px; background: #fff;
    border: 1px solid #e3e7ee; border-radius: 999px; box-shadow: 0 6px 20px rgba(20,25,40,.12); }
  .rail-chip__row button { min-width: 24px; padding: 4px 9px; border: 0; background: transparent; cursor: pointer;
    border-radius: 999px; color: #4b5563; font-weight: 600; font-size: 11px; transition: background .12s ease, color .12s ease; }
  .rail-chip__row button:hover { background: #f4f6fa; }
  .rail-chip__row button.on { background: #1a1f2c; color: #fff; }
  `;

  var OPTS = {
    1: ['Tooltip', '— brighter icons + a hover label  (v3 ships this)'],
    2: ['Hover drawer', '— rail expands to labels on hover'],
    3: ['Always-labelled', '— a caption under each icon'],
    4: ['Recede & wake', '— dim in project, full contrast on hover'],
    5: ['Grouped & accent', '— lit active + accent bar + tooltip']
  };

  window.setRailOpt = function (n, btn) {
    n = String(n);
    var rail = document.querySelector('.gv-bo-side');
    if (rail) rail.setAttribute('data-railopt', n);
    var row = document.getElementById('rail-chip-row');
    if (row) Array.prototype.forEach.call(row.children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-opt') === n);
    });
    var m = OPTS[n] || ['', ''];
    var nm = document.getElementById('rail-chip-name'), wy = document.getElementById('rail-chip-why');
    if (nm) nm.textContent = m[0];
    if (wy) wy.textContent = ' ' + m[1];
  };

  function build() {
    if (!document.getElementById('v2-rail-experiments')) {
      var s = document.createElement('style');
      s.id = 'v2-rail-experiments';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    var rail = document.querySelector('.gv-bo-side');
    if (rail && !rail.getAttribute('data-railopt')) rail.setAttribute('data-railopt', '1');
    if (!document.querySelector('.rail-chip')) {
      var wrap = document.createElement('div');
      wrap.className = 'rail-chip';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Blue rail treatment');
      var name = document.createElement('div');
      name.className = 'rail-chip__name';
      name.innerHTML = '<span class="k">Blue rail</span><b id="rail-chip-name">' + OPTS[1][0] +
        '</b><span class="w" id="rail-chip-why"> ' + OPTS[1][1] + '</span>';
      var row = document.createElement('div');
      row.className = 'rail-chip__row';
      row.id = 'rail-chip-row';
      Object.keys(OPTS).forEach(function (k) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = k;
        b.setAttribute('data-opt', k);
        b.title = OPTS[k][0] + ' ' + OPTS[k][1];
        if (k === '1') b.className = 'on';
        b.addEventListener('click', function () { window.setRailOpt(k, this); });
        row.appendChild(b);
      });
      wrap.appendChild(name);
      wrap.appendChild(row);
      document.body.appendChild(wrap);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
