// Which workspace a hostname names.
//
// `B-resolver-dynamic`. A deployment that serves several workspaces tells them apart by
// the first label of the Host header — `acme.example.com` is the workspace `acme`. This
// module is the parsing and the refusing; `resolveTenant()` in src/_worker.js is the one
// place that calls it, and turning the label into a Durable Object stub is that function's
// last line.
//
// It is a separate module for two reasons. The worker does not need two more module-scope
// tables in it, and the RESERVED list has a second reader coming: the control plane
// generates workspace names (`voracious-eel-294`, never user-chosen), and a generator that
// emits `admin` and a resolver that refuses it are the same list disagreeing. One list,
// imported twice, is the only arrangement where they cannot drift.
//
// EVERYTHING HERE IS A PURE FUNCTION OF A STRING. No env, no fetch, no clock — the
// resolver runs before any config is read, on every request, and it has to be impossible
// for it to be the thing that is slow or the thing that fails.

/**
 * A hostname label a workspace may never be, whatever a generator emits and whatever
 * already exists.
 *
 * These fall into three groups and each is here for its own reason:
 *
 *   · INFRASTRUCTURE — `www`, `mail`, `ns1`, `mx`, `cdn`. A DNS record that has to be able
 *     to exist on this domain. A workspace holding one of these names is a workspace that
 *     cannot be routed around later without taking somebody's site away.
 *   · THE OPERATOR'S OWN SURFACE — `admin`, `status`, `billing`, `support`, `login`,
 *     `auth`. These read as the operator speaking. A stranger's workspace answering on
 *     `login.<domain>` is a phishing page with a real certificate, served by us.
 *   · MAILBOXES THAT MUST STAY ANSWERABLE — `postmaster`, `hostmaster`, `webmaster`,
 *     `abuse`, `security`. Certificate authorities and abuse reporters use these; they are
 *     addresses before they are hostnames, and losing control of one loses a channel.
 *
 * A frozen ARRAY rather than a Set, deliberately: `Object.freeze(new Set())` does not stop
 * `.add()`, so a frozen Set is a table that looks immutable and is not. The list is short
 * and the check runs once per request.
 */
export const RESERVED_LABELS = Object.freeze([
  // infrastructure
  "www", "mail", "smtp", "imap", "pop", "mx", "ns", "ns1", "ns2", "ns3", "ftp", "sftp",
  "cdn", "static", "assets", "img", "images", "media", "files", "edge", "origin", "proxy",
  "vpn", "dns", "autodiscover", "autoconfig", "localhost", "local", "example", "invalid",
  // the operator's own surface
  "admin", "administrator", "root", "system", "internal", "control", "cp", "panel",
  "dashboard", "account", "accounts", "billing", "invoice", "invoices", "pay", "payments",
  "login", "signin", "signup", "register", "auth", "oauth", "sso", "id", "identity",
  "api", "app", "apps", "console", "manage", "portal", "my", "me",
  "status", "support", "help", "docs", "doc", "documentation", "blog", "news", "about",
  "contact", "legal", "privacy", "terms", "press", "careers", "jobs", "shop", "store",
  "download", "downloads", "community", "forum", "wiki",
  "augur", "engine", "site", "web", "hosted", "cloud", "platform",
  // environments, which are the names an operator reaches for in a hurry
  "test", "testing", "staging", "stage", "dev", "develop", "development", "demo",
  "preview", "sandbox", "beta", "alpha", "canary", "next", "old", "new", "tmp", "temp",
  // mailboxes that have to stay answerable
  "postmaster", "hostmaster", "webmaster", "abuse", "security", "noreply", "no-reply",
  "info", "hi", "hello", "sales", "marketing",
]);

/**
 * The shape a workspace label may have: a DNS label, lowercase, no leading or trailing
 * hyphen, at most 63 characters. Anchored at both ends, so a dot anywhere fails and a
 * deeper hostname can never be read as a workspace name.
 */
export const TENANT_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A Host header, reduced to the hostname a comparison can be made against.
 *
 * Three normalizations, each of which is a real request somebody sends:
 *   · a PORT — `acme.example.com:8787`, which every local run produces;
 *   · CASE — the header is case-insensitive and proxies do not agree on which one to send;
 *   · a TRAILING DOT — `acme.example.com.` is the fully-qualified form and is legal.
 *
 * A bracketed IPv6 literal is left alone: it has no labels to take, and the suffix test
 * below will not match it.
 */
export function normalizeHost(hostHeader) {
  let h = String(hostHeader == null ? "" : hostHeader).trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) return h.split("]")[0] + "]";     // [::1]:8787 -> [::1]
  h = h.split(":")[0];
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * The workspace this hostname names, or null.
 *
 * `suffix` is LITERAL and is compared with endsWith, which is the whole trick. A dotted
 * suffix (`.example.com`) puts workspaces on `<name>.example.com` and needs a wildcard
 * certificate; a hyphenated one (`-team.example.com`) keeps every workspace on a
 * first-level hostname, which a universal certificate already covers. Both are one string
 * in this function, and neither is special-cased.
 *
 * Returns null — never a guess — for: no suffix configured, a host that does not carry it,
 * the apex itself, a label of the wrong shape, a deeper hostname, and a reserved name.
 * The caller refuses the request; it does not fall back to a default workspace, because a
 * default on a multi-workspace deployment is somebody else's workspace.
 */
export function tenantLabelFromHost(hostHeader, suffix) {
  const s = String(suffix == null ? "" : suffix).trim().toLowerCase();
  if (!s) return null;
  const host = normalizeHost(hostHeader);
  if (!host || host.length <= s.length || !host.endsWith(s)) return null;
  const label = host.slice(0, -s.length);
  if (!TENANT_LABEL_RE.test(label)) return null;
  if (isReservedLabel(label)) return null;
  return label;
}

/** Whether a label is one the resolver must never resolve. Case-folded; nothing else. */
export function isReservedLabel(label) {
  const l = String(label == null ? "" : label).trim().toLowerCase();
  return l !== "" && RESERVED_LABELS.includes(l);
}
