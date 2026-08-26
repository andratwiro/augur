// The mail transport — one function the rest of the engine calls to send a message.
//
// THE DEGRADE PATH IS THE FEATURE. An invite has always been a link an admin copies out
// of the admin panel and sends themselves. Email does not replace that; it rides on top
// of it. So `sendMail` NEVER throws and NEVER blocks: it returns a verdict, the caller
// hands back the link either way, and the three states an operator can be in all end
// with a working invite:
//
//   no provider configured  → reason "unconfigured", nothing sent, nothing logged, the
//                             panel behaves exactly as it did before mail existed.
//   provider misconfigured  → reason "misconfigured" naming the setting that is missing.
//   provider down / refused → reason "failed" carrying the provider's own words.
//
// Every one of those is REPORTED, never swallowed: the admin API puts the verdict in its
// JSON and the panel shows it next to the link. A provider outage costs you the
// convenience of the send, never the invite.
//
// HTTP ONLY, NEVER SMTP. This runs in a Cloudflare Worker, which has no outbound TCP
// sockets. A provider is a shape of HTTP request, and adding one is adding an entry to
// DRIVERS below.
//
// NO INSTANCE VALUES LIVE HERE. Which provider, which endpoint, which key, which
// address the mail comes from — all of it is runtime worker env, set per deployment
// (see mailConfig). The engine carries the interface and the message wording, and
// nothing that identifies a deployment.

// ---- Configuration ----------------------------------------------------------------
// Runtime worker env, per deployment. Unset MAIL_PROVIDER is the supported default:
// a deployment that never configures mail is a deployment that hands out links.
//
//   MAIL_PROVIDER    driver name — a key of DRIVERS below. Unset ⇒ mail is off.
//   MAIL_FROM        the sending identity: "Name <address@example.org>" or a bare
//                    address. Use a domain you control the DNS for — SPF, DKIM and
//                    DMARC have to pass on it or the mail lands in spam.
//   MAIL_API_KEY     the provider credential (a secret, never a plain env var).
//   MAIL_API_URL     the endpoint. Required by drivers that have no way to derive one;
//                    always allowed as an override.
//   MAIL_PROJECT_ID  the provider-side account/project the sends are billed to, where
//                    the provider wants one in the body.
//   MAIL_REGION      the provider region, where the endpoint is per-region.
const str = (v) => (typeof v === "string" ? v.trim() : "");

// "Display Name <someone@example.org>" → {name, email}. A bare address is the common
// case and gets an empty name. Anything unparseable yields an empty email, which
// sendMail reports as misconfigured rather than sending from nowhere.
export function parseAddress(raw) {
  const s = str(raw);
  const m = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(s);
  if (m) return { name: m[1].replace(/^"|"$/g, "").trim(), email: m[2] };
  return { name: "", email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "" };
}

export function mailConfig(env) {
  const provider = str(env && env.MAIL_PROVIDER).toLowerCase();
  if (!provider) return null;
  return {
    provider,
    from: parseAddress(env && env.MAIL_FROM),
    apiKey: str(env && env.MAIL_API_KEY),
    apiUrl: str(env && env.MAIL_API_URL),
    projectId: str(env && env.MAIL_PROJECT_ID),
    region: str(env && env.MAIL_REGION),
  };
}

// Is mail switched on for this deployment at all? Callers use it to decide whether to
// SAY anything about email — with no provider the panel should look untouched.
export function mailConfigured(env) {
  return !!str(env && env.MAIL_PROVIDER);
}

