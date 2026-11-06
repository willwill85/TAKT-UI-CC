'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const base = process.argv[2];
const cfg = require('../config');
const { shQuote } = require('../lib/ssh');
const node = JSON.parse(fs.readFileSync(cfg.NODES_FILE, 'utf8')).nodes.find(n => n.id === (process.argv[4] || cfg.PRIMARY_NODE_ID));
const mapping = node?.projectMappings?.find(m => m.name === process.argv[3] || m.id === process.argv[3]);
if (!base || !mapping) throw Error('Usage: node scripts/sync-stability-check.js http://127.0.0.1:PORT PROJECT_NAME [NODE_ID]');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = crypto.randomUUID();
const file = 'stability-' + token + '.txt';
const local = path.join(mapping.localPath, file);
const remote = shQuote(mapping.remotePath.replace(/\/$/, '') + '/' + file);
const ssh = command => execFileSync(require('../lib/platform').ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', node.sshHost, command], { encoding: 'utf8', timeout: 15000, windowsHide: true });
const report = { started: new Date().toISOString(), samples: [] };
(async () => {
  const initial = await (await fetch(base + '/api/health')).json();
  for (let index = 0; index < 8; index++) {
    const content = token + ':' + index;
    fs.writeFileSync(local, content);
    let uploaded = false;
    for (let retry = 0; retry < 15; retry++) {
      await delay(1000);
      try { if (ssh('cat ' + remote) === content) { uploaded = true; break; } } catch { /* Still syncing. */ }
    }
    if (!uploaded) throw Error('Upload timeout');
    ssh("printf '%s' '" + content + ":remote' > " + remote);
    let downloaded = false;
    for (let retry = 0; retry < 15; retry++) {
      await delay(1000);
      if (fs.readFileSync(local, 'utf8') === content + ':remote') { downloaded = true; break; }
    }
    if (!downloaded) throw Error('Download timeout');
    const health = await (await fetch(base + '/api/health')).json();
    const status = await (await fetch(base + '/api/status')).json();
    const projects = await (await fetch(base + '/api/project-sync/status')).json();
    if (health.pid !== initial.pid) throw Error('Workbench restarted');
    if (!status.ssh.online || !status.mcp.remoteTunnelOk) throw Error('SSH or MCP disconnected');
    if (projects.projects.some(p => p.error || p.errors > 0)) throw Error('Project sync error');
    report.samples.push({ at: new Date().toISOString(), pid: health.pid, upload: true, download: true, ssh: true, mcp: true });
    console.log('Sync sample', index + 1, 'passed; PID', health.pid);
    if (index < 7) await delay(60000);
  }
  fs.unlinkSync(local);
  for (let retry = 0; retry < 15; retry++) {
    await delay(1000);
    try { ssh('test ! -e ' + remote); report.deletionSynced = true; break; } catch { /* Still syncing. */ }
  }
  if (!report.deletionSynced) throw Error('Deletion timeout');
  report.finished = new Date().toISOString();
  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync('build/sync-stability-report.json', JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); report.error = error.message; fs.mkdirSync('build', { recursive: true }); fs.writeFileSync('build/sync-stability-report.json', JSON.stringify(report, null, 2)); process.exitCode = 1; });
