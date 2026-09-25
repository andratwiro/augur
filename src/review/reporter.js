/*
 * The failure reporter. Sends ANONYMOUS reports of Augur's own failures to /__report, so an
 * on-call can see what people hit without anybody writing in:
 *
 *   action-failed   an `augur:action-failed` event: a comment, status, rename, pin, board
 *                   save/load/realtime or landing that the server refused or never answered
 *   js-error        an uncaught error thrown by AUGUR'S code (/__…, _chrome) — never by a
 *                   prototype's own script: prototypes are anyone's code, and their bugs are
 *                   not the platform failing
 *   rejection       an unhandled promise rejection, same rule
 *
 * A report carries the kind, the action, the status, a short message, the page path and a
 * random id for this tab (so one person hitting a thing twenty times reads differently from
 * twenty people). Never who you are: the server drops cookies and the address. At most 20
 * reports per page, batched.
 */
(function () {
  "use strict";
  if (window.__augurReporter) return;
  window.__augurReporter = true;
  var tab = Math.random().toString(36).slice(2, 10);
  var sent = 0, MAX = 20, q = [], timer = null;
  var OURS = /\/(__[a-z]|_chrome|sw\.js)/;
  function send() {
    timer = null;
    if (!q.length) return;
    var body = JSON.stringify(q.splice(0, 10));
    try {
      var ok = navigator.sendBeacon && navigator.sendBeacon("/__report", new Blob([body], { type: "application/json" }));
      if (!ok) fetch("/__report", { method: "POST", body: body, headers: { "content-type": "application/json" }, keepalive: true });
    } catch (e) { /* reporting never breaks the page */ }
    if (q.length) timer = setTimeout(send, 500); // a batch is at most 10; send the rest too
  }
  function report(r) {
    if (sent >= MAX) return;
    sent++;
    r.tab = tab;
    r.path = location.pathname.slice(0, 200);
    q.push(r);
    if (!timer) timer = setTimeout(send, 1500);
  }
  window.addEventListener("augur:action-failed", function (e) {
    var d = (e && e.detail) || {};
    report({ kind: "action-failed", action: String(d.action || "").slice(0, 60), status: Number(d.status) || 0 });
  });
  window.addEventListener("error", function (e) {
    var src = String((e && e.filename) || "").replace(location.origin, "");
    if (!e || !e.message || !OURS.test(src)) return;
    report({ kind: "js-error", msg: String(e.message).slice(0, 200), src: src.slice(0, 120), line: e.lineno || 0 });
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason, stack = String((r && r.stack) || "");
    if (!OURS.test(stack)) return;
    report({ kind: "rejection", msg: String((r && r.message) || r || "").slice(0, 200) });
  });
  window.addEventListener("pagehide", send);
})();
