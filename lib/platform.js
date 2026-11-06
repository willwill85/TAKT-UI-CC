'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const isWindows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const powershell = isWindows ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
const ssh = process.env.TAKT_SSH_BIN || (isWindows ? path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh');

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const inherited = env[key] || '';
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env[isWindows ? 'Path' : 'PATH'] = [path.dirname(process.execPath), ...(isWindows
    ? [path.join(systemRoot, 'System32'), path.dirname(powershell), path.dirname(ssh)]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']), inherited].join(path.delimiter);
  return env;
}

function psQuote(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
function psArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); " + script, 'utf16le').toString('base64')];
}
function commandSpec(command, args = []) {
  if (command === 'ssh') return { command: ssh, args };
  if (isWindows && command === '/usr/bin/python3') return { command: process.env.TAKT_PYTHON || 'python.exe', args };
  return { command, args };
}
function detached(command, args, options = {}) {
  const child = spawn(command, args, { env: childEnv(), windowsHide: true, detached: true, stdio: 'ignore', ...options });
  child.on('error', () => {});
  child.unref();
  return child;
}
function openTarget(target, reveal = false) {
  if (isWindows) return { command: powershell, args: psArgs(reveal
    ? `Start-Process explorer.exe -ArgumentList ('/select,"' + ${psQuote(target)} + '"')`
    : `Start-Process -FilePath ${psQuote(target)}`) };
  return { command: process.platform === 'darwin' ? 'open' : 'xdg-open', args: process.platform === 'darwin' && reveal ? ['-R', target] : [target] };
}
function contains(root, candidate, impl = path) {
  const rel = impl.relative(impl.resolve(root), impl.resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + impl.sep) && rel !== '..' && !impl.isAbsolute(rel));
}
function findProgram(envName, candidates, fallback) {
  return process.env[envName] || candidates.find((p) => p && fs.existsSync(p)) || fallback;
}
function protectSecret(file) {
  if (!isWindows) return;
  const script = `$acl = [Security.AccessControl.FileSecurity]::new(); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); [IO.File]::SetAccessControl(${psQuote(file)},$acl)`;
  const result = spawnSync(powershell, psArgs(script), { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error('无法限制凭据文件的 NTFS 访问权限: ' + (result.stderr || result.error?.message || result.status));
}
module.exports = { isWindows, powershell, ssh, childEnv, psQuote, psArgs, commandSpec, detached, openTarget, contains, findProgram, protectSecret };
