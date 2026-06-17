/* ============================================================
   FigPal — a tiny companion that trails your cursor.
   One source of truth, used by:
     • figpals/index.html        (adopt / customize page)
     • the prototypes-site shell  (build.js injects this file)
   Visual language mirrors Figma's real FigPals: thick black
   doodle outline, flat pastel fills, blush cheeks, a sleepy
   pose when idle. No feeding / photobooth — just a friend.
   Exposes window.FigPal = { PALETTE, svg, loadConfig, saveConfig, mount }.
   ============================================================ */
(function () {
  const OUT = "#241d29";   // outline (warm near-black)

  const PALETTE = [
    { name: "Blossom",  fur: "#FBB6CE", dark: "#F48FB1", belly: "#FFE3EE", ear: "#F9A8C8", cheek: "#F2789F", paw: "#FFD4E4" },
    { name: "Sky",      fur: "#A9D8FF", dark: "#7CBFF5", belly: "#E2F2FF", ear: "#8FC9FB", cheek: "#5BA8E8", paw: "#CDE9FF" },
    { name: "Mint",     fur: "#A7E8CC", dark: "#73D3AA", belly: "#E0F8EE", ear: "#8FDFBC", cheek: "#46BE92", paw: "#C9F2E0" },
    { name: "Butter",   fur: "#FFDD8A", dark: "#F5C45A", belly: "#FFF1C9", ear: "#FFD473", cheek: "#EBA52E", paw: "#FFE9AE" },
    { name: "Lavender", fur: "#D2C2FF", dark: "#B49FF2", belly: "#EEE7FF", ear: "#C3AEFF", cheek: "#8E6BE8", paw: "#E1D6FF" },
    { name: "Cocoa",    fur: "#D8A87A", dark: "#BD8857", belly: "#F0DCC6", ear: "#CD9A6C", cheek: "#9B6A42", paw: "#E6C9A8" },
    { name: "Cloud",    fur: "#EEF1F7", dark: "#CDD4E2", belly: "#FBFCFF", ear: "#DCE2EE", cheek: "#F2A6BD", paw: "#F3F5FA" },
    { name: "Shadow",   fur: "#6E6680", dark: "#544D63", belly: "#9C95AC", ear: "#7E7690", cheek: "#F48FB1", paw: "#857D97" },
  ];

  // ---- the iconic heart marking ----
  const heart = (cx, cy, s, fill) =>
    `<path transform="translate(${cx},${cy}) scale(${s})"
       d="M0 2.4 C-1.6 -0.4 -5 -0.2 -5 2.6 C-5 5 -2 6.6 0 8.4 C2 6.6 5 5 5 2.6 C5 -0.2 1.6 -0.4 0 2.4 Z"
       fill="${fill}" stroke="${OUT}" stroke-width="1.1" stroke-linejoin="round"/>`;

  /* Upright sitting cat. eyesClosed → content/blink. Faces right (flip with scaleX). */
  function svgUpright(c, eyesClosed) {
    const eyes = eyesClosed
      ? `<path d="M34 41 q4 4 8 0" fill="none" stroke="${OUT}" stroke-width="2.4" stroke-linecap="round"/>
         <path d="M58 41 q4 4 8 0" fill="none" stroke="${OUT}" stroke-width="2.4" stroke-linecap="round"/>`
      : `<g><ellipse cx="39" cy="41" rx="3.4" ry="4.2" fill="${OUT}"/><circle cx="40.3" cy="39.4" r="1.2" fill="#fff"/></g>
         <g><ellipse cx="61" cy="41" rx="3.4" ry="4.2" fill="${OUT}"/><circle cx="62.3" cy="39.4" r="1.2" fill="#fff"/></g>`;
    return `
    <g stroke="${OUT}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round">
      <!-- tail (behind) -->
      <path d="M70 80 C88 80 90 58 76 54 C70 52.5 66 58 70 61 C77 63 76 73 67 73"
            fill="${c.fur}"/>
      <!-- body -->
      <path d="M27 84 C23 64 32 53 50 53 C68 53 77 64 73 84 C66 90 34 90 27 84 Z" fill="${c.fur}"/>
      <!-- belly -->
      <path d="M40 86 C36 74 40 64 50 64 C60 64 64 74 60 86 Z" fill="${c.belly}" stroke="none"/>
      <!-- feet -->
      <ellipse cx="39" cy="85" rx="7.5" ry="5.2" fill="${c.paw}"/>
      <ellipse cx="61" cy="85" rx="7.5" ry="5.2" fill="${c.paw}"/>
      <!-- ears -->
      <path d="M32 26 L27 9 L46 21 Z" fill="${c.fur}"/>
      <path d="M68 26 L73 9 L54 21 Z" fill="${c.fur}"/>
      <!-- head -->
      <circle cx="50" cy="40" r="22" fill="${c.fur}"/>
    </g>
    <!-- inner ears -->
    <path d="M34 23 L31 14 L43 21 Z" fill="${c.ear}"/>
    <path d="M66 23 L69 14 L57 21 Z" fill="${c.ear}"/>
    <!-- stripes -->
    <g fill="${c.dark}" stroke="none" opacity=".9">
      <path d="M50 19 q3 5 0 9 q-3 -4 0 -9 Z"/>
      <path d="M41 20 q2 4 0 8 q-3 -4 0 -8 Z"/>
      <path d="M59 20 q-2 4 0 8 q3 -4 0 -8 Z"/>
    </g>
    <!-- heart marking -->
    ${heart(50, 26, 0.85, c.dark)}
    <!-- cheeks -->
    <ellipse cx="35" cy="47" rx="4.4" ry="2.8" fill="${c.cheek}" opacity=".7"/>
    <ellipse cx="65" cy="47" rx="4.4" ry="2.8" fill="${c.cheek}" opacity=".7"/>
    <!-- eyes -->
    ${eyes}
    <!-- nose + mouth -->
    <path d="M47 45 L53 45 L50 48.5 Z" fill="${OUT}"/>
    <path d="M50 48.5 q-4 4 -7.5 1.5 M50 48.5 q4 4 7.5 1.5" fill="none" stroke="${OUT}" stroke-width="2" stroke-linecap="round"/>
    <!-- whiskers -->
    <g stroke="${OUT}" stroke-width="1.5" stroke-linecap="round" opacity=".55">
      <path d="M33 45 H22 M33 49 H21"/>
      <path d="M67 45 H78 M67 49 H79"/>
    </g>`;
  }

  /* Lying / sleeping cat — the iconic content pose (head resting on tucked paws,
     curled tail, closed smiling eyes, heart on the brow). Faces left. */
  function svgSleep(c) {
    return `
    <g stroke="${OUT}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round">
      <!-- curled tail over the back -->
      <path d="M82 64 C95 58 92 44 80 47 C73 49 74 58 81 56" fill="${c.fur}"/>
      <!-- body (rounded loaf) -->
      <path d="M20 72 C15 56 30 47 50 47 C72 47 87 55 84 69 C82 78 62 80 47 80 C33 80 24 79 20 72 Z" fill="${c.fur}"/>
      <!-- ears -->
      <path d="M22 55 L18 43 L33 52 Z" fill="${c.fur}"/>
      <path d="M45 54 L50 43 L37 51 Z" fill="${c.fur}"/>
      <!-- head resting low on the left -->
      <circle cx="33" cy="65" r="16" fill="${c.fur}"/>
      <!-- tucked front paws under the chin -->
      <ellipse cx="26" cy="78" rx="6.5" ry="4.2" fill="${c.paw}"/>
      <ellipse cx="40" cy="78.5" rx="6.5" ry="4.2" fill="${c.paw}"/>
    </g>
    <!-- inner ears -->
    <path d="M23 52 L21 45 L30 51 Z" fill="${c.ear}"/>
    <path d="M44 52 L48 45 L39 50 Z" fill="${c.ear}"/>
    <!-- gentle back stripes -->
    <g fill="${c.dark}" stroke="none" opacity=".8">
      <path d="M58 49 q3 8 0 15 q-3 -7 0 -15 Z"/>
      <path d="M68 51 q3 7 0 13 q-3 -6 0 -13 Z"/>
    </g>
    <!-- heart marking on the brow -->
    ${heart(33, 53, 0.62, c.dark)}
    <!-- content closed eyes (smiling) -->
    <path d="M24 64 q3.5 3 7 0" fill="none" stroke="${OUT}" stroke-width="2.3" stroke-linecap="round"/>
    <path d="M36 64 q3.5 3 7 0" fill="none" stroke="${OUT}" stroke-width="2.3" stroke-linecap="round"/>
    <!-- cheeks + tiny nose/smile -->
    <ellipse cx="26" cy="69" rx="3.6" ry="2.2" fill="${c.cheek}" opacity=".7"/>
    <ellipse cx="41" cy="69" rx="3.6" ry="2.2" fill="${c.cheek}" opacity=".7"/>
    <path d="M31.5 70 L36.5 70 L34 72.5 Z" fill="${OUT}"/>`;
  }

  /* Build a full <svg> string. state: {pose:'up'|'sleep', eyesClosed:bool} */
  function svg(config, state) {
    const c = PALETTE[(config && config.furIdx) || 0] || PALETTE[0];
    state = state || {};
    const inner = state.pose === "sleep" ? svgSleep(c) : svgUpright(c, !!state.eyesClosed);
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" overflow="visible">
      <ellipse class="fp-shadow" cx="50" cy="91" rx="24" ry="4.6" fill="rgba(60,30,55,.16)"/>
      ${inner}
    </svg>`;
  }

  // ---- config persistence ----
  function loadConfig() {
    try { return Object.assign({ name: "Pal", furIdx: 0 }, JSON.parse(localStorage.getItem("figpal-config")) || {}); }
    catch (e) { return { name: "Pal", furIdx: 0 }; }
  }
  function saveConfig(cfg) { try { localStorage.setItem("figpal-config", JSON.stringify(cfg)); } catch (e) {} }

  /* ----------------------------------------------------------
     mount(): create the trailing companion overlay on a page.
     opts.size (px), opts.start {x,y}. Returns a control handle.
     pointer-events are OFF so it never blocks the UI.
  ---------------------------------------------------------- */
  function mount(opts) {
    opts = opts || {};
    const cfg = loadConfig();
    const size = opts.size || 76;

    const el = document.createElement("div");
    el.className = "figpal-companion";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      `position:fixed;left:0;top:0;width:${size}px;height:${size}px;z-index:2147483600;` +
      `pointer-events:none;will-change:transform;`;
    // two stacked sprites; we toggle which is visible by state
    el.innerHTML =
      `<div class="fp-sprite fp-up">${svg(cfg, { pose: "up" })}</div>` +
      `<div class="fp-sprite fp-up-blink" style="display:none">${svg(cfg, { pose: "up", eyesClosed: true })}</div>` +
      `<div class="fp-sprite fp-sleep" style="display:none">${svg(cfg, { pose: "sleep" })}</div>` +
      `<div class="fp-zzz" aria-hidden="true">z</div>`;
    document.body.appendChild(el);

    // styles (once)
    if (!document.getElementById("figpal-style")) {
      const st = document.createElement("style");
      st.id = "figpal-style";
      st.textContent = `
        .figpal-companion .fp-sprite{position:absolute;inset:0}
        .figpal-companion svg{width:100%;height:100%;display:block}
        .figpal-companion .fp-shadow{transition:rx .3s,opacity .3s}
        .figpal-companion.walk .fp-up svg{animation:fp-bob .42s ease-in-out infinite}
        @keyframes fp-bob{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-7%) rotate(2deg)}}
        .figpal-companion .fp-zzz{position:absolute;top:-6px;right:-2px;font:700 14px ui-rounded,system-ui,sans-serif;color:#9a8fb0;opacity:0}
        .figpal-companion.sleep .fp-zzz{animation:fp-zzz 2.4s ease-out infinite}
        @keyframes fp-zzz{0%{opacity:0;transform:translate(0,4px) scale(.6)}30%{opacity:.9}100%{opacity:0;transform:translate(8px,-16px) scale(1.1)}}
        .figpal-bubble{position:fixed;z-index:2147483601;pointer-events:none;font-size:18px;opacity:0}
        .figpal-bubble.go{animation:fp-float 1.1s ease-out forwards}
        @keyframes fp-float{0%{opacity:0;transform:translateY(0) scale(.4)}25%{opacity:1;transform:translateY(-10px) scale(1)}100%{opacity:0;transform:translateY(-46px) scale(.9)}}
        @media (prefers-reduced-motion: reduce){
          .figpal-companion.walk .fp-up svg{animation:none}
          .figpal-companion.sleep .fp-zzz{animation:none;opacity:.8}
        }`;
      document.head.appendChild(st);
    }

    const up = el.querySelector(".fp-up");
    const blink = el.querySelector(".fp-up-blink");
    const sleep = el.querySelector(".fp-sleep");

    const pos = { x: (opts.start && opts.start.x) || innerWidth * 0.5,
                  y: (opts.start && opts.start.y) || innerHeight * 0.72 };
    const mouse = { x: pos.x, y: pos.y };
    let facing = 1, lastMove = now(), raf = 0, blinkUntil = 0, nextBlink = now() + 3000, running = true;

    function now() { return performance.now(); }

    function onMove(e) { mouse.x = e.clientX; mouse.y = e.clientY; lastMove = now(); }
    addEventListener("pointermove", onMove, { passive: true });

    function heartBubble() {
      const b = document.createElement("div");
      b.className = "figpal-bubble";
      b.textContent = ["💕", "💗", "✨", "🩷"][Math.floor((now() / 137) % 4)];
      b.style.left = (pos.x + size * 0.32) + "px";
      b.style.top = (pos.y - size * 0.1) + "px";
      document.body.appendChild(b);
      requestAnimationFrame(() => b.classList.add("go"));
      setTimeout(() => b.remove(), 1200);
    }
    let nextHeart = now() + 6000;

    function setPose(p) {
      const isSleep = p === "sleep";
      sleep.style.display = isSleep ? "block" : "none";
      up.style.display = isSleep ? "none" : (p === "blink" ? "none" : "block");
      blink.style.display = p === "blink" ? "block" : "none";
      el.classList.toggle("sleep", isSleep);
    }

    function frame() {
      if (!running) return;
      const t = now();
      const idle = t - lastMove;

      // target trails a bit behind/below the cursor so it looks like it's coming over
      const moving = idle < 220;
      let tx, ty;
      if (idle > 900) {            // settle near where it last walked to
        tx = pos.x; ty = pos.y;
      } else {
        tx = mouse.x - facing * size * 0.62;
        ty = mouse.y + size * 0.30;
      }
      tx = Math.max(size * 0.5, Math.min(innerWidth - size * 0.5, tx));
      ty = Math.max(size * 0.5, Math.min(innerHeight - size * 0.4, ty));

      const dx = tx - pos.x, dy = ty - pos.y;
      const dist = Math.hypot(dx, dy);
      if (Math.abs(dx) > 8) facing = dx > 0 ? 1 : -1;
      pos.x += dx * 0.05;
      pos.y += dy * 0.07;

      const walking = dist > 3;
      el.classList.toggle("walk", walking);

      // state machine: walk → sit → (blink) → sleep
      if (walking) {
        setPose("up");
        blinkUntil = 0; nextBlink = t + 2500 + Math.random() * 3000;
      } else if (idle > 11000) {
        setPose("sleep");
      } else {
        // sitting; blink occasionally, drift the odd heart
        if (t > nextBlink && !blinkUntil) { blinkUntil = t + 160; }
        if (blinkUntil && t < blinkUntil) setPose("blink");
        else { if (blinkUntil) { blinkUntil = 0; nextBlink = t + 2500 + Math.random() * 3500; } setPose("up"); }
        if (t > nextHeart && idle > 1500 && idle < 10000) { heartBubble(); nextHeart = t + 7000 + Math.random() * 6000; }
      }

      el.style.transform =
        `translate(${pos.x - size / 2}px, ${pos.y - size / 2}px) scaleX(${facing})`;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      el,
      destroy() { running = false; cancelAnimationFrame(raf); removeEventListener("pointermove", onMove); el.remove(); },
      // refresh(override) re-skins the live pal; pass a config for instant preview,
      // or omit to re-read whatever was last saved.
      refresh(override) { const ncfg = override || loadConfig();
        up.innerHTML = svg(ncfg, { pose: "up" });
        blink.innerHTML = svg(ncfg, { pose: "up", eyesClosed: true });
        sleep.innerHTML = svg(ncfg, { pose: "sleep" }); },
    };
  }

  /* ----------------------------------------------------------
     auto(): the site-wide manager. Mounts ONE companion when
     revealed, and wires a global secret-word listener so the pal
     can be summoned ("figpal") or sent away ("figbye") from ANY
     page — instantly, no reload. Optionally toggles a #figpalPaw.
  ---------------------------------------------------------- */
  let live = null, autoWired = false, autoOpts = {};

  function isRevealed() { try { return localStorage.getItem("figpal-revealed") === "1"; } catch (e) { return false; } }
  function setPaw(on) { const p = document.getElementById("figpalPaw"); if (p) p.classList.toggle("is-on", !!on); }
  function ensureMounted() { if (!live) live = mount(autoOpts); return live; }

  function reveal() { try { localStorage.setItem("figpal-revealed", "1"); } catch (e) {} ensureMounted(); setPaw(true); }
  function hide() {
    try { localStorage.removeItem("figpal-revealed"); } catch (e) {}
    if (live) { live.destroy(); live = null; }
    setPaw(false);
  }

  function auto(opts) {
    autoOpts = opts || {};
    setPaw(isRevealed());
    if (isRevealed()) ensureMounted();
    if (autoWired) return; autoWired = true;
    let buf = "";
    addEventListener("keydown", function (e) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; // don't hijack typing
      if (!e.key || e.key.length !== 1) return;
      buf = (buf + e.key.toLowerCase()).slice(-6);
      if (buf.endsWith("figpal")) reveal();
      else if (buf.endsWith("figbye")) hide();
    });
  }

  window.FigPal = { PALETTE, svg, loadConfig, saveConfig, mount, auto, reveal, hide };
})();
