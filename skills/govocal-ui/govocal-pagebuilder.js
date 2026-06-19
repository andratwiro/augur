/* govocal-pagebuilder.js — the ONE canonical Page Builder engine, shared by every
 * builder surface (project description, homepage, report…). It owns the editor
 * MECHANICS only — palette add (click/drag), block select, on-canvas drag-reorder
 * with drop-lines, nested drop zones, locked top blocks, the settings panel, preview
 * toggle, delete — and is WIDGET-AGNOSTIC: each surface passes its own widget
 * REGISTRY (label · make · settings · wire) and the engine assembles it.
 *
 *   GVPageBuilder.mount({
 *     root, frame, settingsBody, settingsTitle, settingsClose, previewToggle,
 *     localeEl?, showLocale?(widget),        // optional panel-level multiloc switcher
 *     paletteSelector?, paletteAttr?,        // default '.gv-bo-cb-item' / 'data-widget'
 *     widgets,                               // { type: { label, make(block), settings(block),
 *                                            //          wire(block,api), locked, onMount(block,api) } }
 *     seed?(api), toast?(msg), onChange?(api)
 *   }) -> api { makeBlock, select, deselect, frame, toast, makeDropZone, reflectEmpty }
 *
 * The widget registry is the SINGLE SOURCE OF TRUTH (skills/govocal-ui/govocal-widgets.js):
 * the same {make,settings,wire} drives the builders AND each components/<widget>/ demo.
 */
