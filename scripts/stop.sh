#!/usr/bin/env bash
# Stops the web workbench and the local MCP server. Remote tmux sessions keep running.
. "$(dirname "$0")/_common.sh"

stop_one() { # name port
  local name="$1" port="$2" pids
  if [ -f "$RUN_DIR/$name.pid" ]; then kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null; rm -f "$RUN_DIR/$name.pid"; fi
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN -n -P 2>/dev/null)"
  [ -n "$pids" ] && kill $pids 2>/dev/null
  sleep 0.3
  port_listening "$port" && fail "$name (:$port) still listening" || ok "$name stopped"
}

stop_one workbench  "$TAKT_PORT"
stop_one mcp-server "$TAKT_MCP_PORT"

# Tear down the MCP reverse tunnels of the nodes configured in THIS $TAKT_HOME only
# (interactive terminals are separate ssh processes and are not touched).
NODE_BIN="$(find_node)" || exit 0
[ -f "$TAKT_HOME/nodes.json" ] || exit 0
"$NODE_BIN" -e '
const n = (require(process.argv[1]).nodes || []).filter((x) => x.sshHost);
for (const x of n) console.log(x.id.replace(/[^a-zA-Z0-9_-]/g, "") + "\t" + x.sshHost);
' "$TAKT_HOME/nodes.json" | while IFS=$'\t' read -r id host; do
  sock="$HOME/.ssh/sockets/takt-mcp-tunnel-$id.sock"
  [ -S "$sock" ] && ssh -S "$sock" -O exit "$host" >/dev/null 2>&1 && ok "closed tunnel for $host"
done
exit 0
