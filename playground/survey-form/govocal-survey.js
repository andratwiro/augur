/* ──────────────────────────────────────────────────────────────────────────
   GoVocal survey / input-form renderer (the shared "survey kit" engine)
   Data-driven: give it a FORM object (a simplified GoVocal `custom_fields`
   payload) and a mount element, and it renders the page-by-page survey runner —
   every field type, the wizard nav, the progress bar, and the gate behaviour.

   Pair with govocal-survey.css (the field styles). Requires the gv-* primitives
   (govocal-ui.css) + tokens. ONE shared source of truth — don't fork it.

   Usage in any prototype/page:
     <link rel="stylesheet" href="govocal-tokens.css">
     <link rel="stylesheet" href="govocal-ui.css">
     <link rel="stylesheet" href="govocal-survey.css">
     <script src="govocal-survey.js" defer></script>
     ...
     <main class="sv-wrap"><div id="survey"></div></main>
     <script>
       GVSurvey.mount(document.getElementById('survey'), FORM, { title:'Survey' });
     </script>

   Public API:
     GVSurvey.mount(rootEl, form, opts)  → renders the full runner + wizard.
         opts: { title, onClose }
     GVSurvey.field(fieldObj)            → HTML for ONE field (recall a single
         widget — e.g. a matrix or ranking — into your own markup).
     GVSurvey.page(pageObj)              → HTML for one page's fields.

   FIELD object shapes (field.type):
     text · multiline_text · number · date        — { label, desc?, required? }
     select · multiselect                          — { …, options:[..] }
     rating        — { …, max:5, gate:true }
     linear_scale  — { …, max:7, minLabel?, maxLabel?, gate:true }
     sentiment     — { …, faces:['😣',…], labels:['Very bad',…], gate:true }
     ranking       — { …, options:[..] }
     multiselect_image — { …, images:[{src,label},..] }
     matrix        — { …, scale:[..], statements:[..], gate:true }
     map           — { …, shape:'point'|'line'|'polygon' }
     file_upload · shapefile_upload                — { label, desc? }
   `gate:true` = de-facto-required-to-advance (matches the real runner: Next stays
   disabled until rating/scale/sentiment/matrix fields on the page are answered).
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var uid = 0; function nid() { return 'f' + (++uid); }

  function qShell(f, inner) {
    var opt = f.required ? '' : '<span class="sv-q__optional">(optional)</span>';
    var desc = f.desc ? '<p class="sv-q__desc">' + esc(f.desc) + '</p>' : '';
    return '<div class="sv-q" data-gate="' + (f.gate ? 1 : 0) + '">' +
      '<div class="sv-q__label">' + esc(f.label) + opt + '</div>' + desc +
      '<div class="sv-q__control">' + inner + '</div></div>';
  }

  function rText(f) { return qShell(f, '<input class="gv-input" type="text" placeholder="Type your answer" />'); }
  function rMultiline(f) { return qShell(f, '<textarea class="gv-textarea" placeholder="Type your answer"></textarea>'); }
  function rNumber(f) { return qShell(f, '<input class="gv-input" type="number" inputmode="numeric" placeholder="0" style="max-width:160px" />'); }
  function rDate(f) { return qShell(f, '<input class="gv-input" type="date" style="max-width:200px" />'); }

  function rSelect(f) {
    var n = nid();
    var cards = f.options.map(function (o, i) {
      return '<label class="sv-optcard">' +
        '<span class="gv-radio"><input type="radio" name="' + n + '" value="' + i + '" /><span class="circle"></span></span>' +
        '<span class="sv-optcard__txt">' + esc(o) + '</span></label>';
    }).join('');
    return qShell(f, cards);
  }
  function rMultiselect(f) {
    var cards = f.options.map(function (o, i) {
      return '<label class="sv-optcard">' +
        '<span class="gv-checkbox"><input type="checkbox" value="' + i + '" /><span class="box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span></span>' +
        '<span class="sv-optcard__txt">' + esc(o) + '</span></label>';
    }).join('');
    return qShell(f, cards);
  }

  function star() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>'; }
  function rRating(f) {
    var n = nid(); var h = '<div class="sv-rating" role="radiogroup" aria-label="' + esc(f.label) + '">';
    for (var i = 1; i <= f.max; i++) {
      h += '<input type="radio" name="' + n + '" id="' + n + '-' + i + '" value="' + i + '" />' +
        '<label for="' + n + '-' + i + '" data-val="' + i + '" aria-label="' + i + ' of ' + f.max + '">' + star() + '</label>';
    }
    return qShell(f, h + '</div>');
  }

  function rScale(f) {
    var n = nid(); var btns = '';
    for (var i = 1; i <= f.max; i++) {
      btns += '<input type="radio" name="' + n + '" id="' + n + '-' + i + '" value="' + i + '" /><label for="' + n + '-' + i + '">' + i + '</label>';
    }
    var ends = (f.minLabel || f.maxLabel)
      ? '<div class="sv-scale__ends"><span>' + esc(f.minLabel || '') + '</span><span>' + esc(f.maxLabel || '') + '</span></div>' : '';
    return qShell(f, '<div class="sv-scale" role="radiogroup" aria-label="' + esc(f.label) + '">' + btns + '</div>' + ends);
  }

  function rSentiment(f) {
    var n = nid();
    var items = f.faces.map(function (face, i) {
      return '<input type="radio" name="' + n + '" id="' + n + '-' + i + '" value="' + (i + 1) + '" />' +
        '<label for="' + n + '-' + i + '"><span class="face" aria-hidden="true">' + face + '</span><span class="slabel">' + esc(f.labels[i]) + '</span></label>';
    }).join('');
    return qShell(f, '<div class="sv-sentiment" role="radiogroup" aria-label="' + esc(f.label) + '">' + items + '</div>');
  }

  function rRanking(f) {
    var N = f.options.length;
    var opts = f.options.map(function (o, i) {
      var sel = '<select class="sv-rank__select" aria-label="Rank for ' + esc(o) + '"><option value="">–</option>';
      for (var r = 1; r <= N; r++) sel += '<option value="' + r + '">' + r + '</option>';
      sel += '</select>';
      return '<li draggable="true" data-i="' + i + '">' + sel +
        '<span class="sv-rank__txt">' + esc(o) + '</span>' +
        '<span class="sv-rank__handle" aria-hidden="true" title="Drag to reorder"><svg viewBox="0 0 24 24"><path d="M9 5h2v2H9V5m4 0h2v2h-2V5M9 11h2v2H9v-2m4 0h2v2h-2v-2m-4 6h2v2H9v-2m4 0h2v2h-2v-2"/></svg></span></li>';
    }).join('');
    return qShell(f, '<ul class="sv-rank">' + opts + '</ul>');
  }

  function rImages(f) {
    var n = nid();
    var zoom = '<span class="sv-imgcard__zoom" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15 3h6v6h-2V6.41l-3.29 3.3-1.42-1.42L17.59 5H15V3M3 15h2v2.59l3.29-3.3 1.42 1.42L6.41 19H9v2H3v-6z"/></svg></span>';
    var cards = f.images.map(function (im, i) {
      return '<label class="sv-imgcard">' +
        '<span class="sv-imgcard__media"><img src="' + esc(im.src) + '" alt="' + esc(im.label) + '" />' + zoom + '</span>' +
        '<span class="sv-imgcard__foot">' +
        '<span class="gv-checkbox"><input type="checkbox" name="' + n + '" value="' + i + '" /><span class="box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span></span>' +
        '<span class="label">' + esc(im.label) + '</span></span></label>';
    }).join('');
    return qShell(f, '<div class="sv-imggrid">' + cards + '</div>');
  }

  function rMatrix(f) {
    var head = '<tr><th></th>' + f.scale.map(function (s) { return '<th>' + esc(s) + '</th>'; }).join('') + '</tr>';
    var rows = f.statements.map(function (st) {
      var n = 'mx' + nid();
      var cells = f.scale.map(function (s, c) {
        return '<td><label><input type="radio" name="' + n + '" value="' + (c + 1) + '" aria-label="' + esc(st) + ' — ' + esc(s) + '" /><span class="cell"><span class="dot"></span></span></label></td>';
      }).join('');
      return '<tr data-mxrow="1"><th scope="row">' + esc(st) + '</th>' + cells + '</tr>';
    }).join('');
    var table = '<table class="sv-matrix"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
    var mob = f.statements.map(function (st) {
      var n = 'mxm' + nid();
      var btns = f.scale.map(function (s, c) { return '<input type="radio" name="' + n + '" id="' + n + '-' + c + '" value="' + (c + 1) + '" /><label for="' + n + '-' + c + '">' + (c + 1) + '</label>'; }).join('');
      return '<div data-mxrow="1"><div class="stmt">' + esc(st) + '</div><div class="sv-scale" role="radiogroup" aria-label="' + esc(st) + '">' + btns + '</div></div>';
    }).join('');
    return qShell(f, table + '<div class="sv-matrix-mobile">' + mob + '</div>');
  }

  function rMap(f) {
    var tools =
      '<div class="sv-map__zoom"><button type="button" aria-label="Zoom in">+</button><button type="button" aria-label="Zoom out">−</button></div>' +
      '<div class="sv-map__tools">' +
      '<button type="button" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62A7.45 7.45 0 0 1 12.5 11c3.04 0 5.63 1.98 6.54 4.73l2.37-.78A9.01 9.01 0 0 0 12.5 8z"/></svg></button>' +
      '<button type="button" aria-label="Find my location"><svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14"/></svg></button>' +
      '</div>' +
      '<div class="sv-map__draw" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg></div>';
    var hint = '<p class="sv-map__hint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7h2v2h-2V7m0 4h2v6h-2v-6m1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20"/></svg> Click on the map to draw. Then, drag on points to move them.</p>';
    return qShell(f, hint + '<div class="sv-map" role="img" aria-label="Interactive map (' + esc(f.shape || 'point') + ' drawing)">' + tools + '</div>');
  }

  function rDrop(f, shapefile) {
    var cloud = '<svg viewBox="0 0 24 24"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14a6 6 0 0 0 6 6h13a5 5 0 0 0 .35-9.96M14 13v4h-4v-4H7l5-5 5 5z"/></svg>';
    var sub = shapefile ? 'Esri shapefile (.zip containing .shp, .shx, .dbf)' : 'PDF, PNG, JPG, DOCX — up to 50MB';
    return qShell(f, '<div class="sv-drop" role="button" tabindex="0">' + cloud + '<span class="sv-drop__main"><b>Click to upload</b> or drag and drop</span><span class="sv-drop__sub">' + sub + '</span></div>');
  }

  var RENDER = {
    text: rText, multiline_text: rMultiline, number: rNumber, date: rDate, select: rSelect, multiselect: rMultiselect,
    rating: rRating, linear_scale: rScale, sentiment: rSentiment, ranking: rRanking,
    multiselect_image: rImages, matrix: rMatrix, map: rMap,
    file_upload: function (f) { return rDrop(f, false); }, shapefile_upload: function (f) { return rDrop(f, true); }
  };

  function field(f) { return RENDER[f.type] ? RENDER[f.type](f) : ''; }

  function renderPage(p) {
    if (p.kind === 'intro') {
      var media = p.media ? '<div class="sv-intro__media" aria-hidden="true">' + esc(p.media).replace(/\n/g, '<br>') + '</div>' : '';
      return '<div class="sv-page" data-kind="intro"><h2 class="sv-page__title">' + esc(p.title) + '</h2>' + media +
        '<p class="sv-page__desc" style="font-style:normal">' + esc(p.desc || '') + '</p></div>';
    }
    if (p.kind === 'thankyou') {
      return '<div class="sv-page" data-kind="thankyou"><div class="sv-thanks">' +
        '<div class="sv-thanks__check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>' +
        '<h2 class="sv-page__title" style="text-align:center">' + esc(p.title) + '</h2>' +
        '<p class="sv-page__desc" style="font-style:normal">' + esc(p.desc || '') + '</p></div></div>';
    }
    var head = '<h2 class="sv-page__title">' + (p.emoji ? esc(p.emoji) + ' ' : '') + esc(p.title) + '</h2>' +
      (p.desc ? '<p class="sv-page__desc">' + esc(p.desc) + '</p>' : '');
    var body = (p.fields || []).map(field).join('');
    return '<div class="sv-page">' + head + body + '</div>';
  }

  function shellHTML(title) {
    // Progressbar attrs reused by the header bar, footer bar and ring variants.
    var pbar = ' role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0% complete"';
    return '<section class="sv-card" aria-label="' + esc(title || 'Survey') + '">' +
      '<div class="sv-titlebar"><h1>' + esc(title || 'Survey') + '</h1>' +
      '<button class="sv-titlebar__edit" type="button">Edit survey</button>' +
      '<button class="sv-close" type="button" aria-label="Close survey">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div>' +
      // Header progress bar (topbar variant) — pinned under the titlebar, stays visible while scrolling.
      '<div class="sv-hbar"' + pbar + '><span class="sv-hbar__track"><span class="sv-hbar__fill"></span></span><span class="sv-hbar__num">0%</span></div>' +
      '<form class="sv-body" novalidate></form>' +
      '<div class="sv-foot">' +
      '<div class="sv-progress"' + pbar + '><div class="sv-progress__bar"></div></div>' +
      '<div class="sv-foot__row">' +
      '<details class="gv-nav__dd sv-foot__lang"><summary class="gv-lang">EN' +
      '<svg class="gv-nav__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></summary></details>' +
      // Three interchangeable progress indicators; CSS shows exactly one per layout (the
      // rest are display:none, so screen readers never get a duplicate announcement).
      '<span class="sv-foot__ring"' + pbar + '><b class="sv-foot__ring-num">0%</b></span>' +
      '<span class="sv-foot__step" role="status" aria-live="polite" aria-atomic="true">Step 1 of 1</span>' +
      '<span class="sv-foot__pct" role="status" aria-live="polite" aria-atomic="true">0% complete</span>' +
      '<div class="sv-foot__nav">' +
      '<button type="button" class="gv-btn primary-outlined sv-prev"><svg class="gv-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg><span class="sv-prev-label">Previous</span></button>' +
      '<button type="button" class="gv-btn primary sv-next"><span class="sv-next-label">Next</span><svg class="gv-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg></button>' +
      '</div></div></div></section>';
  }

  function mount(root, form, opts) {
    opts = opts || {};
    root.innerHTML = shellHTML(opts.title);
    var bodyEl = root.querySelector('.sv-body'),
        barEl = root.querySelector('.sv-progress__bar'),
        pctEl = root.querySelector('.sv-foot__pct'),
        prevBtn = root.querySelector('.sv-prev'),
        nextBtn = root.querySelector('.sv-next'),
        nextLbl = root.querySelector('.sv-next-label'),
        prevLbl = root.querySelector('.sv-prev-label'),
        // Extra progress indicators used by the playground footer-layout variants.
        hbarFill = root.querySelector('.sv-hbar__fill'),
        hbarNum = root.querySelector('.sv-hbar__num'),
        ringEl = root.querySelector('.sv-foot__ring'),
        ringNum = root.querySelector('.sv-foot__ring-num'),
        stepEl = root.querySelector('.sv-foot__step'),
        progressbars = [].slice.call(root.querySelectorAll('[role="progressbar"]'));
    // Button labels are configurable (opts.labels) so a harness can stress-test how
    // long labels fit the footer at narrow widths. Defaults match the real runner.
    var L = opts.labels || {};
    var LBL = { prev: L.prev || 'Previous', next: L.next || 'Next', submit: L.submit || 'Submit' };
    prevLbl.textContent = LBL.prev;
    var step = 0, total = form.pages.length;
    var lastContent = total - 1;
    while (lastContent > 0 && form.pages[lastContent].kind === 'thankyou') lastContent--;

    function show() {
      var p = form.pages[step];
      bodyEl.innerHTML = renderPage(p);
      bodyEl.scrollTop = 0;
      var pct = (p.kind === 'thankyou') ? 100 : Math.round((Math.min(step, lastContent) / lastContent) * 100);
      var pctTxt = pct + '% complete';
      // Keep every progress representation in sync; only the one CSS shows is visible.
      barEl.style.width = pct + '%';
      pctEl.textContent = pctTxt;
      if (hbarFill) hbarFill.style.width = pct + '%';
      if (hbarNum) hbarNum.textContent = pct + '%';
      if (ringEl) { ringEl.style.setProperty('--p', pct); if (ringNum) ringNum.textContent = pct + '%'; }
      if (stepEl) {
        var sNum = Math.min(step, lastContent) + 1, sTot = lastContent + 1;
        stepEl.textContent = (p.kind === 'thankyou') ? 'Complete' : ('Step ' + sNum + ' of ' + sTot);
      }
      progressbars.forEach(function (el) { el.setAttribute('aria-valuenow', pct); el.setAttribute('aria-valuetext', pctTxt); });
      prevBtn.style.visibility = (step === 0 || p.kind === 'thankyou') ? 'hidden' : 'visible';
      if (p.kind === 'thankyou') { nextBtn.style.display = 'none'; }
      else { nextBtn.style.display = ''; nextLbl.textContent = (step === lastContent ? LBL.submit : LBL.next); }
      refreshGate();
    }

    function refreshGate() {
      var gates = [].slice.call(bodyEl.querySelectorAll('.sv-q[data-gate="1"]'));
      var ok = gates.every(function (q) { return q.querySelector('input:checked'); });
      nextBtn.classList.toggle('disabled', !ok);
      nextBtn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    }

    bodyEl.addEventListener('change', function (e) {
      refreshGate();
      var wrap = e.target.closest('.sv-rating');
      if (wrap) {
        var v = +e.target.value;
        wrap.classList.add('is-set');
        wrap.querySelectorAll('label').forEach(function (l) { l.classList.toggle('on', +l.dataset.val <= v); });
      }
      if (e.target.classList.contains('sv-rank__select')) {
        var sel = e.target, val = +sel.value, list = sel.closest('.sv-rank'), li = sel.closest('li');
        if (val) {
          // Picking a rank moves that option to the chosen slot, then renumbers the
          // whole list — ranking one item auto-orders the rest (1..N by position).
          var others = [].slice.call(list.children).filter(function (n) { return n !== li; });
          var ref = others[val - 1];
          if (ref) list.insertBefore(li, ref); else list.appendChild(li);
          rankRenumber(list);
        }
      }
    });

    // Set every rank <select> to its 1-based position in the list. Called after a drag
    // reorder or an explicit rank pick so position == rank, with no gaps or duplicates.
    function rankRenumber(list) {
      [].slice.call(list.children).forEach(function (row, i) {
        var s = row.querySelector('.sv-rank__select');
        if (s) s.value = String(i + 1);
      });
    }

    var dragEl = null;
    bodyEl.addEventListener('dragstart', function (e) { var li = e.target.closest('.sv-rank li'); if (li) { dragEl = li; e.dataTransfer.effectAllowed = 'move'; } });
    bodyEl.addEventListener('dragover', function (e) { var li = e.target.closest('.sv-rank li'); if (li && dragEl && li !== dragEl) { e.preventDefault(); li.classList.add('drag-over'); } });
    bodyEl.addEventListener('dragleave', function (e) { var li = e.target.closest('.sv-rank li'); if (li) li.classList.remove('drag-over'); });
    bodyEl.addEventListener('drop', function (e) {
      var li = e.target.closest('.sv-rank li');
      if (li && dragEl && li !== dragEl) {
        e.preventDefault(); li.classList.remove('drag-over');
        var list = li.parentNode, items = [].slice.call(list.children);
        if (items.indexOf(dragEl) < items.indexOf(li)) li.after(dragEl); else li.before(dragEl);
        rankRenumber(list);
      }
    });
    bodyEl.addEventListener('dragend', function () { dragEl = null; bodyEl.querySelectorAll('.drag-over').forEach(function (n) { n.classList.remove('drag-over'); }); });

    nextBtn.addEventListener('click', function () { if (nextBtn.classList.contains('disabled')) return; if (step < total - 1) { step++; show(); } });
    prevBtn.addEventListener('click', function () { if (step > 0) { step--; show(); } });
    root.querySelector('.sv-close').addEventListener('click', opts.onClose || function () {});

    show();
    return { show: show, goTo: function (i) { step = Math.max(0, Math.min(total - 1, i)); show(); } };
  }

  window.GVSurvey = { mount: mount, field: field, page: renderPage };
})();
