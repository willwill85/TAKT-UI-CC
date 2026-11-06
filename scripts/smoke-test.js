'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-smoke-'));
const children = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function main() {
  const uiPort = await freePort(), mcpPort = await freePort(), edaPort = await freePort();
  const ui = `http://127.0.0.1:${uiPort}`, mcp = `http://127.0.0.1:${mcpPort}`;
  const env = { ...process.env, TAKT_HOME: home, TAKT_PORT: String(uiPort), TAKT_MCP_PORT: String(mcpPort), TAKT_EDA_PORT: String(edaPort), TAKT_MANAGED_SERVICES: '1', TAKT_REQUIRE_MCP_TOKEN: '0' };
  for (const [script, args] of [['mcp-server/server.js', ['--http']], ['server/server.js', []]]) {
    const child = spawn(process.execPath, [path.join(root, script), ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', (d) => { errors += d; }); child.stdout.resume();
    child.on('error', (err) => { errors += err.message; }); child.testErrors = () => errors; children.push(child);
  }
  async function request(base, endpoint, body, headers = {}, method) {
    if (headers.Host) return new Promise((resolve, reject) => {
      const req = require('node:http').request(base + endpoint, { headers, timeout: 3000 }, (res) => { res.resume(); resolve({ status: res.statusCode, ok: res.statusCode < 400 }); });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP timeout'))); req.end();
    });
    return fetch(base + endpoint, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  }
  for (let i = 0; i < 80; i++) {
    try { if ((await request(ui, '/api/health')).ok && (await request(mcp, '/health')).ok) break; } catch {}
    if (i === 79) throw Error(children.map((c) => c.testErrors()).join('\n'));
    await delay(200);
  }
  assert.equal((await request(ui, '/')).status, 200);
  assert.equal((await request(ui, '/vendor/xterm.js')).status, 200);
  assert.equal((await request(ui, '/api/tree', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await request(ui, '/api/tags', { name: 'blocked' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(ui, '/api/shutdown', {})).status, 401);
  const tree = await (await request(ui, '/api/tree')).json(); assert.equal(tree.nodes.length, 1);
  assert.equal((await request(ui, '/api/tags', { name: 'smoke', color: 'blue' }, { Origin: ui })).status, 200);
  const token = fs.readFileSync(path.join(home, 'mcp-token'), 'utf8').trim();
  const rpc = async (name, args = {}, node = 'node-1') => {
    const result = await request(mcp, '/mcp?node=' + node, { jsonrpc: '2.0', id: 1, method: name === 'list' ? 'tools/list' : 'tools/call', params: { name, arguments: args } }, { Authorization: 'Bearer ' + token });
    assert(result.ok); return result.json();
  };
  assert.equal((await request(mcp, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await request(mcp, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(mcp, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer ' + token, Origin: ui })).status, 403);
  assert.equal((await request(ui, '/api/remote-desktop')).status, 404);
  assert.equal((await request(mcp, '/remote-desktop')).status, 404);
  assert((await (await request(ui, '/api/project-sync/status')).json()).ok);
  assert.equal((await request(mcp, '/health', undefined, { Host: 'evil.example' })).status, 403);
  const tools = (await rpc('list')).result.tools;
  assert.equal(tools.length, process.platform === 'win32' ? 21 : 23);
  if (process.platform === 'win32') assert(!tools.some((t) => t.name.startsWith('xcode_')));
  const mirror = path.join(home, 'work');
  fs.writeFileSync(path.join(mirror, 'sandbox.html'), '<script>parent.fetch("/api/tree")</script>');
  const raw = await request(ui, '/api/raw-file?' + new URLSearchParams({ path: '/root/work/sandbox.html', nodeId: 'node-1' }));
  assert.equal(raw.status, 200);
  assert(raw.headers.get('Content-Security-Policy').startsWith('sandbox '));
  fs.writeFileSync(path.join(mirror, '测试 file.txt'), 'preview 中文 OK');
  const query = new URLSearchParams({ path: '/root/work/测试 file.txt', nodeId: 'node-1' });
  const preview = await (await request(ui, '/api/file-content?' + query)).json();
  assert.equal(preview.content, 'preview 中文 OK');
  const localQuery = new URLSearchParams({ path: path.join(mirror, '测试 file.txt'), nodeId: 'node-1' });
  assert.equal((await (await request(ui, '/api/file-content?' + localQuery)).json()).content, 'preview 中文 OK');
  assert.equal((await request(ui, '/api/files/upload', { targetDirPath: home + '-other', fileName: 'bad.txt', contentBase64: '' })).status, 400);
  assert.equal((await request(ui, '/api/files/upload', { targetDirPath: mirror, fileName: 'upload.txt', contentBase64: Buffer.from('uploaded').toString('base64') })).status, 200);
  assert.equal(fs.readFileSync(path.join(mirror, 'upload.txt'), 'utf8'), 'uploaded');
  const host = await rpc('mac_host_exec', { command: process.platform === 'win32' ? "Write-Output ('TAKT_' + 'WINDOWS_OK')" : "printf 'TAKT_POSIX_OK'" });
  assert.equal(host.result.isError, false); assert(host.result.content[0].text.includes(process.platform === 'win32' ? 'TAKT_WINDOWS_OK' : 'TAKT_POSIX_OK'));
  if (process.platform === 'win32') {
    const usb = await rpc('usb_list_devices_and_ports'); assert.equal(usb.result.isError, false);
    const invalidSerial = await rpc('usb_serial_monitor', { port: '/dev/ttyUSB0' }); assert.equal(invalidSerial.result.isError, true);
    const shot = await rpc('mac_screen_capture', { output_filename: 'smoke.png', max_dimension_px: 480 });
    assert.equal(shot.result.isError, false, shot.result.content?.[0]?.text);
    assert(shot.result.content.some((c) => c.type === 'image'));
  }
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(ui.replace('http:', 'ws:') + '/ws/term?tabId=smoke&nodeId=node-1&mode=shell', { origin: ui });
    let output = ''; let sent = false; const marker = process.platform === 'win32' ? 'TAKT_PTY_WINDOWS' : 'TAKT_PTY_POSIX';
    const timer = setTimeout(() => { ws.close(); reject(Error('PTY timeout: ' + output.slice(-1500))); }, 15000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'resize', cols: 98, rows: 28 }));
      setTimeout(() => {
        sent = true;
        ws.send(JSON.stringify({ type: 'input', data: process.platform === 'win32' ? "Write-Output ('TAKT_PTY_' + 'WINDOWS')\r" : "printf 'TAKT_PTY_%s\\n' POSIX\r" }));
      }, 1300);
    });
    ws.on('message', (data) => {
      const message = JSON.parse(data); if (message.type !== 'output') return;
      output += message.data;
      if (sent && output.includes(marker)) { clearTimeout(timer); ws.close(); resolve(); }
    }); ws.on('error', reject);
  });
  const close = await (await request(ui, '/api/tabs?tabId=smoke', undefined, {}, 'DELETE')).json(); assert(close.ok);
  const report = { platform: process.platform, version: require('../package.json').version, api: true, security: true, filePreview: true, upload: true, mcpTools: tools.length, hostCommand: true, conpty: true, resizeAndClose: true, screenshot: process.platform === 'win32', realLinuxServer: false };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true }); fs.writeFileSync(path.join(root, 'build/smoke-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await request(ui, '/api/shutdown', {}, { Authorization: 'Bearer ' + token });
  await request(mcp, '/shutdown', {}, { Authorization: 'Bearer ' + token });
  await delay(300);
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  for (const child of children) if (child.exitCode === null) { try { child.kill(); } catch {} }
  await delay(400);
  // The directory is created by mkdtemp above; never remove any user workspace.
  fs.rmSync(home, { recursive: true, force: true });
});
