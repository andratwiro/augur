/* Augur Canvas — capture: rasterize a set of canvas nodes to a PNG. Served from
 * /__canvas/capture.js and LAZY-LOADED by canvas.js on the first ⌘⇧C, so a board pays
 * nothing for it until someone asks for a picture.
 *
 * The one export is board-agnostic on purpose: it takes DOM elements and a world rect and
 * knows nothing about board state, node types or the multiplayer room.
 *
 *   GVCanvasCapture.nodesToPng({ els, rect, scale, background, poster, onInfo }) -> Promise<Blob>
 *
 *   els        node host elements to draw, in Z-ORDER (i.e. DOM order in the world layer)
 *   rect       {x,y,w,h} world box to capture — the output frame
 *   scale      output pixels per world px (2 = the "retina screenshot" default)
 *   background optional {fill, dot, step, r}: paper + dot grid, drawn natively
 *   poster(el) optional: a still image URL to stand in for a live frame that can't be read
 *   onInfo(i)  optional: {scale, downgraded, frames:{ok,failed}} once the raster is done
 *
 * HOW IT WORKS — re-render, not screen capture. The nodes are cloned into a mini "world"
 * at scale 1, offset by -rect.x/-rect.y, and rasterized through <foreignObject> into a 2D
 * canvas. That is why the output is crisp at 2x NATURAL size no matter what zoom the board
 * is at, why editor chrome can be stripped, and why nothing asks for a screen-share
 * permission. Three layers composite into one canvas so one bad node degrades instead of
 * killing the capture:
 *
 *   1. paper fill + dot grid, drawn straight into the 2D context
 *   2. the nodes themselves, cloned + inlined + rasterized in <foreignObject> passes
 *   3. live embedded frames, each rasterized in its OWN isolated pass and composited
 *
 * Layer 3 is separate because a framed page carries its own stylesheet, and one shared
 * document would leak that stylesheet across every other node in the shot. The passes in
 * layer 2 are split at each frame so z-order still holds (a note dropped on top of a frame
 * stays on top of it in the shot).
 *
 * ⚠️ An <img> holding an SVG never fetches external references while it rasterizes. So
 * EVERYTHING has to travel inline: stylesheets are read out of document.styleSheets, every
 * url() in them is absolutized and then swallowed as a data URI, and every <img> src is
 * swapped for one too. Anything that can't be inlined is dropped rather than left as a
 * broken reference.
 */
