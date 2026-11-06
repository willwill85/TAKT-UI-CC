'use strict';
function shQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function sessionName(tabId) { return 'takt_' + (String(tabId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || 'main'); }
function remoteSessionCommand(tabId, cwd) {
  const session = shQuote(sessionName(tabId));
  return `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"; CWD=${shQuote(cwd)}; ` +
    'if ! mkdir -p "$CWD" 2>/dev/null || ! cd "$CWD" 2>/dev/null; then CWD="$HOME/work"; mkdir -p "$CWD"; cd "$CWD" || exit 1; fi; ' +
    `if command -v tmux >/dev/null 2>&1; then tmux has-session -t ${session} 2>/dev/null || tmux new-session -d -s ${session} -c "$CWD" 'bash -l'; ` +
    `tmux set-option -t ${session} status off; tmux set-option -t ${session} mouse on; exec tmux attach-session -t ${session}; else exec bash -l; fi`;
}
function interactiveArgs(tabId, cwd, host) {
  if (!host || host.startsWith('-') || /[\r\n\0]/.test(host)) throw new Error('无效 SSH 主机');
  return ['-tt', '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=6', '-o', 'ConnectTimeout=8', host, remoteSessionCommand(tabId, cwd)];
}
function tunnelArgs(node, mcpPort, edaPort) {
  if (!node.sshHost || node.sshHost.startsWith('-') || /[\r\n\0]/.test(node.sshHost)) throw new Error('无效 SSH 主机');
  return ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-R', `127.0.0.1:${mcpPort}:127.0.0.1:${mcpPort}`, '-R', `127.0.0.1:${edaPort}:127.0.0.1:${edaPort}`, node.sshHost];
}
module.exports = { shQuote, sessionName, remoteSessionCommand, interactiveArgs, tunnelArgs };
