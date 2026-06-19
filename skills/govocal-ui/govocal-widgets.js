/* govocal-widgets.js — the canonical Page Builder WIDGET REGISTRY (single source).
 *
 * Each widget is defined ONCE as { label, make(block), settings(block), wire(block,api) }
 * and consumed by THREE surfaces, so they never drift:
 *   1. the builders  — GVPageBuilder.mount({ widgets: GVWidgets.homepage })  (and .project)
 *   2. each components/<widget>/ demo — renders the widget + its config screen
 *   3. the canonical homepage page — renders the same make() output
 *
 *   make(block)     -> default content HTML for the widget body
 *   settings(block) -> the real configuration screen (grounded on the live homepage
 *                      builder, govocal-exports/r9-set-<widget>, 2026-06-19)
 *   wire(block,api) -> two-way binding: settings controls edit the block in place
 *                      (GVWidgets.bind handles the declarative [data-bind] controls)
 *
 * Image base is per-consumer: call GVWidgets.config({ img: '<path>/' }) before use.
 */
window.GVWidgets = (function () {
  var IMG = '';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); };

  /* ── settings-control builders (canonical .gv-bo-* chrome + page-local hb-* layout) ── */
  function mlHead(label) {
    return '<div class="hb-set-head"><span class="hb-set-label">' + label + '</span>'
      + '<div class="gv-bo-multiloc"><button type="button" class="is-active" data-loc="en"><span class="done"></span>EN</button><button type="button" data-loc="es-ES"><span class="miss"></span>ES-ES</button></div></div>';
  }
  // text field. bind = selector in the block whose text this edits (live). opt.html = innerHTML.
  function fText(label, val, bind, opt) {
    opt = opt || {};
    var head = opt.multiloc ? mlHead(label) : '<label class="hb-set-label">' + label + '</label>';
    var help = opt.help ? '<p class="hb-field-help">' + opt.help + '</p>' : '';
    var attrs = (bind ? ' data-bind="' + bind + '"' : '') + (opt.html ? ' data-bind-html="1"' : '');
    return '<div class="hb-set-row">' + head + '<input class="gv-input"' + attrs + ' value="' + esc(val == null ? '' : val) + '"' + (opt.ph ? ' placeholder="' + esc(opt.ph) + '"' : '') + ' />' + help + '</div>';
  }
  function fRte(label, html, bind) {
    return '<div class="hb-set-row">' + mlHead(label)
      + '<div class="gv-bo-cb-rte"><div class="gv-bo-cb-rte__toolbar">'
      + '<span class="gv-bo-cb-rte__group"><select class="gv-bo-cb-rte__select"><option>Normal</option><option>Title</option><option>Subtitle</option></select></span>'
      + '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Bold"><b>B</b></button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Italic"><i>i</i></button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Add link"><span class="gv-icon" data-gv-icon="link"></span></button></span>'
      + '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Ordered list">1.</button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Bulleted list">•</button></span>'
      + '</div><div class="gv-bo-cb-rte__editor" contenteditable="true" data-bind="' + bind + '" data-bind-html="1">' + (html || '') + '</div></div></div>';
  }
  function toggleRow(label, help, checked, set) {
    return '<div class="gv-bo-togglerow is-action" style="margin-bottom:16px"><label class="gv-toggle"><input type="checkbox" data-hbset="' + set + '"' + (checked ? ' checked' : '') + ' /><span class="track"></span></label>'
      + '<div><p class="gv-bo-togglerow__title">' + label + '</p>' + (help ? '<p class="gv-bo-help">' + help + '</p>' : '') + '</div></div>';
  }
  function radioCards(label, opts, cur, set) {
    return '<div class="hb-set-row"><span class="hb-set-label">' + label + '</span><div class="hb-radiocards">'
      + opts.map(function (o) { return '<button type="button" class="hb-radiocard' + (o.val === cur ? ' is-active' : '') + '" data-hbset="' + set + '" data-hbval="' + o.val + '"><span class="hb-radiocard__art ' + o.art + '"></span>' + esc(o.label) + '</button>'; }).join('')
      + '</div></div>';
  }
  function radioRow(label, opts, cur, set) {
    return '<div class="hb-set-row"><span class="hb-set-label">' + label + '</span><div class="hb-radiorow">'
      + opts.map(function (o) { return '<button type="button" class="hb-radiopill' + (o.val === cur ? ' is-active' : '') + '" data-hbset="' + set + '" data-hbval="' + o.val + '">' + esc(o.label) + '</button>'; }).join('')
      + '</div></div>';
  }
  function descBlock(html) { return '<p class="hb-desc">' + html + '</p>'; }
  function uploadRow(label, btn) { return '<div class="hb-set-row"><label class="hb-set-label">' + label + '</label><button class="gv-btn secondary-outlined size-s" type="button">' + (btn || 'Upload image…') + '</button></div>'; }

  /* ── generic two-way binder: wires the declarative [data-bind] text controls so
       editing a field updates the matching node in the block live. Returns the panel
       so per-widget wire() can add radio/toggle specifics via onSet(). ── */
  function bind(block, panel, onSet) {
    panel.querySelectorAll('[data-bind]').forEach(function (ctrl) {
      var sel = ctrl.getAttribute('data-bind'); var html = ctrl.getAttribute('data-bind-html');
      var attr = null, at = sel.indexOf('@'); if (at >= 0) { attr = sel.slice(at + 1); sel = sel.slice(0, at); }
      var tgt = block.querySelector(sel); if (!tgt) return;
      var ce = ctrl.getAttribute('contenteditable') === 'true';
      ctrl.addEventListener('input', function () {
        var v = ce ? ctrl.innerHTML : ctrl.value;
        if (attr) tgt.setAttribute(attr, v); else if (html) tgt.innerHTML = v; else tgt.textContent = v;
      });
    });
    if (onSet) panel.querySelectorAll('[data-hbset]').forEach(function (ctrl) {
      if (ctrl.type === 'checkbox') ctrl.addEventListener('change', function () { onSet(ctrl.getAttribute('data-hbset'), ctrl.checked, ctrl); });
      else ctrl.addEventListener('click', function () {
        // radio group: toggle active among siblings sharing the same data-hbset
        var grp = panel.querySelectorAll('[data-hbset="' + ctrl.getAttribute('data-hbset') + '"]');
        grp.forEach(function (g) { g.classList.remove('is-active'); });
        ctrl.classList.add('is-active');
        onSet(ctrl.getAttribute('data-hbset'), ctrl.getAttribute('data-hbval'), ctrl);
      });
    });
  }

  /* ── content pools (Westmere — mirror pages/homepage) ── */
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
  // a list widget = section title (editable) + an auto-listed body + a description block
  function listWidget(label, defTitle, rendererName, desc) {
    return {
      label: label,
      make: function () { return RENDER[rendererName](defTitle); },
      settings: function () { return fText('Title', defTitle, '.gv-title.h2', { multiloc: true }) + (desc ? descBlock(desc) : ''); }
    };
  }
  // named renderers used by list widgets (so make() and the title-bind agree on markup)
  var RENDER = {
    areas: function (t) { return railSec(t || 'In your area', TEAMS.map(teamCard).join('')); },
    open: function (t) { return railSec(t || 'Open to participation', OPEN.map(function (c) { return compactCard(c, 0); }).join('')); },
    finished: function (t) { return railSec(t || 'Completed projects', DONE.map(function (c) { return compactCard(c, 1); }).join('')); },
    followed: function (t) { return railSec(t || 'Projects you follow', OPEN.slice(0, 3).map(function (c) { return compactCard(c, 0); }).join('')); },
    selection: function (t) { return gridSec(t || 'Selected projects and folders', GRID.map(gridCard).join('')); },
    published: function (t) { return gridSec(t || 'Published projects and folders', GRID.concat(GRID.slice(0, 1)).map(gridCard).join('')); },
    projects: function (t) { return gridSec(t || 'Participation projects', GRID.map(gridCard).join('')); }
  };

  /* ════════ HOMEPAGE widget registry ════════ */
  var HOMEPAGE = {
    'homepage-banner': {
      label: 'Homepage banner',
      make: function () {
        return '<section class="gv-hero signed-out centered" style="background-image:url(\'' + IMG + 'hero.webp\')">'
          + '<div class="gv-hero__inner"><h1 class="gv-hero__title">Help shape the future of Westmere</h1>'
          + '<p class="gv-hero__lead">Have your say on the projects and decisions shaping our city — from the harbour to your own street.</p>'
          + '<div class="gv-avatars" aria-label="15.4 thousand participants"><span class="av"></span><span class="av"></span><span class="av"></span><span class="av"></span><span class="count">15.4k</span></div>'
          + '<div class="gv-hero__actions"><a class="gv-btn primary-inverse" href="#" onclick="return false;">A greener Station Road — share your ideas</a></div></div></section>';
      },
      settings: function (block) {
        var view = block._bannerView || 'signedOut';
        var layouts = [
          { val: 'full-width', label: 'Full-width banner', art: 'hb-ra-full' },
          { val: 'two-column', label: 'Two columns', art: 'hb-ra-cols' },
          { val: 'two-row', label: 'Two rows', art: 'hb-ra-rows' },
          { val: 'fixed-ratio', label: 'Fixed-ratio banner', art: 'hb-ra-ratio' }
        ];
        var ctaOpts = view === 'signedOut'
          ? [{ val: 'signup', label: 'Sign up' }, { val: 'none', label: 'No button' }, { val: 'custom', label: 'Customize' }]
          : [{ val: 'none', label: 'No button' }, { val: 'custom', label: 'Customize' }];
        return '<div class="hb-subtabs"><button type="button" class="hb-subtab' + (view === 'signedOut' ? ' is-active' : '') + '" data-hbview="signedOut">Non-registered users</button><button type="button" class="hb-subtab' + (view === 'signedIn' ? ' is-active' : '') + '" data-hbview="signedIn">Registered users</button></div>'
          + '<p class="hb-help">' + (view === 'signedOut' ? 'This is how visitors that are not registered on the platform see the banner.' : 'This is how registered, signed-in users see the banner.') + '</p>'
          + radioCards('Layout', layouts, block._layout || 'full-width', 'layout')
          + uploadRow('Banner image', 'Replace image…')
          + toggleRow('Enable overlay', '', false, 'overlay')
          + fText('Banner text', '', '.gv-hero__title', { multiloc: true })
          + (view === 'signedOut' ? fText('Banner subtext', '', '.gv-hero__lead', { multiloc: true }) : '')
          + (view === 'signedOut' ? toggleRow('Display avatars', 'Show profile pictures of participants and number of them to non-registered visitors', true, 'avatars') : '')
          + radioRow('Button', ctaOpts, block._cta || 'custom', 'cta')
          + (block._cta === 'custom' || !block._cta ? fText('Button text', '', '.gv-hero__actions .gv-btn', { multiloc: true }) + fText('Button link', '', null, { ph: 'https://...' }) : '');
      },
      wire: function (block, api) {
        var panel = api.panel;
        // prefill bound text inputs from the current DOM
        var t = block.querySelector('.gv-hero__title'), l = block.querySelector('.gv-hero__lead'), b = block.querySelector('.gv-hero__actions .gv-btn');
        panel.querySelectorAll('[data-bind=".gv-hero__title"]').forEach(function (i) { i.value = t ? t.textContent : ''; });
        panel.querySelectorAll('[data-bind=".gv-hero__lead"]').forEach(function (i) { i.value = l ? l.textContent : ''; });
        panel.querySelectorAll('[data-bind=".gv-hero__actions .gv-btn"]').forEach(function (i) { i.value = b ? b.textContent : ''; });
        bind(block, panel, function (key, val) {
          if (key === 'avatars') { var a = block.querySelector('.gv-avatars'); if (a) a.style.display = val ? '' : 'none'; }
          else if (key === 'layout') { block._layout = val; }
          else if (key === 'cta') { block._cta = val; api.select(block); }    // re-render panel for custom fields
          else if (key === 'view') {}
        });
        panel.querySelectorAll('[data-hbview]').forEach(function (btn) { btn.addEventListener('click', function () { block._bannerView = btn.getAttribute('data-hbview'); api.select(block); }); });
      }
    },
    'spotlight': {
      label: 'Spotlight',
      make: function () {
        return '<section class="gv-spotlight"><div class="gv-spotlight__inner"><div>'
          + '<h2 class="gv-spotlight__title">A greener Station Road</h2><p class="gv-spotlight__lead">We’re redesigning Station Road to make space for trees, wider pavements and safer cycling. Take the survey to tell us what matters most on your daily journey.</p>'
          + '<div class="gv-spotlight__actions"><a class="gv-btn primary size-m" href="#" onclick="return false;">Take the survey</a></div>'
          + '<div class="gv-bubbles" style="margin-top:18px"><span class="av"></span><span class="av"></span><span class="av"></span><span class="gv-bubbles__label">145 participants</span></div></div>'
          + '<div class="gv-spotlight__media"><img src="' + IMG + 'spotlight.webp" alt="" loading="lazy" /></div></div></section>';
      },
      settings: function () {
        return '<div class="hb-set-row"><label class="hb-set-label">Select project or folder</label><button type="button" class="hb-pickbtn">A greener Station Road <span class="gv-icon" data-gv-icon="chevron-down"></span></button></div>'
          + fText('Title', '', '.gv-spotlight__title', { multiloc: true })
          + fRte('Description', '', '.gv-spotlight__lead')
          + fText('Button text', '', '.gv-spotlight__actions .gv-btn', { multiloc: true })
          + toggleRow('Show avatars', '', true, 'avatars');
      },
      wire: function (block, api) {
        var panel = api.panel;
        var t = block.querySelector('.gv-spotlight__title'), b = block.querySelector('.gv-spotlight__actions .gv-btn');
        panel.querySelectorAll('[data-bind=".gv-spotlight__title"]').forEach(function (i) { i.value = t ? t.textContent : ''; });
        panel.querySelectorAll('[data-bind=".gv-spotlight__actions .gv-btn"]').forEach(function (i) { i.value = b ? b.textContent : ''; });
        bind(block, panel, function (key, val) { if (key === 'avatars') { var a = block.querySelector('.gv-bubbles'); if (a) a.style.display = val ? '' : 'none'; } });
      }
    },
    'open-to-participation': listWidget('Open to participation', 'Open to participation', 'open', 'This widget will showcase projects where the user can currently <b>take an action to participate</b>.'),
    'followed-items': listWidget('Followed items', 'Projects you follow', 'followed', 'This widget shows each user projects <b>based on their follow preferences</b>.'),
    'areas': listWidget('In your area', 'City climate teams', 'areas', 'This widget shows projects for the <b>areas a user follows</b>.'),
    'selection': {
      label: 'Selected projects and folders',
      make: function () { return RENDER.selection('Selected projects and folders'); },
      settings: function () {
        return fText('Title', 'Selected projects and folders', '.gv-title.h2', { multiloc: true })
          + '<div class="hb-set-row"><label class="hb-set-label">Select projects or folders</label><button type="button" class="hb-pickbtn">Add a project or folder… <span class="gv-icon" data-gv-icon="plus"></span></button>'
          + '<ul class="hb-picklist"><li class="hb-pickitem"><span class="hb-grip" data-gv-icon="drag-handle"></span><span class="hb-pickitem__name">The big downtown survey</span><button class="hb-pickitem__del" aria-label="Remove"><span data-gv-icon="close"></span></button></li>'
          + '<li class="hb-pickitem"><span class="hb-grip" data-gv-icon="drag-handle"></span><span class="hb-pickitem__name">A square for everyone</span><button class="hb-pickitem__del" aria-label="Remove"><span data-gv-icon="close"></span></button></li></ul></div>'
          + '<p class="hb-field-help">With this widget, you can select and determine the order in which you want projects or folders to show to users.</p>';
      }
    },
    'published': listWidget('Published projects and folders', 'Published projects and folders', 'published', 'This widget will showcase the projects and folders that are <b>currently published</b>, respecting the ordering defined on the projects page.'),
    'finished-or-archived': {
      label: 'Finished projects',
      make: function () { return RENDER.finished('Completed projects'); },
      settings: function () {
        return fText('Title', 'Completed projects', '.gv-title.h2', { multiloc: true })
          + radioRow('Filter by', [{ val: 'finished', label: 'Finished' }, { val: 'archived', label: 'Archived' }, { val: 'finished_and_archived', label: 'Finished and archived' }], 'finished', 'filter')
          + descBlock('This widget shows <b>projects that are finished and/or archived</b>. "Finished" also includes projects that are in the last phase, and where the last phase is a report.');
      }
    },
    'events': {
      label: 'Events',
      make: function () { return '<section class="gv-section"><div class="gv-section__body"><div class="hb-events__head"><h2 class="gv-title h2" style="margin:0">Upcoming and ongoing events</h2><a class="gv-btn text" href="#" onclick="return false;">View all events</a></div><div class="gv-events__grid">' + EVENTS.map(eventCard).join('') + '</div></div></section>'; },
      settings: function () { return '<p class="hb-help">Displays the next 3 upcoming events on your platform.</p>'; }
    },
    'call-to-action': {
      label: 'Call to action',
      make: function () { return '<section class="gv-ctaband"><div class="gv-ctaband__inner"><h2 class="gv-ctaband__title">What is your proposal?</h2><p class="gv-ctaband__lead">Post your proposal on this platform, gather support and place it on the city’s agenda.</p><a class="gv-btn primary size-m" href="#" onclick="return false;">Explore all proposals</a></div></section>'; },
      settings: function () {
        return fText('Title', '', '.gv-ctaband__title', { multiloc: true })
          + fText('Description', '', '.gv-ctaband__lead', { multiloc: true })
          + fText('Primary button text', '', '.gv-ctaband__inner .gv-btn', { multiloc: true })
          + fText('Primary button URL', '', null, { ph: 'https://example.com' })
          + fText('Secondary button text', '', null, { multiloc: true })
          + fText('Secondary button URL', '', null, { ph: 'https://example.com' });
      },
      wire: function (block, api) {
        var panel = api.panel, t = block.querySelector('.gv-ctaband__title'), l = block.querySelector('.gv-ctaband__lead'), b = block.querySelector('.gv-ctaband__inner .gv-btn');
        panel.querySelectorAll('[data-bind=".gv-ctaband__title"]').forEach(function (i) { i.value = t ? t.textContent : ''; });
        panel.querySelectorAll('[data-bind=".gv-ctaband__lead"]').forEach(function (i) { i.value = l ? l.textContent : ''; });
        panel.querySelectorAll('[data-bind=".gv-ctaband__inner .gv-btn"]').forEach(function (i) { i.value = b ? b.textContent : ''; });
        bind(block, panel);
      }
    },
    'community-monitor-cta': {
      label: 'Community Monitor',
      make: function () { return '<section class="gv-section"><div class="gv-section__body"><div class="hb-cm"><div class="hb-cm__icon"><span data-gv-icon="trend-up"></span></div><div class="hb-cm__body"><h2 class="hb-cm__title">How is our community doing?</h2><p class="hb-cm__lead">Share how you feel about life in Westmere. It takes 2 minutes and helps the city track what matters over time.</p></div><a class="gv-btn primary" href="#" onclick="return false;">Take the survey</a></div></div></section>'; },
      settings: function () {
        return fText('Title', '', '.hb-cm__title', { multiloc: true })
          + fText('Description', '', '.hb-cm__lead', { multiloc: true })
          + fText('Button', '', '.hb-cm .gv-btn', { multiloc: true })
          + '<p class="hb-field-help"><b>Important:</b> This widget will only be visible on the Homepage when the Community Monitor is accepting responses.</p>';
      },
      wire: function (block, api) {
        var panel = api.panel, t = block.querySelector('.hb-cm__title'), l = block.querySelector('.hb-cm__lead'), b = block.querySelector('.hb-cm .gv-btn');
        panel.querySelectorAll('[data-bind=".hb-cm__title"]').forEach(function (i) { i.value = t ? t.textContent : ''; });
        panel.querySelectorAll('[data-bind=".hb-cm__lead"]').forEach(function (i) { i.value = l ? l.textContent : ''; });
        panel.querySelectorAll('[data-bind=".hb-cm .gv-btn"]').forEach(function (i) { i.value = b ? b.textContent : ''; });
        bind(block, panel);
      }
    },
    'projects': {
      label: 'Projects and folders (legacy)',
      make: function () { return RENDER.projects('Participation projects'); },
      settings: function () { return fText('Projects title', 'Participation projects', '.gv-title.h2', { multiloc: true, ph: 'Westmere is currently working on' }) + '<p class="hb-field-help">To configure the order in which your projects are displayed, reorder them on the Projects page.</p>'; }
    },
    'text': {
      label: 'Text',
      make: function () { return '<section class="gv-section"><div class="gv-prose"><p>Welcome to the official engagement platform of the City of Westmere. Follow participation projects across our districts, share your thoughts on the questions that matter, and give feedback in dialogue with the city.</p></div></section>'; },
      settings: function (block) { var p = block.querySelector('.gv-prose'); return fRte('Text', p ? p.innerHTML : '', '.gv-prose'); },
      wire: function (block, api) { bind(block, api.panel); }
    },
    'white-space': {
      label: 'White space',
      make: function () { return '<div class="hb-ws" style="height:48px"></div>'; },
      settings: function (block) {
        var h = block.querySelector('.hb-ws');
        var cur = h && h.style.height === '24px' ? 'small' : h && h.style.height === '80px' ? 'large' : 'medium';
        return radioRow('Vertical height', [{ val: 'small', label: 'Small' }, { val: 'medium', label: 'Medium' }, { val: 'large', label: 'Large' }], cur, 'size') + toggleRow('Include border', '', false, 'border');
      },
      wire: function (block, api) {
        bind(block, api.panel, function (key, val) {
          var ws = block.querySelector('.hb-ws'); if (!ws) return;
          if (key === 'size') ws.style.height = (val === 'small' ? 24 : val === 'large' ? 80 : 48) + 'px';
          if (key === 'border') ws.classList.toggle('has-border', val);
        });
      }
    },
    'button': {
      label: 'Button',
      make: function () { return '<section class="gv-section"><div class="hb-btnblock is-left"><a class="gv-btn primary size-m" href="#" onclick="return false;">Take the survey</a></div></section>'; },
      settings: function (block) {
        var b = block.querySelector('.gv-btn'), wrap = block.querySelector('.hb-btnblock');
        var style = b && b.classList.contains('secondary-outlined') ? 'secondary' : 'primary';
        var align = wrap && wrap.classList.contains('is-center') ? 'center' : wrap && wrap.classList.contains('is-right') ? 'right' : wrap && wrap.classList.contains('is-full') ? 'full' : 'left';
        return fText('Button text', b ? b.textContent : 'Take the survey', '.hb-btnblock .gv-btn', { multiloc: true })
          + fText('Button URL', '', null, { ph: 'https://...' })
          + radioRow('Button type', [{ val: 'primary', label: 'Primary' }, { val: 'secondary', label: 'Secondary' }], style, 'style')
          + radioRow('Button alignment', [{ val: 'left', label: 'Left' }, { val: 'center', label: 'Center' }, { val: 'right', label: 'Right' }, { val: 'full', label: 'Full width' }], align, 'align');
      },
      wire: function (block, api) {
        bind(block, api.panel, function (key, val) {
          var b = block.querySelector('.gv-btn'), wrap = block.querySelector('.hb-btnblock');
          if (key === 'style' && b) { b.classList.toggle('primary', val === 'primary'); b.classList.toggle('secondary-outlined', val === 'secondary'); }
          if (key === 'align' && wrap) { wrap.className = 'hb-btnblock is-' + val; }
        });
      }
    },
    'image': {
      label: 'Image',
      make: function () { return '<section class="gv-section"><img class="hb-img" src="' + IMG + 'spotlight.webp" alt="" loading="lazy" /></section>'; },
      settings: function () { return uploadRow('Image', 'Upload image…') + fText('Short description of the image', '', '.hb-img@alt', { multiloc: true, help: 'Adding "alt text" for images is important to make your platform accessible for users using screen readers.' }); }
    },
    'iframe': {
      label: 'Embed',
      make: function () { return '<section class="gv-section"><div class="hb-embed"><span data-gv-icon="link"></span> Embedded content<small>Paste a URL to embed</small></div></section>'; },
      settings: function () {
        return fText('Website address', '', '.hb-embed small', { help: 'Full URL of the website you want to embed.' })
          + radioRow('Embed mode', [{ val: 'fixed', label: 'Fixed Height' }, { val: 'ratio', label: 'Aspect Ratio' }], 'fixed', 'embedMode')
          + fText('Desktop height (pixels)', '500', null, { help: 'Height for desktop view (in pixels).' })
          + fText('Short description of the content you are embedding', '', null, { multiloc: true, help: 'It is useful to provide this information for users who rely on a screen reader or other assistive technology.' });
      }
    },
    'video-embed': {
      label: 'Video',
      make: function () { return '<section class="gv-section"><div class="hb-video"><span class="hb-video__play" aria-hidden="true">▶</span></div></section>'; },
      settings: function () { return '<div class="hb-warn"><span class="gv-icon" data-gv-icon="alert-circle"></span><span><b>WARNING: DO NOT PASTE CODE FROM UNTRUSTED SOURCES.</b> Only use embed codes from trusted video platforms like YouTube or Vimeo.</span></div><div class="hb-set-row"><label class="hb-set-label">Embed code</label><textarea class="gv-input" rows="5" placeholder="<iframe …></iframe>"></textarea></div>'; }
    },
    'accordion': {
      label: 'Accordion',
      make: function () { return '<section class="gv-section"><div class="gv-accordion"><details class="gv-acc__item"><summary class="gv-acc__head"><span class="gv-acc__q">How do I take part?</span><span class="gv-acc__chev" data-gv-icon="chevron-right" aria-hidden="true"></span></summary><div class="gv-acc__body"><p>Pick any open project and follow the steps — most take just a few minutes.</p></div></details></div></section>'; },
      settings: function (block) { var q = block.querySelector('.gv-acc__q'); return fText('Title', q ? q.textContent : 'How do I take part?', '.gv-acc__q', { multiloc: true }) + toggleRow('Open by default', '', false, 'open'); },
      wire: function (block, api) { bind(block, api.panel, function (key, val) { if (key === 'open') { var d = block.querySelector('.gv-acc__item'); if (d) d.open = val; } }); }
    },
    'two-column': {
      label: '2 column',
      make: function () { return '<section class="gv-section"><div class="hb-cols hb-cols-2"><div class="hb-colph">Column 1</div><div class="hb-colph">Column 2</div></div></section>'; },
      settings: function (block) {
        var c = block.querySelector('.hb-cols');
        var cur = c && c.classList.contains('hb-cols-2-1') ? '2-1' : c && c.classList.contains('hb-cols-1-2') ? '1-2' : '1-1';
        return radioCards('Column layout', [{ val: '1-1', label: '2 even columns', art: 'hb-ra-cols' }, { val: '2-1', label: '60% / 30%', art: 'hb-ra-cols' }, { val: '1-2', label: '30% / 60%', art: 'hb-ra-cols' }], cur, 'layout');
      },
      wire: function (block, api) { bind(block, api.panel, function (key, val) { if (key === 'layout') { var c = block.querySelector('.hb-cols'); if (c) c.className = 'hb-cols hb-cols-' + val; } }); }
    },
    'three-column': {
      label: '3 column',
      make: function () { return '<section class="gv-section"><div class="hb-cols hb-cols-3"><div class="hb-colph">Column 1</div><div class="hb-colph">Column 2</div><div class="hb-colph">Column 3</div></div></section>'; },
      settings: function () { return '<p class="hb-help">This widget has a fixed three-column layout. Drop content into each column on the canvas.</p>'; }
    },
    'image-text-cards': {
      label: 'Image & text cards',
      make: function () { return '<section class="gv-section"><div class="hb-cards">' + GRID.map(function (c) { return '<div class="hb-card"><div class="hb-card__img"><img src="' + IMG + c.img + '" alt="" loading="lazy" /></div><h3 class="hb-card__t">' + esc(c.t) + '</h3><p class="hb-card__d">' + esc(c.d) + '</p></div>'; }).join('') + '</div></section>'; },
      settings: function () { return '<p class="hb-help">This is a preset of three image-and-text rows. Edit each image or text block directly on the canvas.</p>'; }
    }
  };

  // homepage section order for the default homepage model (mirrors pages/homepage)
  var HOMEPAGE_ORDER = ['homepage-banner', 'spotlight', 'areas', 'open-to-participation', 'finished-or-archived', 'events', 'call-to-action', 'community-monitor-cta', 'text', 'selection', 'published', 'projects', 'followed-items', 'image-text-cards', 'two-column', 'three-column', 'image', 'button', 'accordion', 'iframe', 'video-embed', 'white-space'];

  return {
    config: function (o) { if (o && o.img != null) IMG = o.img; },
    bind: bind, esc: esc,
    homepage: HOMEPAGE, homepageOrder: HOMEPAGE_ORDER,
    project: {}   // filled during the project-builder migration
  };
})();
