#!/usr/bin/env bash
# One-shot installer: checks prerequisites, installs npm dependencies, creates the data directory.
set -euo pipefail
. "$(dirname "$0")/_common.sh"

c_green "== TAKT-UI-CC installer =="

NODE_BIN="$(find_node)" || { fail "Node.js >= 22.13 not found. Install it (macOS: brew install node) and retry."; exit 1; }
ok "Node.js $("$NODE_BIN" -v) ($NODE_BIN)"

command -v npm >/dev/null || { fail "npm not found"; exit 1; }
command -v ssh >/dev/null || { fail "ssh not found"; exit 1; }
ok "ssh: $(command -v ssh)"

cd "$REPO_ROOT"
echo "Installing npm dependencies (node-pty needs a prebuilt binary or Xcode command line tools)…"
npm install --no-audit --no-fund
ok "npm dependencies installed"

"$NODE_BIN" -e "const p=require('node-pty');const t=p.spawn('/bin/echo',['ok'],{});t.onExit(()=>process.exit(0));" \
  && ok "node-pty can spawn a pseudo-terminal" \
  || { fail "node-pty cannot spawn. Run: npm rebuild node-pty (needs Xcode CLT: xcode-select --install)"; exit 1; }

mkdir -p "$TAKT_HOME/work"
ok "data directory: $TAKT_HOME"

if command -v syncthing >/dev/null; then ok "syncthing found (optional, used for file sync)"; else warn "syncthing not found (optional). macOS: brew install syncthing"; fi

echo
c_green "Done. Next steps:"
echo "  1. Make sure you can 'ssh <your-host>' without a password prompt (key auth, entry in ~/.ssh/config)."
echo "  2. Start everything:    npm run start:all      (or: bash scripts/start.sh)"
echo "  3. Open the UI:         http://127.0.0.1:$TAKT_PORT   (or build the macOS app: bash scripts/build-app.sh)"
echo "  4. Click “节点” (Nodes) in the top-left and bind your first Linux host."
echo "  Health check any time:  npm run doctor"