(function () {
  "use strict";
  if (window.GVCanvasCapture) return;

  var XHTML = "http://www.w3.org/1999/xhtml";
  var MAX_PIXELS = 40e6;      // ~40MP: past this a browser starts handing back empty blobs
  var MAX_RESOURCE = 6e6;     // one inlined asset
  var MAX_INLINED = 24e6;     // all inlined assets in one capture
  var FETCH_MS = 8000;

  // editor chrome — everything here is UI for working the board, not board content
  var CHROME = ".gvc-resize,.gvc-handle,.gvc-addrow,.gvc-addcol,.gvc-hit,.gvc-draghandle," +
               ".gvc-peer-sel,.gvc-remote-focus,.gvc-crop,.gvc-cropwin";
  var CHROME_CLASSES = ["sel", "editing", "interacting", "gvc-linked", "gvc-remote-move", "dropping"];
  // chrome that is counter-scaled to the live zoom on the board; the capture is at natural
  // scale, so these go back to 1:1 (they're content — a frame's name, a section's label)
  var COUNTER_SCALED = ".gvc-tilename,.gvc-seclabel";

  // ⚠️ A rasterizing SVG is frozen at time ZERO, so any entrance animation is caught at its
  // FIRST keyframe. With the common `animation: fade-in .4s both` that means opacity 0 — a page
  // that reads perfectly on screen comes out as an empty panel (this cost an afternoon: the
  // frame's nav and footer drew, the whole slide did not). Zero duration + zero delay lands
  // every animation on its END state instead, which is the settled page you were looking at.
  var FROZEN = "\n*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
               "transition:none!important;caret-color:transparent!important;}\n";

  var inlined = 0;
  var resCache = {};          // absolute url -> Promise<dataURI|null> (+ .__value once settled)
  var hostCss = null;         // the board page's own stylesheet, inlined once per session

  /* ---------- inlining ---------- */

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function abs(url, base) {
    if (!url) return null;
    try { return new URL(url, base).href; } catch (e) { return null; }
  }
  function readAsDataUri(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error("read")); };
      fr.readAsDataURL(blob);
    });
  }
  // Never rejects: a resource that can't be inlined resolves to null and is dropped, because
  // a shot missing one image beats no shot at all.
  function asDataUri(url) {
    if (!url) return Promise.resolve(null);
    if (/^data:/i.test(url)) return Promise.resolve(url);
    if (resCache[url]) return resCache[url];
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, FETCH_MS) : null;
    var p = fetch(url, { credentials: "same-origin", signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("http"); return r.blob(); })
      .then(function (b) {
        if (b.size > MAX_RESOURCE || inlined + b.size > MAX_INLINED) throw new Error("too big");
        inlined += b.size;
        return readAsDataUri(b);
      })
      .catch(function () { return null; })
      .then(function (v) { if (timer) clearTimeout(timer); return v; });
    resCache[url] = p;
    return p;
  }
  // resolve a batch and park each value ON its cached promise, so the clone pass that needs
  // them can stay synchronous
  function settle(urls) {
    return Promise.all(urls.map(function (u) {
      var p = asDataUri(u);
      return p.then(function (v) { p.__value = v; return v; });
    }));
  }

  /* ---------- stylesheets ---------- */

  function rulesText(sheet, base) {
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return ""; }   // cross-origin sheet: unreadable
    if (!rules) return "";
    var out = "";
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      // @import: take the imported sheet's rules, drop the statement (it would never load)
      if (r.styleSheet) { out += rulesText(r.styleSheet, r.styleSheet.href || base); continue; }
      out += r.cssText + "\n";
    }
    return absolutizeCss(out, base);
  }
  function absolutizeCss(text, base) {
    return text.replace(/url\((\s*['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
      if (/^(data:|blob:|#)/i.test(u)) return m;
      var a = abs(u, base);
      return a ? 'url("' + a + '")' : m;
    });
  }
  function docCss(doc) {
    var out = "";
    var sheets = doc.styleSheets;
    for (var i = 0; i < sheets.length; i++) out += rulesText(sheets[i], sheets[i].href || doc.baseURI);
    return out;
  }
  // swallow every url() the stylesheet still points at — fonts above all, since a page's
  // typeface is the difference between "that's the prototype" and "that's some text"
  function inlineCssUrls(css) {
    var urls = [], re = /url\("([^"]+)"\)/g, m;
    while ((m = re.exec(css))) if (!/^data:/i.test(m[1]) && urls.indexOf(m[1]) < 0) urls.push(m[1]);
    if (!urls.length) return Promise.resolve(css);
    return Promise.all(urls.map(function (u) {
      return asDataUri(u).then(function (d) { return { u: u, d: d }; });
    })).then(function (list) {
      list.forEach(function (it) {
        if (it.d) css = css.split('url("' + it.u + '")').join('url("' + it.d + '")');
      });
      return css;
    });
  }

  /* ---------- cloning ---------- */

  // A clone is inert markup, so anything the DOM was holding live has to be written down:
  // canvas pixels, form values. Source and clone are walked in parallel — querySelectorAll
  // returns document order in both, so the pairs line up. Call this BEFORE pruning the clone.
  function carryLiveState(src, clone) {
    var sc = src.querySelectorAll("canvas"), cc = clone.querySelectorAll("canvas");
    for (var i = 0; i < sc.length && i < cc.length; i++) {
      var data = null;
      try { data = sc[i].width && sc[i].height ? sc[i].toDataURL() : null; } catch (e) { data = null; }
      var rep = document.createElement("img");
      rep.setAttribute("style", (cc[i].getAttribute("style") || "") +
        ";width:" + sc[i].offsetWidth + "px;height:" + sc[i].offsetHeight + "px");
      if (data) rep.setAttribute("src", data);
      if (cc[i].parentNode) cc[i].parentNode.replaceChild(rep, cc[i]);
    }
    var si = src.querySelectorAll("input,textarea,select"), ci = clone.querySelectorAll("input,textarea,select");
    for (var j = 0; j < si.length && j < ci.length; j++) {
      var s = si[j], c = ci[j];
      if (s.tagName === "TEXTAREA") c.textContent = s.value;
      else if (s.tagName === "SELECT") {
        each(c.options, function (o, k) {
          if (s.options[k] && s.options[k].selected) o.setAttribute("selected", "selected");
          else o.removeAttribute("selected");
        });
      } else if (s.type === "checkbox" || s.type === "radio") {
        if (s.checked) c.setAttribute("checked", "checked"); else c.removeAttribute("checked");
      } else c.setAttribute("value", s.value == null ? "" : s.value);
    }
  }
  function dropScripts(clone) {
    each(clone.querySelectorAll("script,noscript,iframe,object,embed,link[rel~=stylesheet]"), function (e) { e.remove(); });
    // the review overlay hangs its whole UI in a shadow root on this element — chrome, and a
    // clone can't see into it anyway
    each(clone.querySelectorAll("#gv-review-host,#gvc-cursors,#gvc-ui,#gvc-guides"), function (e) { e.remove(); });
  }
  // ⚠️ Only ever run this on the ENGINE's own nodes. A framed page is somebody else's markup,
  // where a class called "sel" or "editing" is theirs and means something.
  function stripChrome(clone) {
    CHROME_CLASSES.forEach(function (c) { clone.classList.remove(c); });
    each(clone.querySelectorAll(CHROME), function (e) { e.remove(); });
    each(clone.querySelectorAll("." + CHROME_CLASSES.join(",.")), function (e) {
      CHROME_CLASSES.forEach(function (c) { e.classList.remove(c); });
    });
    each(clone.querySelectorAll(COUNTER_SCALED), function (e) {
      e.style.transform = "none";
      e.style.maxWidth = "100%";
    });
  }
  function freezeEditables(clone) {
    each(clone.querySelectorAll("[contenteditable]"), function (e) { e.setAttribute("contenteditable", "false"); });
  }

  // Every <img> in the shot, so it can be swapped for a data URI before the clone is
  // serialized (the rasterizer will not fetch anything itself).
  function imageUrls(el, base) {
    var urls = [];
    each(el.querySelectorAll("img[src]"), function (i) {
      var a = abs(i.getAttribute("src"), base); if (a) urls.push(a);
    });
    return urls;
  }
  function swapImages(clone, base) {
    each(clone.querySelectorAll("img"), function (i) {
      var raw = i.getAttribute("src") || "";
      if (/^data:/i.test(raw)) return;
      i.removeAttribute("srcset");
      var a = abs(raw, base);
      var v = a && resCache[a] ? resCache[a].__value : null;
      if (v) i.setAttribute("src", v); else i.remove();
    });
  }

  /* ---------- rasterizing through <foreignObject> ---------- */

  // ⚠️ DATA URL, NEVER A BLOB URL. An <img> carrying the same SVG loads happily from either,
  // but a blob: one TAINTS the canvas it is drawn into (opaque origin) — and the tainting only
  // shows up at the very end, as toBlob throwing SecurityError. Verified in Chromium: data =
  // clean, blob = tainted. Blob URLs would be the tidier choice for a payload this big; they
  // are simply not an option here.
  function svgUrlImage(svg) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("svg")); };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }
  function serialize(el) {
    el.setAttribute("xmlns", XHTML);
    return new XMLSerializer().serializeToString(el);
  }
  // w/h = the CSS box the content lays out in; k = pixels per CSS px in the image we want back.
  // ⚠️ The upscale is a CSS transform on the content, NOT an SVG viewBox. WebKit lays a
  // foreignObject out at 1:1 and ignores the viewBox scale, which put the whole capture in the
  // top-left quadrant of its own bitmap at half size (Chromium honours the viewBox, so this
  // only showed up when the same test was run under WebKit). Keeping viewBox == width/height
  // means no engine has to scale anything.
  function rasterize(el, w, h, k) {
    var outW = Math.max(1, Math.round(w * k)), outH = Math.max(1, Math.round(h * k));
    var box = document.createElement("div");
    box.setAttribute("style", "width:" + w + "px;height:" + h + "px;transform:scale(" + k + ");transform-origin:top left;");
    box.appendChild(el);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + outW + '" height="' + outH +
      '" viewBox="0 0 ' + outW + " " + outH + '"><foreignObject x="0" y="0" width="' + outW + '" height="' + outH + '">' +
      serialize(box) + "</foreignObject></svg>";
    return svgUrlImage(svg).then(function (img) {
      if (!img.decode) return img;
      return img.decode().then(function () { return img; }, function () { return img; });
    });
  }

  /* ---------- layer 1: paper + dot grid ---------- */

  function drawBackground(ctx, rect, bg) {
    if (!bg) return;
    if (bg.fill) { ctx.fillStyle = bg.fill; ctx.fillRect(0, 0, rect.w, rect.h); }
    var step = bg.step || 0, r = bg.r || 0;
    if (!bg.dot || !step || !r) return;
    // the live grid's dots sit at the CENTRE of each step-sized tile anchored on the world
    // origin — world (step/2 + k*step) — which is exactly what makes them camera-independent
    ctx.fillStyle = bg.dot;
    var half = step / 2;
    var x0 = Math.floor((rect.x - half) / step) * step + half;
    var y0 = Math.floor((rect.y - half) / step) * step + half;
    for (var y = y0; y < rect.y + rect.h + step; y += step) {
      for (var x = x0; x < rect.x + rect.w + step; x += step) {
        ctx.beginPath();
        ctx.arc(x - rect.x, y - rect.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ---------- layer 3: one live frame, in its own document ---------- */

  function frameOf(el) {
    var body = el.querySelector ? el.querySelector(".gvc-tilebody") : null;
    if (!body) return null;
    var frame = body.querySelector("iframe");
    if (!frame) return null;
    var doc = null;
    try { doc = frame.contentDocument; } catch (e) { doc = null; }   // cross-origin: unreadable
    if (!doc || !doc.documentElement || !doc.body || !doc.body.firstChild) return null;
    return { body: body, frame: frame, doc: doc };
  }
  // The framed page renders at a fixed device viewport and is CSS-scaled into the frame box —
  // the same trick the live board uses — so the shot matches what is on screen at any zoom.
  function rasterizeFrame(el, outScale) {
    var f = frameOf(el);
    if (!f) return Promise.resolve(null);
    var bw = f.body.clientWidth, bh = f.body.clientHeight;
    var dw = f.frame.offsetWidth, dh = f.frame.offsetHeight;
    if (!bw || !bh || !dw || !dh) return Promise.resolve(null);
    var s = bw / dw, doc = f.doc, base = doc.baseURI;

    var html = doc.documentElement.cloneNode(true);
    carryLiveState(doc.documentElement, html);
    dropScripts(html);
    freezeEditables(html);

    return Promise.all([
      inlineCssUrls(docCss(doc)),
      settle(imageUrls(doc.documentElement, base))
    ]).then(function (res) {
      swapImages(html, base);
      var style = document.createElement("style");
      style.textContent = res[0] + FROZEN;
      var head = html.querySelector("head");
      if (head) head.appendChild(style); else html.insertBefore(style, html.firstChild);
      html.setAttribute("style", (html.getAttribute("style") || "") +
        ";width:" + dw + "px;height:" + dh + "px;overflow:hidden");

      var inner = document.createElement("div");
      inner.setAttribute("style", "width:" + dw + "px;height:" + dh + "px;overflow:hidden;" +
        "transform:scale(" + s + ");transform-origin:top left;");
      inner.appendChild(html);
      var wrap = document.createElement("div");
      wrap.setAttribute("style", "width:" + bw + "px;height:" + bh + "px;overflow:hidden;background:#fff;");
      wrap.appendChild(inner);

      return rasterize(wrap, bw, bh, outScale);
    }).then(function (img) {
      return { img: img, x: el.offsetLeft, y: el.offsetTop, w: bw, h: bh, radius: radiusOf(f.body) };
    });
  }
  function radiusOf(elm) {
    try { return parseFloat(getComputedStyle(elm).borderTopLeftRadius) || 0; } catch (e) { return 0; }
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (r <= 0) { ctx.rect(x, y, w, h); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------- layer 2: a run of ordinary nodes, one document ---------- */

  // One pass can hold any number of ordinary nodes: they are all styled by the engine's own
  // stylesheet, so there is nothing to leak. Runs are cut at live frames only.
  function buildRun(els, rect, css, poster) {
    var wrap = document.createElement("div");
    wrap.id = "gvc-root";   // inherits the engine's font/colour rules...
    // ...but not its fixed full-screen box, and not its paper fill (layer 1 painted that)
    wrap.setAttribute("style", "position:relative;inset:auto;left:auto;top:auto;width:" + rect.w +
      "px;height:" + rect.h + "px;overflow:hidden;background:none;");
    var style = document.createElement("style");
    style.textContent = css + FROZEN;
    wrap.appendChild(style);
    var world = document.createElement("div");
    world.id = "gvc-world";
    world.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;" +
      "transform:translate(" + (-rect.x) + "px," + (-rect.y) + "px);");
    wrap.appendChild(world);
    els.forEach(function (src) {
      var c = src.cloneNode(true);
      carryLiveState(src, c);
      stripChrome(c);
      freezeEditables(c);
      // A live frame draws nothing in a clone, so the frame box falls back to the node's own
      // still image — and to a neutral placeholder if there isn't one. When the frame's own
      // pass succeeds this is simply painted over.
      var body = c.querySelector(".gvc-tilebody");
      var iframe = body ? body.querySelector("iframe") : null;
      if (iframe) {
        iframe.remove();
        var v = poster ? poster(src) : null;
        if (v) {
          var im = document.createElement("img");
          im.setAttribute("src", v);
          body.appendChild(im);
        } else {
          var ph = document.createElement("div");
          ph.className = "ph";
          ph.textContent = "…";
          body.appendChild(ph);
        }
      }
      swapImages(c, document.baseURI);
      world.appendChild(c);
    });
    return wrap;
  }

  /* ---------- the export ---------- */

  function nodesToPng(opts) {
    var els = (opts.els || []).slice();
    var rect = opts.rect;
    var want = opts.scale || 2;
    var posterOf = opts.poster || null;
    var info = { scale: want, downgraded: false, frames: { ok: 0, failed: 0 } };
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return Promise.reject(new Error("empty rect"));

    // a broken blob is worse than a smaller picture: halve until it fits, then say so
    var scale = want;
    while (scale > 1 && rect.w * rect.h * scale * scale > MAX_PIXELS) scale = scale / 2;
    if (rect.w * rect.h * scale * scale > MAX_PIXELS) scale = Math.max(0.05, Math.sqrt(MAX_PIXELS / (rect.w * rect.h)));
    info.scale = scale;
    info.downgraded = scale < want;

    var cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(rect.w * scale));
    cv.height = Math.max(1, Math.round(rect.h * scale));
    var ctx = cv.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawBackground(ctx, rect, opts.background);

    // cut the element list into runs of ordinary nodes separated by live frames, so a note
    // dropped ON a framed prototype still lands on top of it in the shot
    var segments = [], run = [], frames = [];
    els.forEach(function (e) {
      run.push(e);
      if (frameOf(e)) { frames.push(e); segments.push({ run: run, frame: e }); run = []; }
    });
    if (run.length) segments.push({ run: run, frame: null });

    inlined = 0;
    // every still image the shot might need, resolved up front — the clone pass is synchronous
    var urls = [];
    els.forEach(function (e) { urls = urls.concat(imageUrls(e, document.baseURI)); });
    if (posterOf) frames.forEach(function (e) {
      var u = abs(posterOf(e), document.baseURI); if (u) urls.push(u);
    });
    function posterData(src) {
      var u = posterOf ? abs(posterOf(src), document.baseURI) : null;
      return u && resCache[u] ? resCache[u].__value : null;
    }

    if (!hostCss) hostCss = inlineCssUrls(docCss(document)).catch(function () { return ""; });

    var chain = Promise.all([hostCss, settle(urls)]);
    segments.forEach(function (seg) {
      chain = chain.then(function (pre) {
        var wrap = buildRun(seg.run, rect, pre[0], posterData);
        return rasterize(wrap, rect.w, rect.h, scale)
          .then(function (img) { ctx.drawImage(img, 0, 0, rect.w, rect.h); })
          .catch(function () {})     // one bad run must not cost the whole capture
          .then(function () {
            if (!seg.frame) return;
            return rasterizeFrame(seg.frame, scale).then(function (r) {
              if (!r || !r.img) { info.frames.failed++; return; }
              info.frames.ok++;
              ctx.save();
              roundRect(ctx, r.x - rect.x, r.y - rect.y, r.w, r.h, r.radius);
              ctx.clip();
              ctx.drawImage(r.img, r.x - rect.x, r.y - rect.y, r.w, r.h);
              ctx.restore();
            }, function () { info.frames.failed++; });
          })
          .then(function () { return pre; });
      });
    });

    return chain.then(function () {
      if (opts.onInfo) { try { opts.onInfo(info); } catch (e) {} }
      return new Promise(function (resolve, reject) {
        cv.toBlob(function (b) { if (b) resolve(b); else reject(new Error("blob")); }, "image/png");
      });
    });
  }

  window.GVCanvasCapture = { nodesToPng: nodesToPng };
})();
