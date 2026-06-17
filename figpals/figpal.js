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
  const SW  = 4.2;         // canonical chunky outline weight (uniform everywhere)

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

  /* Upright sitting cat. eyesClosed → content/blink. Faces right (flip with scaleX).
     Built to the real FigPal language: one continuous chunky rounded silhouette,
     rounded ear tips, flat pastel fill, lighter belly, soft stripe dabs, blush. */
  function svgUpright(c, eyesClosed) {
    const eyes = eyesClosed
      ? `<path d="M35 41.5 q4.2 4 8.4 0" fill="none" stroke="${OUT}" stroke-width="2.8" stroke-linecap="round"/>
         <path d="M56.6 41.5 q4.2 4 8.4 0" fill="none" stroke="${OUT}" stroke-width="2.8" stroke-linecap="round"/>`
      : `<ellipse cx="39.4" cy="41.5" rx="3.5" ry="4.4" fill="${OUT}"/><circle cx="40.7" cy="39.7" r="1.25" fill="#fff"/>
         <ellipse cx="60.6" cy="41.5" rx="3.5" ry="4.4" fill="${OUT}"/><circle cx="61.9" cy="39.7" r="1.25" fill="#fff"/>`;
    return `
    <g stroke="${OUT}" stroke-width="${SW}" stroke-linejoin="round" stroke-linecap="round">
      <!-- tail: thick curl resting beside the haunch -->
      <path d="M71 82 C90 84 92 60 78 56 C70 53.6 64.5 60 69 63.5 C76 66 75.5 75 67.5 75" fill="${c.fur}"/>
      <!-- body: rounded sitting loaf -->
      <path d="M26 85 C21.5 64 31 52 50 52 C69 52 78.5 64 74 85 C66.5 90.5 33.5 90.5 26 85 Z" fill="${c.fur}"/>
      <!-- ears: rounded triangles -->
      <path d="M33 24 C30 14 28.5 11 31 10 C33.5 9 41 15 45.5 20.5 Z" fill="${c.fur}"/>
      <path d="M67 24 C70 14 71.5 11 69 10 C66.5 9 59 15 54.5 20.5 Z" fill="${c.fur}"/>
      <!-- head -->
      <circle cx="50" cy="40" r="22.5" fill="${c.fur}"/>
    </g>
    <!-- belly (lighter), tucked inside body -->
    <path d="M41 87 C37 75 41 65 50 65 C59 65 63 75 59 87 Z" fill="${c.belly}" stroke="none"/>
    <!-- feet -->
    <g stroke="${OUT}" stroke-width="${SW}" stroke-linejoin="round" stroke-linecap="round">
      <ellipse cx="39" cy="85.5" rx="8" ry="5.4" fill="${c.paw}"/>
      <ellipse cx="61" cy="85.5" rx="8" ry="5.4" fill="${c.paw}"/>
    </g>
    <!-- inner ears -->
    <path d="M34 22 C32 16 31 13.5 32.4 13 C34 12.5 39 16 42 20 Z" fill="${c.ear}"/>
    <path d="M66 22 C68 16 69 13.5 67.6 13 C66 12.5 61 16 58 20 Z" fill="${c.ear}"/>
    <!-- soft stripe dabs on the crown -->
    <g fill="${c.dark}" stroke="none" opacity=".85">
      <path d="M50 19.5 C52.3 21 52.3 25.5 50 28.5 C47.7 25.5 47.7 21 50 19.5 Z"/>
      <path d="M41 21 C43 22.4 43 26 41 28.5 C39 26 39 22.4 41 21 Z"/>
      <path d="M59 21 C61 22.4 61 26 59 28.5 C57 26 57 22.4 59 21 Z"/>
    </g>
    <!-- heart marking on the brow -->
    ${heart(50, 26.5, 0.82, c.dark)}
    <!-- cheeks -->
    <ellipse cx="34.5" cy="47.5" rx="4.6" ry="3" fill="${c.cheek}" opacity=".6"/>
    <ellipse cx="65.5" cy="47.5" rx="4.6" ry="3" fill="${c.cheek}" opacity=".6"/>
    <!-- eyes -->
    ${eyes}
    <!-- nose + mouth (w-smile) -->
    <path d="M47.4 45.4 L52.6 45.4 L50 48.6 Z" fill="${OUT}"/>
    <path d="M50 48.6 q-3.8 3.6 -7.2 1.4 M50 48.6 q3.8 3.6 7.2 1.4" fill="none" stroke="${OUT}" stroke-width="2.1" stroke-linecap="round"/>`;
  }

  /* Lying / sleeping cat — THE iconic FigPal pose (ref 04): one long rounded loaf,
     head resting low on the left atop tucked front paws, two ears up top, a thick
     tail curling back over the right haunch, soft stripe rings, content closed eyes,
     big blush, heart on the brow. Faces left. */
  function svgSleep(c) {
    return `
    <g stroke="${OUT}" stroke-width="${SW}" stroke-linejoin="round" stroke-linecap="round">
      <!-- thick tail curling up and over the right haunch -->
      <path d="M70 67 C84 71 88 47 76 45 C66.5 43.2 63 53 70 55 C77 57 75 64 67 62.5" fill="${c.fur}"/>
      <!-- resting body loaf (head bump on the left, rounded haunch on the right) -->
      <path d="M22 70
               C16 64 17 50 30 47
               C40 45 47 49 50 55
               C53 48.5 61 45.5 71 46.5
               C84 47.5 87 62 79 69
               C72 75 57 75 48 73
               C40 75 28 75 22 70 Z" fill="${c.fur}"/>
      <!-- ears on top of the resting head -->
      <path d="M24 52 C21 44 20 41 22.5 40.5 C25 40 30 44.5 32.5 49 Z" fill="${c.fur}"/>
      <path d="M44 52 C46.5 44.5 47.5 41.5 45 41 C42.5 40.5 38 44.5 36 49 Z" fill="${c.fur}"/>
      <!-- tucked front paws under the chin -->
      <ellipse cx="25" cy="72.5" rx="6.8" ry="4.4" fill="${c.paw}"/>
      <ellipse cx="40" cy="73" rx="6.8" ry="4.4" fill="${c.paw}"/>
    </g>
    <!-- inner ears -->
    <path d="M24.6 49 C22.6 43.5 22 41.5 23.6 41.2 C25.4 41 29 44 31 48 Z" fill="${c.ear}"/>
    <path d="M43.4 49 C45.4 43.7 46 41.6 44.4 41.3 C42.6 41 39 44 37 48 Z" fill="${c.ear}"/>
    <!-- soft stripe rings on the haunch -->
    <g fill="none" stroke="${c.dark}" stroke-width="3.4" stroke-linecap="round" opacity=".8">
      <path d="M58 50 C55 55 55 61 58 66"/>
      <path d="M66 49.5 C63.5 54.5 63.5 60.5 66 65.5"/>
      <path d="M74 50.5 C72 54.5 72 59.5 74 63.5"/>
    </g>
    <!-- heart marking on the brow -->
    ${heart(34, 52, 0.6, c.dark)}
    <!-- content closed eyes (gentle downward arcs) -->
    <path d="M25.5 60 q4 3.4 8 0" fill="none" stroke="${OUT}" stroke-width="2.7" stroke-linecap="round"/>
    <path d="M37 60 q4 3.4 8 0" fill="none" stroke="${OUT}" stroke-width="2.7" stroke-linecap="round"/>
    <!-- cheeks + tiny nose -->
    <ellipse cx="27" cy="65" rx="4" ry="2.6" fill="${c.cheek}" opacity=".6"/>
    <ellipse cx="43" cy="65" rx="4" ry="2.6" fill="${c.cheek}" opacity=".6"/>
    <path d="M32 65.6 L38 65.6 L35 68.6 Z" fill="${OUT}"/>`;
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
      `<div class="fp-sprite fp-up" style="opacity:1">${svg(cfg, { pose: "up" })}</div>` +
      `<div class="fp-sprite fp-up-blink" style="opacity:0">${svg(cfg, { pose: "up", eyesClosed: true })}</div>` +
      `<div class="fp-sprite fp-sleep" style="opacity:0">${svg(cfg, { pose: "sleep" })}</div>` +
      `<div class="fp-zzz" aria-hidden="true">z</div>`;
    document.body.appendChild(el);

    // styles (once)
    if (!document.getElementById("figpal-style")) {
      const st = document.createElement("style");
      st.id = "figpal-style";
      st.textContent = `
        .figpal-companion .fp-sprite{position:absolute;inset:0;transition:opacity .09s ease}
        .figpal-companion .fp-sleep{transition:opacity .35s ease}
        .figpal-companion svg{width:100%;height:100%;display:block;transform-origin:50% 88%}
        .figpal-companion .fp-shadow{transition:rx .3s,opacity .3s}
        /* trot: two springy steps per cycle — a small lift + slight squash, gentle tilt */
        .figpal-companion.walk .fp-up svg{animation:fp-bob .46s ease-in-out infinite}
        @keyframes fp-bob{
          0%   {transform:translateY(0)     scaleY(1)    rotate(-1.5deg)}
          25%  {transform:translateY(-9%)   scaleY(1.03) rotate(0deg)}
          50%  {transform:translateY(0)     scaleY(.985) rotate(1.5deg)}
          75%  {transform:translateY(-9%)   scaleY(1.03) rotate(0deg)}
          100% {transform:translateY(0)     scaleY(1)    rotate(-1.5deg)}
        }
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
    // facing: target ±1 (deadzoned); facingNow eases toward it for a smooth flip.
    let facing = 1, facingNow = 1, walking = false, lastFlip = 0;
    let lastMove = now(), lastT = now(), raf = 0, blinkUntil = 0, nextBlink = now() + 3000, running = true;

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

    // Crossfade between stacked sprites (opacity, not display) so pose changes —
    // especially sit→sleep — settle gently instead of snapping.
    let curPose = "up";
    function setPose(p) {
      if (p === curPose) return;
      curPose = p;
      const isSleep = p === "sleep";
      sleep.style.opacity = isSleep ? "1" : "0";
      up.style.opacity = (p === "up") ? "1" : "0";
      blink.style.opacity = (p === "blink") ? "1" : "0";
      // keep all stacked but let the hidden ones ignore layout cost
      sleep.style.zIndex = isSleep ? "2" : "1";
      el.classList.toggle("sleep", isSleep);
    }

    function frame() {
      if (!running) return;
      const t = now();
      // dt normalised to 60fps so the lerp feels identical on any refresh rate.
      const dt = Math.min(3, (t - lastT) / 16.667); lastT = t;
      const idle = t - lastMove;

      // Target: trail behind & a little below the cursor so it reads as "coming over".
      // After a short pause, lock the target where it stands so it settles cleanly
      // instead of creeping (kills the rubber-band wobble).
      let tx, ty;
      if (idle > 650) {
        tx = pos.x; ty = pos.y;
      } else {
        tx = mouse.x - facing * size * 0.60;
        ty = mouse.y + size * 0.28;
      }
      tx = Math.max(size * 0.5, Math.min(innerWidth - size * 0.5, tx));
      ty = Math.max(size * 0.5, Math.min(innerHeight - size * 0.4, ty));

      const dx = tx - pos.x, dy = ty - pos.y;
      const dist = Math.hypot(dx, dy);

      // Time-based exponential ease toward the target (frame-rate independent).
      const k = 1 - Math.pow(1 - 0.16, dt);   // ~0.16/frame at 60fps
      pos.x += dx * k;
      pos.y += dy * (k * 1.25);

      // Walk hysteresis: only start trotting past a clear distance, and only stop
      // once truly arrived — prevents on/off vibration at the destination.
      if (!walking && dist > 14) walking = true;
      else if (walking && dist < 4) walking = false;
      el.classList.toggle("walk", walking);

      // Facing follows horizontal motion with a deadzone (ignore micro-jitter) AND a
      // short commit window (≥320ms between flips) so it can't dither when the cursor
      // wiggles around a vertical line. facingNow eases quickly toward the target — a
      // brisk turn-around, kept fast so the scaleX never lingers collapsed at 0.
      const wantFacing = dx > 0 ? 1 : -1;
      if (walking && Math.abs(dx) > 10 && wantFacing !== facing && (t - lastFlip) > 320) {
        facing = wantFacing; lastFlip = t;
      }
      facingNow += (facing - facingNow) * (1 - Math.pow(1 - 0.34, dt));
      if (Math.abs(facingNow - facing) < 0.02) facingNow = facing;

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
        `translate(${pos.x - size / 2}px, ${pos.y - size / 2}px) scaleX(${facingNow})`;
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
