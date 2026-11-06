'use strict';
const { spawn } = require('node:child_process');
const platform = require('./platform');
const { tunnelArgs } = require('./ssh');

// Windows OpenSSH has no ControlMaster sockets. One foreground child owns each tunnel.
class TunnelManager {
  constructor(mcpPort, edaPort, launch = spawn) { this.mcpPort = mcpPort; this.edaPort = edaPort; this.launch = launch; this.tunnels = new Map(); }
  ensure(node, restart = false) {
    const old = this.tunnels.get(node.id);
    if (old && old.host === node.sshHost && old.child.exitCode === null && !old.failed && !restart) return old;
    this.stop(node.id);
    const child = this.launch(platform.ssh, tunnelArgs(node, this.mcpPort, this.edaPort), {
      env: platform.childEnv(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const entry = { child, host: node.sshHost, failed: false, error: '' };
    this.tunnels.set(node.id, entry);
    child.stderr.on('data', (data) => { entry.error = (entry.error + data).slice(-2000); });
    child.on('error', (err) => { entry.failed = true; entry.error = err.message; });
    child.on('close', () => { entry.failed = true; });
    return entry;
  }
  reconcile(nodes) {
    for (const id of this.tunnels.keys()) if (!nodes.some((n) => n.id === id && n.enabled && n.sshHost)) this.stop(id);
  }
  stop(id) {
    const entry = this.tunnels.get(id);
    if (entry) { this.tunnels.delete(id); try { entry.child.kill(); } catch {} }
  }
  stopAll() { for (const id of this.tunnels.keys()) this.stop(id); }
}
module.exports = { TunnelManager };
