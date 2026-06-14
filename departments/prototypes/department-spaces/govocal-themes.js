/* ──────────────────────────────────────────────────────────────────────────
   GoVocal city theme switcher
   The product themes three colours per tenant (city): primary, secondary, text
   (front/app/component-library/utils/styleUtils.ts → getTheme()).
   This drives those three CSS variables from a `?theme=` URL param and renders a
   small live picker so a prototype can be previewed across several city palettes.

   Usage in a prototype:
     <link rel="stylesheet" href="govocal-tokens.css">
     <link rel="stylesheet" href="govocal-ui.css">
     <script src="govocal-themes.js" defer></script>
   Then build with var(--gv-tenant-primary) / -secondary / -text (never hardcode
   brand colours). Open ?theme=2 to preview a city, or use the on-screen picker.

   Add a template: append to GV_THEMES. Each city sets only the 3 tenant colours;
   tints + focus + component states derive from them automatically.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  // id 0 is the faithful GoVocal brand default. Templates 1+ are AA-safe
  // (white button text ≥ 4.5:1 on `primary`) so they're safe to demo.
  // NOTE: the GoVocal default uses an AA-safe pink (#E10069, 4.77:1 white-on-primary).
  // The exact brand pink is #ef0071 but it's ~4.3:1 — just under WCAG AA for white text.
  var GV_THEMES = [
    { id: 0, name: 'GoVocal',  primary: '#E10069', secondary: '#000000', text: '#333333' },
    { id: 1, name: 'Ocean',    primary: '#044D6C', secondary: '#147985', text: '#1A2B33' },
    { id: 2, name: 'Forest',   primary: '#04884C', secondary: '#0A5159', text: '#20302A' },
    { id: 3, name: 'Royal',    primary: '#4B2E83', secondary: '#2E1A47', text: '#241B33' },
    { id: 4, name: 'Sunset',   primary: '#C2410C', secondary: '#8C680D', text: '#3A2A18' },
  ];
  window.GV_THEMES = GV_THEMES;

  function findTheme(raw) {
    if (raw == null || raw === '') return GV_THEMES[0];
    var byId = GV_THEMES.find(function (t) { return String(t.id) === String(raw); });
    if (byId) return byId;
    var lc = String(raw).toLowerCase();
    return GV_THEMES.find(function (t) { return t.name.toLowerCase() === lc; }) || GV_THEMES[0];
  }

  function applyTheme(theme) {
    var r = document.documentElement.style;
    r.setProperty('--gv-tenant-primary', theme.primary);
    r.setProperty('--gv-tenant-secondary', theme.secondary);
    r.setProperty('--gv-tenant-text', theme.text);
    document.documentElement.setAttribute('data-gv-theme', theme.id);
  }

  function syncUrl(theme) {
    try {
      var url = new URL(window.location.href);
      if (theme.id === 0) url.searchParams.delete('theme');
      else url.searchParams.set('theme', theme.id);
      window.history.replaceState({}, '', url);
    } catch (e) { /* file:// — ignore */ }
  }

  function current() {
    var params = new URLSearchParams(window.location.search);
    return findTheme(params.get('theme'));
  }

  // Apply ASAP to avoid a flash of the default palette.
  applyTheme(current());

  function renderPicker() {
    if (document.getElementById('gv-theme-picker')) return;
    var active = current();
    var wrap = document.createElement('div');
    wrap.id = 'gv-theme-picker';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Preview city theme');
    wrap.innerHTML =
      '<style>' +
      '#gv-theme-picker{position:fixed;z-index:2147483000;right:16px;bottom:16px;' +
      'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;' +
      'background:#fff;box-shadow:0 4px 12px -1px rgba(0,0,0,.18);' +
      "font-family:'Public Sans',system-ui,sans-serif;font-size:13px;color:#333}" +
      '#gv-theme-picker .gv-tp-label{font-weight:600;color:#596B7A;white-space:nowrap}' +
      '#gv-theme-picker .gv-tp-swatches{display:flex;gap:6px}' +
      '#gv-theme-picker button.gv-tp-sw{width:24px;height:24px;border-radius:50%;border:2px solid transparent;' +
      'cursor:pointer;padding:0;outline-offset:2px}' +
      '#gv-theme-picker button.gv-tp-sw[aria-pressed="true"]{border-color:#333;box-shadow:0 0 0 2px #fff inset}' +
      '#gv-theme-picker button.gv-tp-sw:focus-visible{outline:2px solid #044D6C}' +
      '#gv-theme-picker .gv-tp-name{min-width:54px;font-weight:600}' +
      '@media (max-width:480px){#gv-theme-picker .gv-tp-name{display:none}}' +
      '</style>' +
      '<span class="gv-tp-label">City</span>' +
      '<span class="gv-tp-swatches"></span>' +
      '<span class="gv-tp-name">' + active.name + '</span>';
    var sw = wrap.querySelector('.gv-tp-swatches');
    var nameEl = wrap.querySelector('.gv-tp-name');
    GV_THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'gv-tp-sw';
      b.style.background = t.primary;
      b.title = t.name;
      b.setAttribute('aria-label', 'Preview ' + t.name + ' theme');
      b.setAttribute('aria-pressed', String(t.id === active.id));
      b.addEventListener('click', function () {
        applyTheme(t);
        syncUrl(t);
        nameEl.textContent = t.name;
        sw.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
      });
      sw.appendChild(b);
    });
    document.body.appendChild(wrap);
  }

  // Opt out of the on-screen picker with <body data-gv-theme-picker="off">.
  function init() {
    syncUrl(current());
    if (document.body && document.body.getAttribute('data-gv-theme-picker') !== 'off') {
      renderPicker();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
