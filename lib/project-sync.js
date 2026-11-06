'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { contains } = require('./platform');
const { shQuote } = require('./ssh');
function createProjectApi(node, run, cfg) {
  const xml = fs.readFileSync(cfg.findSyncthingConfig(), 'utf8');
  const key = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
  if (!key) throw Error('本机 Syncthing 尚未配置');
  async function api(side, url, method = 'GET', body) {
    if (side === 'local') {
      const r = await fetch(cfg.SYNCTHING_URL + url, { method, headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Error('本机 Syncthing API: ' + r.status);
      return JSON.parse(await r.text() || '{}');
    }
    const q = Buffer.from(JSON.stringify({ url, method, body })).toString('base64');
    const py = `import os,json,base64,urllib.request,xml.etree.ElementTree as E\nq=json.loads(base64.b64decode('${q}'))\np=next(p for p in [os.path.expanduser('~/.local/state/syncthing/config.xml'),os.path.expanduser('~/.config/syncthing/config.xml')] if os.path.exists(p))\nx=E.parse(p).getroot()\nr=urllib.request.Request('http://'+x.findtext('gui/address')+q['url'],method=q['method'],data=json.dumps(q['body']).encode() if q.get('body') is not None else None,headers={'X-API-Key':x.findtext('gui/apikey'),'Content-Type':'application/json'})\nwith urllib.request.urlopen(r,timeout=10) as f: print(f.read().decode() or '{}')`;
    const r = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', node.sshHost, 'python3 -c ' + shQuote(py)], 15000);
    if (r.exitCode) throw Error('服务器 Syncthing API 失败: ' + r.stderr.slice(-250));
    return JSON.parse(r.stdout);
  }
  return api;
}
async function configureProject({ node, localPath, name, run, cfg }) {
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,79}$/u.test(name) || name === '..') throw Error('项目名称无效');
  if (!path.isAbsolute(localPath) || !fs.statSync(localPath).isDirectory()) throw Error('请选择已存在的本地目录');
  localPath = fs.realpathSync(localPath);
  if (!node.sshHost) throw Error('节点尚未绑定 SSH');
  if ((node.projectMappings || []).some(m => contains(m.localPath, localPath) || contains(localPath, m.localPath) || m.remotePath === node.remoteWorkDir + '/' + name)) throw Error('项目目录或服务器名称与已有映射重叠');
  const remotePath = node.remoteWorkDir.replace(/\/$/, '') + '/' + name;
  const id = 'takt-project-' + crypto.randomUUID();
  const api = createProjectApi(node, run, cfg);
  const snapshots = {};
  for (const side of ['local', 'remote']) {
    snapshots[side] = await api(side, '/rest/config/folders');
    const target = side === 'local' ? localPath : remotePath;
    for (const f of snapshots[side]) {
      const overlap = side === 'local' ? contains(f.path, target) || contains(target, f.path) : target === f.path || target.startsWith(f.path + '/') || f.path.startsWith(target + '/');
      if (overlap && f.id !== node.syncthingFolderId) throw Error(side + ' 目录与其他 Syncthing 文件夹重叠');
    }
  }
  const check = await run('ssh', ['-o','BatchMode=yes',node.sshHost, `test ! -e ${shQuote(remotePath)} && test ! -L ${shQuote(remotePath)}`], 10000);
  if (check.exitCode) throw Error('服务器目标已存在，请使用新的项目名称，避免合并已有数据');
  const localID = (await api('local', '/rest/system/status')).myID;
  const remoteID = (await api('remote', '/rest/system/status')).myID;
  for (const [side, peer] of [['local', remoteID], ['remote', localID]]) {
    if (!(await api(side, '/rest/config/devices')).some(d => d.deviceID === peer)) throw Error('请先完成节点的 Syncthing 设备配对');
  }
  const backup = path.join(cfg.TAKT_HOME, 'sync-backups', id + '.json');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify({ nodeId: node.id, snapshots, localPath, remotePath }, null, 2));
  try {
    for (const side of ['local', 'remote']) {
      const parent = snapshots[side].find(f => f.id === node.syncthingFolderId);
      if (parent) await api(side, '/rest/config/folders/' + encodeURIComponent(parent.id), 'PATCH', { paused: true });
      const folder = await api(side, '/rest/config/defaults/folder');
      Object.assign(folder, { id, label: name, path: side === 'local' ? localPath : remotePath, type: 'sendreceive', paused: true, ignorePerms: true, fsWatcherEnabled: true, fsWatcherDelayS: 1, rescanIntervalS: 60, devices: [{ deviceID: localID }, { deviceID: remoteID }] });
      await api(side, '/rest/config/folders/' + id, 'PUT', folder);
    }
    for (const side of ['remote', 'local']) await api(side, '/rest/config/folders/' + id, 'PATCH', { paused: false });
  } catch (error) {
    const rollbackErrors = [];
    for (const side of ['local', 'remote']) {
      try {
        const current = await api(side, '/rest/config/folders');
        if (current.some(f => f.id === id)) await api(side, '/rest/config/folders/' + id, 'DELETE');
        const parent = snapshots[side].find(f => f.id === node.syncthingFolderId);
        if (parent) await api(side, '/rest/config/folders/' + encodeURIComponent(parent.id), 'PUT', parent);
      } catch (e) { rollbackErrors.push(side + ': ' + e.message); }
    }
    throw Error(error.message + (rollbackErrors.length ? '; 回滚未完成，配置备份: ' + backup : '; 已恢复原同步配置'));
  }
  return { id, name, localPath, remotePath, backup };
}
async function removeProject({ node, mapping, run, cfg, commit, api = createProjectApi(node, run, cfg) }) {
  const snapshots = {};
  for (const side of ['local', 'remote']) {
    const folders = await api(side, '/rest/config/folders');
    const folder = folders.find(f => f.id === mapping.id);
    if (folder && folder.path.replaceAll('\\', '/').replace(/\/$/, '') !== (side === 'local' ? mapping.localPath : mapping.remotePath).replaceAll('\\', '/').replace(/\/$/, '')) throw Error('同步配置路径与项目映射不一致，已停止移除');
    snapshots[side] = folder || null;
    // A resumed parent would continue syncing this project after removal.
    const parent = folders.find(f => f.id === node.syncthingFolderId);
    if (parent && !parent.paused) throw Error('原 work 整目录同步仍在运行，请先暂停，再移除独立项目');
  }
  const backup = path.join(cfg.TAKT_HOME, 'sync-backups', 'remove-' + crypto.randomUUID() + '.json');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify({ nodeId: node.id, mapping, snapshots }, null, 2));
  try {
    for (const side of ['local', 'remote']) if (snapshots[side]) await api(side, '/rest/config/folders/' + encodeURIComponent(mapping.id), 'PATCH', { paused: true });
    for (const side of ['local', 'remote']) if (snapshots[side]) await api(side, '/rest/config/folders/' + encodeURIComponent(mapping.id), 'DELETE');
    await commit();
  } catch (error) {
    const failures = [];
    for (const side of ['local', 'remote']) if (snapshots[side]) {
      try { await api(side, '/rest/config/folders/' + encodeURIComponent(mapping.id), 'PUT', snapshots[side]); }
      catch (e) { failures.push(side + ': ' + e.message); }
    }
    throw Error(error.message + (failures.length ? '; 配置回滚失败: ' + failures.join('; ') + '; 备份: ' + backup : '; 已恢复两端原同步配置'));
  }
  return { backup };
}
module.exports = { configureProject, removeProject };