window.GVPageBuilder = (function () {
  function mount(cfg) {
    var root = cfg.root, frame = cfg.frame, WIDGETS = cfg.widgets || {};
    var sTitle = cfg.settingsTitle, sBody = cfg.settingsBody;
    var paletteSel = cfg.paletteSelector || '.gv-bo-cb-item';
    var paletteAttr = cfg.paletteAttr || 'data-widget';
    var toast = cfg.toast || function () {};
    var uid = 1, selected = null, dragData = null, activeZone = null;
    function def(t) { return WIDGETS[t] || {}; }
    function emit() { if (cfg.onChange) cfg.onChange(api); }

    // ── block factory ─────────────────────────────────────────────────────────
    function makeBlock(widget) {
      var d = def(widget);
      var block = document.createElement('div');
      block.className = 'gv-bo-cb-block' + (d.locked ? ' cb-locked' : '');
      block.setAttribute('data-widget', widget);
      block.setAttribute('data-label', d.label || widget);
      block.setAttribute('draggable', d.locked ? 'false' : 'true');
      block.id = 'gvcb-' + (uid++);
      var tab = document.createElement('span');
      tab.className = 'gv-bo-cb-block__label';
      tab.innerHTML = (d.label || widget) + (d.locked ? ' <span class="cb-lockmark" aria-hidden="true"><span class="gv-icon" data-gv-icon="lock"></span></span>' : '');
      block.appendChild(tab);
      var content = document.createElement('div');
      content.innerHTML = d.make ? d.make(block) : '';
      while (content.firstChild) block.appendChild(content.firstChild);
      wireBlock(block);
      var zones = block.querySelectorAll('[data-cb-zone]');
      for (var z = 0; z < zones.length; z++) makeDropZone(zones[z], 'y');
      if (d.onMount) d.onMount(block, api);
      if (window.GVIcons) window.GVIcons.render(block);
      if (window.GVAvatars) window.GVAvatars.fill(block);
      return block;
    }

    function wireBlock(block) {
      block.addEventListener('click', function (e) {
        if (root.classList.contains('cb-preview')) return;
        e.stopPropagation();
        select(block);
      });
      if (block.classList.contains('cb-locked')) { block.setAttribute('draggable', 'false'); return; }
      block.addEventListener('dragstart', function (e) {
        if (root.classList.contains('cb-preview')) { e.preventDefault(); return; }
        e.stopPropagation();
        clearLine();
        dragData = { mode: 'move', el: block };
        block.classList.add('is-dragging');
        try { e.dataTransfer.setData('text/plain', 'move'); } catch (x) {}
        e.dataTransfer.effectAllowed = 'move';
      });
      block.addEventListener('dragend', function () { block.classList.remove('is-dragging'); clearLine(); });
    }

    // ── drop zones (frame + nested) with a drop-line indicator ────────────────
    function clearLine() {
      if (activeZone && activeZone._cbZone) activeZone._cbZone.clear();
      activeZone = null;
    }
    function zoneChildUnder(zoneEl, axis, x, y) {
      var kids = zoneEl.children;
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (!child.classList || !child.classList.contains('gv-bo-cb-block')) continue;
        if (child.classList.contains('cb-locked')) continue;
        var r = child.getBoundingClientRect();
        if (axis === 'x') { if (x < r.left + r.width / 2) return child; }
        else { if (y < r.top + r.height / 2) return child; }
      }
      return null;
    }
    function makeDropZone(zoneEl, axis) {
      if (zoneEl._cbZone) return;
      var line = document.createElement('div');
      line.className = 'gv-bo-cb-dropline cb-dropline--' + axis;
      function clear() {
        if (line.parentNode) line.parentNode.removeChild(line);
        zoneEl.classList.remove('cb-zone--over', 'is-dragover');
      }
      zoneEl._cbZone = { line: line, clear: clear };

      zoneEl.addEventListener('dragover', function (e) {
        if (!dragData) return;
        if (root.classList.contains('cb-preview')) return;
        if (dragData.mode === 'move' && (dragData.el === zoneEl || dragData.el.contains(zoneEl))) {
          e.dataTransfer.dropEffect = 'none'; e.stopPropagation(); return;
        }
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = dragData.mode === 'move' ? 'move' : 'copy';
        if (activeZone && activeZone !== zoneEl && activeZone._cbZone) activeZone._cbZone.clear();
        activeZone = zoneEl;
        zoneEl.classList.add('cb-zone--over', 'is-dragover');
        var before = zoneChildUnder(zoneEl, axis, e.clientX, e.clientY);
        if (before && before === dragData.el) { clear(); zoneEl.classList.add('cb-zone--over'); return; }
        if (before) zoneEl.insertBefore(line, before);
        else zoneEl.appendChild(line);
      });
      zoneEl.addEventListener('dragleave', function (e) {
        if (e.target === zoneEl && !zoneEl.contains(e.relatedTarget)) clear();
      });
      zoneEl.addEventListener('drop', function (e) {
        if (!dragData) return;
        if (root.classList.contains('cb-preview')) return;
        if (dragData.mode === 'move' && (dragData.el === zoneEl || dragData.el.contains(zoneEl))) {
          e.preventDefault(); e.stopPropagation(); return;
        }
        e.preventDefault(); e.stopPropagation();
        var ref = line.parentNode ? line : zoneChildUnder(zoneEl, axis, e.clientX, e.clientY);
        if (dragData.mode === 'add') {
          var block = makeBlock(dragData.widget);
          if (line.parentNode) zoneEl.insertBefore(block, line);
          else if (ref) zoneEl.insertBefore(block, ref);
          else zoneEl.appendChild(block);
          select(block);
          toast('Added: ' + (def(dragData.widget).label || dragData.widget));
        } else if (dragData.mode === 'move' && dragData.el) {
          if (line.parentNode) line.parentNode.insertBefore(dragData.el, line);
          else if (ref) zoneEl.insertBefore(dragData.el, ref);
          else zoneEl.appendChild(dragData.el);
          toast('Element moved');
        }
        clear(); activeZone = null; dragData = null; reflectEmptyAll(); emit();
      });
    }

    // ── empty-state reflection ────────────────────────────────────────────────
    function directBlockCount(el) {
      var n = 0, kids = el.children;
      for (var i = 0; i < kids.length; i++) if (kids[i].classList && kids[i].classList.contains('gv-bo-cb-block')) n++;
      return n;
    }
    function zoneIsEmpty(zone) {
      if (directBlockCount(zone) > 0) return false;
      if (zone.querySelector('.cb-accordion__text')) return false;
      return true;
    }
    function reflectEmptyAll() {
      var n = directBlockCount(frame);
      frame.classList.toggle('is-empty', n === 0);
      if (n === 0) deselect();
      var zones = frame.querySelectorAll('[data-cb-zone]');
      for (var i = 0; i < zones.length; i++) zones[i].classList.toggle('cb-zone--empty', zoneIsEmpty(zones[i]));
    }

    // ── selection + settings panel ────────────────────────────────────────────
    function deselect() {
      if (selected) selected.classList.remove('is-selected');
      selected = null;
      root.classList.remove('cb-has-panel');
    }
    function select(block) {
      if (selected) selected.classList.remove('is-selected');
      selected = block; block.classList.add('is-selected');
      root.classList.add('cb-has-panel');
      var widget = block.getAttribute('data-widget');
      var d = def(widget);
      if (sTitle) sTitle.textContent = block.getAttribute('data-label') || d.label || widget;
      // optional panel-level multiloc switcher (project builder); homepage uses per-field
      if (cfg.localeEl) cfg.localeEl.style.display = (cfg.showLocale ? cfg.showLocale(widget) : false) ? '' : 'none';
      sBody.innerHTML = d.settings ? d.settings(block) : '<p class="hb-help">No settings for this element.</p>';
      if (window.GVIcons) window.GVIcons.render(sBody);
      if (d.wire) d.wire(block, api);
      if (block.classList.contains('cb-locked')) {
        var note = document.createElement('p');
        note.className = 'cb-lockednote';
        note.innerHTML = '<span class="gv-icon" data-gv-icon="lock"></span> Pinned to the top of the page — editable, but can’t be moved or removed.';
        sBody.appendChild(note);
        if (window.GVIcons) window.GVIcons.render(note);
        return;
      }
      var del = document.createElement('button');
      del.className = 'gv-bo-cb-delete'; del.type = 'button';
      del.innerHTML = '<span class="gv-icon" data-gv-icon="delete"></span> Delete';
      sBody.appendChild(del);
      if (window.GVIcons) window.GVIcons.render(del);
      del.addEventListener('click', function () {
        if (!selected) return;
        var b = selected; deselect(); b.parentNode.removeChild(b); reflectEmptyAll(); emit();
        toast('Element deleted');
      });
    }

    // ── palette (click adds at end · drag inserts at drop-line) ────────────────
    var items = document.querySelectorAll(paletteSel);
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var w = item.getAttribute(paletteAttr);
        item.addEventListener('click', function () {
          var block = makeBlock(w); frame.appendChild(block); select(block);
          block.scrollIntoView({ block: 'center', behavior: 'smooth' });
          reflectEmptyAll(); emit(); toast('Added: ' + (def(w).label || w));
        });
        item.addEventListener('dragstart', function (e) {
          clearLine(); dragData = { mode: 'add', widget: w }; item.classList.add('is-dragging');
          try { e.dataTransfer.setData('text/plain', w); } catch (x) {}
          e.dataTransfer.effectAllowed = 'copy';
        });
        item.addEventListener('dragend', function () { item.classList.remove('is-dragging'); clearLine(); });
      })(items[i]);
    }

    // ── frame as the primary drop zone + canvas click-to-deselect ─────────────
    makeDropZone(frame, 'y');
    var canvas = frame.closest('.gv-bo-cb-canvas') || frame.parentNode;
    canvas.addEventListener('click', function (e) { if (e.target === canvas || e.target === frame) deselect(); });

    if (cfg.settingsClose) cfg.settingsClose.addEventListener('click', deselect);
    if (cfg.previewToggle) cfg.previewToggle.addEventListener('change', function () {
      root.classList.toggle('cb-preview', this.checked); if (this.checked) deselect();
      toast(this.checked ? 'Preview mode' : 'Editing mode');
    });

    var api = { makeBlock: makeBlock, select: select, deselect: deselect, frame: frame,
      panel: sBody, toast: toast, makeDropZone: makeDropZone, reflectEmpty: reflectEmptyAll, def: def };

    if (cfg.seed) cfg.seed(api); else reflectEmptyAll();
    return api;
  }
  return { mount: mount };
})();
