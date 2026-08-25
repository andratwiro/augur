/* Starter — the one behaviour the design system ships: copy to clipboard.
   A button carrying data-s-copy="<selector>" copies that element's text and
   says so. Works over file:// as well as over https, because the clipboard
   API is unavailable in some file:// contexts and the old execCommand path
   still is not. No dependencies, no build step. */
(function () {
  "use strict";

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function confirmOn(btn, ok) {
    var was = btn.getAttribute("data-label") || btn.textContent;
    btn.setAttribute("data-label", was);
    btn.textContent = ok ? "Copied" : "Press ⌘C";
    if (ok) btn.setAttribute("data-copied", "");
    clearTimeout(btn._sTimer);
    btn._sTimer = setTimeout(function () {
      btn.textContent = btn.getAttribute("data-label");
      btn.removeAttribute("data-copied");
    }, 1800);
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-s-copy]") : null;
    if (!btn) return;
    var src = document.querySelector(btn.getAttribute("data-s-copy"));
    if (!src) return;
    var text = (src.textContent || "").trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { confirmOn(btn, true); },
        function () { confirmOn(btn, fallbackCopy(text)); }
      );
    } else {
      confirmOn(btn, fallbackCopy(text));
    }
  });
})();
