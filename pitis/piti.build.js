/* ============================================================
   Piti build addon — the ENTIRE build-time footprint of the
   Piti companion lives here, so build.js stays Piti-agnostic.

   build.js loads this as an optional addon (one try/import) and
   calls these generic hooks; if this file is absent the site
   builds exactly the same, just without the companion.

   Hooks:
     css()                -> extra <style> appended to every shell page
     cornerHtml()         -> markup appended before </body> on shell pages (fixed paw)
     bodyScripts()        -> <script> appended before </body> on shell pages
     transformHtml(h, v)  -> post-process for every COPIED prototype/page/demo
     emit(ctx)            -> copy the companion's own files into /dist
   ============================================================ */

// Loader injected into every copied prototype/page/demo so the pal follows the
// cursor INSIDE prototypes too — not just the nav shell. auto() skips inside
// iframes, so previews never spawn a pal. Absolute /piti.js => served from root.
export function transformHtml(html, version) {
  if (html.includes("gv-piti-start") || html.includes("piti.js")) return html; // already has it / is the customizer
  const tag =
    '<!--gv-piti-start--><script src="/piti.js?v=' + (version || "") +
    '" defer></script><script>addEventListener("DOMContentLoaded",function(){try{window.Piti&&window.Piti.auto()}catch(e){}})</script><!--gv-piti-end-->';
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

// Scripts for the generated shell pages (which aren't passed through transformHtml).
export function bodyScripts(version) {
  const v = version ? "?v=" + version : "";
  return '<script src="/piti.js' + v + '" defer></script>' +
    '<script>addEventListener("DOMContentLoaded",function(){try{window.Piti&&window.Piti.auto();}catch(e){}});</script>';
}

// A quiet paw tucked into the bottom-right corner → opens the customizer. Kept
// barely-there until hover so it reads as an easter egg, not chrome.
// (The companion itself is summoned/dismissed with Shift+Ñ, handled in piti.js.)
export function cornerHtml() {
  return '<a class="piti-paw" href="/pitis/" aria-label="Piti" title="Piti">' +
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<ellipse cx="12" cy="16.5" rx="5" ry="4.2"/>' +
    '<ellipse cx="5.6" cy="11.2" rx="2" ry="2.7"/>' +
    '<ellipse cx="9.8" cy="8.2" rx="2.1" ry="2.9"/>' +
    '<ellipse cx="14.2" cy="8.2" rx="2.1" ry="2.9"/>' +
    '<ellipse cx="18.4" cy="11.2" rx="2" ry="2.7"/>' +
    '</svg></a>';
}

export function css() {
  return `
    /* Pitis is an admin-only toy: hidden by default, revealed only when the profile
       script marks the page as admin (html.gv-admin — set by PROFILE_JS from /__me).
       Default-hidden (not JS-hidden) so Irene/Tali never see a flash of the paw. */
    .piti-paw { display: none; }
    html.gv-admin .piti-paw {
      position: fixed; right: 14px; bottom: 12px; z-index: 50;
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 8px;
      color: var(--faint); opacity: .28;
      transition: color .15s ease, opacity .15s ease, transform .15s ease;
    }
    .piti-paw svg { width: 15px; height: 15px; display: block; }
    .piti-paw:hover { color: var(--accent); opacity: 1; transform: translateY(-1px); }
    .piti-paw:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; opacity: 1; }
    @media print { .piti-paw { display: none; } }`;
}

// Copy the companion's own files into /dist. ctx provides build.js helpers so we
// don't duplicate them: { ROOT, DIST, fs, path, copyDir, isInternalOnly, exists }.
export async function emit({ ROOT, DIST, fs, path, copyDir, isInternalOnly, exists }) {
  const src = path.join(ROOT, "pitis");
  if (!(await exists(src))) return;
  // Ship ONLY the playable app — never the internal docs (*.md) or the gitignored
  // research imagery in reference/ (Figma's own assets, kept on-machine only).
  const skip = (name) => isInternalOnly(name) || name.endsWith(".md") || name === "reference";
  await copyDir(src, path.join(DIST, "pitis"), skip);
  // Also expose the engine at the dist root so any page can load it by absolute path.
  const engine = path.join(src, "piti.js");
  if (await exists(engine)) await fs.copyFile(engine, path.join(DIST, "piti.js"));
}
