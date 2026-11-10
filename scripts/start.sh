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

# Syncthing is optional. Prefer the platform service manager, then fall back to a
# detached process (needed by minimal Linux and WSL2 installations).
if command -v syncthing >/dev/null 2>&1; then
  if http_ok "http://127.0.0.1:8384/rest/noauth/health"; then
    ok "syncthing already running"
  else
    started=0
    if command -v brew >/dev/null 2>&1 && brew list syncthing >/dev/null 2>&1; then
      brew services start syncthing >/dev/null 2>&1 && started=1
    elif command -v systemctl >/dev/null 2>&1; then
      systemctl --user start syncthing.service >/dev/null 2>&1 && started=1
    fi
    if [ "$started" -eq 0 ]; then
      nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' \
        "$(command -v syncthing)" serve --no-browser --logflags=0 \
        </dev/null >"$LOG_DIR/syncthing.log" 2>&1 &
      echo $! >"$RUN_DIR/syncthing.pid"
    fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      http_ok "http://127.0.0.1:8384/rest/noauth/health" && break
      sleep 0.5
    done
    http_ok "http://127.0.0.1:8384/rest/noauth/health" \
      && ok "syncthing started" \
      || warn "syncthing is installed but did not start (file sync remains optional)"
  fi
fi

echo
echo "UI:  http://127.0.0.1:$TAKT_PORT"
echo "Log: $LOG_DIR"
