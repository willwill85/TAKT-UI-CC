#!/usr/bin/env bash
# Hermetic smoke test: fresh data dir, separate ports, no network, no real servers.
# Verifies that both servers start and that the security guards behave.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

export TAKT_HOME="$(mktemp -d)"
export TAKT_PORT="${SMOKE_PORT:-3290}" TAKT_MCP_PORT="${SMOKE_MCP_PORT:-18990}" TAKT_EDA_PORT="${SMOKE_EDA_PORT:-49890}"
UI="http://127.0.0.1:$TAKT_PORT"; MCP="http://127.0.0.1:$TAKT_MCP_PORT"
FAILS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILS=$((FAILS+1)); }
expect() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else bad "$1 (expected $2, got $3)"; fi
}
cleanup() { bash "$HERE/stop.sh" >/dev/null 2>&1; rm -rf "$TAKT_HOME"; }
trap cleanup EXIT

echo "== smoke test (data: $TAKT_HOME, ports: $TAKT_PORT/$TAKT_MCP_PORT) =="
bash "$HERE/start.sh" >/dev/null 2>&1
sleep 2

expect "UI serves index.html"            200 "$(curl -s -o /dev/null -w '%{http_code}' "$UI/")"
expect "vendored xterm.js served"        200 "$(curl -s -o /dev/null -w '%{http_code}' "$UI/vendor/xterm.js")"
expect "path traversal blocked"          404 "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$UI/vendor/../../config.js")"
expect "MCP /health"                     200 "$(curl -s -o /dev/null -w '%{http_code}' "$MCP/health")"

TREE="$(curl -s "$UI/api/tree")"
expect "fresh install has one node"      1 "$(printf '%s' "$TREE" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["nodes"]))' 2>/dev/null)"

expect "foreign Host rejected (UI)"      403 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "$UI/api/tree")"
expect "foreign Origin POST rejected"    403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example.com' -H 'Content-Type: text/plain' -d '{"name":"x"}' "$UI/api/tags")"
expect "same-origin POST accepted"       200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $UI" -H 'Content-Type: application/json' -d '{"name":"smoke","color":"blue"}' "$UI/api/tags")"

TOKEN="$(cat "$TAKT_HOME/mcp-token" 2>/dev/null)"
RPC='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
expect "MCP /mcp without token -> 401"   401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$RPC" "$MCP/mcp")"
expect "MCP /mcp wrong token -> 401"     401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d "$RPC" "$MCP/mcp")"
expect "MCP /mcp with token -> 200"      200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$RPC" "$MCP/mcp")"
expect "MCP foreign Host rejected"       403 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "$MCP/health")"
expect "MCP foreign Origin rejected"     403 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example.com' "$MCP/health")"

BIND="$(lsof -iTCP:"$TAKT_MCP_PORT" -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR==2{print $9}')"
case "$BIND" in 127.0.0.1:*) pass "MCP bound to loopback ($BIND)";; *) bad "MCP bound to '$BIND'";; esac
[ "$(stat -f '%Lp' "$TAKT_HOME/mcp-token" 2>/dev/null || stat -c '%a' "$TAKT_HOME/mcp-token")" = "600" ] && pass "token file mode 600" || bad "token file mode"

echo
if [ "$FAILS" -eq 0 ]; then printf '\033[32mAll smoke tests passed.\033[0m\n'; else printf '\033[31m%s test(s) failed.\033[0m\n' "$FAILS"; fi
exit "$FAILS"