// ---- Drivers ------------------------------------------------------------------------
// A driver is three small answers: where to POST, what to put in the request, and how to
// read an id back out. It owns the wire shape only — the endpoint host stays in config so
// a region change or a provider's own migration is a setting, not an engine release.
//
// `missing(cfg)` returns the names of the settings this driver cannot work without, so a
// half-configured deployment gets told which env var to set instead of a 400 from a
// vendor.
export const DRIVERS = Object.freeze({
  // Transactional Email over Scaleway's HTTP API (v1alpha1). Per-region endpoint, so
  // MAIL_REGION is required unless MAIL_API_URL spells the whole thing out. Auth is a
  // secret key in X-Auth-Token; the project the send is billed to goes in the body.
  scaleway: {
    endpoint(cfg) {
      if (cfg.apiUrl) return cfg.apiUrl;
      if (!cfg.region) return "";
      return `https://api.scaleway.com/transactional-email/v1alpha1/regions/${encodeURIComponent(cfg.region)}/emails`;
    },
    missing(cfg) {
      const out = [];
      if (!cfg.apiKey) out.push("MAIL_API_KEY");
      if (!cfg.projectId) out.push("MAIL_PROJECT_ID");
      if (!cfg.apiUrl && !cfg.region) out.push("MAIL_REGION");
      return out;
    },
    request(cfg, msg) {
      const from = { email: cfg.from.email };
      if (cfg.from.name) from.name = cfg.from.name;
      return {
        headers: { "X-Auth-Token": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [{ email: msg.to }],
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          project_id: cfg.projectId,
        }),
      };
    },
    id(json) {
      const first = json && Array.isArray(json.emails) ? json.emails[0] : null;
      return (first && typeof first.id === "string") ? first.id : "";
    },
  },

  // The escape hatch: POST the rendered message as plain JSON to whatever URL the
  // deployment names, bearer-authenticated. Anyone whose provider is not in this file
  // puts a dozen-line relay in front of it and configures this, rather than forking the
  // engine to add a driver. It also carries `template`, so a relay that would rather own
  // the wording can ignore the rendered bodies and use its own.
  http: {
    endpoint(cfg) { return cfg.apiUrl; },
    missing(cfg) {
      const out = [];
      if (!cfg.apiUrl) out.push("MAIL_API_URL");
      if (!cfg.apiKey) out.push("MAIL_API_KEY");
      return out;
    },
    request(cfg, msg) {
      return {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: cfg.from.email,
          fromName: cfg.from.name || "",
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          template: msg.template,
        }),
      };
    },
    id(json) { return json && typeof json.id === "string" ? json.id : ""; },
  },
});

// ---- Templates ----------------------------------------------------------------------
// Three messages, because three are what the product actually sends: someone confirming
// the address they signed up with, someone invited to an existing workspace, and someone
// whose credential was reset. All three say the same thing in the end — here is a link,
// it works once, ignore this if it wasn't you.
//
// Wording is deliberately plain and deployment-neutral. `workspace` is whatever the
// caller passes (the host it is serving, or the workspace's name), so the engine names
// no deployment.
//
// Every template renders BOTH a text and an HTML body. Text is not a fallback, it is
// half the message: plenty of clients show it, and a text part is one of the cheapest
// things you can do for deliverability.

const escHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One visual shell for all three, inline-styled and image-free: mail clients strip
// <style> blocks and block remote images, and a remote image would leak a read receipt
// and an instance hostname into every message.
function htmlShell({ heading, lines, link, action, footer }) {
  const body = lines.map((l) => `<p style="margin:0 0 14px">${escHtml(l)}</p>`).join("\n      ");
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#fbfbfd;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16171a">
  <div style="max-width:520px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid rgba(16,17,26,0.09);border-radius:14px">
    <h1 style="margin:0 0 18px;font-size:19px;font-weight:600;letter-spacing:-0.015em">${escHtml(heading)}</h1>
    <div style="color:#2c2f36">
      ${body}
    </div>
    <p style="margin:22px 0 18px">
      <a href="${escHtml(link)}" style="display:inline-block;padding:11px 18px;border-radius:9px;background:#2c2150;color:#ffffff;text-decoration:none;font-weight:600">${escHtml(action)}</a>
    </p>
    <p style="margin:0 0 14px;font-size:13px;color:#5b626e">If the button does nothing, copy this address into your browser:<br />
      <a href="${escHtml(link)}" style="color:#4f46e5;word-break:break-all">${escHtml(link)}</a></p>
    <p style="margin:0;font-size:13px;color:#9aa0ab">${escHtml(footer)}</p>
  </div>
</body></html>`;
}

function textBody({ lines, link, footer }) {
  return `${lines.join("\n\n")}\n\n${link}\n\n${footer}\n`;
}

// A link is single-use and short-lived, and saying so is what stops a puzzled recipient
// from sitting on it for a week. The caller passes the window it actually minted.
const expiryLine = (hours) => {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return "The link can be used once.";
  if (h % 24 === 0) {
    const d = h / 24;
    return `The link can be used once, and stops working in ${d} day${d === 1 ? "" : "s"}.`;
  }
  return `The link can be used once, and stops working in ${h} hour${h === 1 ? "" : "s"}.`;
};

export const TEMPLATES = Object.freeze({
  // Someone typed an address into a signup form. Nothing exists yet — this proves the
  // address is theirs before anything is provisioned against it.
  "signup-verify": (v) => {
    const lines = [
      "Confirm this address to finish setting up your workspace.",
      expiryLine(v.expiresHours),
    ];
    return {
      subject: "Confirm your email address",
      text: textBody({ lines, link: v.link, footer: "If you didn't ask for this, ignore this message — nothing was created." }),
      html: htmlShell({
        heading: "Confirm your email address",
        lines, link: v.link, action: "Confirm address",
        footer: "If you didn't ask for this, ignore this message — nothing was created.",
      }),
    };
  },

  // An admin added someone to a workspace's roster. The link sets their password and
  // signs them in, which is the whole of "accepting" an invite.
  "roster-invite": (v) => {
    const who = str(v.inviter);
    const lines = [
      who ? `${who} invited you to ${v.workspace}.` : `You have been invited to ${v.workspace}.`,
      "Choose a password and you're in.",
      expiryLine(v.expiresHours),
    ];
    return {
      subject: `You're invited to ${str(v.workspace) || "a workspace"}`,
      text: textBody({ lines, link: v.link, footer: "If you weren't expecting this, ignore this message." }),
      html: htmlShell({
        heading: "You've been invited",
        lines, link: v.link, action: "Set your password",
        footer: "If you weren't expecting this, ignore this message.",
      }),
    };
  },

  // The credential is already gone by the time this is sent — reset revokes and mints the
  // link in one action, so there is never a live password alongside a pending link. The
  // wording has to match that, or people go looking for the old one.
  "credential-reset": (v) => {
    const lines = [
      `Your password for ${v.workspace} was reset, so the old one no longer works.`,
      "Choose a new one to get back in.",
      expiryLine(v.expiresHours),
    ];
    return {
      subject: `Set a new password for ${str(v.workspace) || "your account"}`,
      text: textBody({ lines, link: v.link, footer: "If you didn't expect this, tell whoever runs the site — someone with admin access did it." }),
      html: htmlShell({
        heading: "Set a new password",
        lines, link: v.link, action: "Choose a new password",
        footer: "If you didn't expect this, tell whoever runs the site — someone with admin access did it.",
      }),
    };
  },
});

export function renderMail(template, vars = {}) {
  const fn = TEMPLATES[template];
  if (!fn) return null;
  const v = { workspace: "your workspace", link: "", inviter: "", expiresHours: 0, ...vars };
  return fn(v);
}

// ---- The abuse guards ----------------------------------------------------------------
//
// FOUR RATE LAYERS AND TWO THINGS THAT ARE NOT RATE LIMITS. They stop different attacks,
// and any one of them alone stops none of the others.
//
// THE ATTACK THE ORIGINAL GUARD COULD NOT SEE. Every limit here used to be keyed on the
// RECIPIENT. So one actor triggers three resets each at ten thousand DIFFERENT addresses,
// stays inside every cap, and sends thirty thousand messages. That is the shape that
// destroys a sending domain's reputation, and it is also the cost shape: the sending plan
// is 300 messages a MONTH, so a modest burst exhausts the quota and signup then fails
// silently for everyone. The per-actor ceiling is the one that was missing; without it the
// other layers are decoration.
//
//   1. CEILING, per recipient per window. Stops one person's inbox being bombed.
//   2. FLOOR, a minimum gap between two sends to one address. NOT the same guard: 3/hour
//      permits three instantly, so a double-clicked resend button sends three. The floor
//      is what makes a resend button honest, and it is the cheapest fix here.
//   3. CEILING, per ACTOR — the admin for an invite, the client IP for anything a stranger
//      can reach. This is the one that sees the attack above.
//   4. CEILING, per INSTANCE. Hard-stops and logs loudly rather than queueing, because the
//      failure it prevents is silent quota exhaustion that breaks signup for everybody.
//
// `roster-invite` IS capped now, generously. The old reasoning — an authenticated admin
// naming an address they are also putting on their own roster — holds right up until the
// admin credential is the thing that was stolen, and an uncapped authenticated path is
// still a mail cannon, just one that needs a login first.
//
// EVERY LIMIT DEGRADES THE WAY THE TRANSPORT ALREADY DOES: refusing to send still returns
// a copy-pasteable link and a visible reason, never a silent swallow. Nothing a person was
// trying to DO is refused; only the email is.
//
// The numbers are named constants a self-hoster can raise. They protect a 300-a-month
// plan, not a large one.
//
// KV has no atomic increment, so these are soft counters — the same shape and the same
// honest limits as the login throttle. With no KV at all none of them apply, which is the
// local-development case.

