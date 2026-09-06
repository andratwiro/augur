// installer-mac.mjs — the file `/__onboarding/installer/mac` hands back: a double-click
// `.command` that gets a person from "no terminal at all" to a connected agent, with no
// administrator password at any step.
//
// WHY A TARBALL AND NOT A VERSION MANAGER. The person this exists for has never run a
// coding agent — teaching them nvm/volta/asdf first is a second onboarding stacked in
// front of the one this flow already is. The official Node tarball, unpacked under
// `~/.augur/node`, needs nothing installed first and nothing admin: it is one `curl`,
// one `tar --strip-components=1`, and a `PATH` entry for this process only.
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
// WHY set -euo pipefail PLUS AN ERR TRAP. A double-clicked `.command` runs in its own
// Terminal window with nobody watching a shell prompt: `set -e` alone means an unguarded
// command failing (a `mkdir`, a `cd`, a disk full) ends the script and the window just
// sits there, or closes, with no sentence anyone read. Every risky step already calls
// `fail` explicitly for a specific sentence; the ERR trap is the catch-all behind that,
// so nothing this script does can fail silently. `fail` itself always prints, always
// waits for Return, and only then exits — a window that closes on its own is the one
// failure mode nothing here may produce.
export function macInstallerScript({ origin, agentTool }) {
  const host = new URL(origin).host;
  const NODE_LTS_FALLBACK = "v22.12.0"; // last known good LTS line; see file header
  return `#!/bin/bash
# Connect this Mac to ${host}. Double-click runs this in Terminal. Nothing needs an
# administrator password: everything goes under your home folder in ~/.augur.
set -euo pipefail
say() { printf '\\n\\033[1m%s\\033[0m\\n' "$1"; }
fail() { printf '\\n\\033[31m%s\\033[0m\\n' "$1"; printf 'Nothing outside ~/.augur was changed. Press Return to close.'; read -r; exit 1; }
trap 'fail "Something went wrong and setup stopped."' ERR
HOME_BIN="$HOME/.augur/node/bin"; mkdir -p "$HOME/.augur"
export PATH="$HOME_BIN:$HOME/.augur/npm/bin:$PATH"; export npm_config_prefix="$HOME/.augur/npm"

say "1/4  Node"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  echo "found $(node -v), using it"
else
  ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
  VER=$(curl -fsSL https://nodejs.org/dist/index.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s).find(x=>x.lts);console.log(l.version)})' 2>/dev/null || echo ${NODE_LTS_FALLBACK})
  echo "installing Node $VER for your account only"
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-darwin-$ARCH.tar.gz" -o "$HOME/.augur/node.tgz" || fail "could not download Node. Are you online?"
  rm -rf "$HOME/.augur/node"; mkdir -p "$HOME/.augur/node"; tar -xzf "$HOME/.augur/node.tgz" -C "$HOME/.augur/node" --strip-components=1; rm -f "$HOME/.augur/node.tgz"
  echo "Node $(node -v) ready"
fi

say "2/4  The agent (${agentTool.name})"
if command -v ${agentTool.bin} >/dev/null 2>&1; then echo "found ${agentTool.bin}, using it"; else ${agentTool.install} || fail "could not install ${agentTool.name}."; fi

say "3/4  Augur's command line"
npm install -g @augurworks/augur >/dev/null 2>&1 || fail "could not install @augurworks/augur."
echo "augur $(augur --version 2>/dev/null || echo ready)"

say "4/4  Connect to ${host}"
echo "A browser tab will open on the workspace. Type the code shown below into it."
augur connect --origin ${origin} --no-wait || fail "the workspace did not answer."
open "${origin}/__welcome" >/dev/null 2>&1 || true
augur connect --origin ${origin} || fail "the pairing was not approved in time. Run this file again for a fresh code."

mkdir -p "$HOME/Augur/${host}"; cd "$HOME/Augur/${host}"
say "Done. Your agent starts here, in ~/Augur/${host}. Ask it to open your page."
exec ${agentTool.bin}
`;
}
