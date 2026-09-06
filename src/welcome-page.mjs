// welcome-page.mjs — the five-step flow a person meets once, before the workspace.
//
// WHAT IT IS FOR. A new editor arrives at a workspace full of pages and no way to change
// one: everything here is built by an agent in a terminal on their own machine, and
// nothing on a gallery says so. This page is the whole of that instruction — connect a
// terminal, change one line, see it live — and it ends the moment they have done it once.
//
// FOUR RULES IT IS BUILT TO, and each is easy to undo by accident:
//   · NO PASTEABLE AGENT PROMPT. The only thing to copy is one command; everything else
//     is one plain sentence addressed to the person. A screen full of prompt text teaches
//     people to paste rather than to ask, and it dates the moment the flow changes.
//   · NO PRODUCT NAMED. The question is "do you already run a coding agent in a terminal",
//     which is true whatever they run. The one tool the engine can install for them is
//     named in `src/agent-tool.mjs` and nowhere in this file — see `agentTool` below.
//   · NO EXTERNAL REQUEST. One inline style block, one inline script, no font, no CDN, no
//     image. A person meeting the workspace for the first time is the worst moment for a
//     third-party asset to hang, and this page is served before they trust the place.
//   · EVERY STEP IS SKIPPABLE. "do this later" writes `later` on the member and the gate
//     lifts for good. Nothing here may become a wall in front of somebody's own workspace.
//
// The SERVER decides nothing about progress: which step is showing is one localStorage
// word, and every fact the page waits on (paired, drafting, landed) comes from
// `/__onboarding/me`, which is the workspace's own record and agrees across devices.

import { installerFileNames } from "./installer-mac.mjs";

const esc = (s) => String(s === undefined || s === null ? "" : s)
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// A value going into the inline SCRIPT, not into markup: JSON with `<` escaped, so a
// string containing `</script>` cannot end the element. HTML-escaping here instead would
// be safe but wrong — it would put `&amp;` inside a JavaScript string.
const jsStr = (s) => JSON.stringify(String(s === undefined || s === null ? "" : s)).replace(/</g, "\\u003c");

// The approve control, rendered in BOTH of step 2's branches. Somebody who took the
// installer lands back here from the installer's own `open` with a code to type, exactly
// as somebody who already had a terminal does — one branch with no field to type it into
// is a dead end, and it is the branch belonging to the person least able to get out of it.
const APPROVE_FORM = `<form data-approve><input class="code" name="code" placeholder="ABCD-EFGH" autocomplete="off" aria-label="Pairing code"><button class="primary">Approve</button></form>`;

/**
 * The welcome page, as one document.
 *
 * @param {object}  o
 * @param {string}  o.origin     this workspace's origin — the `--origin` the command carries.
 * @param {object}  o.me         the signed-in member (used only to key their own progress).
 * @param {object} [o.agentTool] `AGENT_TOOL` — the tool the installer sets up. Threaded
 *   through for the install step to name if it ever should; deliberately unused by the
 *   copy above, and accepted here so the caller has one place to pass it.
 */
