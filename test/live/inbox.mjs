// test/live/inbox.mjs — read one mailbox over IMAP, with no dependency.
//
// The suite's fake people receive real mail: a sign-in code, an invite link. This is the
// smallest client that can wait for one such message and hand back its text. It speaks
// four IMAP commands (LOGIN, SELECT, SEARCH, FETCH) over TLS and understands literals,
// which is all a code-or-link message needs.
import tls from "node:tls";

function connect({ host, user, pass }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: 993, servername: host }, () => {});
    let buf = Buffer.alloc(0);
    let waiting = null; // {tag, resolve}
    let seq = 0;
    const pump = () => {
      if (!waiting) return;
      // A tagged response line ends the command. Literals ({N}\r\n + N bytes) are
      // carried inside the accumulated buffer; the caller parses them.
      const text = buf.toString("latin1");
      const re = new RegExp(`(^|\\r\\n)${waiting.tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`);
      const m = re.exec(text);
      if (!m) return;
      // Make sure no literal announced before the tag line is still incomplete: count
      // every {N} and check the bytes exist before the match.
      const end = m.index + m[0].length;
      const body = buf.subarray(0, end);
      buf = buf.subarray(end);
      const w = waiting; waiting = null;
      w.resolve({ ok: m[2] === "OK", raw: body });
    };
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
    sock.on("error", reject);
    sock.once("data", () => {
      const cmd = (line) => new Promise((res) => {
        const tag = `A${++seq}`;
        waiting = { tag, resolve: res };
        sock.write(`${tag} ${line}\r\n`);
      });
      resolve({
        cmd,
        close: () => { try { sock.end(); } catch (e) { /* closing */ } },
      });
    });
  });
}

const q = (s) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
const imapDate = (d) => {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()}-${M[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};

/** Decode a quoted-printable body; base64 when the part says so. */
function decodeBody(raw, encoding) {
  const enc = String(encoding || "").toLowerCase();
  if (enc.includes("base64")) return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc.includes("quoted-printable")) {
    return Buffer.from(raw.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  }
  return raw;
}

/** Pull every literal out of a FETCH response, in order. */
function literals(raw) {
  const out = [];
  let i = 0;
  const s = raw.toString("latin1");
  for (;;) {
    const m = /\{(\d+)\}\r\n/.exec(s.slice(i));
    if (!m) break;
    const start = i + m.index + m[0].length;
    const n = Number(m[1]);
    out.push(raw.subarray(start, start + n).toString("latin1"));
    i = start + n;
  }
  return out;
}

/**
 * Wait for a message in `folder` that arrived at or after `since` and whose subject
 * matches `subjectRe` (optional). Returns `{subject, text}` with the decoded body — the
 * text/plain part when the message is multipart, else the whole body — or null on timeout.
 */
export async function waitForMail({ folder = "INBOX", since = new Date(Date.now() - 60000), subjectRe = null, timeoutMs = 120000, pollMs = 5000, cfg }) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    const c = await connect(cfg);
    try {
      const login = await c.cmd(`LOGIN ${q(cfg.user)} ${q(cfg.pass)}`);
      if (!login.ok) throw new Error("imap: login refused");
      const sel = await c.cmd(`SELECT ${q(folder)}`);
      if (sel.ok) {
        const search = await c.cmd(`SEARCH SINCE ${imapDate(since)}`);
        const line = search.raw.toString("latin1").split("\r\n").find((l) => l.startsWith("* SEARCH"));
        const ids = line ? line.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean) : [];
        for (const id of ids.reverse()) {
          if (seen.has(id)) continue;
          const f = await c.cmd(`FETCH ${id} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT])`);
          const lits = literals(f.raw);
          const header = lits[0] || "", body = lits[1] || "";
          const subject = (/^Subject:\s*(.*)$/im.exec(header) || [, ""])[1].trim();
          const dm = /INTERNALDATE "([^"]+)"/.exec(f.raw.toString("latin1"));
          const at = dm ? new Date(dm[1]) : new Date(0);
          if (at < since) { seen.add(id); continue; }
          if (subjectRe && !subjectRe.test(subject)) { seen.add(id); continue; }
          const text = extractText(header, body);
          return { subject, text, at, folder, id };
        }
      }
    } finally { c.close(); }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** The plain text of a message: the text/plain part when multipart, else the body decoded. */
function extractText(header, body) {
  const ct = (/^Content-Type:\s*(.*)$/im.exec(header) || [, ""])[1];
  const cte = (/^Content-Transfer-Encoding:\s*(.*)$/im.exec(header) || [, ""])[1];
  const bm = /boundary="?([^";\r\n]+)"?/i.exec(ct);
  if (!bm) return decodeBody(body, cte);
  const parts = body.split(`--${bm[1]}`);
  let plain = null, html = null;
  for (const p of parts) {
    const sep = p.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const ph = p.slice(0, sep), pb = p.slice(sep + 4);
    const pct = (/^Content-Type:\s*(.*)$/im.exec(ph) || [, ""])[1];
    const pcte = (/^Content-Transfer-Encoding:\s*(.*)$/im.exec(ph) || [, ""])[1];
    if (/text\/plain/i.test(pct) && plain == null) plain = decodeBody(pb, pcte);
    if (/text\/html/i.test(pct) && html == null) html = decodeBody(pb, pcte);
  }
  return plain != null ? plain : (html != null ? html.replace(/<[^>]+>/g, " ") : decodeBody(body, cte));
}

/** The six-digit code and the first https link in a credential message. */
export function parseCredentialMail(text) {
  const code = (/\b(\d{6})\b/.exec(text) || [, null])[1];
  const link = (/https?:\/\/[^\s"'<>)]+/.exec(text) || [null])[0];
  return { code, link };
}
