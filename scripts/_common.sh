#!/usr/bin/env bash
# Shared helpers for TAKT-UI-CC scripts. Source this file; do not execute it.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TAKT_HOME="${TAKT_HOME:-$HOME/.takt-ai}"
export TAKT_PORT="${TAKT_PORT:-3080}"
export TAKT_MCP_PORT="${TAKT_MCP_PORT:-18765}"
LOG_DIR="$TAKT_HOME/logs"
RUN_DIR="$TAKT_HOME/run"
mkdir -p "$LOG_DIR" "$RUN_DIR" "$HOME/.ssh/sockets"

# Optional per-user overrides (KEY=value lines), e.g. TAKT_PORT=3090
[ -f "$TAKT_HOME/env" ] && set -a && . "$TAKT_HOME/env" && set +a

c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$*"; }

# Find a Node.js >= 22.13 (needed for the built-in node:sqlite module).
find_node() {
  local cand
  for cand in "${TAKT_NODE:-}" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    if "$cand" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

port_listening() { lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; }

http_ok() { curl -fsS -m 2 "$1" >/dev/null 2>&1; }
