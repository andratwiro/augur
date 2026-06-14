/* ──────────────────────────────────────────────────────────────────────────
   GoVocal cookie-consent banner (drop-in, self-contained)

   Realism rule: every RESIDENT / PARTICIPANT-facing prototype shows a cookie
   consent dialog before the experience (in English). Backend/admin screens skip
   it. See skills/govocal-ui/SKILL.md and the repo CLAUDE.md.

   Usage — add ONE line near the end of <body>:
     <script src="govocal-cookies.js" defer></script>
   Optional config on <body>:
     data-gv-cookies-city="Vienna"   → title "Your cookie settings — Vienna"
     data-gv-cookies="always"        → show on every load (for demos/galleries)
     data-gv-cookies="off"           → disable
     data-gv-cookies-policy="…url…"  → "Read our cookie policy" link target

   Themeable: buttons use var(--gv-tenant-primary) when govocal-tokens.css is
   present, else a safe fallback. Choice is stored in localStorage so a returning
   reviewer isn't nagged (clear it, or use ?cookies=reset, to see it again).
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  var KEY = 'gv-cookie-consent';

  function cfg(name, dflt) {
    var b = document.body;
    var v = b && b.getAttribute('data-gv-cookies-' + name);
    return v == null || v === '' ? dflt : v;
  }
  function mode() {
    var b = document.body;
    return (b && b.getAttribute('data-gv-cookies')) || 'once';
  }

  function stored() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function save(choice) {
    try { localStorage.setItem(KEY, JSON.stringify(choice)); } catch (e) {}
  }

  function shouldShow() {
    if (mode() === 'off') return false;
    try {
      var p = new URLSearchParams(location.search);
      if (p.get('cookies') === 'reset') { try { localStorage.removeItem(KEY); } catch (e) {} return true; }
    } catch (e) {}
    if (mode() === 'always') return true;
    return !stored();
  }

  var STYLE =
    '#gv-cookies{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;' +
    "font-family:var(--gv-font-family,'Public Sans',system-ui,-apple-system,Segoe UI,Roboto,sans-serif);}" +
    '#gv-cookies .gvck-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5);}' +
    '#gv-cookies .gvck-modal{position:relative;background:#fff;border-radius:8px;max-width:560px;width:100%;' +
    'box-shadow:0 12px 48px rgba(0,0,0,.28);padding:28px 28px 0;color:var(--gv-text-primary,#333);' +
    'animation:gvck-in .18s ease-out;}' +
    '#gv-cookies .gvck-icon{width:40px;height:40px;margin-bottom:14px;color:var(--gv-tenant-primary,#E10069);}' +
    '#gv-cookies h2{font-size:22px;font-weight:700;line-height:1.3;margin:0 0 10px;color:var(--gv-text-primary,#333);}' +
    '#gv-cookies p{font-size:15px;line-height:1.55;margin:0 0 6px;color:var(--gv-text-primary,#333);}' +
    '#gv-cookies a.gvck-policy{color:inherit;text-decoration:underline;}' +
    '#gv-cookies .gvck-prefs{margin:14px 0 2px;display:none;}' +
    '#gv-cookies .gvck-prefs.open{display:block;}' +
    '#gv-cookies .gvck-pref{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--gv-divider,#E0E0E0);}' +
    '#gv-cookies .gvck-pref input{margin-top:3px;width:18px;height:18px;accent-color:var(--gv-success,#04884C);}' +
    '#gv-cookies .gvck-pref b{display:block;font-size:14px;font-weight:600;}' +
    '#gv-cookies .gvck-pref span{display:block;font-size:13px;color:var(--gv-text-secondary,#596B7A);}' +
    '#gv-cookies .gvck-foot{display:flex;justify-content:flex-end;align-items:center;gap:10px;flex-wrap:wrap;' +
    'border-top:1px solid var(--gv-divider,#E0E0E0);margin-top:18px;padding:16px 0;}' +
    '#gv-cookies button{font:inherit;font-size:16px;border-radius:var(--gv-radius,3px);cursor:pointer;' +
    'min-height:44px;padding:9px 18px;border:1px solid transparent;line-height:1.3;}' +
    '#gv-cookies button.gvck-text{background:none;color:var(--gv-text-secondary,#596B7A);margin-right:auto;padding-left:0;}' +
    '#gv-cookies button.gvck-text:hover{color:var(--gv-text-primary,#333);}' +
    '#gv-cookies button.gvck-primary{background:var(--gv-tenant-primary,#E10069);color:#fff;}' +
    '#gv-cookies button.gvck-primary:hover{filter:brightness(.92);}' +
    '#gv-cookies button:focus-visible{outline:2px solid var(--gv-tenant-primary,#E10069);outline-offset:2px;}' +
    '@keyframes gvck-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '@media (prefers-reduced-motion:reduce){#gv-cookies .gvck-modal{animation:none}}' +
    '@media (max-width:520px){#gv-cookies button.gvck-primary{flex:1}}';

  var ICON =
    '<svg class="gvck-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2a10 10 0 1 0 10 10 1 1 0 0 0-1.2-1 3 3 0 0 1-3.6-3.6A1 1 0 0 0 16 6a3 3 0 0 1-3-3 1 1 0 0 0-1-1Z"/>' +
    '<circle cx="9" cy="10" r="1.3"/><circle cx="14.5" cy="9" r="1.1"/><circle cx="9.5" cy="15" r="1.2"/>' +
    '<circle cx="14" cy="14.5" r="1.4"/></svg>';

  function build(city, policy) {
    var title = city ? 'Your cookie settings — ' + city : 'Your cookie settings';
    var wrap = document.createElement('div');
    wrap.id = 'gv-cookies';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'gvck-title');
    wrap.innerHTML =
      '<style>' + STYLE + '</style>' +
      '<div class="gvck-backdrop"></div>' +
      '<div class="gvck-modal">' +
        ICON +
        '<h2 id="gvck-title">' + title + '</h2>' +
        '<p>By accepting cookies, you help us improve this platform. ' +
        '<a class="gvck-policy" href="' + policy + '">Read our cookie policy</a>.</p>' +
        '<div class="gvck-prefs" id="gvck-prefs">' +
          '<label class="gvck-pref"><input type="checkbox" checked disabled>' +
            '<span><b>Essential</b><span>Required for the platform to work. Always on.</span></span></label>' +
          '<label class="gvck-pref"><input type="checkbox" id="gvck-analytics">' +
            '<span><b>Analytics</b><span>Help us understand how the platform is used.</span></span></label>' +
          '<label class="gvck-pref"><input type="checkbox" id="gvck-marketing">' +
            '<span><b>Marketing</b><span>Personalise content and measure campaigns.</span></span></label>' +
        '</div>' +
        '<div class="gvck-foot">' +
          '<button type="button" class="gvck-text" data-act="edit">Edit</button>' +
          '<button type="button" class="gvck-primary" data-act="decline">Decline</button>' +
          '<button type="button" class="gvck-primary" data-act="accept">Accept</button>' +
        '</div>' +
      '</div>';
    return wrap;
  }

  function show() {
    if (document.getElementById('gv-cookies')) return;
    var city = cfg('city', '');
    var policy = cfg('policy', '#');
    var el = build(city, policy);
    document.body.appendChild(el);

    var prefs = el.querySelector('#gvck-prefs');
    var editBtn = el.querySelector('[data-act="edit"]');
    var prevFocus = document.activeElement;

    function close(choice) {
      save(choice);
      el.parentNode && el.parentNode.removeChild(el);
      try { prevFocus && prevFocus.focus(); } catch (e) {}
      document.dispatchEvent(new CustomEvent('gv-cookie-consent', { detail: choice }));
    }

    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'edit') {
        var open = prefs.classList.toggle('open');
        editBtn.textContent = open ? 'Hide options' : 'Edit';
        if (open) { var a = el.querySelector('#gvck-analytics'); a && a.focus(); }
        return;
      }
      if (act === 'decline') return close({ essential: true, analytics: false, marketing: false, choice: 'declined' });
      // accept (or save after editing) reflects the toggles when the panel is open
      var anal = el.querySelector('#gvck-analytics');
      var mkt = el.querySelector('#gvck-marketing');
      var edited = prefs.classList.contains('open');
      close({
        essential: true,
        analytics: edited ? !!(anal && anal.checked) : true,
        marketing: edited ? !!(mkt && mkt.checked) : true,
        choice: edited ? 'saved' : 'accepted',
      });
    });

    // Keep focus inside the dialog (cheap trap; consent is explicit, Esc doesn't close).
    var accept = el.querySelector('[data-act="accept"]');
    accept && accept.focus();
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = el.querySelectorAll('a[href],button,input:not([disabled])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    });
  }

  function init() { if (shouldShow()) show(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
