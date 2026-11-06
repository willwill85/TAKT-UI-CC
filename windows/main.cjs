'use strict';
const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const backend = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.join(__dirname, '..');
const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime/node.exe') : process.env.TAKT_NODE || process.execPath.replace(/node_modules[\\/]electron[\\/]dist[\\/]electron.exe$/i, 'node.exe');
const cfg = require(path.join(backend, 'config'));
const children = [];
let mainWindow;
let url;
let quitting = false;
let failed = false;
const smokeTest = process.argv.includes('--takt-smoke');
function fail(title, message) {
  if (failed || quitting) return;
  failed = true;
  try { fs.mkdirSync(cfg.LOG_DIR, { recursive: true }); fs.writeFileSync(path.join(cfg.LOG_DIR, 'desktop-error.log'), title + '\n' + message); } catch {}
  if (smokeTest) console.error(title + ': ' + message);
  else dialog.showErrorBox(title, message);
  app.quit();
}
function nodePath() {
  if (app.isPackaged || process.env.TAKT_NODE) return node;
  // Development starts under system Node via scripts/desktop.js.
  if (!process.env.TAKT_DEV_NODE) throw new Error('请通过 npm run desktop 启动');
  return process.env.TAKT_DEV_NODE;
}
async function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
async function boot() {
  if (app.isPackaged) {
    for (const name of ['node-pty', 'ws']) {
      if (!fs.existsSync(path.join(backend, 'node_modules', name, 'package.json'))) throw new Error(`安装包不完整：缺少 ${name}，请重新安装完整 Windows 版本。`);
    }
  }
  const port = process.env.TAKT_PORT ? cfg.PORT : await freePort();
  const mcpPort = cfg.MCP_PORT;
  url = `http://127.0.0.1:${port}`;
  fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
  fs.mkdirSync(path.join(cfg.TAKT_HOME, 'run'), { recursive: true });
  fs.writeFileSync(path.join(cfg.TAKT_HOME, 'run/desktop.json'), JSON.stringify({ pid: process.pid, version: app.getVersion() }));
  const env = { ...process.env, TAKT_PORT: String(port), TAKT_MCP_PORT: String(mcpPort), TAKT_MANAGED_SERVICES: '1' };
  for (const [name, script, args] of [['mcp-server', 'mcp-server/server.js', ['--http']], ['workbench', 'server/server.js', []]]) {
    const logPath = path.join(cfg.LOG_DIR, `${name}.log`);
    const logStart = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    const log = fs.openSync(path.join(cfg.LOG_DIR, `${name}.log`), 'a');
    const child = spawn(nodePath(), [path.join(backend, script), ...args], { windowsHide: true, env, stdio: ['ignore', log, log, 'ipc'] });
    if (name === 'workbench') child.on('message', async (message) => {
      if (message?.type !== 'pick-project-directory' || typeof message.id !== 'string') return;
      try {
        if (!mainWindow || mainWindow.isDestroyed()) throw Error('桌面窗口尚未就绪');
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show(); mainWindow.setAlwaysOnTop(true); mainWindow.focus();
        const result = await dialog.showOpenDialog(mainWindow, { title: '选择要同步的本地项目目录', properties: ['openDirectory'], defaultPath: cfg.DEFAULT_WORK_DIR });
        if (child.connected) child.send({ type: 'project-directory-result', id: message.id, path: result.canceled ? '' : result.filePaths[0] || '' });
      } catch (error) {
        if (child.connected) child.send({ type: 'project-directory-result', id: message.id, error: error.message });
      } finally {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
      }
    });
    fs.closeSync(log); children.push(child);
    child.on('error', (err) => fail('TAKT 服务启动失败', `${name}: ${err.message}`));
    child.on('exit', (code) => {
      if (quitting || failed) return;
      let detail = '';
      try { detail = fs.readFileSync(logPath).subarray(logStart).toString('utf8').slice(-3000); } catch {}
      fail('TAKT 服务已退出', `${name} 退出 (${code})\n${detail || '未获得服务日志'}\n完整日志：${cfg.LOG_DIR}`);
    });
  }
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const health = await (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).json();
      if (health.pid === children[1].pid) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error(`工作台未能启动，请查看 ${cfg.LOG_DIR}`);
  mainWindow = new BrowserWindow({ width: 1500, height: 940, minWidth: 960, minHeight: 640, title: `TAKT-UI-CC ${app.getVersion()} · Windows 11`, backgroundColor: '#090a0d', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => { if (/^https?:\/\//.test(target)) shell.openExternal(target); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== url) event.preventDefault(); });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '工作台', submenu: [{ label: '打开数据目录', click: () => shell.openPath(cfg.TAKT_HOME) }, { label: '打开日志目录', click: () => shell.openPath(cfg.LOG_DIR) }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'toggleDevTools', label: '开发者工具' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  await mainWindow.loadURL(url);
}
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(boot).catch((err) => fail('TAKT 启动失败', err.message));
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  // Only stop this instance's live children. A second-instance exit must never stop the first.
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    const taskkill = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    taskkill.on('error', () => { try { child.kill(); } catch {} });
  }
});