export const MAIL_RATE = Object.freeze({
  "credential-reset": { max: 3, windowMs: 60 * 60 * 1000, minGapMs: 60 * 1000 },
  "signup-verify": { max: 5, windowMs: 60 * 60 * 1000, minGapMs: 60 * 1000 },
  // Generous: re-sending a lost invite is a real workflow and must not be blocked. It is
  // capped at all because "only an admin can reach it" stops being a guarantee the moment
  // an admin credential leaks.
  "roster-invite": { max: 30, windowMs: 60 * 60 * 1000, minGapMs: 20 * 1000 },
});

// Per ACTOR: who triggered the send, across every recipient and every template.
export const MAIL_ACTOR_RATE = Object.freeze({ max: 20, windowMs: 60 * 60 * 1000 });

// Per INSTANCE. 50 a day against a 300-a-month plan: an instance sending its real volume
// never comes near it, and a runaway is stopped having spent a sixth of the month rather
// than all of it. Raise it if you send more; it exists to bound an accident, not to ration.
export const MAIL_GLOBAL_RATE = Object.freeze({ max: 50, windowMs: 24 * 60 * 60 * 1000 });

export const MAIL_RL_PREFIX = "rl:mail:";
export const MAIL_SUPPRESS_KEY = "mail:suppressed";

const lc = (e) => String(e || "").trim().toLowerCase();
export const mailRateKey = (template, to) => `${MAIL_RL_PREFIX}${template}:${lc(to)}`;
export const mailActorKey = (actor) => `${MAIL_RL_PREFIX}actor:${lc(actor)}`;
export const MAIL_GLOBAL_KEY = `${MAIL_RL_PREFIX}instance`;

// ---- Suppression: never send to an address that has hard-bounced ----------------------
//
// LEARNED THE EXPENSIVE WAY. Bounces to two addresses on the sending domain got both
// blocklisted at the provider for a MONTH, and the provider caps blocklist deletions at
// five per rolling 24 hours — so the cleanup is structurally slower than the damage. A
// local refusal costs nothing and is the only part of this that is faster than the harm.
//
// It is a local list and it is deliberately not clever: an address goes on when something
// tells us it hard-bounced, and it comes off when a human takes it off. Guessing that a
// bounce was temporary is how an address gets bounced a second time.
export async function mailSuppressed(kv, to) {
  if (!kv) return false;
  try {
    const list = JSON.parse((await kv.get(MAIL_SUPPRESS_KEY)) || "null");
    return !!(list && typeof list === "object" && !Array.isArray(list) && list[lc(to)]);
  } catch (e) { return false; }
}

export async function mailSuppress(kv, to, reason = "hard-bounce", now = Date.now()) {
  if (!kv) return false;
  try {
    const raw = JSON.parse((await kv.get(MAIL_SUPPRESS_KEY)) || "null");
    const list = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    list[lc(to)] = { reason: String(reason).slice(0, 120), at: new Date(now).toISOString() };
    await kv.put(MAIL_SUPPRESS_KEY, JSON.stringify(list));
    return true;
  } catch (e) { return false; }
}

// ---- The counters --------------------------------------------------------------------
// Read-only, so a caller can report the wait without spending a write.

async function readCounter(kv, key, now) {
  try {
    const rec = JSON.parse((await kv.get(key)) || "null");
    return rec && rec.until > now ? rec : null;
  } catch (e) { return null; }
}

async function noteCounter(kv, key, rule, now) {
  try {
    const rec = await readCounter(kv, key, now);
    const n = (rec ? rec.n : 0) + 1;
    const until = rec ? rec.until : now + rule.windowMs;
    await kv.put(key, JSON.stringify({ n, until, last: now }), {
      expirationTtl: Math.ceil(rule.windowMs / 1000) + 60,
    });
  } catch (e) {}
}

