// test/live/human.mjs — a person at a browser, played by a script.
//
// Everything a member does by hand that the suite needs: sign in with the mailed code,
// approve an agent's pairing code, invite people and change roles, press Land or Discard
// on the draft bar. It holds ONE cookie per person and sends exactly the requests the
// engine's own forms and scripts send, so a drill that passes here passes in a browser.
import fs from "node:fs";
import path from "node:path";
import { ORIGIN, ACCOUNT_ORIGIN, WORKSPACE, MAIL_COOLDOWN_MS, imapConfig, folderOf, addressOf, sleep, workDir } from "./env.mjs";
import { waitForMail, parseCredentialMail } from "./inbox.mjs";

const COOKIE = "__Host-augur_user";
/** The account store's own session, set on ITS host by the code sign-in's hand-off. */
const ACCOUNT_COOKIE = "__Host-augur_session";

/** The cookies the jar holds for one host, as a header value. */
function cookiesFor(jar, host) {
  return [...jar.entries()].filter(([, v]) => v.host === host).map(([k, v]) => `${k}=${v.value}`).join("; ");
}

/** Follow a redirect chain by hand, sending each host its own cookies and keeping every one set on the way. */
async function follow(url, init, jar, hops = 6) {
  const first = cookiesFor(jar, new URL(url).host);
  let res = await fetch(url, { ...init, headers: { ...((init && init.headers) || {}), ...(first ? { cookie: first } : {}) }, redirect: "manual" });
  for (let i = 0; i < hops; i++) {
    for (const sc of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const m = /^([^=]+)=([^;]*)/.exec(sc);
      if (m) jar.set(m[1], { value: m[2], host: new URL(url).host });
    }
    const loc = res.headers.get("location");
    if (!loc || ![301, 302, 303, 307, 308].includes(res.status)) return { res, url };
    url = new URL(loc, url).href;
    const cookie = cookiesFor(jar, new URL(url).host);
    res = await fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
  }
  return { res, url };
}

export class Human {
  constructor(persona) {
    this.persona = persona;
    this.email = addressOf(persona);
    this.origin = ORIGIN();
    this.jar = new Map();
  }
  get cookie() {
    const c = this.jar.get(COOKIE);
    return c ? `${COOKIE}=${c.value}` : "";
  }
  /**
   * The headers a browser sends and a script does not. This person IS a browser, and the
   * engine gives a non-browser fetch of a prototype one extra paragraph for assistants —
   * a person's reads must be the page as published, byte for byte.
   */
  headers(extra = {}) {
    return {
      "user-agent": "Mozilla/5.0 (live suite; a person at a browser)",
      "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none",
      ...(this.cookie ? { cookie: this.cookie } : {}), ...extra,
    };
  }

  /** The account session, when the jar holds one — set by the mailed sign-in's hand-off. */
  get accountCookie() {
    const c = this.jar.get(ACCOUNT_COOKIE);
    return c ? c.value : "";
  }

  /** Everything the jar holds, for a caller that keeps it between processes. */
  jarDump() {
    return [...this.jar.entries()].map(([name, v]) => ({ name, value: v.value, host: v.host }));
  }
  jarLoad(saved) {
    // The older file shape was the workspace cookie alone.
    const list = Array.isArray(saved) ? saved : (saved && saved.name ? [{ ...saved, host: new URL(this.origin).host }] : []);
    for (const c of list) if (c && c.name && c.value && c.host) this.jar.set(c.name, { value: c.value, host: c.host });
  }

  /**
   * Sign in to the workspace. Returns the workspace cookie.
   *
   * Through the ACCOUNT SESSION when the jar holds one and the runner names the account
   * origin: `GET <account>/enter?workspace=<id>` mints a hand-off and the chain ends with a
   * workspace cookie — no mail. That is how a person who signed in once gets back into a
   * workspace after a role change or a re-invite revoked their session, and it is what
   * keeps a drill from asking the mailer for a second code inside its cooldown.
   *
   * A chain that ends WITHOUT a cookie is the workspace's answer to this person: a 404 for
   * somebody it does not know (a removed member signs in like a stranger), and the error
   * says so. A chain that ends back at the account's own sign-in is an account session that
   * has expired, and the mailed code is the way in again.
   */
  async signIn({ timeoutMs = 150000 } = {}) {
    if (this.accountCookie && ACCOUNT_ORIGIN() && WORKSPACE()) {
      const r = await follow(`${ACCOUNT_ORIGIN()}/enter?workspace=${encodeURIComponent(WORKSPACE())}`, { method: "GET" }, this.jar);
      if (this.cookie) return this.cookie;
      const end = new URL(r.url);
      const backAtAccountGate = end.origin === ACCOUNT_ORIGIN() && r.res.status !== 404;
      if (!backAtAccountGate) {
        throw new Error(`signin: chain ended at ${end.origin}${end.pathname}${end.search.replace(/handoff=[^&]+/, "handoff=…")} with ${r.res.status} and no ${COOKIE}`);
      }
      this.jar.delete(ACCOUNT_COOKIE); // expired or refused: the mailed code opens a new one
    }
    return this.signInByMail({ timeoutMs });
  }

