/* pp-render.js — the ONE canonical project-page renderer, shared by every surface.
 *
 * Ported from pages/project-page (PHASES → stepper/panel → METHODS body, ideation
 * feed + Leaflet map). It is fully MODEL-DRIVEN: window.PP.render(model) paints the
 * canonical skeleton in this document from the tester's data, with empty states for a
 * freshly-built project (no submissions yet). It runs INSIDE the per-surface iframe, so
 * the canonical IDs never collide and the viewport-based responsive CSS works.
 *
 * Model shape:
 *   { hero:'<src>', title:'', intro:'<html>', desc:'<html>', participants:0,
 *     phases:[ {name, method, dates, status:'past|current|upcoming', description, ideas?:[]} ],
 *     surveys:[ {title, cta, desc?} ], events:[ {m,d,y,title,when,where,regs,img?} ],
 *     editable:false }
 */
(function () {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); };
  var $ = function (s, r) { return (r || document).querySelector(s); };

  var ideaView = 'list', ppMap = null, ppMarkers = [], IDEAS = [], PHASES = [], CURRENT = 0, active = 0, MODEL = null;
  var CTA_LABELS = { information: 'Learn more', survey: 'Take the survey', ideation: 'Add your idea', voting: 'Cast your vote', proposals: 'Submit a proposal', 'common-ground': 'Get started', volunteering: 'Volunteer' };

  /* ── method bodies ──────────────────────────────────────────────────────── */
  function cardHTML(d) {
    var thumb = d.img
      ? '<div class="gv-ideacard__thumb"><img src="' + d.img + '" alt="" loading="lazy" /></div>'
      : '<div class="gv-ideacard__thumb"><span data-gv-icon="vote-up" aria-hidden="true"></span></div>';
    var initials = String(d.author || '').split(' ').map(function (w) { return w[0]; }).slice(0, 2).join('');
    var SC = { 'accepted': '', 'implemented': 'is-implemented', 'under consideration': 'is-considered', 'rejected': 'is-rejected', 'proposed': 'is-proposed' };
    var pill = d.status ? '<span class="gv-ideacard__status ' + (SC[d.status] || '') + '">' + esc(d.status) + '</span>' : '';
    return '<article class="gv-ideacard e2e-idea-card">' + thumb +
      '<div class="gv-ideacard__body"><h3 class="gv-ideacard__title"><a href="#">' + esc(d.title) + '</a></h3>' +
      '<div class="gv-ideacard__head"><span class="gv-ideacard__avatar" aria-hidden="true">' + esc(initials) + '</span>' +
      '<div><div class="gv-ideacard__meta"><span class="gv-ideacard__author">' + esc(d.author) + '</span><span class="gv-ideacard__sep" aria-hidden="true">&bull;</span><span class="gv-ideacard__time">' + esc(d.time) + '</span></div>' +
      '<p class="gv-ideacard__excerpt">' + esc(d.excerpt) + '</p></div></div>' +
      '<footer class="gv-ideacard__foot"><div class="gv-react"><button class="gv-react__btn" aria-label="Like"><span data-gv-icon="vote-up"></span></button><span class="gv-react__count">' + (d.likes || 0) + '</span><button class="gv-react__btn" aria-label="Dislike"><span data-gv-icon="vote-down"></span></button><span class="gv-react__count">' + (d.dislikes || 0) + '</span></div>' +
      '<span class="gv-react__comment"><span data-gv-icon="comments"></span>' + (d.comments || 0) + '</span>' + pill + '</footer></div></article>';
  }
  function mapViewHTML() {
    var items = IDEAS.map(function (d, i) { return '<article class="pp-mapidea" data-pin="' + i + '"><h3 class="pp-mapidea__title">' + esc(d.title) + '</h3><div class="pp-mapidea__stats"><span class="pp-mapidea__stat"><span data-gv-icon="vote-up" aria-hidden="true"></span>' + (d.likes || 0) + '</span><span class="pp-mapidea__stat"><span data-gv-icon="comments" aria-hidden="true"></span>' + (d.comments || 0) + '</span></div></article>'; }).join('');
    return '<div class="pp-mapwrap"><div class="pp-map" role="region" aria-label="Map of idea locations"><div class="pp-map__canvas" id="pp-map-canvas"></div></div><div class="pp-mappanel"><div class="pp-mappanel__top"><button class="gv-btn secondary-outlined size-s pp-mapcard__filters" type="button">Filters</button></div><div class="pp-mapcard__list">' + items + '</div></div></div>';
  }
  function ppPopupHTML(d) {
    return '<h3 class="pp-poptitle">' + esc(d.title) + '</h3><div class="pp-popstats"><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21h2V9H2v12zm20-11a2 2 0 0 0-2-2h-6.31l.95-4.57.03-.32a1.5 1.5 0 0 0-.44-1.06L13.17 1 6.59 7.59A2 2 0 0 0 6 9v10a2 2 0 0 0 2 2h9a2 2 0 0 0 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>' + (d.likes || 0) + '</span><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>' + (d.comments || 0) + '</span></div>';
  }
  function ppInitMap() {
    var el = document.getElementById('pp-map-canvas');
    if (!el || typeof L === 'undefined' || !IDEAS.length) return;
    if (ppMap) { ppMap.invalidateSize(); return; }
    ppMap = L.map(el, { scrollWheelZoom: false, zoomControl: false });
    L.control.zoom({ position: 'topright' }).addTo(ppMap);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(ppMap);
    ppMarkers = IDEAS.map(function (d, i) {
      var icon = L.divIcon({ className: '', html: '<span class="pp-marker" data-pin="' + i + '">' + (i + 1) + '</span>', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16] });
      var m = L.marker([d.lat, d.lng], { icon: icon, title: d.title }).addTo(ppMap);
      m.bindPopup(ppPopupHTML(d), { closeButton: true });
      return m;
    });
    var bounds = L.latLngBounds(IDEAS.map(function (d) { return [d.lat, d.lng]; }));
    ppMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
    requestAnimationFrame(function () { ppMap && ppMap.invalidateSize(); });
  }
  var METHODS = {
    ideation: function () {
      if (!IDEAS.length) return '<div class="pp-empty"><span class="gv-icon" data-gv-icon="idea"></span><div><b>No ideas yet</b>Once this phase is live, residents’ ideas will appear here as a feed and on the map.</div></div>';
      var isMap = ideaView === 'map';
      return '<div class="pp-toolbar' + (isMap ? ' is-map' : '') + '" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;">' +
        '<h2 class="gv-feed__count">' + IDEAS.length + ' ideas</h2>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<button class="gv-filters-btn pp-toolbar__filters" type="button"><svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px"><path d="M4 5h16M7 12h10M10 19h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Filters</button>' +
          '<div class="gv-viewseg" role="tablist"><button class="gv-viewseg__tab" role="tab" data-view="list" aria-selected="' + (!isMap) + '"><span data-gv-icon="menu"></span>List</button><button class="gv-viewseg__tab" role="tab" data-view="map" aria-selected="' + isMap + '"><span data-gv-icon="map"></span>Map</button></div>' +
        '</div></div>' +
        '<div class="gv-feed' + (isMap ? ' is-map' : '') + '">' +
          (isMap ? mapViewHTML() : '<div class="gv-feed__col">' + IDEAS.map(cardHTML).join('') + '</div>') +
          '<aside class="gv-feedfilter"><div><p class="gv-feedfilter__label">SORT BY</p><div class="gv-feedfilter__group gv-feedfilter__group--sort"><button class="gv-feedfilter__btn is-active" type="button"><span class="gv-feedfilter__icon" data-gv-icon="idea"></span>Most liked</button><button class="gv-feedfilter__btn" type="button"><span class="gv-feedfilter__icon" data-gv-icon="clock"></span>New</button></div></div></aside>' +
        '</div>';
    },
    information: function (p) {
      return '<div class="gv-prose"><p>' + esc((p && p.description) || 'Information for this phase will appear here.') + '</p></div>';
    }
  };
  function placeholderHTML(p) {
    var icon = ({ voting: 'vote-up', survey: 'survey', information: 'info-outline', 'common-ground': 'group', volunteering: 'volunteer', proposals: 'vote-up' })[p.method] || 'info-outline';
    var live = p.status === 'current';
    return '<div class="pp-empty"><span class="gv-icon" data-gv-icon="' + icon + '"></span><div><b>' + esc(p.name) + '</b>' +
      (live ? 'This ' + esc(p.method) + ' phase is open. Participation appears here once residents take part.'
            : 'This phase hasn’t opened yet — its ' + esc(p.method) + ' panel will appear here when it goes live.') + '</div></div>';
  }

  /* ── stepper + active phase ─────────────────────────────────────────────── */
  function renderStepper() {
    var stepperEl = $('#stepper'); if (!stepperEl) return;
    stepperEl.innerHTML = PHASES.map(function (p, i) {
      var isCurrent = i === CURRENT, dot = isCurrent ? '<span class="gv-pstep__dot"></span>' : '';
      return '<button class="gv-phase' + (isCurrent ? ' current' : '') + '" role="tab" data-i="' + i + '" aria-selected="' + (i === active) + '"><span class="gv-pstep">' + dot + (i + 1) + '</span><span class="gv-phase__label">' + esc(p.name) + '</span></button>';
    }).join('');
    stepperEl.querySelectorAll('.gv-phase').forEach(function (b) { b.addEventListener('click', function () { setPhase(+b.dataset.i); }); });
  }
  function setPhase(i) {
    active = i;
    var p = PHASES[i], isCurrent = i === CURRENT;
    var sp = $('#stepper'); if (sp) sp.querySelectorAll('.gv-phase').forEach(function (b) { b.setAttribute('aria-selected', String(+b.dataset.i === i)); });
    $('#phasepanel').innerHTML = '<div class="gv-phasepanel__head' + (isCurrent ? '' : ' muted') + '"><span class="gv-phasepanel__num" aria-hidden="true">' + (i + 1) + '</span><div><h3 class="gv-phasepanel__name">' + esc(p.name) + '</h3><p class="gv-phasepanel__date">' + esc(p.dates || '') + '</p></div></div>' + (p.description ? '<div class="gv-phasepanel__desc"><p>' + esc(p.description) + '</p></div>' : '');
    if (ppMap) { try { ppMap.remove(); } catch (e) {} ppMap = null; ppMarkers = []; }
    IDEAS = (p.ideas || []);
    $('#phasebody').innerHTML = (METHODS[p.method] ? METHODS[p.method](p) : placeholderHTML(p));
    if (window.GVIcons) window.GVIcons.render($('#phasebody'));
    if (p.method === 'ideation' && ideaView === 'map') ppInitMap();
  }

  /* ── interactions (bound once) ──────────────────────────────────────────── */
  var wired = false;
  function wire() {
    if (wired) return; wired = true;
    var prev = $('#ppPrev'), next = $('#ppNext'), cur = $('#ppCur');
    if (prev) prev.addEventListener('click', function () { setPhase(Math.max(0, active - 1)); });
    if (next) next.addEventListener('click', function () { setPhase(Math.min(PHASES.length - 1, active + 1)); });
    if (cur) cur.addEventListener('click', function () { setPhase(CURRENT); });
    var fb = $('#followBtn');
    if (fb) fb.addEventListener('click', function () { var on = fb.getAttribute('aria-pressed') !== 'true'; fb.setAttribute('aria-pressed', String(on)); var l = $('#followLabel'); if (l) l.textContent = on ? 'Following (9)' : 'Follow (8)'; });
    document.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('.gv-viewseg__tab[data-view]');
      if (tab) { if (tab.dataset.view !== ideaView) { ideaView = tab.dataset.view; setPhase(active); } return; }
      var item = e.target.closest && e.target.closest('.pp-mapidea[data-pin]');
      if (item && ppMap) { var m = ppMarkers[+item.dataset.pin]; if (m) { ppMap.panTo(m.getLatLng()); m.openPopup(); } }
    });
  }

  /* ── pieces ─────────────────────────────────────────────────────────────── */
  function pboxHTML(m) {
    // Participation box = the live phase action(s). Extra surveys render as their own
    // cards below (extraCardsHTML), matching the canonical project-page layout.
    var actives = (m.phases || []).filter(function (p) { return p.status === 'current'; })
      .map(function (p) { return { cta: p.cta || CTA_LABELS[p.method] || 'Take part', primary: true }; });
    if (!actives.length) return '';
    var people = (m.participants ? '<div class="gv-participants gv-pbox__people" style="margin-top:4px;"><span class="gv-avatars on-light" aria-hidden="true"><span class="av"></span><span class="av"></span><span class="av"></span></span><span class="gv-pcount">' + m.participants + ' participants</span></div>'
      : '<div class="gv-participants gv-pbox__people" style="margin-top:4px;"><span class="gv-pcount" style="color:var(--gv-text-secondary)">Be the first to take part</span></div>');
    return '<div class="gv-pbox"><div class="gv-pbox__actions">' +
      actives.map(function (a) { return '<a class="gv-btn ' + (a.primary ? 'primary' : 'secondary-outlined') + ' full" href="#">' + esc(a.cta) + '</a>'; }).join('') +
      '</div>' + people + '</div>';
  }
  function extraCardsHTML(m) {
    return (m.surveys || []).map(function (e) {
      return '<div class="gv-extra-survey gv-extra-survey--card"><span class="gv-extra-survey__tag"><span class="gv-icon" data-gv-icon="survey"></span> Survey</span><h3 class="gv-extra-survey__title">' + esc(e.title) + '</h3><p class="gv-extra-survey__desc">' + esc(e.desc || 'Runs alongside the project — open to everyone.') + '</p><a class="gv-btn secondary-outlined full" href="#">' + esc(e.cta || 'Take the survey') + '</a></div>';
    }).join('');
  }
  function eventCardHTML(ev) {
    return '<article class="gv-event-card bordered"><div class="gv-event-card__media">' + (ev.img ? '<img src="' + ev.img + '" alt="" loading="lazy" />' : '') +
      '<span class="gv-event-card__date is-beside"><span class="m">' + esc(ev.m) + '</span><span class="d">' + esc(ev.d) + '</span><span class="y">' + esc(ev.y || '2026') + '</span></span></div>' +
      '<div class="gv-event-card__body"><div class="gv-event-card__titlerow"><h3 class="gv-event-card__title"><a href="#">' + esc(ev.title) + '</a></h3></div>' +
      '<div class="gv-event-card__meta"><p class="gv-event-card__row"><span data-gv-icon="clock"></span> ' + esc(ev.when) + '</p><p class="gv-event-card__row"><span data-gv-icon="location-simple"></span> ' + esc(ev.where) + '</p></div>' +
      '<a class="gv-btn primary full" href="#">Register</a></div></article>';
  }

  /* ── public render ──────────────────────────────────────────────────────── */
  window.PP = {
    render: function (model, mode) {
      MODEL = model = model || {};
      document.body.classList.add('pp-doc');
      document.body.setAttribute('data-pp-mode', mode || 'fo');
      // The admin "Edit project / Following" managers row belongs to the full FO page
      // only; the phone preview + builder canvas have their own chrome, so hide it there.
      var mgr = document.querySelector('.pp-managers'); if (mgr) mgr.style.display = (mode && mode !== 'fo') ? 'none' : '';
      // banner
      var banner = $('#banner'), bannerSec = banner && banner.closest('.pp-banner');
      if (model.hero) { if (banner) banner.src = model.hero; if (bannerSec) bannerSec.style.display = ''; }
      else if (bannerSec) bannerSec.style.display = 'none';
      // header text
      if ($('#title')) $('#title').textContent = model.title || 'Untitled project';
      if ($('#intro')) $('#intro').innerHTML = model.intro || '';
      if ($('#desc')) {
        $('#desc').innerHTML = model.desc || '';
        var descRow = $('#desc').closest('.pp-row'); if (descRow) descRow.style.display = (model.desc ? '' : 'none');
      }
      // CTA column = participation box + extra-survey cards
      if ($('#cta')) $('#cta').innerHTML = pboxHTML(model) + extraCardsHTML(model);
      // participation bar
      var pb = $('#partbar');
      var cur = (model.phases || []).filter(function (p) { return p.status === 'current'; })[0];
      if (pb) pb.innerHTML = cur ? '<span class="gv-partbar__status">Open for participation</span><a class="gv-btn on-color" href="#">' + esc(cur.cta || CTA_LABELS[cur.method] || 'Take part') + ' <span data-gv-icon="arrow-right"></span></a>' : '';
      var pbWrap = pb && pb.closest('.gv-partbar'); if (pbWrap) pbWrap.style.display = cur ? '' : 'none';
      // phases / method band
      PHASES = (model.phases || []).slice();
      var band = $('#stepper') && $('#stepper').closest('.gv-methodband');
      if (!PHASES.length) { if (band) band.style.display = 'none'; }
      else {
        if (band) band.style.display = '';
        CURRENT = PHASES.findIndex(function (p) { return p.status === 'current'; }); if (CURRENT < 0) CURRENT = 0;
        ideaView = 'list'; active = CURRENT;
        wire(); renderStepper(); setPhase(CURRENT);
      }
      // events
      var ev = $('#events'), evSec = ev && ev.closest('.gv-section');
      if (ev) ev.innerHTML = (model.events || []).map(eventCardHTML).join('');
      if (evSec) evSec.style.display = (model.events || []).length ? '' : 'none';
      // glyphs + avatars across the whole doc
      if (window.GVIcons) window.GVIcons.render(document.body);
      if (window.GVAvatars && window.GVAvatars.fill) window.GVAvatars.fill(document.body);
      if (mode === 'builder') enableBuilder(model);
      else if (mode === 'phone') enablePhone();
    }
  };

  // The phone preview is a non-interactive thumbnail: a click anywhere opens the content
  // builder (in the parent); only scrolling works inside. (Wired once.)
  var _phoneWired = false;
  function enablePhone() {
    if (_phoneWired) return; _phoneWired = true;
    document.body.style.cursor = 'pointer';
    document.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); postOut({ ppOpenBuilder: true }); }, true);
  }

  /* ── Builder mode: edit the canonical page in place, sync changes to the parent ── */
  function postOut(msg) { try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) {} }
  var _ceT;
  function emitContent() {
    clearTimeout(_ceT);
    _ceT = setTimeout(function () {
      var t = $('#title'), intro = $('#intro');
      postOut({ ppContent: { title: t ? t.textContent.trim() : '', content: intro ? cleanContent(intro) : '' } });
    }, 350);
  }
  function cleanContent(intro) {
    // Serialize the editable content minus all builder-only chrome.
    var clone = intro.cloneNode(true);
    clone.querySelectorAll('.pp-del, .pp-addbar, .pp-dropline').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    clone.querySelectorAll('[data-pp-block]').forEach(function (n) {
      n.removeAttribute('data-pp-block'); n.removeAttribute('draggable'); n.classList.remove('pp-dragging');
      n.style.position = ''; if (!n.getAttribute('style')) n.removeAttribute('style');
    });
    return clone.innerHTML;
  }
  function delBtn() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'pp-del'; b.setAttribute('aria-label', 'Delete'); b.textContent = '×';
    b.addEventListener('click', function (e) { e.stopPropagation(); var blk = b.closest('[data-pp-block]'); if (blk) { blk.remove(); emitContent(); } });
    return b;
  }
  // A content block is a DRAGGABLE wrapper; only its inner text is contenteditable
  // (keeps drag-to-reorder from fighting text selection).
  function decorateBlock(el) {
    el.setAttribute('data-pp-block', '1');
    el.style.position = 'relative';
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', function (e) { ppDrag = { kind: 'move', el: el }; el.classList.add('pp-dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'move'); } catch (x) {} e.stopPropagation(); });
    el.addEventListener('dragend', function () { el.classList.remove('pp-dragging'); clearIndicator(); ppDrag = null; });
    el.querySelectorAll('p, .gv-acc__q, .gv-btn').forEach(function (n) { n.setAttribute('contenteditable', 'true'); });
    if (!el.querySelector('.pp-del')) el.appendChild(delBtn());
  }
  function newBlockEl(type) {
    var node = document.createElement('div');
    if (type === 'text') node.innerHTML = '<div class="gv-projdesc"><p>New paragraph — click to edit.</p></div>';
    else if (type === 'faq') node.innerHTML = '<div class="gv-accordion"><details class="gv-acc__item" open><summary class="gv-acc__head"><span class="gv-acc__q">New question?</span><span class="gv-acc__chev" data-gv-icon="chevron-right"></span></summary><div class="gv-acc__body"><p>Answer — click to edit.</p></div></details></div>';
    else node.innerHTML = '<a class="gv-btn primary" href="#" onclick="return false">Button label</a>';
    var el = node.firstChild; decorateBlock(el);
    if (window.GVIcons) window.GVIcons.render(el);
    return el;
  }
  function wrapBlocks(intro) {
    Array.prototype.forEach.call(intro.children, function (el) {
      if (el.classList.contains('pp-addbar') || el.hasAttribute('data-pp-block')) return;
      decorateBlock(el);
    });
  }
  // ── Builder palette: a sticky widget tray at the top of the canvas ──
  function makeChip(label, type, group) {
    var chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'pp-chip'; chip.draggable = true; chip.textContent = label; chip.dataset.type = type;
    chip.addEventListener('dragstart', function (e) { ppDrag = { kind: 'new', type: type, group: group }; try { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', type); } catch (x) {} });
    chip.addEventListener('dragend', function () { clearIndicator(); ppDrag = null; });
    chip.addEventListener('click', function () {
      if (group === 'content') { var intro = $('#intro'); if (intro) { intro.appendChild(newBlockEl(type)); emitContent(); } }
      else postOut({ ppAdd: type });   // project widgets are added to the model by the parent
    });
    return chip;
  }
  function buildPalette() {
    var host = $('main') || document.body;
    var old = host.querySelector('.pp-palette'); if (old) old.remove();   // idempotent across re-renders
    var bar = document.createElement('div'); bar.className = 'pp-palette';
    function group(title, items) {
      var g = document.createElement('div'); g.className = 'pp-palette__group';
      var h = document.createElement('span'); h.className = 'pp-palette__label'; h.textContent = title; g.appendChild(h);
      items.forEach(function (it) { g.appendChild(makeChip(it[0], it[1], it[2])); });
      bar.appendChild(g);
    }
    group('Content', [['＋ Text', 'text', 'content'], ['＋ FAQ', 'faq', 'content'], ['＋ Button', 'button', 'content']]);
    group('Project', [['＋ Survey', 'survey', 'project'], ['＋ Phase', 'phase', 'project']]);
    host.insertBefore(bar, host.firstChild);
  }
  // ── Drag-drop: insert content widgets at a position, reorder blocks, drop project widgets anywhere ──
  var ppDrag = null, _ind = null;
  function isProject() { return ppDrag && ppDrag.kind === 'new' && ppDrag.group === 'project'; }
  function blockAfter(intro, y) {
    var blocks = Array.prototype.filter.call(intro.children, function (c) { return c.hasAttribute('data-pp-block') && !c.classList.contains('pp-dragging'); });
    for (var i = 0; i < blocks.length; i++) { var r = blocks[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return blocks[i]; }
    return null;
  }
  function showIndicator(intro, ref) {
    if (!_ind) { _ind = document.createElement('div'); _ind.className = 'pp-dropline'; }
    intro.insertBefore(_ind, ref);   // ref null → append
  }
  function clearIndicator() { if (_ind && _ind.parentNode) _ind.parentNode.removeChild(_ind); }
  var _dndDocWired = false;
  function setupDnD(intro) {
    if (!intro._dndWired) {
      intro._dndWired = true;
      intro.addEventListener('dragover', function (e) { if (!ppDrag || isProject()) return; e.preventDefault(); try { e.dataTransfer.dropEffect = ppDrag.kind === 'new' ? 'copy' : 'move'; } catch (x) {} showIndicator(intro, blockAfter(intro, e.clientY)); });
      intro.addEventListener('drop', function (e) {
        if (!ppDrag || isProject()) return; e.preventDefault();
        var ref = blockAfter(intro, e.clientY); clearIndicator();
        var el = ppDrag.kind === 'new' ? newBlockEl(ppDrag.type) : ppDrag.el;
        if (el && el !== ref) intro.insertBefore(el, ref);
        ppDrag = null; emitContent();
      });
    }
    if (!_dndDocWired) {
      _dndDocWired = true;
      // Project widgets (Survey / Phase) drop ANYWHERE on the page → parent adds to the model.
      document.addEventListener('dragover', function (e) { if (isProject()) e.preventDefault(); });
      document.addEventListener('drop', function (e) { if (isProject()) { e.preventDefault(); postOut({ ppAdd: ppDrag.type }); ppDrag = null; } });
    }
  }
  function enableBuilder(model) {
    document.body.classList.add('pp-builder');
    var t = $('#title'); if (t) { t.setAttribute('contenteditable', 'true'); t.setAttribute('data-pp-edit', 'title'); }
    var intro = $('#intro');
    if (intro) { wrapBlocks(intro); setupDnD(intro); }
    buildPalette();
    // Hero: always show a clickable banner in the builder (upload handled by the parent).
    var bannerSec = $('#banner') && $('#banner').closest('.pp-banner');
    if (bannerSec) {
      bannerSec.style.display = '';
      bannerSec.classList.add('pp-banner--edit');
      if (!model.hero) bannerSec.innerHTML = '<div class="pp-banner__ph"><span data-gv-icon="image"></span> Add a header image</div>';
      bannerSec.style.cursor = 'pointer';
      bannerSec.onclick = function () { postOut({ ppEdit: 'hero' }); };
    }
    // Click the participation box / timeline → ask the parent to surface phase/survey mgmt.
    // (onclick, not addEventListener, so re-renders don't stack handlers.)
    ['#cta', '.gv-methodband'].forEach(function (sel) {
      var z = $(sel); if (z) { z.classList.add('pp-zone-edit'); z.onclick = function () { postOut({ ppEdit: sel === '#cta' ? 'participation' : 'phases' }); }; }
    });
    if (!_builderInputWired) { _builderInputWired = true; document.addEventListener('input', function () { emitContent(); }); }
    if (window.GVIcons) window.GVIcons.render(document.body);
  }
  var _builderInputWired = false;
  // expose for the iframe bootstrap (called after render when mode==='builder')
  window.PP.enableBuilder = enableBuilder;

  // Auto-render if a model was injected before this script ran.
  if (window.__PP_MODEL__) window.PP.render(window.__PP_MODEL__);
})();
