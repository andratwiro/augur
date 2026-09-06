// installer-mac.mjs — what `/__onboarding/installer/mac` hands back: a `.command` that
// gets a person from "no terminal at all" to a connected agent, with no administrator
// password at any step.
//
// ⚠️ IT IS SERVED INSIDE A ZIP, AND THAT IS NOT PACKAGING FUSS. HTTP carries no file mode,
// so a `.command` downloaded directly lands on the disk 0644 and Terminal refuses to run
// it — the one failure this file cannot talk anybody out of, because the person it is
// written for has no terminal to `chmod` from. A ZIP entry carries the mode; `src/zip-
// store.mjs` writes one entry at 0755, and unpacking it (a double-click in Finder, or
// `unzip`) leaves an executable `connect-<host>.command` beside the archive. That is what
// the person opens — see `installerFileNames`, which is the ONE place those two names are
// built, so the page's instructions and the download's headers cannot drift apart.
//
// WHY A TARBALL AND NOT A VERSION MANAGER. The person this exists for has never run a
// coding agent — teaching them nvm/volta/asdf first is a second onboarding stacked in
// front of the one this flow already is. The official Node tarball, unpacked under
// `~/.augur/node`, needs nothing installed first and nothing admin: it is one `curl`,
// one `tar --strip-components=1`, and a `PATH` entry.
//
// WHY THE VERSION LOOKUP HAS A FALLBACK CONSTANT. `nodejs.org/dist/index.json` names the
// current LTS line, and that answer is the one to trust — it moves forward on its own so
// this file does not need editing every time Node ships a new LTS. NODE_LTS_FALLBACK is
// only what runs if that lookup itself fails (no network yet, a captive portal, the
// endpoint briefly down): a LAST KNOWN GOOD line, not a ceiling, and it is deliberately
// still recent enough that `command -v node` skips the whole step for most people. Bump
// it by hand when it starts looking stale; nothing breaks by leaving it be, because the
// index lookup is the path that runs whenever it can.
//
// WHY THE AGENT TOOL IS A PARAMETER. `agentTool` is `AGENT_TOOL` from ./agent-tool.mjs —
// the engine's one named third-party tool — threaded in rather than imported here so this
// module says nothing on its own about which tool that is. Every mention in the script
// body below reads `agentTool.name` / `.install` / `.bin`; grep this file for a literal
// tool name and find none.
//
// WHY set -euo pipefail PLUS AN ERR TRAP. A `.command` opened from Finder runs in its own
// Terminal window with nobody watching a shell prompt: `set -e` alone means an unguarded
// command failing (a `mkdir`, a `cd`, a disk full) ends the script and the window just
// sits there, or closes, with no sentence anyone read. Every risky step already calls
// `fail` explicitly for a specific sentence; the ERR trap is the catch-all behind that,
// so nothing this script does can fail silently. `fail` itself always prints, always
// waits for Return, and only then exits — a window that closes on its own is the one
// failure mode nothing here may produce.
//
// ⚠️ EVERY `fail` SENTENCE SAYS WHAT TO DO NEXT, and that is a rule rather than a style.
// The reader of these lines is by definition somebody with no terminal, no colleague at
// the next desk and no idea which of the four steps they were on. "could not install X"
// leaves them with nowhere to go; "check you are online and run this file again" is a
// next move they can make alone. A new `fail` with no remedy in it is a regression, and
// `test/installer-mac.test.mjs` fails on one.
//
// ⚠️ NOTHING MAY RUN OUTSIDE THE TRAP'S REACH. `exec` replaces the shell, so a bare
// `exec <bin>` with the binary missing dies with the shell's own "command not found" and
// no sentence at all — the trap is gone by then. The `command -v` guard immediately
// before it is what keeps the last step inside the same contract as every other one.
export function macInstallerScript({ origin, agentTool }) {
  const host = new URL(origin).host;
  const NODE_LTS_FALLBACK = "v22.12.0"; // last known good LTS line; see file header
  return `#!/bin/bash
# Connect this Mac to ${host}. Open this file and it runs in Terminal. Nothing needs an
# administrator password: everything goes under your home folder.
set -euo pipefail
say() { printf '\\n\\033[1m%s\\033[0m\\n' "$1"; }
fail() { printf '\\n\\033[31m%s\\033[0m\\n' "$1"; printf 'Nothing outside your home folder was changed. Press Return to close.'; read -r; exit 1; }
trap 'fail "Setup stopped before it finished. Run this file again; if it stops in the same place twice, send the person who invited you the last few lines above."' ERR
HOME_BIN="$HOME/.augur/node/bin"; mkdir -p "$HOME/.augur"
export PATH="$HOME_BIN:$HOME/.augur/npm/bin:$PATH"; export npm_config_prefix="$HOME/.augur/npm"

say "1/4  Node"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); fi
case "\${NODE_MAJOR:-0}" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
if [ "\${NODE_MAJOR:-0}" -ge 20 ]; then
  echo "found $(node -v), using it"
else
  ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
  VER=$(curl -fsSL https://nodejs.org/dist/index.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s).find(x=>x.lts);console.log(l.version)})' 2>/dev/null || echo ${NODE_LTS_FALLBACK})
  echo "installing Node $VER for your account only"
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-darwin-$ARCH.tar.gz" -o "$HOME/.augur/node.tgz" || fail "could not download Node — check you are online and run this file again."
  rm -rf "$HOME/.augur/node"; mkdir -p "$HOME/.augur/node"
  tar -xzf "$HOME/.augur/node.tgz" -C "$HOME/.augur/node" --strip-components=1 || fail "the download was damaged — run this file again."
  rm -f "$HOME/.augur/node.tgz"
  echo "Node $(node -v) ready"
fi

say "2/4  The agent (${agentTool.name})"
if command -v ${agentTool.bin} >/dev/null 2>&1; then echo "found ${agentTool.bin}, using it"; else ${agentTool.install} || fail "could not install ${agentTool.name} — check you are online and run this file again. The lines just above are what the installer said went wrong."; fi

say "3/4  Augur's command line"
npm install -g @augurworks/augur || fail "could not install Augur's command line — check you are online and run this file again. The lines just above are what the installer said went wrong."
command -v augur >/dev/null 2>&1 || fail "Augur's command line installed but this Terminal cannot find it — close this window, open a new one, and run this file again."

say "4/4  Connect to ${host}"
echo "A browser tab will open on the workspace. Type the code shown below into it."
augur connect --origin ${origin} --no-wait || fail "the workspace did not answer — check you are online and run this file again. If it keeps happening, ask the person who invited you for a fresh link."
open "${origin}/__welcome" >/dev/null 2>&1 || true
augur connect --origin ${origin} || fail "the pairing was not approved in time — run this file again for a fresh code, and type that code into the page that opens."

# Keep the tools findable in Terminal windows opened later. One guarded line, appended
# once: this script's own PATH export lives only in this process, so without it the person
# gets a working agent today and "command not found" tomorrow.
PROFILE="$HOME/.zprofile"
PATH_LINE='export PATH="$HOME/.augur/node/bin:$HOME/.augur/npm/bin:$PATH"  # added by Augur'
if ! grep -qF "$PATH_LINE" "$PROFILE" 2>/dev/null; then
  printf '%s\\n' "$PATH_LINE" >> "$PROFILE" || fail "could not write to ~/.zprofile — everything else is installed, so open Terminal and type ${agentTool.bin} to start."
  echo "added these tools to your PATH in ~/.zprofile, so new Terminal windows find them too"
fi

mkdir -p "$HOME/Augur/${host}"; cd "$HOME/Augur/${host}"
say "Done. Your agent starts here, in ~/Augur/${host}. Ask it to open your page."
command -v ${agentTool.bin} >/dev/null 2>&1 || fail "${agentTool.name} is installed but this Terminal cannot find it — close this window, open a new one, and type ${agentTool.bin} to start."
exec ${agentTool.bin}
`;
}

/**
 * The two names the download wears, built from the workspace's host.
 *
 * ONE definition, because the page tells the person which file to open and the route
 * names the same file in `Content-Disposition` and inside the archive: three copies of
 * one string, and a drift between them is an instruction to open a file that is not
 * there. The `:` of a `host:port` becomes `-` rather than being dropped, so
 * `localhost:8788` reads as `localhost-8788` instead of collapsing into `localhost8788`.
 *
 * @param {string} host  a URL host, with or without a port.
 * @returns {{command: string, zip: string}}
 */
export function installerFileNames(host) {
  const safe = String(host || "").replace(/:/g, "-").replace(/[^a-z0-9.-]/gi, "");
  return { command: `connect-${safe}.command`, zip: `connect-${safe}.zip` };
}
