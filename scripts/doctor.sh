#!/usr/bin/env bash
# Diagnoses the local install and every configured Linux node. Read-only.
. "$(dirname "$0")/_common.sh"

c_green "== TAKT-UI-CC doctor =="
echo "repo: $REPO_ROOT"
echo "data: $TAKT_HOME   ports: ui=$TAKT_PORT mcp=$TAKT_MCP_PORT"
echo
echo "Local machine"
NODE_BIN="$(find_node)" && ok "Node.js $("$NODE_BIN" -v)" || fail "Node.js >= 22.13 missing"
[ -d "$REPO_ROOT/node_modules/node-pty" ] && ok "npm dependencies installed" || fail "run scripts/install.sh"
command -v ssh >/dev/null && ok "ssh" || fail "ssh missing"
command -v syncthing >/dev/null && ok "syncthing installed" || warn "syncthing not installed (optional)"
[ -f "$TAKT_HOME/mcp-token" ] && ok "MCP token present" || warn "MCP token not generated yet (created on first start)"
port_listening "$TAKT_PORT"     && ok "workbench listening on :$TAKT_PORT"   || warn "workbench not running (bash scripts/start.sh)"
port_listening "$TAKT_MCP_PORT" && ok "MCP server listening on :$TAKT_MCP_PORT" || warn "MCP server not running"
if [ -n "${NODE_BIN:-}" ] && port_listening "$TAKT_MCP_PORT"; then
  bind="$(lsof -iTCP:"$TAKT_MCP_PORT" -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR==2{print $9}')"
  case "$bind" in 127.0.0.1:*|localhost:*) ok "MCP bound to loopback only ($bind)";; *) fail "MCP is bound to $bind — it should be 127.0.0.1 only!";; esac
fi

echo
echo "Nodes ($TAKT_HOME/nodes.json)"
if [ ! -f "$TAKT_HOME/nodes.json" ]; then
  warn "no nodes configured yet — open the UI and click “节点”"
  exit 0
fi
[ -n "${NODE_BIN:-}" ] || exit 0
"$NODE_BIN" -e '
const n=require(process.argv[1]).nodes||[];
for (const x of n) console.log([x.id,x.sshHost||"-",x.remoteWorkDir||"-",x.localWorkDir||"-",x.enabled?"1":"0"].join("\t"));
' "$TAKT_HOME/nodes.json" | while IFS=$'\t' read -r id host rdir ldir enabled; do
  echo "• $id  (ssh: $host, remote: $rdir, local: $ldir, enabled: $enabled)"
  [ -d "$ldir" ] && ok "local folder exists" || warn "local folder missing: $ldir"
  [ "$host" = "-" ] && { warn "no SSH host bound"; continue; }
  if ! out="$(ssh -o BatchMode=yes -o ConnectTimeout=6 "$host" 'echo up; for b in tmux python3 claude syncthing; do command -v $b >/dev/null 2>&1 && echo "has:$b" || echo "no:$b"; done; curl -fsS -m 2 http://127.0.0.1:'"$TAKT_MCP_PORT"'/health >/dev/null 2>&1 && echo "mcp:ok" || echo "mcp:down"' 2>&1)"; then
    fail "ssh $host failed: $(echo "$out" | tail -1)"; continue
  fi
  ok "ssh reachable"
  for b in tmux python3 claude; do
    echo "$out" | grep -q "has:$b" && ok "remote has $b" || { [ "$b" = claude ] && warn "remote has no 'claude' CLI in PATH" || fail "remote is missing $b"; }
  done
  echo "$out" | grep -q "has:syncthing" && ok "remote has syncthing" || warn "remote has no syncthing (file sync disabled for this node)"
  echo "$out" | grep -q "mcp:ok" && ok "MCP reverse tunnel works (remote can reach :$TAKT_MCP_PORT)" || warn "MCP tunnel not up yet (the watchdog builds it within ~10s of a node being enabled)"
done