  /** The mailed six-digit code, the way a person with no session at all gets in. */
  async signInByMail({ timeoutMs = 150000 } = {}) {
    await this.waitOutMailCooldown();
    const since = new Date(Date.now() - 5000);
    const form = new URLSearchParams({ email: this.email });
    const r1 = await fetch(`${this.origin}/__signin`, { method: "POST", body: form, redirect: "manual" });
    if (r1.status !== 200) throw new Error(`signin: gate answered ${r1.status}`);
    this.noteMailMint();
    const mail = await waitForMail({ folder: folderOf(this.persona), since, subjectRe: /code|sign/i, timeoutMs, cfg: imapConfig() });
    if (!mail) throw new Error(`signin: no code mail for ${this.persona} within ${timeoutMs} ms`);
    const { code } = parseCredentialMail(mail.text);
    if (!code) throw new Error(`signin: mail had no six-digit code: ${mail.subject}`);
    const r2 = await follow(`${this.origin}/__signin/code`, { method: "POST", body: new URLSearchParams({ email: this.email, code }) }, this.jar);
    if (!this.cookie) throw new Error(`signin: chain ended at ${r2.url.replace(/handoff=[^&]+/, "handoff=…")} with ${r2.res.status} and no ${COOKIE}`);
    this.mail = mail;
    return this.cookie;
  }

  /**
   * The account store mails ONE code per address per cooldown and withholds the next; a
   * request inside the window gets a 200 and no mail, which used to surface as a timeout
   * with a misleading message. The last request is remembered on disk, across processes,
   * and a second one waits for the window to pass — slow, said out loud, and green.
   */
  mintFile() { return path.join(workDir("mail-mint"), `${this.persona}.json`); }
  noteMailMint() { fs.writeFileSync(this.mintFile(), JSON.stringify({ at: Date.now() })); }
  async waitOutMailCooldown() {
    let at = 0;
    try { at = JSON.parse(fs.readFileSync(this.mintFile(), "utf8")).at || 0; } catch (e) { /* never mailed */ }
    const wait = at + MAIL_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      console.error(`[live] ${this.persona}: a code was mailed ${Math.round((Date.now() - at) / 1000)} s ago; the mailer withholds another for ${Math.ceil(wait / 1000)} s — waiting`);
      await sleep(wait + 2000);
    }
  }

  /** A page or engine route as this person sees it. */
  async get(pathname, extra = {}) {
    return fetch(`${this.origin}${pathname}`, { headers: this.headers(extra), redirect: "manual" });
  }
  async json(pathname, body, method = "POST") {
    const r = await fetch(`${this.origin}${pathname}`, {
      method, headers: this.headers({ "content-type": "application/json" }), body: body ? JSON.stringify(body) : undefined, redirect: "manual",
    });
    const out = await r.json().catch(() => ({}));
    return { status: r.status, ...out };
  }

  /** Approve an agent's pairing code — what the /__connect page's button does. */
  approvePairing(code) { return this.json("/__publish/_pair/approve", { code }); }

  /**
   * Redeem a passwordless invite link the way the page's own form does it: GET the
   * redemption page first (a mail scanner's GET never consumes the token, so this costs
   * nothing and matches what a person's click actually sends), then POST the form-encoded
   * body `invitePost` reads via `request.formData()` — NOT JSON, and the field is
   * `token`, not `t` (that's only the GET's query param). `follow` keeps every Set-Cookie
   * on the way and chains straight through the `/` → `/__welcome` redirect a first
   * redemption ends in, so `landedUrl`/`text` are already the page the person sees next.
   */
  async acceptInvite(inviteUrl) {
    const u = new URL(inviteUrl);
    const t = u.searchParams.get("t") || "";
    await this.get(`/__invite?t=${encodeURIComponent(t)}`);
    const { res, url } = await follow(`${this.origin}/__invite`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t }).toString(),
    }, this.jar);
    const text = await res.text().catch(() => "");
    return { status: res.status, ok: !!this.cookie, landedUrl: url, text };
  }

  /** Admin panel operations, by their `op` name: invite, space, reset, and the rest. */
  admin(op) { return this.json("/__admin/users", op); }
  users(space) { return this.json(`/__admin/users${space ? `?space=${encodeURIComponent(space)}` : ""}`, null, "GET"); }

  /** The draft bar's buttons: land or discard a draft as a member, from the browser. */
  landFromBar(unit, draftId, baseRevision, note = "") {
    return this.json("/__unit/land", { unit, draftId, baseRevision, note });
  }
  discardFromBar(unit, draftId) { return this.json("/__unit/discard", { unit, draftId }); }
  presence(unit) { return this.json(`/__unit/presence?unit=${encodeURIComponent(unit)}`, null, "GET"); }
  history(unit) { return this.json(`/__unit/history?unit=${encodeURIComponent(unit)}`, null, "GET"); }
  drafts() { return this.json("/__unit/drafts", null, "GET"); }
  restore(unit, revision, note = "") { return this.json("/__unit/restore", { unit, revision, note }); }
}

/**
 * Pair a terminal for this person: start the flow as an agent would, approve it as the
 * person would, claim the token as the agent would. Returns `{token, space}`.
 */
export async function pairFor(human, { label = "live-suite" } = {}) {
  const origin = human.origin;
  const start = await (await fetch(`${origin}/__publish/_pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  if (!start.code) throw new Error(`pair start: ${JSON.stringify(start)}`);
  const ap = await human.approvePairing(start.code);
  if (ap.status !== 200) return { refused: ap };
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${origin}/__publish/_pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: start.code, deviceSecret: start.deviceSecret }) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 200 && body.token) return { token: body.token, space: body.space, expiresAt: body.expiresAt || null };
    if (r.status !== 202) throw new Error(`pair claim: ${r.status} ${JSON.stringify(body)}`);
    await sleep(1000);
  }
  throw new Error("pair claim: still pending after approval");
}