/**
 * {allowed, retryAfterMs, layer} — `layer` names WHICH guard refused, because "try again
 * later" without saying which limit was hit is the message that makes an operator think
 * the mail is broken.
 */
export async function mailRateCheck(kv, template, to, now = Date.now(), opts = {}) {
  const rule = MAIL_RATE[template];
  if (!kv) return { allowed: true, retryAfterMs: 0 };

  if (rule) {
    const rec = await readCounter(kv, mailRateKey(template, to), now);
    if (rec) {
      // FLOOR first: it is the one a person actually trips, and naming the ceiling when
      // they double-clicked would be a wrong answer.
      if (rule.minGapMs && rec.last && now - rec.last < rule.minGapMs) {
        return { allowed: false, retryAfterMs: rule.minGapMs - (now - rec.last), layer: "floor" };
      }
      if (rec.n >= rule.max) {
        return { allowed: false, retryAfterMs: rec.until - now, layer: "recipient" };
      }
    }
  }

  if (opts.actor) {
    const rec = await readCounter(kv, mailActorKey(opts.actor), now);
    if (rec && rec.n >= MAIL_ACTOR_RATE.max) {
      return { allowed: false, retryAfterMs: rec.until - now, layer: "actor" };
    }
  }

  const g = await readCounter(kv, MAIL_GLOBAL_KEY, now);
  if (g && g.n >= MAIL_GLOBAL_RATE.max) {
    return { allowed: false, retryAfterMs: g.until - now, layer: "instance" };
  }

  return { allowed: true, retryAfterMs: 0 };
}

// Count the ATTEMPT, not the success: a provider that times out on every call still costs
// the recipient nothing, but it must not become a way around the cap.
export async function mailRateNote(kv, template, to, now = Date.now(), opts = {}) {
  if (!kv) return;
  const rule = MAIL_RATE[template];
  if (rule) await noteCounter(kv, mailRateKey(template, to), rule, now);
  if (opts.actor) await noteCounter(kv, mailActorKey(opts.actor), MAIL_ACTOR_RATE, now);
  await noteCounter(kv, MAIL_GLOBAL_KEY, MAIL_GLOBAL_RATE, now);
}

// ---- Send ---------------------------------------------------------------------------
// The one entry point. Returns a verdict, always; throws, never.
//
//   { ok: true,  reason: "sent", provider, id }
//   { ok: false, reason: "unconfigured" }                    no provider — the default
//   { ok: false, reason: "misconfigured", detail }           provider named, settings missing
//   { ok: false, reason: "unknown-template", detail }        a caller bug
//   { ok: false, reason: "bad-recipient", detail }           not an address
//   { ok: false, reason: "rate-limited", retryAfterMs, layer } capped — layer names which
//                                                            guard: floor | recipient |
//                                                            actor | instance
//   { ok: false, reason: "suppressed", detail }              this address hard-bounced before
//   { ok: false, reason: "failed", detail }                  the provider said no
//
// `fetchImpl` and `kv` are injectable so the suite can drive every one of those without
// a network and without a live account. Nothing in here reaches for a global except
// through those two seams.
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEND_TIMEOUT_MS = 10000;
const DETAIL_MAX = 240;

