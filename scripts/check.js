'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
for (const dir of ['lib', 'server', 'mcp-server', 'scripts', 'windows', 'tests']) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  for (const file of fs.readdirSync(path.join(root, dir)).filter((f) => /\.(c?js)$/.test(f))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, dir, file)], { stdio: 'inherit', windowsHide: true });
    if (result.status) process.exit(result.status);
  }
}
const result = spawnSync(process.execPath, ['--check', path.join(root, 'config.js')], { stdio: 'inherit', windowsHide: true });
if (result.status) process.exit(result.status);
const html = fs.readFileSync(path.join(root, 'server/public/index.html'), 'utf8');
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new (require('node:vm').Script)(match[1]);
console.log('JavaScript 与前端脚本语法检查通过');
