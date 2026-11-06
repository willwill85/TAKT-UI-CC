'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Server, utils } = require('ssh2');
const { TunnelManager } = require('../lib/ssh-tunnels');
const platform = require('../lib/platform');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('Windows system OpenSSH carries a real HTTP request through the managed reverse tunnel and reconnects', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-ssh-fixture-'));
  const keys = utils.generateKeyPairSync('ed25519');
  const key = path.join(dir, 'identity'); fs.writeFileSync(key, keys.private, { mode: 0o600 });
  platform.protectSecret(key);
  const connections = []; let peer; const forwarded = new Set();
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    connections.push(client);
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      // The fixture accepts only its throwaway public key and is bound to loopback.
      const parsed = utils.parseKey(keys.private);
      if (ctx.method === 'publickey' && ctx.key.data.equals(parsed.getPublicSSH()) && (!ctx.signature || parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) ctx.accept(); else ctx.reject();
    });
    client.on('ready', () => { peer = client; });
    client.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward') { forwarded.add(info.bindPort); accept(); }
      else if (name === 'cancel-tcpip-forward') accept();
      else if (reject) reject();
    });
  });
  const local = http.createServer((_req, res) => { res.end('TAKT_REVERSE_MCP_OK'); });
  const manager = new TunnelManager(0, 0, (command, args, options) => spawn(command, ['-F', path.join(dir, 'config'), ...args], options));
  try {
    await new Promise((r) => local.listen(0, '127.0.0.1', r));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const localPort = local.address().port;
    manager.mcpPort = localPort; manager.edaPort = localPort + 1;
    fs.writeFileSync(path.join(dir, 'config'), `Host takt-fixture\n HostName 127.0.0.1\n Port ${server.address().port}\n User fixture\n IdentityFile "${key.replaceAll('\\', '/')}"\n StrictHostKeyChecking no\n UserKnownHostsFile NUL\n IdentitiesOnly yes\n`);
    const node = { id: 'fixture', sshHost: 'takt-fixture', enabled: true };
    const entry = manager.ensure(node);
    for (let i = 0; i < 80 && !forwarded.has(localPort); i++) { if (entry.failed) throw Error(entry.error); await delay(100); }
    assert(forwarded.has(localPort), 'OpenSSH 应成功注册反向转发');
    const body = await new Promise((resolve, reject) => peer.forwardOut('127.0.0.1', localPort, '127.0.0.1', 1234, (err, stream) => {
      if (err) return reject(err);
      const timer = setTimeout(() => { stream.destroy(); reject(Error('反向 HTTP 响应超时')); }, 3000);
      let response = ''; stream.on('data', (d) => { response += d; }); stream.on('error', (e) => { clearTimeout(timer); reject(e); }); stream.on('end', () => { clearTimeout(timer); stream.end(); resolve(response); });
      stream.write(`GET /mcp-test HTTP/1.1\r\nHost: 127.0.0.1:${localPort}\r\nConnection: close\r\n\r\n`);
    }));
    assert(body.includes('TAKT_REVERSE_MCP_OK'));
    peer.end();
    for (let i = 0; i < 40 && !entry.failed; i++) await delay(50);
    assert(entry.failed);
    forwarded.clear(); const reconnect = manager.ensure(node);
    assert.notEqual(reconnect.child.pid, entry.child.pid);
    for (let i = 0; i < 80 && !forwarded.has(localPort); i++) { if (reconnect.failed) throw Error(reconnect.error); await delay(100); }
    assert(forwarded.has(localPort), '隧道断开后应重新连接');
    manager.stopAll(); assert.equal(manager.tunnels.size, 0);
  } finally {
    manager.stopAll(); for (const client of connections) { client.end(); client._sock.destroy(); }
    local.closeAllConnections();
    await new Promise((r) => server.close(r)); await new Promise((r) => local.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
