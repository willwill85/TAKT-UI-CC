'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async ({ appOutDir }) => {
  const resources = path.join(appOutDir, 'resources');
  const backend = path.join(resources, 'backend');
  const modules = path.join(backend, 'node_modules');
  for (const name of ['node-pty', 'ws', 'node-addon-api']) {
    if (!fs.existsSync(path.join(modules, name, 'package.json'))) throw new Error(`安装包缺少生产依赖 ${name}；不能依赖源码目录中的 node_modules`);
  }
  const source = `const assert=require('node:assert/strict');const path=require('node:path');const r=require('node:module').createRequire(${JSON.stringify(path.join(backend, 'package.json'))});for(const name of ['node-pty','ws']){const resolved=r.resolve(name);assert(resolved.startsWith(${JSON.stringify(modules + path.sep)}),name+' escaped package');r(name)};require('node:sqlite');console.log('Bundled Node, SQLite, node-pty and ws verified');`;
  const env = { ...process.env }; delete env.NODE_PATH;
  const result = spawnSync(path.join(resources, 'runtime/node.exe'), ['-e', source], { encoding: 'utf8', windowsHide: true, env, timeout: 15000 });
  if (result.status !== 0) throw new Error('安装包独立运行时验证失败: ' + (result.stderr || result.error?.message));
  console.log(result.stdout.trim());
};
