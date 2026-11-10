#!/usr/bin/env bash
# One-shot installer: checks prerequisites, installs npm dependencies, creates the data directory.
set -euo pipefail
. "$(dirname "$0")/_common.sh"

c_green "== TAKT-UI-CC installer =="

NODE_BIN="$(find_node)" || { fail "Node.js >= 22.13 not found. Install it (macOS: brew; Linux/WSL2: your package manager or nvm) and retry."; exit 1; }
ok "Node.js $("$NODE_BIN" -v) ($NODE_BIN)"

command -v npm >/dev/null || { fail "npm not found"; exit 1; }
command -v ssh >/dev/null || { fail "ssh not found"; exit 1; }
ok "ssh: $(command -v ssh)"
for tool in curl lsof perl; do
  command -v "$tool" >/dev/null || { fail "$tool not found"; exit 1; }
done
ok "curl, lsof and perl found"

cd "$REPO_ROOT"
echo "Installing npm dependencies (node-pty needs a prebuilt binary or native build tools)…"
npm install --no-audit --no-fund
ok "npm dependencies installed"

"$NODE_BIN" -e "const p=require('node-pty');const t=p.spawn('/bin/echo',['ok'],{});t.onExit(()=>process.exit(0));" \
  && ok "node-pty can spawn a pseudo-terminal" \
  || { fail "node-pty cannot spawn. Run: npm rebuild node-pty (macOS: Xcode CLT; Linux/WSL2: build-essential + python3)"; exit 1; }

mkdir -p "$TAKT_HOME/work"
ok "data directory: $TAKT_HOME"

if command -v syncthing >/dev/null; then ok "syncthing found (optional, used for file sync)"; else warn "syncthing not found (optional). Install it with brew, apt, dnf or pacman."; fi

echo
c_green "Done. Next steps:"
echo "  1. Make sure you can 'ssh <your-host>' without a password prompt (key auth, entry in ~/.ssh/config)."
echo "  2. Start everything:    npm run start:all      (or: bash scripts/start.sh)"
echo "  3. Open the UI:         http://127.0.0.1:$TAKT_PORT   (or build the macOS app: bash scripts/build-app.sh)"
echo "  4. Click “节点” (Nodes) in the top-left and bind your first Linux host."
echo "  Health check any time:  npm run doctor"
