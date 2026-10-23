#!/usr/bin/env bash
# Starts the local MCP server and the web workbench in the background (idempotent).
set -uo pipefail
. "$(dirname "$0")/_common.sh"

NODE_BIN="$(find_node)" || { fail "Node.js >= 22.13 not found"; exit 1; }
[ -d "$REPO_ROOT/node_modules/node-pty" ] || { fail "Dependencies missing. Run: bash scripts/install.sh"; exit 1; }

start_one() { # name  port  script  args...
  local name="$1" port="$2" script="$3"; shift 3
  if port_listening "$port"; then
    ok "$name already running (:$port)"
    return
  fi
  # Fully detach into a new session so closing the terminal (SIGHUP) never kills the services.
  nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$NODE_BIN" "$script" "$@" </dev/null >"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    if port_listening "$port"; then ok "$name started (:$port, pid $(cat "$RUN_DIR/$name.pid"))"; return; fi
  done
  fail "$name did not come up — see $LOG_DIR/$name.log"
}

c_green "== Starting TAKT-UI-CC =="
start_one mcp-server "$TAKT_MCP_PORT" "$REPO_ROOT/mcp-server/server.js" --http
start_one workbench  "$TAKT_PORT"     "$REPO_ROOT/server/server.js"

# Syncthing is optional; start it if installed via Homebrew and not already running.
if command -v brew >/dev/null 2>&1 && brew list syncthing >/dev/null 2>&1; then
  brew services start syncthing >/dev/null 2>&1 && ok "syncthing service running" || true
fi

echo
echo "UI:  http://127.0.0.1:$TAKT_PORT"
echo "Log: $LOG_DIR"
