// scripts/lib/cli-args.mjs — the two things every verb's argv has in common.
//
// `--origin <url>` is how the front door teaches `connect`, and an agent that paired with
// `connect --origin X` carries the flag onto the next verb it types: `ls --origin X`,
// `open --origin X …`. Until the router lifted it out, only `connect` read the flag; every
// other verb left it in argv, where a positional scan took the URL for a prototype name
// (`ls --origin https://…` answered `no opportunity "https://…" here`) and the origin fell
// back to whatever was paired last. The router takes the flag here and hands the verb
// AUGUR_ORIGIN instead, which every verb already honours.

/** Lift `--origin <url>` / `--origin=<url>` out of `args`. Returns { rest, origin, error }. */
export function takeOrigin(args) {
  const rest = [];
  let origin = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--origin") {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) return { rest: args, origin: "", error: "--origin needs a URL, e.g. --origin https://your.site" };
      origin = v; i++; continue;
    }
    if (a.startsWith("--origin=")) { origin = a.slice("--origin=".length); if (!origin) return { rest: args, origin: "", error: "--origin needs a URL, e.g. --origin=https://your.site" }; continue; }
    rest.push(a);
  }
  return { rest, origin: origin.replace(/\/+$/, ""), error: null };
}

/**
 * The one sentence for a shell whose folder is gone. `augur close` removes the draft folder
 * it is run in, so the very next command from that shell starts in a directory that no
 * longer exists, and Node's `process.cwd()` throws ENOENT before any verb has run a line.
 * A stack trace there reads as a broken tool; the situation is a `cd ..`.
 */
export function cwdGone() {
  try { process.cwd(); return null; } catch (e) {
    return "the folder this shell is in no longer exists (a draft folder was closed here, most likely). `cd ..` and run the command again.";
  }
}

/**
 * The positional arguments, skipping only the values of flags that take one. A bare flag
 * (`--new`) takes nothing, so the word after it is a positional: `augur open --new a/b`
 * and `augur open a/b --new` are the same command. Treating every flag as one that takes
 * a value read `--new a/b` as a flag and its value, and refused with "name a prototype"
 * while the docs taught exactly that order.
 */
export function positionals(args, valueFlags = []) {
  const takes = new Set(valueFlags);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) { if (takes.has(a) && !a.includes("=")) i++; continue; }
    out.push(a);
  }
  return out;
}
