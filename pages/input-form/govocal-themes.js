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

   City logos (for realism): give a theme a `logo` (an HTML string — inline <svg>
   or <img src="logos/ocean.svg">) and any element with `data-gv-logo` renders it,
   swapping live with the theme. Until a real logo is set, a clean placeholder
   (city mark + name) is generated automatically. Example slot in a header:
     <a class="brand" data-gv-logo aria-label="City home"></a>
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  // ── City logos (inline SVG recreations of each tenant's mark + wordmark). ──
  // Replace any of these with the official asset (inline <svg> or <img src>) anytime.
  var LOGO_WIEN =
    '<span style="display:inline-flex;align-items:center;gap:8px;font-family:var(--gv-font-family,sans-serif)">' +
    '<svg width="29" height="33" viewBox="0 0 34 38" aria-hidden="true">' +
    '<path d="M2 2h30v18c0 9-7 14-15 17C9 34 2 29 2 20V2Z" fill="#FF0000"/>' +
    '<path d="M14.2 7h5.6v6.2H26v5.6h-6.2V25h-5.6v-6.2H8v-5.6h6.2V7Z" fill="#fff"/></svg>' +
    '<span style="font-weight:800;font-size:17px;line-height:.9;color:#000;letter-spacing:-.01em">Stadt<br>Wien</span></span>';

  var LOGO_KBH =
    '<span style="display:inline-flex;align-items:center;gap:9px;font-family:var(--gv-font-family,sans-serif)">' +
    '<svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true">' +
    '<circle cx="24" cy="24" r="22" fill="none" stroke="#000C2E" stroke-width="2"/>' +
    '<g fill="#000C2E">' +
    '<rect x="21" y="14" width="6" height="13"/><path d="M21 14l3-5 3 5Z"/>' +
    '<rect x="12.5" y="18" width="5.5" height="9"/><path d="M12.5 18l2.75-4 2.75 4Z"/>' +
    '<rect x="30" y="18" width="5.5" height="9"/><path d="M30 18l2.75-4 2.75 4Z"/></g>' +
    '<path d="M12 32q3 -3 6 0t6 0 6 0 6 0" fill="none" stroke="#000C2E" stroke-width="1.6"/>' +
    '<path d="M12 36q3 -3 6 0t6 0 6 0 6 0" fill="none" stroke="#000C2E" stroke-width="1.6"/></svg>' +
    '<span style="line-height:1.04;color:#000C2E"><span style="font-weight:800;font-size:13px">Københavns</span>' +
    '<br><span style="font-weight:600;font-size:11px;letter-spacing:.03em">Kommune</span></span></span>';

  var LOGO_CA =
    '<span style="display:inline-flex;align-items:center;gap:9px;font-family:var(--gv-font-family,sans-serif)">' +
    '<svg width="38" height="31" viewBox="0 0 46 38" aria-hidden="true">' +
    '<path d="M25 4h12a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6h-1v5l-6-5h-5a6 6 0 0 1-6-6v-8a6 6 0 0 1 6-6Z" fill="#E79450"/>' +
    '<path d="M9 1h12a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6h-5l-6 5v-5H9a6 6 0 0 1-6-6V7a6 6 0 0 1 6-6Z" fill="#1C2745"/></svg>' +
    '<span style="line-height:1;color:#1C2745"><span style="font-weight:800;font-size:15px;letter-spacing:-.01em">Engaged</span>' +
    '<br><span style="font-weight:700;font-size:9px;letter-spacing:.14em">CALIFORNIA</span></span></span>';

  // id 0 = the GoVocal platform default — deep teal #0E7C86 (4.95:1 white-on-primary)
  // + warm coral accent #E2603A. Replaced the old hot-pink/black default. Ids 1+ are REAL city tenants
  // with their authoritative brand colours + logos (researched from official sources):
  //   Københavns Kommune — KBH Blå #000C2E (Pantone 296C), design.kk.dk
  //   Stadt Wien — Wien Rot #FF0000 + Ur Schwarz #000000, wien.gv.at CD-manual
  //   Engaged California — navy #1C2745 + orange #E79450
  // FAITHFUL-BUT-FLAGGED: Wien Rot #FF0000 is only ~4:1 white-on-primary (under AA) —
  // it's the official colour, kept faithful; the audit will flag it (expected).
  // Each tenant configures a custom font (the product's customFontName). The real city
  // faces are proprietary and can't be bundled, so each stack lists the real name(s)
  // first (rendered where licensed/installed) then a FREE substitute chosen to match the
  // city's brand character, then the GoVocal Public Sans fallback (same as the live sites):
  //   Stadt Wien — "Wiener Melange" (Dalton Maag, 2019: warm, humanist, rounded, open
  //     counters) → substitute Mulish (warm humanist sans).
  //   Københavns Kommune — "KBH Sans" (Playtype/e-Types: Art-Nouveau curves + modern
  //     grotesque) → substitute Archivo (grotesque).
  //   Engaged California — "Noto Sans" (free, loaded exactly).
  //   GoVocal default — Public Sans (the component-library default; no custom font).
  var FONT_FALLBACK = '"Public Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
  var GV_THEMES = [
    { id: 0, name: 'GoVocal',            primary: '#0E7C86', secondary: '#E2603A', text: '#333333', logo: null,      font: null },
    { id: 1, name: 'Københavns Kommune', primary: '#000C2E', secondary: '#0A1A4A', text: '#1A1A1A', logo: LOGO_KBH,  font: '"KBH Sans", "KBH", "Archivo", ' + FONT_FALLBACK },
    { id: 2, name: 'Stadt Wien',         primary: '#FF0000', secondary: '#000000', text: '#1A1A1A', logo: LOGO_WIEN, font: '"Wiener Melange", "WienerMelange_W_Rg", "Mulish", ' + FONT_FALLBACK },
    { id: 3, name: 'Engaged California', primary: '#1C2745', secondary: '#E79450', text: '#1A1A1A', logo: LOGO_CA,   font: '"Noto Sans", ' + FONT_FALLBACK },
  ];
  window.GV_THEMES = GV_THEMES;

  // Load the free substitute/real web fonts once (Google Fonts; Public Sans already loaded by govocal-ui.css).
  (function loadFonts() {
    if (document.getElementById('gv-theme-fonts')) return;
    var l = document.createElement('link');
    l.id = 'gv-theme-fonts';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Mulish:wght@400;600;700;800&family=Noto+Sans:wght@400;600;700;800&display=swap';
    (document.head || document.documentElement).appendChild(l);
  })();

  // ── City logo: real `logo` markup if provided, else a generated placeholder. ──
  function initials(name) {
    return (name || '?').trim().split(/\s+/).map(function (w) { return w.charAt(0); })
      .join('').slice(0, 2).toUpperCase();
  }
  function logoMarkup(theme) {
    if (theme.logo) return theme.logo; // real city logo (inline SVG or <img>)
    return (
      '<span style="display:inline-flex;align-items:center;gap:9px;' +
      "font-family:'Public Sans',system-ui,-apple-system,Segoe UI,Roboto,sans-serif\">" +
      '<span aria-hidden="true" style="display:inline-grid;place-items:center;width:30px;height:30px;' +
      'border-radius:7px;background:' + theme.primary + ';color:#fff;font-weight:800;font-size:13px;' +
      'letter-spacing:-.02em;flex:0 0 auto">' + initials(theme.name) + '</span>' +
      '<span style="font-weight:700;font-size:16px;letter-spacing:-.01em;' +
      'color:var(--gv-tenant-text,#1a1a1a)">' + theme.name + '</span></span>'
    );
  }
  function renderLogos(theme) {
    var slots = document.querySelectorAll('[data-gv-logo]');
    for (var i = 0; i < slots.length; i++) slots[i].innerHTML = logoMarkup(theme);
  }
  window.GVThemeLogo = logoMarkup; // expose for custom rendering

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
    if (theme.font) r.setProperty('--gv-font-family', theme.font);
    else r.removeProperty('--gv-font-family'); // fall back to the tokens.css default
    document.documentElement.setAttribute('data-gv-theme', theme.id);
    if (document.body) renderLogos(theme); // body absent on first (pre-parse) call
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
    renderLogos(current()); // fill any [data-gv-logo] slots now that <body> exists
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
