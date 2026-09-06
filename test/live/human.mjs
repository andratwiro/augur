// test/live/human.mjs — a person at a browser, played by a script.
//
// Everything a member does by hand that the suite needs: sign in with the mailed code,
// approve an agent's pairing code, invite people and change roles, press Land or Discard
// on the draft bar. It holds ONE cookie per person and sends exactly the requests the
// engine's own forms and scripts send, so a drill that passes here passes in a browser.
import { ORIGIN, imapConfig, folderOf, addressOf, sleep } from "./env.mjs";
import { waitForMail, parseCredentialMail } from "./inbox.mjs";

const COOKIE = "__Host-augur_user";

/** Follow a redirect chain by hand, keeping the workspace cookie when it is set. */
async function follow(url, init, jar, hops = 6) {
  let res = await fetch(url, { ...init, redirect: "manual" });
  for (let i = 0; i < hops; i++) {
    for (const sc of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const m = /^([^=]+)=([^;]*)/.exec(sc);
      if (m) jar.set(m[1], { value: m[2], host: new URL(url).host });
    }
    const loc = res.headers.get("location");
    if (!loc || ![301, 302, 303, 307, 308].includes(res.status)) return { res, url };
    url = new URL(loc, url).href;
    const host = new URL(url).host;
    const cookie = [...jar.entries()].filter(([, v]) => v.host === host).map(([k, v]) => `${k}=${v.value}`).join("; ");
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
  headers(extra = {}) {
    return { ...(this.cookie ? { cookie: this.cookie } : {}), ...extra };
  }

  /** Sign in at the workspace gate with the mailed six-digit code. Returns the cookie. */
  async signIn({ timeoutMs = 150000 } = {}) {
    const since = new Date(Date.now() - 5000);
    const form = new URLSearchParams({ email: this.email });
    const r1 = await fetch(`${this.origin}/__signin`, { method: "POST", body: form, redirect: "manual" });
    if (r1.status !== 200) throw new Error(`signin: gate answered ${r1.status}`);
    const mail = await waitForMail({ folder: folderOf(this.persona), since, subjectRe: /code|sign/i, timeoutMs, cfg: imapConfig() });
    if (!mail) throw new Error(`signin: no code mail for ${this.persona} within ${timeoutMs} ms`);
    const { code } = parseCredentialMail(mail.text);
    if (!code) throw new Error(`signin: mail had no six-digit code: ${mail.subject}`);
    const r2 = await follow(`${this.origin}/__signin/code`, { method: "POST", body: new URLSearchParams({ email: this.email, code }) }, this.jar);
    if (!this.cookie) throw new Error(`signin: chain ended at ${r2.url} with ${r2.res.status} and no ${COOKIE}`);
    this.mail = mail;
    return this.cookie;
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
