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
export const DRIVERS = {
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
};

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

export const TEMPLATES = {
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
};

export function renderMail(template, vars = {}) {
  const fn = TEMPLATES[template];
  if (!fn) return null;
  const v = { workspace: "your workspace", link: "", inviter: "", expiresHours: 0, ...vars };
  return fn(v);
}

// ---- Per-address rate limit ---------------------------------------------------------
// A template that a STRANGER can trigger is a mail cannon pointed at whoever's address
// they type: a reset form or a signup form will happily send the tenth message to the
// same person, and the address owner is the one who suffers. So the two templates an
// unauthenticated caller can reach are capped per recipient, per window.
//
// The cap is on the MAIL, never on the action. A rate-limited send still returns a link
// to its caller, so an admin resetting the same person four times in an hour gets four
// working links and three emails — the panel says so, and nothing they were trying to do
// was refused.
//
// `roster-invite` is deliberately uncapped: it can only be reached by an authenticated
// admin naming an address they are also putting on their own roster, so a cap there
// protects nobody and blocks a real workflow (re-sending an invite that got lost).
//
// KV has no atomic increment, so this is a soft counter — the same shape and the same
// honest limits as the login throttle. With no KV at all it does not apply.
export const MAIL_RATE = {
  "credential-reset": { max: 3, windowMs: 60 * 60 * 1000 },
  "signup-verify": { max: 5, windowMs: 60 * 60 * 1000 },
};
export const MAIL_RL_PREFIX = "rl:mail:";

const lc = (e) => String(e || "").trim().toLowerCase();
export const mailRateKey = (template, to) => `${MAIL_RL_PREFIX}${template}:${lc(to)}`;

// {allowed, retryAfterMs} — read-only, so a caller can report the wait without spending
// a write.
export async function mailRateCheck(kv, template, to, now = Date.now()) {
  const rule = MAIL_RATE[template];
  if (!kv || !rule) return { allowed: true, retryAfterMs: 0 };
  try {
    const rec = JSON.parse((await kv.get(mailRateKey(template, to))) || "null");
    if (rec && rec.until > now && rec.n >= rule.max) {
      return { allowed: false, retryAfterMs: rec.until - now };
    }
  } catch (e) {}
  return { allowed: true, retryAfterMs: 0 };
}

// Count the ATTEMPT, not the success: a provider that times out on every call still costs
// the recipient nothing, but it must not become a way around the cap.
export async function mailRateNote(kv, template, to, now = Date.now()) {
  const rule = MAIL_RATE[template];
  if (!kv || !rule) return;
  const key = mailRateKey(template, to);
  try {
    const rec = JSON.parse((await kv.get(key)) || "null");
    const n = (rec && rec.until > now ? rec.n : 0) + 1;
    const until = rec && rec.until > now ? rec.until : now + rule.windowMs;
    await kv.put(key, JSON.stringify({ n, until }), {
      expirationTtl: Math.ceil(rule.windowMs / 1000) + 60,
    });
  } catch (e) {}
}

// ---- Send ---------------------------------------------------------------------------
// The one entry point. Returns a verdict, always; throws, never.
//
//   { ok: true,  reason: "sent", provider, id }
//   { ok: false, reason: "unconfigured" }                    no provider — the default
//   { ok: false, reason: "misconfigured", detail }           provider named, settings missing
//   { ok: false, reason: "unknown-template", detail }        a caller bug
//   { ok: false, reason: "bad-recipient", detail }           not an address
//   { ok: false, reason: "rate-limited", retryAfterMs }      capped for this address
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

  const gate = await mailRateCheck(kv, template, to, now);
  if (!gate.allowed) return { ok: false, reason: "rate-limited", retryAfterMs: gate.retryAfterMs };
  await mailRateNote(kv, template, to, now);

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
    case "rate-limited": {
      const mins = Math.max(1, Math.ceil((result.retryAfterMs || 0) / 60000));
      return `Not emailed — too many messages to this address already. Try again in ${mins} min. Send the link yourself.`;
    }
    case "misconfigured": return `Email is switched on but not finished: ${result.detail}. Send the link yourself.`;
    case "bad-recipient": return "Not emailed — that address isn't valid. Send the link yourself.";
    default: return `Couldn't email them (${result.detail || result.reason}). Send the link yourself.`;
  }
}
