'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上打包');
// Electron 45 downloads its development binary lazily; initialize it before electronDist is used.
require('electron');
const output = path.join(root, 'build/windows-runtime');
const backend = path.join(output, 'backend');
fs.mkdirSync(backend, { recursive: true });
for (const entry of ['config.js', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'lib', 'server', 'mcp-server', 'scripts/ssh-session.js']) {
  fs.cpSync(path.join(root, entry), path.join(backend, entry), { recursive: true });
}
// Copy only the production dependency closure, never the developer's entire node_modules or user data.
const copied = new Set();
function dependency(name) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fs.cpSync(source, path.join(backend, 'node_modules', name), { recursive: true });
  for (const dep of Object.keys(pkg.dependencies || {})) dependency(dep);
}
for (const name of Object.keys(require('../package.json').dependencies)) dependency(name);
const runtime = path.join(output, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(backend, 'LICENSE'));
// Ship the notices for the exact Node version copied above, with a versioned offline cache.
const https = require('node:https');
const license = path.join(runtime, 'NODE-LICENSE.txt');
const cachedLicense = path.join(__dirname, `licenses/NODE-${process.versions.node}-LICENSE.txt`);
function fetchLicense(attempt = 0) {
  const request = https.get(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, (res) => {
    if (res.statusCode !== 200) { request.destroy(new Error('许可证 HTTP ' + res.statusCode)); res.resume(); return; }
    let text = ''; res.setEncoding('utf8'); res.on('data', (data) => { text += data; });
    res.on('end', () => {
      if (!text.includes('Node.js is licensed')) { console.error('Node.js 许可证内容无效'); process.exitCode = 1; return; }
      fs.writeFileSync(license, text);
    });
    res.on('error', (err) => request.destroy(err));
  });
  request.setTimeout(15000, () => request.destroy(new Error('许可证下载超时')));
  request.on('error', (err) => { if (attempt < 2) fetchLicense(attempt + 1); else { console.error(err.message); process.exitCode = 1; } });
}
if (fs.existsSync(cachedLicense)) fs.copyFileSync(cachedLicense, license); else fetchLicense();
console.log(`Windows 运行时已准备: Node ${process.versions.node}，依赖 ${[...copied].join(', ')}`);
