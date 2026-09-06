#!/usr/bin/env bash
#
# One command, start to finish. Run:  bash install.sh
#
# Builds the extension, runs the render smoke test, packages a .vsix, and
# installs it into VS Code. Stops at the first failure with a readable reason
# rather than leaving a half-installed extension behind.

set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ok  %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31m!!  %s\033[0m\n\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "node is not installed."
command -v npm  >/dev/null || die "npm is not installed."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18 or newer is needed. Found $(node -v)."
ok "node $(node -v)"

say "Installing dependencies"
npm install --no-audit --no-fund --silent
ok "dependencies installed"

say "Vendoring three.js into media/"
npm run --silent vendor
[ -f media/three.min.js ] || die "media/three.min.js was not created."

say "Compiling TypeScript"
npm run --silent compile
[ -f out/extension.js ] || die "out/extension.js was not created."
ok "compiled"

say "Running the render smoke test"
# Loads the real renderer in a headless DOM with a stubbed GL context, drives
# frames until the network commits a decision, and exercises every message the
# extension can send. A black panel fails here instead of in your editor.
if npm run --silent test > /tmp/ig-test.log 2>&1; then
  grep -E '^(layers shown|decision posted|activation keys|SMOKE)' /tmp/ig-test.log | sed 's/^/    /'
  ok "renderer runs clean"
else
  tail -30 /tmp/ig-test.log
  die "The smoke test failed. Full log: /tmp/ig-test.log"
fi

say "Packaging the .vsix"
rm -f ./*.vsix
npx --yes @vscode/vsce@3.9.2 package --allow-missing-repository >/tmp/ig-pack.log 2>&1 \
  || { tail -20 /tmp/ig-pack.log; die "Packaging failed. Full log: /tmp/ig-pack.log"; }
VSIX="$(ls -1 ./*.vsix | head -1)"
[ -n "$VSIX" ] || die "No .vsix was produced."
ok "$(basename "$VSIX")  ($(du -h "$VSIX" | cut -f1))"

if command -v code >/dev/null; then
  say "Installing into VS Code"
  code --uninstall-extension kanak.inference-graph >/dev/null 2>&1 || true
  code --install-extension "$VSIX" --force
  ok "installed"
  printf '\n\033[1;32mDone.\033[0m Restart VS Code, then open:\n'
  printf '    %s/examples/policy-net.netgraph.json\n\n' "$(pwd)"
else
  printf '\n\033[1;33mVS Code CLI not found.\033[0m Install by hand:\n'
  printf '    code --install-extension %s\n' "$VSIX"
  printf '  or in VS Code: Extensions panel, "..." menu, Install from VSIX.\n\n'
fi
