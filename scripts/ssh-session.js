#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const platform = require('../lib/platform');
const { interactiveArgs } = require('../lib/ssh');

const [tabId = 'default', cwd = '/root/work', host = '', mode = ''] = process.argv.slice(2);
let child;
let stopped = false;
process.on('SIGTERM', () => { stopped = true; if (child) child.kill(); process.exit(); });
process.on('SIGINT', () => {}); // Ctrl-C belongs to the interactive SSH session.
async function run() {
  if (!host) {
    console.log(mode === 'local' ? '[TAKT] 本机终端 · ' + (platform.isWindows ? 'PowerShell' : 'Bash') : '[TAKT] 尚未绑定 SSH 主机。当前为本机终端，请在“节点”中配置服务器。');
    const env = platform.childEnv();
    // Codex injects its own PowerShell modules into the parent environment. Its
    // PSReadLine can trigger a publisher prompt in Windows PowerShell 5.1.
    // Keep the user's normal module paths and execution policy intact.
    if (platform.isWindows && env.PSModulePath) {
      env.PSModulePath = env.PSModulePath.split(';').filter((entry) => !/[\\/]codex-runtimes[\\/]codex-primary-runtime[\\/]dependencies[\\/]native[\\/]powershell[\\/]modules[\\/]?$/i.test(entry)).join(';');
    }
    child = spawn(platform.isWindows ? platform.powershell : '/bin/bash', platform.isWindows ? ['-NoLogo', '-NoProfile'] : ['-l'], { stdio: 'inherit', env });
    return new Promise((resolve) => { child.on('error', (err) => { console.error(err.message); resolve(); }); child.on('exit', resolve); });
  }
  let failures = 0;
  while (!stopped) {
    const started = Date.now();
    const code = await new Promise((resolve) => {
      child = spawn(platform.ssh, interactiveArgs(tabId, cwd, host), { stdio: 'inherit', env: platform.childEnv() });
      child.on('error', (err) => { console.error('[TAKT] ' + err.message); resolve(1); });
      child.on('exit', resolve);
    });
    if (code !== 255) break;
    failures = Date.now() - started < 10000 ? failures + 1 : 0;
    if (failures >= 4) {
      console.log(`\r\n[TAKT] 连续连接失败。请检查 ssh ${host}、密钥和网络，按回车重试。`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise((resolve) => { rl.once('line', resolve); rl.once('close', resolve); });
      rl.close(); failures = 0;
    } else {
      console.log('\r\n[TAKT] SSH 中断，正在重新连接远端 tmux 会话……');
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}
run().catch((err) => { console.error(err.message); process.exitCode = 1; });