export async function sendMail(env, message = {}, opts = {}) {
  const { to, template, vars = {} } = message;
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const kv = opts.kv !== undefined ? opts.kv : (env && env.COMMENTS) || null;
  const now = opts.now || Date.now();

  const cfg = mailConfig(env);
  if (!cfg) return { ok: false, reason: "unconfigured" };

  const driver = DRIVERS[cfg.provider];
  if (!driver) {
    return { ok: false, reason: "misconfigured",
      detail: `unknown MAIL_PROVIDER "${cfg.provider}" — known drivers: ${Object.keys(DRIVERS).join(", ")}` };
  }
  const missing = driver.missing(cfg).concat(cfg.from.email ? [] : ["MAIL_FROM"]);
  if (missing.length) {
    return { ok: false, reason: "misconfigured", detail: `not set: ${missing.join(", ")}` };
  }
  const endpoint = driver.endpoint(cfg);
  if (!endpoint) return { ok: false, reason: "misconfigured", detail: "not set: MAIL_API_URL" };

  if (!EMAILISH.test(String(to || ""))) {
    return { ok: false, reason: "bad-recipient", detail: "not an email address" };
  }
  const rendered = renderMail(template, vars);
  if (!rendered) return { ok: false, reason: "unknown-template", detail: String(template) };

  // Suppression is checked BEFORE any counter, so an address we already know hard-bounced
  // costs nobody their budget — and so a suppressed address cannot be used to burn an
  // actor's allowance.
  if (await mailSuppressed(kv, to)) {
    return { ok: false, reason: "suppressed",
      detail: "this address hard-bounced before; sending to it again risks the whole domain's reputation" };
  }

  const gate = await mailRateCheck(kv, template, to, now, { actor: opts.actor });
  if (!gate.allowed) {
    // The instance ceiling is the one worth waking someone for: everything still works,
    // links are still handed out, and nobody would otherwise notice until signup mail
    // stopped arriving for everyone.
    if (gate.layer === "instance") {
      try {
        console.log(JSON.stringify({
          level: "alarm",
          event: "mail-instance-ceiling",
          detail: `This instance has attempted ${MAIL_GLOBAL_RATE.max} sends in ${Math.round(MAIL_GLOBAL_RATE.windowMs / 3600000)}h and is now refusing. Links are still being handed out. Check for a loop or an abusive caller before raising MAIL_GLOBAL_RATE.`,
        }));
      } catch (e) { /* an alarm may never break the refusal it announces */ }
    }
    return { ok: false, reason: "rate-limited", retryAfterMs: gate.retryAfterMs, layer: gate.layer };
  }
  await mailRateNote(kv, template, to, now, { actor: opts.actor });

  if (!fetchImpl) return { ok: false, reason: "failed", detail: "no fetch available" };

  const req = driver.request(cfg, { to, template, ...rendered });
  try {
    const init = { method: "POST", headers: req.headers, body: req.body };
    // A provider that hangs must not hold the admin's request open. AbortSignal.timeout
    // exists in workerd and in Node 18+; where it does not, the send simply has no
    // deadline rather than failing to be attempted.
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
    }
    const res = await fetchImpl(endpoint, init);
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, reason: "failed", detail: `${res.status} ${body.slice(0, DETAIL_MAX)}`.trim() };
    }
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch (e) {}
    return { ok: true, reason: "sent", provider: cfg.provider, id: driver.id(json) || "" };
  } catch (e) {
    return { ok: false, reason: "failed", detail: String((e && e.message) || e).slice(0, DETAIL_MAX) };
  }
}

// What an operator should be told, in one line. The panel shows this next to the link,
// so it has to be useful to someone who has never read this file: name the state, and
// where a setting is missing, name the setting.
export function mailNotice(result, to) {
  if (!result) return "";
  if (result.ok) return `Emailed to ${to}.`;
  switch (result.reason) {
    case "unconfigured": return "";
    case "suppressed":
      return "Not emailed. That address bounced before, so we no longer send to it. Send the link yourself.";
    case "rate-limited": {
      const ms = result.retryAfterMs || 0;
      const wait = ms < 60000 ? `${Math.max(1, Math.ceil(ms / 1000))} s` : `${Math.ceil(ms / 60000)} min`;
      // Name WHICH limit. "Try again later" without saying which one is the message that
      // makes an operator conclude the mail is broken and stop trusting the panel.
      switch (result.layer) {
        case "floor":
          return `Not emailed yet. That was moments ago, so try again in ${wait}. Send the link yourself.`;
        case "actor":
          return `Not emailed. You have sent a lot of mail in the last hour, so try again in ${wait}. Send the link yourself.`;
        case "instance":
          return `Not emailed. This whole instance has hit its sending limit for the day. Nothing is lost. Send the link yourself, and check the logs for a loop.`;
        default:
          return `Not emailed. Too many messages to this address already, so try again in ${wait}. Send the link yourself.`;
      }
    }
    case "misconfigured": return `Email is switched on but not finished: ${result.detail}. Send the link yourself.`;
    case "bad-recipient": return "Not emailed — that address isn't valid. Send the link yourself.";
    default: return `Couldn't email them (${result.detail || result.reason}). Send the link yourself.`;
  }
}