export function renderWelcomePage({ origin, me, agentTool } = {}) {
  const cmd = `npx @augurworks/augur connect --origin ${origin || ""}`;
  // The name the download unpacks to, taken from the module that also names it inside the
  // archive and in the route's Content-Disposition — one string, so the sentence telling
  // somebody which file to open cannot come to describe a file that is not there. A host
  // that will not parse leaves the copy without a name rather than with a wrong one.
  let commandFile = "";
  try { commandFile = installerFileNames(new URL(origin).host).command; } catch (e) { commandFile = ""; }
  const openLine = commandFile
    ? `The download unpacks to a file called <code>${esc(commandFile)}</code>. Open that one.`
    : `Unpack the download, then open the <code>.command</code> file inside it.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Welcome · Augur</title>
<style>
  :root{--bg:#fbfbfd;--fg:#16171a;--muted:#5b626e;--line:rgba(16,17,26,.15);--accent:#2c2150;color-scheme:light}
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;grid-template-columns:minmax(22rem,40%) 1fr;font:16px/1.55 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
  .left{padding:clamp(1.5rem,5vw,4rem);display:flex;flex-direction:column;justify-content:center;gap:1rem}
  .right{background:#eeeef3;display:grid;place-items:center;padding:2rem}
  h1{font-size:1.8rem;margin:0} p{margin:0;color:var(--muted)}
  section[data-step]{display:none} body[data-at="agent"] [data-step="agent"],body[data-at="install"] [data-step="install"],body[data-at="connect"] [data-step="connect"],body[data-at="change"] [data-step="change"],body[data-at="done"] [data-step="done"]{display:contents}
  .cards{display:grid;gap:.75rem} .card{text-align:left;padding:1rem 1.25rem;border:1px solid var(--line);border-radius:12px;background:#fff;font:inherit;cursor:pointer}
  .cmd{display:flex;gap:.5rem;align-items:center} code{font:600 15px ui-monospace,Menlo,monospace;background:#fff;border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;flex:1;overflow:auto}
  .primary{font:600 15px inherit;color:#fff;background:var(--accent);border:0;border-radius:9px;padding:.7rem 1.1rem;cursor:pointer;align-self:flex-start;text-decoration:none;display:inline-block} .primary[disabled]{opacity:.45;cursor:default}
  .status{font-size:.95rem;color:var(--muted)} .status[data-on="1"]{color:#137333;font-weight:600}
  .later{position:fixed;right:1rem;bottom:1rem;font-size:.85rem;color:var(--muted)}
  form[data-approve]{display:flex;gap:.5rem;align-items:center}
  input.code{font:600 16px ui-monospace,Menlo,monospace;letter-spacing:.12em;padding:.6rem .8rem;border:1px solid var(--line);border-radius:8px;width:11em}
  iframe{width:min(36rem,90%);aspect-ratio:4/3;border:0;border-radius:12px;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.08)}
  @media(max-width:48rem){body{grid-template-columns:1fr}.right{min-height:14rem}}
</style></head>
<body data-at="agent">
<div class="left">
  <section data-step="agent">
    <h1>Do you already run a coding agent in a terminal?</h1>
    <p>This workspace is built by an agent on your own machine. One connection and everything it makes shows up here.</p>
    <div class="cards">
      <button class="card" data-go="connect"><b>Yes, I have one</b><br><span class="status">Get the command.</span></button>
      <button class="card" data-go="install"><b>Not yet</b><br><span class="status">Download a file for your Mac that sets it up and connects it.</span></button>
    </div>
  </section>
  <section data-step="install">
    <h1>Set one up</h1>
    <p>One file for your Mac. It installs what is needed, connects to this workspace, and opens the approval page for you.</p>
    <a class="primary" href="/__onboarding/installer/mac">Download for Mac</a>
    <p>${openLine} If your Mac says it is from an unidentified developer, right-click it and choose Open.</p>
    ${APPROVE_FORM}
    <p class="status" data-status>Waiting for a terminal…</p>
    <button class="primary" data-go="change" disabled data-needs="paired">Next</button>
  </section>
  <section data-step="connect">
    <h1>Connect your agent</h1>
    <p>Ask your assistant to run this, and to tell you the code it prints. Then type the code here.</p>
    <div class="cmd"><code data-cmd>${esc(cmd)}</code><button class="primary" data-copy>Copy</button></div>
    ${APPROVE_FORM}
    <p class="status" data-status>Waiting for a terminal…</p>
    <button class="primary" data-go="change" disabled data-needs="paired">Next</button>
  </section>
  <section data-step="change">
    <h1>Change one thing</h1>
    <p>A page of your own is live on the right. Ask your assistant to open <code data-unit></code> and change the line on it to anything you like.</p>
    <p class="status" data-status>Waiting for your agent…</p>
    <button class="primary" data-go="done" disabled data-needs="landed">Next</button>
  </section>
  <section data-step="done">
    <h1>You're in</h1>
    <p>Three places to start: build a design system, start a prototype, try the canvas.</p>
    <button class="primary" data-finish>Open the workspace</button>
  </section>
</div>
<div class="right"><iframe data-frame hidden title="Your page"></iframe></div>
<a class="later" href="#" data-later>do this later</a>
<script>
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.prototype.slice.call(r.querySelectorAll(s));
  const body = document.body;
  // Which step is showing is a per-person, per-browser convenience and nothing more: the
  // workspace's own record is what every decision below is actually made on, so a private
  // window, a cleared store or a second machine costs a person one click, never progress.
  const KEY = "augur-welcome:" + ${jsStr(me && me.email)};
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} },
  };
  let at = store.get() || "agent";
  let landed = false;      // the last answer, so the preview reloads on the CHANGE, not every tick
  let notice = "";         // an approval refusal, kept on screen until the next attempt
  let unitAsked = false;   // the member's page is made once, not once per re-entry
  let timer = null;

  const go = (s) => { at = s; body.dataset.at = s; store.set(s); if (s === "change") ensureUnit(); };
  $$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  $$("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    if (navigator.clipboard) navigator.clipboard.writeText($("[data-cmd]").textContent);
  }));

  $$("[data-approve]").forEach((f) => {
    f.addEventListener("input", () => { notice = ""; });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = String(new FormData(f).get("code") || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const say = (t) => { notice = t; const s = $("[data-status]", f.closest("[data-step]")); if (s) { s.textContent = t; s.dataset.on = "0"; } };
      let r, j = {};
      try {
        r = await fetch("/__publish/_pair/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
        j = await r.json().catch(() => ({}));
      } catch (err) { return say("That did not work."); }
      if (!r.ok) return say(j.error === "no-such-code" ? "That code is not waiting any more. Ask for a fresh one." : (j.message || "That did not work."));
      notice = ""; f.reset(); poll();
    });
  });

  // The two ways out, and both write the flag BEFORE leaving: a person who clicks past
  // this page must never meet it again because the write was still in flight.
  const leave = async (flag) => {
    try {
      await fetch("/__onboarding/me", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(flag) });
    } catch (e) { /* the gate stays up; the link is still there next time */ }
    location.href = "/";
  };
  $("[data-later]").addEventListener("click", (e) => { e.preventDefault(); leave({ later: true }); });
  $("[data-finish]").addEventListener("click", () => leave({ done: true }));

  async function ensureUnit() {
    if (unitAsked) return;
    unitAsked = true;
    try { show(await (await fetch("/__onboarding/me/unit", { method: "POST" })).json()); }
    catch (e) { unitAsked = false; /* the poll below keeps asking */ }
  }

  function show(j) {
    if (!j || typeof j !== "object") return;
    $$("[data-needs=paired]").forEach((b) => { b.disabled = !j.paired; });
    $$("[data-step=install] [data-status],[data-step=connect] [data-status]").forEach((s) => {
      if (notice && !j.paired) return;   // do not wipe "that code is not waiting any more" a tick later
      s.textContent = j.paired ? "Connected." : "Waiting for a terminal…";
      s.dataset.on = j.paired ? "1" : "0";
    });
    if (j.unit) {
      $("[data-unit]").textContent = String(j.unit).replace(/^\/|\/$/g, "");
      const f = $("[data-frame]");
      if (f.hidden) { f.src = j.url; f.hidden = false; }
    }
    const cs = $("[data-step=change] [data-status]");
    cs.textContent = j.landed ? "It's live: " + j.url : j.drafting ? "Your agent is editing…" : "Waiting for your agent…";
    cs.dataset.on = j.landed ? "1" : "0";
    $$("[data-needs=landed]").forEach((b) => { b.disabled = !j.landed; });
    const f = $("[data-frame]");
    if (j.landed && !landed && !f.hidden) f.src = j.url + "?t=" + Date.now();
    landed = !!j.landed;
  }

  // ONE loop, however many times this is called: an approval calls it to refresh at once,
  // and without the clear each call would leave another timer running for the life of the
  // page — a poll that quietly doubles its own rate every time somebody types a code.
  async function poll() {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      const j = await (await fetch("/__onboarding/me")).json();
      if (j && j.done) { location.href = "/"; return; }
      show(j);
    } catch (e) { /* offline, or the store blinked — try again on the next tick */ }
    timer = setTimeout(poll, 3000);
  }

  go(at); poll();
})();
</script></body></html>`;
}
