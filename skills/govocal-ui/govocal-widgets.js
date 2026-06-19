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

  /* ════════ PROJECT (description) widget registry ════════
     Ported from pages/bo-content-builder so both builders run on ONE engine. The
     per-widget make() / settings() / wire() preserve the project builder's exact
     behaviour (timeline, events, participation box, RTE, nested columns, locked
     hero/title). Globals are reached through the engine `api` (frame/panel/root). */
  var PROJECT = (function () {
    // ── phase + event state (the project this builder edits) ──
    var CB_PHASES = [
      { name: 'Information', method: 'information', dates: '1 Mar – 31 Mar 2026', desc: 'Background on the project and how to take part.' },
      { name: 'Share your ideas', method: 'ideation', dates: '1 Apr – 31 May 2026', desc: 'Submit your ideas and react to what others suggest.' },
      { name: 'Vote', method: 'voting', dates: '1 Jun – 30 Jun 2026', desc: 'Help prioritise the shortlisted ideas.' },
      { name: 'Results', method: 'information', dates: 'Jul 2026', desc: 'See which ideas move into the master plan.' }
    ];
    var CB_CURRENT = 1;
    var CB_METHOD_CTA = { information: 'Learn more', survey: 'Take the survey', ideation: 'Submit your idea', voting: 'Cast your vote', proposals: 'Submit a proposal' };
    function cbCurrentCTA() { var p = CB_PHASES[CB_CURRENT] || {}; return CB_METHOD_CTA[p.method] || 'Take part'; }
    function syncParticipationCTAs(frame) {
      var ctas = frame.querySelectorAll('.cb-pbox [data-pbox="cta"]');
      for (var i = 0; i < ctas.length; i++) if (!ctas[i].hasAttribute('data-cta-custom')) ctas[i].textContent = cbCurrentCTA();
    }
    function cbPhasePanel(i) {
      var p = CB_PHASES[i], muted = i === CB_CURRENT ? '' : ' muted';
      return '<div class="gv-phasepanel__head' + muted + '"><span class="gv-phasepanel__num" aria-hidden="true">' + (i + 1) + '</span>' +
        '<div><h3 class="gv-phasepanel__name">' + p.name + '</h3><p class="gv-phasepanel__date">' + p.dates + '</p></div></div>' +
        '<div class="gv-phasepanel__desc"><p>' + p.desc + '</p></div>';
    }
    function cbTimelineHTML() {
      var steps = CB_PHASES.map(function (p, i) {
        var cur = i === CB_CURRENT, dot = cur ? '<span class="gv-pstep__dot"></span>' : '';
        return '<button class="gv-phase' + (cur ? ' current' : '') + '" type="button" role="tab" data-i="' + i + '" aria-selected="' + (i === CB_CURRENT) + '"><span class="gv-pstep">' + dot + (i + 1) + '</span><span class="gv-phase__label">' + p.name + '</span></button>';
      }).join('');
      return '<section class="gv-phases cb-timeline"><div class="gv-phases__bar"><h2>Phases</h2></div>' +
        '<div class="gv-stepper" role="tablist" aria-label="Project phases">' + steps + '</div>' +
        '<div class="gv-phasepanel cb-timeline__panel">' + cbPhasePanel(CB_CURRENT) + '</div></section>';
    }
    var CB_EVENTS = [
      { m: 'Aug', d: '22', y: '2026', title: 'Dorothea Dix Park — on-site design walk', when: '22 Aug 2026 · 17:30 – 19:00', where: 'Dorothea Dix Park, Raleigh', regs: '41' },
      { m: 'Sep', d: '10', y: '2026', title: 'Online townhall: review the shortlisted ideas', when: '10 Sep 2026 · 18:00 – 19:30', where: 'Online (Zoom)', regs: '88' },
      { m: 'Sep', d: '24', y: '2026', title: 'Pop-up booth at the State Fair', when: '24 Sep 2026 · 10:00 – 16:00', where: 'NC State Fairgrounds', regs: '12' }
    ];
    function cbEventCard(ev) {
      return '<article class="gv-event-card bordered"><div class="gv-event-card__media" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
        '<span class="gv-event-card__date"><span class="m">' + ev.m + '</span><span class="d">' + ev.d + '</span><span class="y">' + ev.y + '</span></span></div>' +
        '<div class="gv-event-card__body"><h3 class="gv-event-card__title"><a href="#">' + ev.title + '</a></h3>' +
        '<div class="gv-event-card__meta"><p class="gv-event-card__row"><span data-gv-icon="clock"></span> ' + ev.when + '</p>' +
        '<p class="gv-event-card__row"><span data-gv-icon="location-simple"></span> ' + ev.where + '</p>' +
        '<p class="gv-event-card__row"><span data-gv-icon="user"></span> ' + ev.regs + ' registrants</p></div>' +
        '<a class="gv-btn primary full" href="#">Register</a></div></article>';
    }
    function cbEventsHTML(n) {
      return '<section class="cb-events"><div class="gv-events__head"><h2 class="gv-title h2" style="margin:0">Events</h2>' +
        '<a class="gv-btn text" href="#">View all events</a></div><div class="gv-events__grid">' + CB_EVENTS.slice(0, n).map(cbEventCard).join('') + '</div></section>';
    }

    // ── widget content (make) ──
    var MK = {
      'text': function () { return '<div class="gv-bo-cb-block__body"><div class="cb-richtext cb-p" contenteditable="true">This is some text. You can edit and format it by using the editor in the panel on the right.</div></div>'; },
      'button': function () { return '<div class="cb-btnblock"><span class="cb-fakebtn">Take the survey</span></div>'; },
      'image': function () { return '<div class="cb-imgph"><span class="gv-icon" data-gv-icon="eye"></span> Click to upload an image</div>'; },
      'two-column': function () { return '<div class="cb-cols cb-cols-2"><div class="cb-col cb-zone--empty" data-cb-zone="col"><div class="cb-zone__ph">Drop content here</div></div><div class="cb-col cb-zone--empty" data-cb-zone="col"><div class="cb-zone__ph">Drop content here</div></div></div>'; },
      'three-column': function () { return '<div class="cb-cols cb-cols-3"><div class="cb-col cb-zone--empty" data-cb-zone="col"><div class="cb-zone__ph">Drop content here</div></div><div class="cb-col cb-zone--empty" data-cb-zone="col"><div class="cb-zone__ph">Drop content here</div></div><div class="cb-col cb-zone--empty" data-cb-zone="col"><div class="cb-zone__ph">Drop content here</div></div></div>'; },
      'white-space': function () { return '<div class="cb-ws"></div>'; },
      'accordion': function () { return '<div class="cb-accordion"><div class="cb-accordion__head"><span class="cb-accordion__title">Accordion title</span> <span class="gv-icon" data-gv-icon="chevron-down"></span></div><div class="cb-accordion__body cb-zone--empty" data-cb-zone="accordion"><div class="cb-accordion__text cb-p">Hidden panel content the resident can expand.</div><div class="cb-zone__ph">Drop content here</div></div></div>'; },
      'iframe': function () { return '<div class="cb-iframe">&lt;/&gt; Embedded content<span class="cb-iframe__cap">Paste a URL to embed</span></div>'; },
      'participation-box': function () { return '<div class="cb-pbox"><div class="cb-pbox__actions"><a class="gv-btn primary" data-pbox="cta" href="#">' + cbCurrentCTA() + '</a><a class="gv-btn primary-outlined" data-pbox="events" href="#">Upcoming events</a></div><div class="gv-participants cb-pbox__people"><span class="gv-avatars on-light" aria-hidden="true"><span class="av"></span><span class="av"></span><span class="av"></span></span><span class="gv-pcount"><span data-pbox="count">2,435</span> contributions</span></div></div>'; },
      'file-attachment': function () { return '<div class="cb-file"><span class="gv-icon" data-gv-icon="download"></span><span class="cb-file__info"><span class="cb-file__name">project-brief.pdf</span><span class="cb-file__meta">PDF · 1.2 MB</span></span></div>'; },
      'image-text-cards': function () { return '<div class="cb-cards" data-n="3"><div class="cb-card"><div class="cb-card__img"></div><div class="cb-card__cap">Card one</div></div><div class="cb-card"><div class="cb-card__img"></div><div class="cb-card__cap">Card two</div></div><div class="cb-card"><div class="cb-card__img"></div><div class="cb-card__cap">Card three</div></div></div>'; },
      'info-accordions': function () { return '<div class="cb-accordion"><div class="cb-accordion__head"><span class="cb-accordion__title">How will my input be used?</span> <span class="gv-icon" data-gv-icon="chevron-down"></span></div><div class="cb-accordion__body cb-zone--empty" data-cb-zone="accordion"><div class="cb-accordion__text cb-p">An explanation of the process.</div><div class="cb-zone__ph">Drop content here</div></div></div>'; },
      'timeline': function () { return cbTimelineHTML(); },
      'events': function () { return cbEventsHTML(2); },
      'hero': function () { return '<div class="cb-hero"><img class="cb-hero__img" src="https://images.unsplash.com/photo-1519331379826-f10be5486c6f?w=1400&h=400&fit=crop" alt="Project banner"></div>'; },
      'title': function () { return '<h1 class="gv-title h1 cb-title" contenteditable="true">Let’s Reimagine Dorothea Dix Park</h1>'; }
    };
    var LABEL = { 'text': 'Text', 'button': 'Button', 'image': 'Image', 'two-column': '2 column', 'three-column': '3 column', 'white-space': 'White space', 'accordion': 'Accordion', 'iframe': 'Embed', 'participation-box': 'Participation Box', 'file-attachment': 'File Attachment', 'image-text-cards': 'Image & text cards', 'info-accordions': 'Info & accordions', 'timeline': 'Timeline', 'events': 'Events', 'hero': 'Project image', 'title': 'Project title' };
    var TX = { text: 1, button: 1, accordion: 1, 'info-accordions': 1, 'participation-box': 1, 'image-text-cards': 1, title: 1 };

    // ── settings (bodyFor) ──
    function rteToolbar() {
      return '<div class="gv-bo-cb-rte__toolbar"><span class="gv-bo-cb-rte__group"><select class="gv-bo-cb-rte__select"><option>Normal</option><option>Title</option><option>Subtitle</option></select></span>' +
        '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Bold" data-fmt="bold"><b>B</b></button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Italic" data-fmt="italic"><i>i</i></button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Add link" data-fmt="link"><span class="gv-icon" data-gv-icon="link"></span></button></span>' +
        '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Align left" data-fmt="left">▤</button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Center text" data-fmt="center">▥</button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Align right" data-fmt="right">▤</button></span>' +
        '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Ordered list" data-fmt="ol">1.</button><button class="gv-bo-cb-rte__btn" type="button" aria-label="Unordered list" data-fmt="ul">•</button></span>' +
        '<span class="gv-bo-cb-rte__group"><button class="gv-bo-cb-rte__btn" type="button" aria-label="Remove formatting" data-fmt="clean">T<sub>x</sub></button></span></div>';
    }
    function row(label, control) { return '<div class="gv-bo-cb-settings__row"><span class="gv-bo-cb-settings__rowlabel">' + label + '</span>' + control + '</div>'; }
    function bodyFor(widget, block) {
      if (widget === 'text') return rteToolbar() + '<div class="gv-bo-cb-rte__editor" id="cb-rte-editor" contenteditable="true"></div>';
      if (widget === 'button') return row('Button text', '<input class="gv-input" id="cb-f-btnlabel" value="Take the survey">') + row('Link URL', '<input class="gv-input" id="cb-f-btnurl" value="/projects/dix-park/survey">') + row('Style', '<select class="gv-bo-select" id="cb-f-btnstyle"><option value="primary">Primary</option><option value="secondary">Secondary</option><option value="link">Text link</option></select>');
      if (widget === 'image') return row('Image', '<input class="gv-input" type="file" id="cb-f-imgfile" accept="image/*">') + row('Or paste URL', '<input class="gv-input" id="cb-f-imgurl" placeholder="https://…">') + row('Alt text', '<input class="gv-input" id="cb-f-imgalt" placeholder="Describe the image">');
      if (widget === 'two-column' || widget === 'three-column') {
        var o = widget === 'three-column' ? '<option value="equal">Equal</option><option value="wide-center">Wide centre</option>' : '<option value="equal">Equal</option><option value="wide-narrow">Wide / narrow</option><option value="narrow-wide">Narrow / wide</option>';
        return row('Column layout', '<select class="gv-bo-select" id="cb-f-collayout">' + o + '</select>');
      }
      if (widget === 'white-space') return row('Height', '<select class="gv-bo-select" id="cb-f-wsheight"><option value="24">Small</option><option value="40" selected>Medium</option><option value="80">Large</option></select>');
      if (widget === 'accordion' || widget === 'info-accordions') return row('Title', '<input class="gv-input" id="cb-f-acctitle" value="Accordion title">') + row('Content', '<textarea class="gv-input" id="cb-f-acccontent" rows="4">Hidden panel content the resident can expand.</textarea>');
      if (widget === 'iframe') return row('Embed URL', '<input class="gv-input" id="cb-f-embedurl" placeholder="https://…">');
      if (widget === 'participation-box') return row('Action label', '<input class="gv-input" data-set="cta" id="cb-f-cta" value="Take the survey">') + row('Events label', '<input class="gv-input" data-set="events" id="cb-f-events" value="Upcoming events">') + row('Contributions', '<input class="gv-input" data-set="count" id="cb-f-count" value="2,435">') + row('Show buttons', '<label class="gv-toggle"><input type="checkbox" data-set="btns" id="cb-f-btns" checked><span class="track"></span></label>') + row('Show contributions', '<label class="gv-toggle"><input type="checkbox" data-set="people" id="cb-f-people" checked><span class="track"></span></label>');
      if (widget === 'file-attachment') return row('Display name', '<input class="gv-input" id="cb-f-filename" value="project-brief.pdf">') + row('File', '<input class="gv-input" type="file" id="cb-f-filefile">');
      if (widget === 'image-text-cards') return row('Number of cards', '<select class="gv-bo-select" id="cb-f-cardcount"><option value="2">2</option><option value="3" selected>3</option><option value="4">4</option></select>') + '<div id="cb-f-cardcaps"></div>';
      if (widget === 'timeline') { var op = CB_PHASES.map(function (p, i) { return '<option value="' + i + '"' + (i === CB_CURRENT ? ' selected' : '') + '>' + p.name + '</option>'; }).join(''); return row('Current phase', '<select class="gv-bo-select" id="cb-f-curphase">' + op + '</select>') + row('', '<p class="cb-p" style="color:var(--gv-cool-grey-600);font-size:var(--gv-fs-13)">The phase timeline mirrors the project’s phases. Residents see the same component.</p>'); }
      if (widget === 'events') return row('Events shown', '<select class="gv-bo-select" id="cb-f-eventcount"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option></select>');
      if (widget === 'hero') return row('Replace image', '<input class="gv-input" type="file" id="cb-f-herofile" accept="image/*">') + row('Image URL', '<input class="gv-input" id="cb-f-herourl" placeholder="https://…">');
      if (widget === 'title') return row('Project title', '<input class="gv-input" id="cb-f-ptitle" value="Let’s Reimagine Dorothea Dix Park">');
      return row('Settings', '<div class="cb-p">No additional settings for this element.</div>');
    }

    // ── RTE + per-widget binding (wire) ──
    var syncing = false;
    function textTargetOf(block) { if (block.getAttribute('data-widget') === 'text') return block.querySelector('.cb-richtext') || block.querySelector('.gv-bo-cb-block__body, .cb-p'); return null; }
    function bindTextBinding(block, widget, api) {
      if (widget !== 'text') return;
      var ed = document.getElementById('cb-rte-editor'), tgt = textTargetOf(block);
      if (!ed || !tgt) return;
      syncing = true; ed.innerHTML = tgt.innerHTML; syncing = false;
      ed.addEventListener('input', function () { if (syncing) return; syncing = true; tgt.innerHTML = ed.innerHTML; syncing = false; });
      if (tgt._cbSync) tgt.removeEventListener('input', tgt._cbSync);
      tgt._cbSync = function () { if (syncing) return; syncing = true; ed.innerHTML = tgt.innerHTML; syncing = false; };
      tgt.addEventListener('input', tgt._cbSync);
      bindHeadingSelect(ed, block, api);
    }
    function bindHeadingSelect(ed, block, api) {
      var sel = api.panel.querySelector('.gv-bo-cb-rte__select'); if (!sel || !ed) return;
      sel.addEventListener('change', function () { ed.focus(); var tag = sel.value === 'Title' ? 'H2' : sel.value === 'Subtitle' ? 'H3' : 'P'; document.execCommand('formatBlock', false, tag); var tgt = textTargetOf(block); if (tgt) { syncing = true; tgt.innerHTML = ed.innerHTML; syncing = false; } });
    }
    function bindRteButtons(api, block) {
      var ed = document.getElementById('cb-rte-editor'), btns = api.panel.querySelectorAll('.gv-bo-cb-rte__btn');
      var CMD = { bold: 'bold', italic: 'italic', left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', ol: 'insertOrderedList', ul: 'insertUnorderedList', clean: 'removeFormat' };
      for (var i = 0; i < btns.length; i++) (function (btn) {
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
        btn.addEventListener('click', function () {
          if (!ed) { btn.classList.toggle('is-on'); return; }
          var fmt = btn.getAttribute('data-fmt'); ed.focus();
          if (fmt === 'link') { var url = prompt('Link URL', 'https://'); if (url) document.execCommand('createLink', false, url); }
          else if (CMD[fmt]) document.execCommand(CMD[fmt], false, null);
          if (fmt === 'bold' || fmt === 'italic') btn.classList.toggle('is-on');
          var tgt = textTargetOf(block); if (tgt) { syncing = true; tgt.innerHTML = ed.innerHTML; syncing = false; }
        });
      })(btns[i]);
    }
    function wireTimeline(block) {
      var steppers = block.querySelectorAll('.cb-timeline .gv-stepper');
      for (var s = 0; s < steppers.length; s++) (function (stepper) {
        var section = stepper.closest('.cb-timeline'), panel = section ? section.querySelector('.cb-timeline__panel') : null;
        stepper.querySelectorAll('.gv-phase').forEach(function (btn) {
          btn.addEventListener('click', function () { var i = +btn.dataset.i; stepper.querySelectorAll('.gv-phase').forEach(function (b) { b.setAttribute('aria-selected', String(+b.dataset.i === i)); }); if (panel) { panel.innerHTML = cbPhasePanel(i); if (window.GVIcons) window.GVIcons.render(panel); } });
        });
      })(steppers[s]);
    }
    function wireAccordion(block, api) {
      var heads = block.querySelectorAll('.cb-accordion__head');
      for (var i = 0; i < heads.length; i++) (function (head) {
        head.addEventListener('click', function (e) {
          var acc = head.closest('.cb-accordion');
          if (api.root.classList.contains('cb-preview')) { if (acc) acc.classList.toggle('cb-accordion--open'); return; }
          if (e.target.closest('.gv-icon')) { e.stopPropagation(); if (acc) acc.classList.toggle('cb-accordion--open'); }
        });
      })(heads[i]);
    }
    function bindParticipationBox(block, api) {
      var card = block.querySelector('.cb-pbox'); var panel = api.panel;
      function q(s) { return panel.querySelector('[data-set="' + s + '"]'); } function r(s) { return card ? card.querySelector('[data-pbox="' + s + '"]') : null; }
      var ctaIn = q('cta'), eventsIn = q('events'), countIn = q('count'), btnsTgl = q('btns'), peopleTgl = q('people');
      if (btnsTgl) btnsTgl.checked = !card.classList.contains('cb-pbox--nobtns');
      if (peopleTgl) peopleTgl.checked = !card.classList.contains('cb-pbox--nopeople');
      var ctaNode = r('cta'); if (ctaIn && ctaNode) ctaIn.value = (ctaNode.textContent || '').trim();
      if (ctaIn) ctaIn.addEventListener('input', function () { var c = r('cta'); if (c) { c.textContent = this.value || 'Take part'; c.setAttribute('data-cta-custom', ''); } });
      if (eventsIn) eventsIn.addEventListener('input', function () { var e = r('events'); if (e) e.textContent = this.value || 'Upcoming events'; });
      if (countIn) countIn.addEventListener('input', function () { var c = r('count'); if (c) c.textContent = this.value || '0'; });
      if (btnsTgl) btnsTgl.addEventListener('change', function () { card.classList.toggle('cb-pbox--nobtns', !this.checked); });
      if (peopleTgl) peopleTgl.addEventListener('change', function () { card.classList.toggle('cb-pbox--nopeople', !this.checked); });
    }
    function wireBody(widget, block, api) {
      function pv(id) { return document.getElementById(id); } function bq(s) { return block.querySelector(s); }
      if (widget === 'button') { var lbl = pv('cb-f-btnlabel'), sty = pv('cb-f-btnstyle'), url = pv('cb-f-btnurl'), btn = bq('.cb-fakebtn'); if (lbl && btn) { lbl.value = (btn.textContent || '').trim(); lbl.addEventListener('input', function () { btn.textContent = lbl.value || 'Button'; }); } if (sty && btn) sty.addEventListener('change', function () { btn.classList.remove('cb-fakebtn--secondary', 'cb-fakebtn--link'); if (sty.value === 'secondary') btn.classList.add('cb-fakebtn--secondary'); else if (sty.value === 'link') btn.classList.add('cb-fakebtn--link'); }); if (url && btn) url.addEventListener('input', function () { btn.setAttribute('data-href', url.value); }); return; }
      if (widget === 'white-space') { var ws = bq('.cb-ws'), hs = pv('cb-f-wsheight'); if (ws && hs) hs.addEventListener('change', function () { ws.style.height = hs.value + 'px'; }); return; }
      if (widget === 'image') { var altIn = pv('cb-f-imgalt'), fileIn = pv('cb-f-imgfile'), urlIn = pv('cb-f-imgurl'); function setSrc(src) { var node = block.querySelector('.cb-img'); if (!node) { node = document.createElement('img'); node.className = 'cb-img'; var slot = block.querySelector('.cb-imgph'); if (slot) slot.parentNode.replaceChild(node, slot); else block.appendChild(node); } node.src = src; if (altIn) node.alt = altIn.value || ''; } if (fileIn) fileIn.addEventListener('change', function () { if (fileIn.files && fileIn.files[0]) setSrc(URL.createObjectURL(fileIn.files[0])); }); if (urlIn) urlIn.addEventListener('input', function () { if (urlIn.value) setSrc(urlIn.value); }); if (altIn) altIn.addEventListener('input', function () { var n = block.querySelector('.cb-img'); if (n) n.alt = altIn.value; }); return; }
      if (widget === 'iframe') { var cap = bq('.cb-iframe__cap'), embed = pv('cb-f-embedurl'); if (cap && embed) embed.addEventListener('input', function () { var v = embed.value.trim(); if (!v) { cap.textContent = 'Paste a URL to embed'; return; } var host = v.replace(/^https?:\/\//, '').split('/')[0]; var type = /youtu|vimeo/.test(v) ? 'embedded video' : /maps/.test(v) ? 'embedded map' : 'embedded content'; cap.textContent = host + ' — ' + type; }); return; }
      if (widget === 'two-column' || widget === 'three-column') { var cols = bq('.cb-cols'), lay = pv('cb-f-collayout'); var map3 = { equal: '1fr 1fr 1fr', 'wide-center': '1fr 2fr 1fr' }, map2 = { equal: '1fr 1fr', 'wide-narrow': '2fr 1fr', 'narrow-wide': '1fr 2fr' }; var m = widget === 'three-column' ? map3 : map2; if (cols && lay) { lay.value = cols.getAttribute('data-collayout') || 'equal'; lay.addEventListener('change', function () { cols.setAttribute('data-collayout', lay.value); cols.style.gridTemplateColumns = m[lay.value] || m.equal; }); } return; }
      if (widget === 'accordion' || widget === 'info-accordions') { var head = bq('.cb-accordion__title'), textNode = bq('.cb-accordion__text'), tIn = pv('cb-f-acctitle'), cIn = pv('cb-f-acccontent'); if (head && tIn) { tIn.value = (head.textContent || '').trim(); tIn.addEventListener('input', function () { head.textContent = tIn.value; }); } if (textNode && cIn) { cIn.value = (textNode.textContent || '').trim(); cIn.addEventListener('input', function () { textNode.textContent = cIn.value; }); } return; }
      if (widget === 'file-attachment') { var nameNode = bq('.cb-file__name'), metaNode = bq('.cb-file__meta'), nIn = pv('cb-f-filename'), fIn = pv('cb-f-filefile'); if (nameNode && nIn) { nIn.value = (nameNode.textContent || '').trim(); nIn.addEventListener('input', function () { nameNode.textContent = nIn.value; }); } if (fIn) fIn.addEventListener('change', function () { if (!fIn.files || !fIn.files[0]) return; var f = fIn.files[0]; if (nameNode) nameNode.textContent = f.name; if (nIn) nIn.value = f.name; if (metaNode) { var ext = (f.name.split('.').pop() || '').toUpperCase(); var size = f.size < 1048576 ? (Math.max(1, Math.round(f.size / 1024)) + ' KB') : ((f.size / 1048576).toFixed(1) + ' MB'); metaNode.textContent = ext + ' · ' + size; } }); return; }
      if (widget === 'image-text-cards') { var grid = bq('.cb-cards'), countSel = pv('cb-f-cardcount'), capsHost = pv('cb-f-cardcaps'); function renderCaps() { if (!capsHost || !grid) return; var caps = grid.querySelectorAll('.cb-card__cap'), html = ''; for (var c = 0; c < caps.length; c++) html += row('Card ' + (c + 1), '<input class="gv-input" data-cardcap="' + c + '" value="' + (caps[c].textContent || '').replace(/"/g, '&quot;') + '">'); capsHost.innerHTML = html; var capIns = capsHost.querySelectorAll('[data-cardcap]'); for (var d = 0; d < capIns.length; d++) (function (inp) { inp.addEventListener('input', function () { var idx = +inp.getAttribute('data-cardcap'), node = grid.querySelectorAll('.cb-card__cap')[idx]; if (node) node.textContent = inp.value; }); })(capIns[d]); } if (countSel && grid) countSel.addEventListener('change', function () { var n = +countSel.value; while (grid.querySelectorAll('.cb-card').length > n) grid.removeChild(grid.lastElementChild); while (grid.querySelectorAll('.cb-card').length < n) { var idx = grid.querySelectorAll('.cb-card').length; var card = document.createElement('div'); card.className = 'cb-card'; card.innerHTML = '<div class="cb-card__img"></div><div class="cb-card__cap">Card ' + (idx + 1) + '</div>'; grid.appendChild(card); } grid.setAttribute('data-n', String(n)); renderCaps(); }); renderCaps(); return; }
      if (widget === 'timeline') { var curSel = pv('cb-f-curphase'); if (curSel) curSel.addEventListener('change', function () { CB_CURRENT = +curSel.value; var sec = bq('.cb-timeline'); if (!sec) return; var steps = CB_PHASES.map(function (p, i) { var cur = i === CB_CURRENT, dot = cur ? '<span class="gv-pstep__dot"></span>' : ''; return '<button class="gv-phase' + (cur ? ' current' : '') + '" type="button" role="tab" data-i="' + i + '" aria-selected="' + (i === CB_CURRENT) + '"><span class="gv-pstep">' + dot + (i + 1) + '</span><span class="gv-phase__label">' + p.name + '</span></button>'; }).join(''); sec.querySelector('.gv-stepper').innerHTML = steps; sec.querySelector('.cb-timeline__panel').innerHTML = cbPhasePanel(CB_CURRENT); wireTimeline(block); if (window.GVIcons) window.GVIcons.render(sec); syncParticipationCTAs(api.frame); }); return; }
      if (widget === 'events') { var evGrid = bq('.gv-events__grid'), evCount = pv('cb-f-eventcount'); if (evGrid && evCount) evCount.addEventListener('change', function () { evGrid.innerHTML = CB_EVENTS.slice(0, +evCount.value).map(cbEventCard).join(''); if (window.GVIcons) window.GVIcons.render(evGrid); }); return; }
      if (widget === 'hero') { var heroImg = bq('.cb-hero__img'), hf = pv('cb-f-herofile'), hu = pv('cb-f-herourl'); if (hf && heroImg) hf.addEventListener('change', function () { if (hf.files && hf.files[0]) heroImg.src = URL.createObjectURL(hf.files[0]); }); if (hu && heroImg) hu.addEventListener('input', function () { if (hu.value) heroImg.src = hu.value; }); return; }
      if (widget === 'title') { var h1 = bq('.cb-title'), tIn2 = pv('cb-f-ptitle'); if (h1 && tIn2) { tIn2.value = (h1.textContent || '').trim(); tIn2.addEventListener('input', function () { h1.textContent = tIn2.value; }); } return; }
      if (widget === 'participation-box') { bindParticipationBox(block, api); return; }
    }

    // ── assemble the registry: every widget shares the dispatchers above ──
    var REG = {};
    Object.keys(MK).forEach(function (w) {
      REG[w] = {
        label: LABEL[w] || w,
        locked: (w === 'hero' || w === 'title'),
        make: MK[w],
        settings: function (block) { return bodyFor(block.getAttribute('data-widget'), block); },
        onMount: function (block, api) { wireAccordion(block, api); wireTimeline(block); },
        wire: function (block, api) { var w2 = block.getAttribute('data-widget'); bindTextBinding(block, w2, api); bindRteButtons(api, block); wireBody(w2, block, api); }
      };
    });
    REG._meta = { tx: TX };   // which widgets show the panel-level locale switcher
    return REG;
  })();

  return {
    config: function (o) { if (o && o.img != null) IMG = o.img; },
    bind: bind, esc: esc,
    homepage: HOMEPAGE, homepageOrder: HOMEPAGE_ORDER,
    project: PROJECT
  };
})();
