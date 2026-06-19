/* ════════ HOMEPAGE BUILDER ENGINE — one model, two surfaces ════════
   window.HBModel = ordered list of homepage widgets. The same model drives the
   builder canvas (#hb-frame, selectable blocks) AND, on Save, a faithful homepage.
   The per-widget SETTINGS panels are grounded on the LIVE homepage builder
   (govocal-exports/r9-set-<widget>, captured 2026-06-19) + citizenlab source
   (ContentBuilder/components/Widgets). Faithful to the canonical pages/homepage.

   SYNC: homepage sync set = THIS engine (HB_R renderers + M model + SETTINGS) ⇄
   pages/homepage/index.html (canonical reference) ⇄ the prototype HB engine in
   parallel-participation/prototypes/back-office-test/index.html. A widget/settings
   change here MUST be mirrored in the prototype's SETTINGS + the canonical page.
   See memory page-builder-sync-contract. */
(function () {
  var IMG = '../homepage/img/';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); };

  var LABELS = {
    'homepage-banner': 'Homepage banner', 'open-to-participation': 'Open to participation',
    'followed-items': 'Followed items', 'finished-or-archived': 'Finished projects', 'areas': 'In your area',
    'spotlight': 'Spotlight', 'selection': 'Selected projects and folders', 'published': 'Published projects and folders',
    'events': 'Events', 'call-to-action': 'Call to action', 'community-monitor-cta': 'Community Monitor',
    'projects': 'Projects and folders (legacy)', 'text': 'Text', 'white-space': 'White space', 'button': 'Button',
    'image': 'Image', 'iframe': 'Embed', 'video-embed': 'Video', 'accordion': 'Accordion',
    'two-column': '2 column', 'three-column': '3 column', 'image-text-cards': 'Image & text cards'
  };

  // ── content pools (mirror pages/homepage — Westmere) ──
  var OPEN = [
    { img: 'street.webp', t: 'Riverside path study', s: '2 days left' },
    { img: 'climate-harbour.webp', t: 'Harbour cycle network', s: '5 days left' },
    { img: 'done-square.webp', t: 'Redesigning Market Square', s: '1 week left' },
    { img: 'climate-northgate.webp', t: 'Northgate green corridor', s: '2 months left' },
    { img: 'feat-downtown.webp', t: 'Downtown mobility plan', s: 'No end date' }
  ];
  var DONE = [
    { img: 'done-youth.webp', t: 'Children & youth strategy 2025–2030', s: '7 weeks ago' },
    { img: 'done-schoolyards.webp', t: 'Greening the schoolyards', s: '3 weeks ago' },
    { img: 'done-oldtown.webp', t: 'Old Town as new', s: '5 months ago' }
  ];
  var TEAMS = [
    { img: 'climate-riverside.webp', t: 'Riverside climate team', n: '145' },
    { img: 'climate-oldtown.webp', t: 'Old Town climate team', n: '69' },
    { img: 'climate-harbour.webp', t: 'Harbour climate team', n: '132' },
    { img: 'climate-northgate.webp', t: 'Northgate climate team', n: '98' },
    { img: 'climate-westside.webp', t: 'Westside climate team', n: '211' }
  ];
  var EVENTS = [
    { img: 'event-online.webp', m: 'Jun', d: '18', t: 'Community session: bringing online & offline participation together', when: '18 Jun 2026 · 11:00 – 12:00', li: 'Online meeting', link: 1, r: '2', rsvp: 1 },
    { img: 'event-walk.webp', m: 'Jun', d: '25', t: 'Station Road walk & talk: see the plans on site', when: '25 Jun 2026 · 17:30 – 19:00', li: 'Northgate station, Station Road', r: '41' },
    { img: 'event-budget.webp', m: 'Jul', d: '02', t: 'Participatory budget: info & Q&A session', when: '2 Jul 2026 · 18:00 – 19:30', li: 'Online meeting', link: 1, r: '7' }
  ];
  var GRID = [
    { img: 'feat-downtown.webp', t: 'The big downtown survey', d: 'What does downtown need to become more liveable? Tell us which places matter.' },
    { img: 'done-square.webp', t: 'A square for everyone', d: 'How can Market Square become a popular meeting point in the neighbourhood?' },
    { img: 'street.webp', t: 'The future of Station Road', d: 'Help redesign Station Road for trees, walking and safer cycling.' }
  ];

  function compactCard(c, done) {
    return '<article class="gv-pcard light compact"><div class="gv-pcard__thumb"><img src="' + IMG + c.img + '" alt="" loading="lazy" /></div>'
      + '<div class="gv-pcard__body"><h3 class="gv-pcard__title"><a href="#" onclick="return false;">' + esc(c.t) + '</a></h3>'
      + '<span class="gv-pcard__status' + (done ? ' done' : '') + '"><span data-gv-icon="' + (done ? 'check-circle' : 'clock-solid') + '" aria-hidden="true"></span> ' + esc(c.s) + '</span>'
      + '<span class="gv-pcard__more">Learn more</span></div></article>';
  }
  function teamCard(c) {
    return '<article class="gv-pcard light climate-team" style="flex:0 0 320px"><div class="gv-pcard__thumb"><img src="' + IMG + c.img + '" alt="" loading="lazy" /></div>'
      + '<div class="gv-pcard__body"><h3 class="gv-pcard__title"><a href="#" onclick="return false;">' + esc(c.t) + '</a></h3>'
      + '<div class="gv-bubbles xs"><span class="av"></span><span class="av"></span><span class="av"></span><span class="gv-bubbles__label">' + c.n + ' participants</span></div>'
      + '<p class="gv-pcard__desc">Wanted: your idea for a better climate in this district.</p></div></article>';
  }
  function gridCard(c) {
    return '<article class="gv-pcard light"><div class="gv-pcard__thumb"><img src="' + IMG + c.img + '" alt="" loading="lazy" /></div>'
      + '<div class="gv-pcard__body"><h3 class="gv-pcard__title"><a href="#" onclick="return false;">' + esc(c.t) + '</a></h3>'
      + '<p class="gv-pcard__desc">' + esc(c.d) + '</p><span class="gv-pcard__more">Learn more</span></div></article>';
  }
  function eventCard(e) {
    var rsvp = e.rsvp ? '<span class="gv-event-card__rsvp">Going</span>' : '';
    var loc = e.link ? '<p class="gv-event-card__row"><span data-gv-icon="link"></span> <a href="#" onclick="return false;">' + esc(e.li) + '</a></p>'
      : '<p class="gv-event-card__row"><span data-gv-icon="location-simple"></span> ' + esc(e.li) + '</p>';
    return '<article class="gv-event-card bordered"><div class="gv-event-card__media"><img src="' + IMG + e.img + '" alt="" loading="lazy" />'
      + '<span class="gv-event-card__date"><span class="m">' + e.m + '</span><span class="d">' + e.d + '</span><span class="y">2026</span></span>' + rsvp + '</div>'
      + '<div class="gv-event-card__body"><h3 class="gv-event-card__title"><a href="#" onclick="return false;">' + esc(e.t) + '</a></h3>'
      + '<div class="gv-event-card__meta"><p class="gv-event-card__row"><span data-gv-icon="clock"></span> ' + esc(e.when) + '</p>' + loc
      + '<p class="gv-event-card__row"><span data-gv-icon="user"></span> ' + e.r + ' registrants</p></div>'
      + '<a class="gv-btn primary full" href="#" onclick="return false;">Register</a></div></article>';
  }
  function railSec(title, cards) {
    return '<section class="gv-section"><div class="gv-section__head"><h2 class="gv-title h2">' + esc(title) + '</h2></div>'
      + '<div class="gv-section__body"><div class="gv-rail" tabindex="0" role="group" aria-label="' + esc(title) + '">' + cards + '</div></div></section>';
  }
  function gridSec(title, cards) {
    return '<section class="gv-section"><div class="gv-section__head"><h2 class="gv-title h2">' + esc(title) + '</h2></div>'
      + '<div class="gv-section__body"><div class="hb-grid">' + cards + '</div></div></section>';
  }

  // ── one renderer per widget (faithful to canonical pages/homepage) ──
  var HB_R = {
    'homepage-banner': function (w) {
      var avatars = w.avatars === false ? '' : '<div class="gv-avatars" aria-label="15.4 thousand participants"><span class="av"></span><span class="av"></span><span class="av"></span><span class="av"></span><span class="count">15.4k</span></div>';
      var btn = w.cta === 'none' ? '' : '<div class="gv-hero__actions"><a class="gv-btn primary-inverse" href="#" onclick="return false;">' + esc(w.ctaLabel || (w.cta === 'signup' ? 'Sign up' : 'A greener Station Road — share your ideas')) + '</a></div>';
      return '<section class="gv-hero signed-out centered" style="background-image:url(\'' + IMG + 'hero.webp\')">'
        + '<div class="gv-hero__inner"><h1 class="gv-hero__title">' + esc(w.title) + '</h1>'
        + '<p class="gv-hero__lead">' + esc(w.lead) + '</p>' + avatars + btn + '</div></section>';
    },
    'spotlight': function (w) {
      var avatars = w.avatars === false ? '' : '<div class="gv-bubbles" style="margin-top:18px"><span class="av"></span><span class="av"></span><span class="av"></span><span class="gv-bubbles__label">145 participants</span></div>';
      return '<section class="gv-spotlight"><div class="gv-spotlight__inner"><div>'
        + '<h2 class="gv-spotlight__title">' + esc(w.title) + '</h2><p class="gv-spotlight__lead">' + esc(w.lead) + '</p>'
        + '<div class="gv-spotlight__actions"><a class="gv-btn primary size-m" href="#" onclick="return false;">' + esc(w.cta) + '</a></div>' + avatars + '</div>'
        + '<div class="gv-spotlight__media"><img src="' + IMG + 'spotlight.webp" alt="" loading="lazy" /></div></div></section>';
    },
    'areas': function (w) { return railSec(w.title || 'In your area', TEAMS.map(teamCard).join('')); },
    'open-to-participation': function (w) { return railSec(w.title || 'Open to participation', OPEN.map(function (c) { return compactCard(c, 0); }).join('')); },
    'finished-or-archived': function (w) { return railSec(w.title || 'Completed projects', DONE.map(function (c) { return compactCard(c, 1); }).join('')); },
    'followed-items': function (w) { return railSec(w.title || 'Projects you follow', OPEN.slice(0, 3).map(function (c) { return compactCard(c, 0); }).join('')); },
    'selection': function (w) { return gridSec(w.title || 'Selected projects and folders', GRID.map(gridCard).join('')); },
    'published': function (w) { return gridSec(w.title || 'Published projects and folders', GRID.concat(GRID.slice(0, 1)).map(gridCard).join('')); },
    'projects': function (w) { return gridSec(w.title || 'Participation projects', GRID.map(gridCard).join('')); },
    'events': function (w) {
      return '<section class="gv-section"><div class="gv-section__body"><div class="hb-events__head"><h2 class="gv-title h2" style="margin:0">Upcoming and ongoing events</h2><a class="gv-btn text" href="#" onclick="return false;">View all events</a></div><div class="gv-events__grid">' + EVENTS.map(eventCard).join('') + '</div></div></section>';
    },
    'call-to-action': function (w) {
      var sec = w.cta2 ? ' <a class="gv-btn primary-inverse size-m" href="#" onclick="return false;">' + esc(w.cta2) + '</a>' : '';
      return '<section class="gv-ctaband"><div class="gv-ctaband__inner"><h2 class="gv-ctaband__title">' + esc(w.title) + '</h2><p class="gv-ctaband__lead">' + esc(w.lead) + '</p><a class="gv-btn primary size-m" href="#" onclick="return false;">' + esc(w.cta) + '</a>' + sec + '</div></section>';
    },
    'community-monitor-cta': function (w) {
      return '<section class="gv-section"><div class="gv-section__body"><div class="hb-cm"><div class="hb-cm__icon"><span data-gv-icon="trend-up"></span></div>'
        + '<div class="hb-cm__body"><h2 class="hb-cm__title">' + esc(w.title || 'How is our community doing?') + '</h2><p class="hb-cm__lead">' + esc(w.lead || 'Share how you feel about life in Westmere. It takes 2 minutes and helps the city track what matters over time.') + '</p></div>'
        + '<a class="gv-btn primary" href="#" onclick="return false;">' + esc(w.cta || 'Take the survey') + '</a></div></div></section>';
    },
    'text': function (w) {
      return '<section class="gv-section"><div class="gv-prose">' + (w.html || '<p>Welcome to the official engagement platform of the City of Westmere. Follow participation projects across our districts, share your thoughts on the questions that matter, and give feedback in dialogue with the city.</p><p><em>Sign up today and help us build a greener, more connected Westmere.</em></p>') + '</div></section>';
    },
    'button': function (w) {
      var align = w.align || 'left', cls = w.style === 'secondary' ? 'secondary-outlined' : 'primary';
      return '<section class="gv-section"><div class="hb-btnblock is-' + align + '"><a class="gv-btn ' + cls + ' size-m" href="#" onclick="return false;">' + esc(w.label || 'Take the survey') + '</a></div></section>';
    },
    'image': function (w) { return '<section class="gv-section"><img class="hb-img" src="' + IMG + (w.img || 'spotlight.webp') + '" alt="' + esc(w.alt || '') + '" loading="lazy" /></section>'; },
    'white-space': function (w) { var h = w.size === 'small' ? 24 : w.size === 'large' ? 80 : 48; return '<div class="hb-ws' + (w.border ? ' has-border' : '') + '" style="height:' + h + 'px"></div>'; },
    'accordion': function (w) {
      return '<section class="gv-section"><div class="gv-accordion">'
        + '<details class="gv-acc__item"' + (w.open ? ' open' : '') + '><summary class="gv-acc__head"><span class="gv-acc__q">' + esc(w.title || 'How do I take part?') + '</span><span class="gv-acc__chev" data-gv-icon="chevron-right" aria-hidden="true"></span></summary><div class="gv-acc__body"><p>Pick any open project and follow the steps — most take just a few minutes.</p></div></details>'
        + '</div></section>';
    },
    'two-column': function (w) {
      var lay = w.layout === '2-1' ? 'hb-cols-2-1' : w.layout === '1-2' ? 'hb-cols-1-2' : 'hb-cols-2';
      return '<section class="gv-section"><div class="hb-cols ' + lay + '"><div class="hb-colph">Column 1</div><div class="hb-colph">Column 2</div></div></section>';
    },
    'three-column': function (w) { return '<section class="gv-section"><div class="hb-cols hb-cols-3"><div class="hb-colph">Column 1</div><div class="hb-colph">Column 2</div><div class="hb-colph">Column 3</div></div></section>'; },
    'image-text-cards': function (w) {
      return '<section class="gv-section"><div class="hb-cards">'
        + GRID.map(function (c) { return '<div class="hb-card"><div class="hb-card__img"><img src="' + IMG + c.img + '" alt="" loading="lazy" /></div><h3 class="hb-card__t">' + esc(c.t) + '</h3><p class="hb-card__d">' + esc(c.d) + '</p></div>'; }).join('')
        + '</div></section>';
    },
    'iframe': function (w) { return '<section class="gv-section"><div class="hb-embed"><span data-gv-icon="link"></span> Embedded content<small>' + esc(w.url || 'Paste a URL to embed') + '</small></div></section>'; },
    'video-embed': function (w) { return '<section class="gv-section"><div class="hb-video"><span class="hb-video__play" aria-hidden="true">▶</span></div></section>'; }
  };

  function widgetHTML(w) { var fn = HB_R[w.type]; return fn ? fn(w) : '<section class="gv-section"><div class="hb-colph">' + esc(LABELS[w.type] || w.type) + '</div></section>'; }

  // ── the model: ONE of every widget, in a faithful homepage order ──
  var M = [
    { type: 'homepage-banner', title: 'Help shape the future of Westmere', lead: 'Have your say on the projects and decisions shaping our city — from the harbour to your own street.', cta: 'custom', ctaLabel: 'A greener Station Road — share your ideas', avatars: true, layout: 'full-width' },
    { type: 'spotlight', title: 'A greener Station Road', lead: "We're redesigning Station Road to make space for trees, wider pavements and safer cycling. Take the survey to tell us what matters most on your daily journey.", cta: 'Take the survey', avatars: true },
    { type: 'areas', title: 'City climate teams' },
    { type: 'open-to-participation', title: 'Open to participation' },
    { type: 'finished-or-archived', title: 'Completed projects', filter: 'finished' },
    { type: 'events' },
    { type: 'call-to-action', title: 'What is your proposal?', lead: "Post your proposal on this platform, gather support and place it on the city's agenda.", cta: 'Explore all proposals' },
    { type: 'community-monitor-cta', title: 'How is our community doing?', lead: 'Share how you feel about life in Westmere. It takes 2 minutes and helps the city track what matters over time.', cta: 'Take the survey' },
    { type: 'text' },
    { type: 'selection', title: 'Selected projects and folders' },
    { type: 'published', title: 'Published projects and folders' },
    { type: 'projects', title: 'Participation projects' },
    { type: 'followed-items', title: 'Projects you follow' },
    { type: 'image-text-cards' },
    { type: 'two-column', layout: '1-1' }, { type: 'three-column' },
    { type: 'image', alt: '' }, { type: 'button', label: 'Take the survey', style: 'primary', align: 'left' },
    { type: 'accordion', title: 'How do I take part?', open: false }, { type: 'iframe' }, { type: 'video-embed' }, { type: 'white-space', size: 'medium', border: false }
  ];
  var uid = 1;
  M.forEach(function (w) { w.id = 'hw_' + (uid++); });
  window.HBModel = M;
  function find(id) { for (var i = 0; i < M.length; i++) if (M[i].id === id) return M[i]; return null; }
  function indexOf(id) { for (var i = 0; i < M.length; i++) if (M[i].id === id) return i; return -1; }

  var frame = document.getElementById('hb-frame');
  var root = document.getElementById('hb-root');
  var sTitle = document.getElementById('hb-settings-title');
  var sBody = document.getElementById('hb-settings-body');
  var toastEl = document.getElementById('hb-toast');
  var selId = null;
  var bannerView = 'signedOut';

  function renderCanvas() {
    frame.innerHTML = M.map(function (w) {
      return '<div class="gv-bo-cb-block' + (w.id === selId ? ' is-selected' : '') + '" data-hb-id="' + w.id + '" data-hb-widget="' + w.type + '">'
        + '<span class="gv-bo-cb-block__label">' + esc(LABELS[w.type] || w.type) + '</span>' + widgetHTML(w) + '</div>';
    }).join('');
    if (window.GVIcons) window.GVIcons.render(frame);
    if (window.GVAvatars) window.GVAvatars.fill(frame);
  }
  function renderBlock(id) {
    var el = frame.querySelector('[data-hb-id="' + id + '"]'); if (!el) return;
    var w = find(id);
    el.innerHTML = '<span class="gv-bo-cb-block__label">' + esc(LABELS[w.type] || w.type) + '</span>' + widgetHTML(w);
    if (window.GVIcons) window.GVIcons.render(el);
    if (window.GVAvatars) window.GVAvatars.fill(el);
  }

  // ════════ settings-panel builders (real fields, canonical chrome) ════════
  function mlHead(label) {
    return '<div class="hb-set-head"><span class="hb-set-label">' + label + '</span>'
      + '<div class="gv-bo-multiloc"><button type="button" class="is-active" data-loc="en"><span class="done"></span>EN</button><button type="button" data-loc="es-ES"><span class="miss"></span>ES-ES</button></div></div>';
  }
  function fText(key, label, opt) {
    opt = opt || {};
    var head = opt.multiloc ? mlHead(label) : '<label class="hb-set-label">' + label + '</label>';
    var help = opt.help ? '<p class="hb-field-help">' + opt.help + '</p>' : '';
    return '<div class="hb-set-row">' + head + '<input class="gv-input" data-hb-field="' + key + '"' + (opt.ph ? ' placeholder="' + esc(opt.ph) + '"' : '') + ' />' + help + '</div>';
  }
  function fArea(key, label, opt) {
    opt = opt || {};
    var head = opt.multiloc ? mlHead(label) : '<label class="hb-set-label">' + label + '</label>';
    return '<div class="hb-set-row">' + head + '<textarea class="gv-input" rows="3" data-hb-field="' + key + '"></textarea></div>';
  }
  function fRte(label) {
    return '<div class="hb-set-row">' + mlHead(label)
      + '<div class="gv-bo-cb-rte"><div class="gv-bo-cb-rte__toolbar">'
      + '<span class="gv-bo-cb-rte__group"><select class="gv-bo-cb-rte__select"><option>Normal</option><option>Title</option><option>Subtitle</option></select></span>'
      + '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Bold"><b>B</b></button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Italic"><i>i</i></button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Add link"><span class="gv-icon" data-gv-icon="link"></span></button></span>'
      + '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Ordered list">1.</button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Bulleted list">•</button></span>'
      + '</div><div class="gv-bo-cb-rte__editor" contenteditable="true" data-hb-field="html"></div></div></div>';
  }
  function toggleRow(key, label, help, checked) {
    // canonical .gv-bo-togglerow.is-action — green toggle first, label/help block right
    return '<div class="gv-bo-togglerow is-action" style="margin-bottom:16px"><label class="gv-toggle"><input type="checkbox" data-hb-toggle="' + key + '"' + (checked ? ' checked' : '') + ' /><span class="track"></span></label>'
      + '<div><p class="gv-bo-togglerow__title">' + label + '</p>' + (help ? '<p class="gv-bo-help">' + help + '</p>' : '') + '</div></div>';
  }
  function radioCards(key, opts, cur) {
    return '<div class="hb-set-row"><span class="hb-set-label">Layout</span><div class="hb-radiocards">'
      + opts.map(function (o) { return '<button type="button" class="hb-radiocard' + (o.val === cur ? ' is-active' : '') + '" data-hb-set="' + key + '" data-hb-val="' + o.val + '"><span class="hb-radiocard__art ' + o.art + '"></span>' + esc(o.label) + '</button>'; }).join('')
      + '</div></div>';
  }
  function radioRow(key, label, opts, cur) {
    return '<div class="hb-set-row"><span class="hb-set-label">' + label + '</span><div class="hb-radiorow">'
      + opts.map(function (o) { return '<button type="button" class="hb-radiopill' + (o.val === cur ? ' is-active' : '') + '" data-hb-set="' + key + '" data-hb-val="' + o.val + '">' + esc(o.label) + '</button>'; }).join('')
      + '</div></div>';
  }
  function descBlock(html) { return '<p class="hb-desc">' + html + '</p>'; }
  function uploadRow(label, btn) { return '<div class="hb-set-row"><label class="hb-set-label">' + label + '</label><button class="gv-btn secondary-outlined size-s" type="button">' + (btn || 'Upload image…') + '</button></div>'; }

  var SETTINGS = {
    'homepage-banner': function (w) {
      var layouts = [
        { val: 'full-width', label: 'Full-width banner', art: 'hb-ra-full' },
        { val: 'two-column', label: 'Two columns', art: 'hb-ra-cols' },
        { val: 'two-row', label: 'Two rows', art: 'hb-ra-rows' },
        { val: 'fixed-ratio', label: 'Fixed-ratio banner', art: 'hb-ra-ratio' }
      ];
      var ctaOpts = bannerView === 'signedOut'
        ? [{ val: 'signup', label: 'Sign up' }, { val: 'none', label: 'No button' }, { val: 'custom', label: 'Customize' }]
        : [{ val: 'none', label: 'No button' }, { val: 'custom', label: 'Customize' }];
      var custom = w.cta === 'custom'
        ? fText('ctaLabel', 'Button text', { multiloc: true }) + fText('ctaUrl', 'Button link', { ph: 'https://...' })
        : '';
      var subtext = bannerView === 'signedOut' ? fText('lead', 'Banner subtext', { multiloc: true }) : '';
      var avatars = bannerView === 'signedOut' ? toggleRow('avatars', 'Display avatars', 'Show profile pictures of participants and number of them to non-registered visitors', w.avatars !== false) : '';
      return '<div class="hb-subtabs"><button type="button" class="hb-subtab' + (bannerView === 'signedOut' ? ' is-active' : '') + '" data-hb-bview="signedOut">Non-registered users</button><button type="button" class="hb-subtab' + (bannerView === 'signedIn' ? ' is-active' : '') + '" data-hb-bview="signedIn">Registered users</button></div>'
        + '<p class="hb-help">' + (bannerView === 'signedOut' ? 'This is how visitors that are not registered on the platform see the banner.' : 'This is how registered, signed-in users see the banner.') + '</p>'
        + radioCards('layout', layouts, w.layout || 'full-width')
        + uploadRow('Banner image', 'Replace image…')
        + toggleRow('overlay', 'Enable overlay', '', !!w.overlay)
        + fText('title', 'Banner text', { multiloc: true })
        + subtext + avatars
        + radioRow('cta', 'Button', ctaOpts, w.cta || 'custom') + custom;
    },
    'spotlight': function (w) {
      return '<div class="hb-set-row"><label class="hb-set-label">Select project or folder</label><button type="button" class="hb-pickbtn">A greener Station Road <span class="gv-icon" data-gv-icon="chevron-down"></span></button></div>'
        + fText('title', 'Title', { multiloc: true })
        + fRte('Description')
        + fText('cta', 'Button text', { multiloc: true })
        + toggleRow('avatars', 'Show avatars', '', w.avatars !== false);
    },
    'open-to-participation': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + descBlock('This widget will showcase projects where the user can currently <b>take an action to participate</b>.');
    },
    'followed-items': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + descBlock('This widget shows each user projects <b>based on their follow preferences</b>. This includes projects that they follow, as well as projects where they follow inputs, and projects related to topics or areas that they are interested in.');
    },
    'finished-or-archived': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + radioRow('filter', 'Filter by', [{ val: 'finished', label: 'Finished' }, { val: 'archived', label: 'Archived' }, { val: 'finished_and_archived', label: 'Finished and archived' }], w.filter || 'finished')
        + descBlock('This widget shows <b>projects that are finished and/or archived</b>. "Finished" also includes projects that are in the last phase, and where the last phase is a report.');
    },
    'areas': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + descBlock('This widget shows projects for the <b>areas a user follows</b>. Users who follow no areas see all projects.');
    },
    'selection': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + '<div class="hb-set-row"><label class="hb-set-label">Select projects or folders</label><button type="button" class="hb-pickbtn">Add a project or folder… <span class="gv-icon" data-gv-icon="plus"></span></button>'
        + '<ul class="hb-picklist"><li class="hb-pickitem"><span class="hb-grip" data-gv-icon="drag-handle"></span><span class="hb-pickitem__name">The big downtown survey</span><button class="hb-pickitem__del" aria-label="Remove"><span data-gv-icon="close"></span></button></li>'
        + '<li class="hb-pickitem"><span class="hb-grip" data-gv-icon="drag-handle"></span><span class="hb-pickitem__name">A square for everyone</span><button class="hb-pickitem__del" aria-label="Remove"><span data-gv-icon="close"></span></button></li>'
        + '<li class="hb-pickitem"><span class="hb-grip" data-gv-icon="drag-handle"></span><span class="hb-pickitem__name">The future of Station Road</span><button class="hb-pickitem__del" aria-label="Remove"><span data-gv-icon="close"></span></button></li></ul></div>'
        + '<p class="hb-field-help">With this widget, you can select and determine the order in which you want projects or folders to show to users.</p>';
    },
    'published': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + descBlock('This widget will showcase the projects and folders that are <b>currently published</b>, respecting the ordering defined on the projects page.');
    },
    'events': function (w) {
      return '<p class="hb-help">Displays the next 3 upcoming events on your platform.</p>';
    },
    'call-to-action': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + fText('lead', 'Description', { multiloc: true })
        + fText('cta', 'Primary button text', { multiloc: true })
        + fText('ctaUrl', 'Primary button URL', { ph: 'https://example.com' })
        + fText('cta2', 'Secondary button text', { multiloc: true })
        + fText('cta2Url', 'Secondary button URL', { ph: 'https://example.com' });
    },
    'community-monitor-cta': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + fText('lead', 'Description', { multiloc: true })
        + fText('cta', 'Button', { multiloc: true })
        + '<p class="hb-field-help"><b>Important:</b> This widget will only be visible on the Homepage when the Community Monitor is accepting responses.</p>';
    },
    'projects': function (w) {
      return fText('title', 'Projects title', { multiloc: true, ph: 'Westmere is currently working on' })
        + '<p class="hb-field-help">To configure the order in which your projects are displayed, reorder them on the Projects page.</p>';
    },
    'text': function (w) { return fRte('Text'); },
    'white-space': function (w) {
      return radioRow('size', 'Vertical height', [{ val: 'small', label: 'Small' }, { val: 'medium', label: 'Medium' }, { val: 'large', label: 'Large' }], w.size || 'medium')
        + toggleRow('border', 'Include border', '', !!w.border);
    },
    'button': function (w) {
      return fText('label', 'Button text', { multiloc: true })
        + fText('url', 'Button URL', { ph: 'https://...' })
        + radioRow('style', 'Button type', [{ val: 'primary', label: 'Primary' }, { val: 'secondary', label: 'Secondary' }], w.style || 'primary')
        + radioRow('align', 'Button alignment', [{ val: 'left', label: 'Left' }, { val: 'center', label: 'Center' }, { val: 'right', label: 'Right' }, { val: 'full', label: 'Full width' }], w.align || 'left');
    },
    'image': function (w) {
      return uploadRow('Image', 'Upload image…')
        + fText('alt', 'Short description of the image', { multiloc: true, help: 'Adding "alt text" for images is important to make your platform accessible for users using screen readers.' });
    },
    'iframe': function (w) {
      return fText('url', 'Website address', { help: 'Full URL of the website you want to embed.' })
        + radioRow('embedMode', 'Embed mode', [{ val: 'fixed', label: 'Fixed Height' }, { val: 'ratio', label: 'Aspect Ratio' }], w.embedMode || 'fixed')
        + (w.embedMode === 'ratio'
          ? '<div class="hb-set-row"><label class="hb-set-label">Aspect ratio</label><select class="gv-bo-select"><option>16:9</option><option>4:3</option><option>3:4</option><option>1:1</option><option>Custom</option></select><p class="hb-field-help">Choose an aspect ratio that scales responsively across all devices.</p></div>'
          : fText('h', 'Desktop height (pixels)', { ph: '500', help: 'Height for desktop view (in pixels).' }))
        + fText('embedAlt', 'Short description of the content you are embedding', { multiloc: true, help: 'It is useful to provide this information for users who rely on a screen reader or other assistive technology.' });
    },
    'video-embed': function (w) {
      return '<div class="hb-warn"><span class="gv-icon" data-gv-icon="alert-circle"></span><span><b>WARNING: DO NOT PASTE CODE FROM UNTRUSTED SOURCES.</b> Only use embed codes from trusted video platforms like YouTube or Vimeo.</span></div>'
        + '<div class="hb-set-row"><label class="hb-set-label">Embed code</label><textarea class="gv-input" rows="5" data-hb-field="code" placeholder="<iframe …></iframe>"></textarea></div>';
    },
    'accordion': function (w) {
      return fText('title', 'Title', { multiloc: true })
        + toggleRow('open', 'Open by default', '', !!w.open);
    },
    'two-column': function (w) {
      return radioCards('layout', [
        { val: '1-1', label: '2 even columns', art: 'hb-ra-cols' },
        { val: '2-1', label: '60% / 30%', art: 'hb-ra-cols' },
        { val: '1-2', label: '30% / 60%', art: 'hb-ra-cols' }
      ], w.layout || '1-1');
    },
    'three-column': function (w) { return '<p class="hb-help">This widget has a fixed three-column layout. Drop content into each column on the canvas.</p>'; },
    'image-text-cards': function (w) { return '<p class="hb-help">This is a preset of three image-and-text rows. Edit each image or text block directly on the canvas.</p>'; }
  };

  function settingsHTML(w) { return (SETTINGS[w.type] || function () { return '<p class="hb-help">Settings for the <strong>' + esc(LABELS[w.type] || w.type) + '</strong> widget.</p>'; })(w); }

  function deselect() { selId = null; root.classList.remove('cb-has-panel'); frame.querySelectorAll('.is-selected').forEach(function (b) { b.classList.remove('is-selected'); }); }
  function fillFields(w) {
    // reflect model values into the panel's text controls
    sBody.querySelectorAll('[data-hb-field]').forEach(function (el) {
      var k = el.getAttribute('data-hb-field'); var v = w[k];
      if (el.getAttribute('contenteditable') === 'true') { if (v != null) el.innerHTML = v; }
      else if (v != null) el.value = v;
    });
  }
  function select(id) {
    selId = id; root.classList.add('cb-has-panel');
    frame.querySelectorAll('.gv-bo-cb-block').forEach(function (b) { b.classList.toggle('is-selected', b.getAttribute('data-hb-id') === id); });
    var w = find(id); sTitle.textContent = LABELS[w.type] || w.type;
    sBody.innerHTML = settingsHTML(w)
      + '<div class="hb-blockbar"><button type="button" data-hb-move="-1" title="Move up">▲ Up</button><button type="button" data-hb-move="1" title="Move down">▼ Down</button></div>'
      + '<button class="gv-bo-cb-delete" type="button" data-hb-del="1"><span data-gv-icon="delete"></span> Delete</button>';
    fillFields(w);
    if (window.GVIcons) window.GVIcons.render(sBody);
  }
  function reselect() { var w = find(selId); if (!w) return; var keep = selId; select(keep); }

  frame.addEventListener('click', function (e) {
    if (root.classList.contains('cb-preview')) return;
    var b = e.target.closest('.gv-bo-cb-block'); if (b) select(b.getAttribute('data-hb-id'));
  });
  document.getElementById('hb-settings-close').addEventListener('click', deselect);

  // text / textarea / rte input
  sBody.addEventListener('input', function (e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-hb-field'); if (!f || !selId) return;
    var w = find(selId);
    w[f] = e.target.getAttribute('contenteditable') === 'true' ? e.target.innerHTML : e.target.value;
    renderBlock(selId);
  });
  // toggles
  sBody.addEventListener('change', function (e) {
    var t = e.target.getAttribute && e.target.getAttribute('data-hb-toggle'); if (!t || !selId) return;
    find(selId)[t] = e.target.checked; renderBlock(selId);
  });
  // radio pills / cards, subtabs, move, delete
  sBody.addEventListener('click', function (e) {
    var set = e.target.closest('[data-hb-set]'), bview = e.target.closest('[data-hb-bview]');
    var mv = e.target.closest('[data-hb-move]'), del = e.target.closest('[data-hb-del]');
    if (set && selId) { find(selId)[set.getAttribute('data-hb-set')] = set.getAttribute('data-hb-val'); renderBlock(selId); reselect(); }
    else if (bview && selId) { bannerView = bview.getAttribute('data-hb-bview'); reselect(); }
    else if (mv && selId) { var i = indexOf(selId), j = i + parseInt(mv.getAttribute('data-hb-move'), 10); if (j < 0 || j >= M.length) return; var t = M[i]; M[i] = M[j]; M[j] = t; renderCanvas(); var el = frame.querySelector('[data-hb-id="' + selId + '"]'); if (el) el.scrollIntoView({ block: 'center' }); }
    else if (del && selId) { var k = indexOf(selId); if (k >= 0) M.splice(k, 1); deselect(); renderCanvas(); }
  });

  // preview toggle
  document.getElementById('hb-preview-toggle').addEventListener('change', function () { root.classList.toggle('cb-preview', this.checked); if (this.checked) deselect(); });

  // palette → add a widget (click or drop)
  function addWidget(type) { var w = { id: 'hw_' + (uid++), type: type }; M.push(w); renderCanvas(); select(w.id); var el = frame.querySelector('[data-hb-id="' + w.id + '"]'); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  var dragType = null;
  root.querySelectorAll('.gv-bo-cb-palette .gv-bo-cb-item').forEach(function (it) {
    var type = it.getAttribute('data-hb-widget');
    it.addEventListener('click', function () { addWidget(type); });
    it.addEventListener('dragstart', function () { dragType = type; it.classList.add('is-dragging'); });
    it.addEventListener('dragend', function () { dragType = null; it.classList.remove('is-dragging'); });
  });
  frame.addEventListener('dragover', function (e) { if (dragType) { e.preventDefault(); frame.classList.add('is-dragover'); } });
  frame.addEventListener('dragleave', function () { frame.classList.remove('is-dragover'); });
  frame.addEventListener('drop', function (e) { if (dragType) { e.preventDefault(); frame.classList.remove('is-dragover'); addWidget(dragType); } });

  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('is-show'); clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.classList.remove('is-show'); }, 1400); }
  document.getElementById('hb-save').addEventListener('click', function () { toast('Homepage saved'); });
  document.querySelector('.gv-bo-cb-topbar__back').addEventListener('click', function () { location.href = '../homepage/'; });

  renderCanvas();
})();
