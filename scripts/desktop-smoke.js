'use strict';
// Exercise the actual Electron renderer over its localhost DevTools socket.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-desktop-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => r(port)); }); }); }
let child, socket, target, desktopPid;
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
let id = 0; const pending = new Map(); const rendererErrors = [];
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => { const next = ++id; const timer = setTimeout(() => { pending.delete(next); reject(Error('CDP timeout ' + method)); }, 20000); pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params })); });
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function main() {
  const uiPort = await freePort(), mcpPort = await freePort(), edaPort = await freePort(), debugPort = await freePort();
  const env = { ...process.env, TAKT_HOME: home, TAKT_PORT: String(uiPort), TAKT_MCP_PORT: String(mcpPort), TAKT_EDA_PORT: String(edaPort), TAKT_DEV_NODE: process.execPath };
  if (process.argv[2]) {
    delete env.TAKT_DEV_NODE; delete env.TAKT_NODE; delete env.PATH; delete env.Path;
    const windows = process.env.SystemRoot || 'C:\\Windows';
    env.Path = [path.join(windows, 'System32'), path.join(windows, 'System32/OpenSSH'), path.join(windows, 'System32/WindowsPowerShell/v1.0')].join(';');
  }
  delete env.ELECTRON_RUN_AS_NODE;
  let executable = process.argv[2] || require('electron');
  const originalExecutable = executable;
  const isolated = Boolean(process.argv[2]) && !path.basename(executable).includes('win-x64');
  if (isolated) {
    const appDir = path.join(home, 'isolated-application');
    fs.cpSync(path.dirname(executable), appDir, { recursive: true });
    executable = path.join(appDir, path.basename(executable));
  }
  const args = [...(process.argv[2] ? [] : [path.join(root, 'windows')]), '--takt-smoke', `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'];
  child = spawn(executable, args, { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stdout.resume(); child.stderr.on('data', (d) => { errors += d; });
  child.on('error', (err) => { errors += err.message; });
  for (let i = 0; i < 150; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${uiPort}`)); if (target) break; } catch {}
    const errorFile = path.join(home, 'logs/desktop-error.log');
    if (fs.existsSync(errorFile)) throw Error(fs.readFileSync(errorFile, 'utf8'));
    // A portable self-extractor may exit after spawning its real desktop process.
    if (!process.argv[2] && child.exitCode !== null) throw Error('Electron 已退出: ' + errors.slice(-2000));
    if (i === 149) throw Error('Electron 未就绪: ' + errors.slice(-2000));
    await delay(200);
  }
  desktopPid = JSON.parse(fs.readFileSync(path.join(home, 'run/desktop.json'), 'utf8')).pid;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, reject) => { socket.once('open', r); socket.once('error', reject); });
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.exceptionThrown') rendererErrors.push(msg.params.exceptionDetails);
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); msg.error ? waiter.reject(Error(msg.error.message)) : waiter.resolve(msg.result); }
  });
  await cdp('Runtime.enable');
  await cdp('Page.bringToFront');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await delay(1200);
  const originalHealth = await (await fetch(`http://127.0.0.1:${uiPort}/api/health`)).json();
  if (!path.basename(executable).includes('win-x64')) {
    const second = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { second.kill(); reject(Error('第二实例未退出')); }, 10000);
      second.once('error', reject); second.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal((await (await fetch(`http://127.0.0.1:${uiPort}/api/health`)).json()).pid, originalHealth.pid, '第二实例退出不能关闭第一实例的服务');
  }
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.equal(await evaluate('typeof process'), 'undefined');
  await evaluate(`fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Windows 验证',nodeId:'node-1'})}).then(r=>r.json())`);
  await cdp('Page.reload'); await delay(2000);
  const visible = await evaluate(`({title:document.title,tree:document.getElementById('projectTree')?.textContent || document.body.innerText,folderButton:[...document.querySelectorAll('button')].filter(b=>b.title.includes('新建')).length})`);
  assert(visible.tree.includes('Windows 验证'), '项目应在侧边栏渲染');
  // Use the same visible project + button that a user presses.
  const buttons = await evaluate(`[...document.querySelectorAll('button')].filter(b=>/终端|对话/.test(b.title)).map(b=>({title:b.title,cls:b.className}))`);
  const click = await evaluate(`(()=>{const button=document.getElementById('btnLocalTerminal'); if(button){button.click();return true}return false})()`);
  if (!click) throw Error('无法找到项目终端按钮: ' + JSON.stringify(buttons));
  // Wait for PowerShell's prompt: sending during ConPTY startup can be lost.
  let shellReady = false;
  for (let i = 0; i < 100; i++) {
    shellReady = await evaluate(`document.body.innerText.includes('PS C:')`);
    if (shellReady) break;
    await delay(200);
  }
  if (!shellReady) {
    console.error(await evaluate(`(async()=>{const t=(await (await fetch('/api/tree')).json()).openTabs[0];return await new Promise(resolve=>{const ws=new WebSocket('ws://'+location.host+'/ws/term?'+new URLSearchParams({...t,mode:'local'}));let output='';ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='output')output+=m.data};setTimeout(()=>{ws.close();resolve({raw:output,body:document.body.innerText,errors:[]})},500)})})()`));
  }
  assert(shellReady, 'PowerShell prompt should be ready before input');
  await evaluate(`document.getElementById('btnInjectManualCmd').click()`);
  let terminal = '';
  for (let i = 0; i < 60; i++) { terminal = await evaluate(`document.body.innerText`); if (/Major\s+Minor\s+Build/.test(terminal)) break; await delay(200); }
  // Xterm uses a canvas renderer in some versions; inspect its accessibility text or backend scrollback.
  if (!/Major\s+Minor\s+Build/.test(terminal)) {
    const text = await evaluate(`document.body.innerText`);
    const image = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(root, 'build'), { recursive: true }); fs.writeFileSync(path.join(root, 'build/windows-desktop-failure.png'), Buffer.from(image.data, 'base64'));
    console.error(JSON.stringify({ body: text.slice(-4000), terminal, errors: rendererErrors, tabs: await evaluate(`fetch('/api/tree').then(r=>r.json()).then(d=>d.openTabs)`) }));
    assert(/Major\s+Minor\s+Build/.test(text), '终端应渲染实际命令输出');
  }
  fs.writeFileSync(path.join(home, 'work/Windows 验证/preview.txt'), 'Windows 11 文件预览验证');
  await evaluate(`fetch('/api/file-content?'+new URLSearchParams({path:'/root/work/Windows 验证/preview.txt',nodeId:'node-1'})).then(r=>r.json()).then(d=>{if(!d.content.includes('文件预览验证'))throw Error('preview failed')})`);
  await evaluate(`[...document.querySelectorAll('.project-header')].find(e=>e.textContent.includes('Windows 验证')).click()`);
  await delay(500);
  assert(await evaluate(`(()=>{const file=[...document.querySelectorAll('.tree-row')].find(e=>e.querySelector('.tree-name')?.textContent==='preview.txt'); if(!file)return false; file.click();return true})()`));
  await delay(400);
  assert(await evaluate(`document.getElementById('previewBody').textContent.includes('文件预览验证')`));
  assert(await evaluate(`document.getElementById('btnViewChat').disabled`), 'local PowerShell should keep terminal mode');
  await evaluate(`document.getElementById('btnProjectSync').click()`);
  assert(await evaluate(`document.getElementById('projectSyncDialog').open`));
  await evaluate(`document.getElementById('projectSyncDialog').close()`);
  await evaluate(`(${require('./dockterm-ui-fixture').toString()})()`);
  await delay(500);
  await evaluate(`document.getElementById('btnNewQuickSession').click(); document.getElementById('btnViewChat').click()`);
  await delay(1200);
  assert(await evaluate(`!document.getElementById('docktermChatStage').hidden && document.getElementById('docktermMessages').textContent.includes('Fixture reply')`));
  assert(await evaluate(`document.getElementById('docktermMessages').querySelector('pre code').textContent.includes('answer = 42')`));
  assert(await evaluate(`document.getElementById('docktermModelSelect').value==='fixture-model'`));
  await evaluate(`(()=>{ const input=document.getElementById('docktermComposerInput'); const dt=new DataTransfer(); dt.items.add(new File(['attachment fixture'],'fixture.txt',{type:'text/plain'})); input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})); })()`);
  await delay(300);
  assert.equal(await evaluate(`window.taktChatFixture.uploads`), 1);
  assert(await evaluate(`document.body.textContent.includes('fixture.txt')`));
  await evaluate(`(()=>{const input=document.getElementById('docktermComposerInput'); input.value='Fixture send'; input.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('btnDocktermSend').click(); })()`);
  await delay(500);
  assert(await evaluate(`window.taktChatFixture.inputs.some(i=>i.text.includes('Fixture send') && i.text.includes('/root/work/.takt/uploads/fixture.txt'))`));
  await evaluate(`document.getElementById('btnViewTerminal').click()`);
  assert(await evaluate(`document.getElementById('docktermChatStage').hidden`));
  await cdp('Browser.getVersion');
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/windows-desktop.png'), Buffer.from(screenshot.data, 'base64'));
  assert.equal(rendererErrors.length, 0, JSON.stringify(rendererErrors));
  const report = { packaged: Boolean(process.argv[2]), restrictedPath: Boolean(process.argv[2]), isolatedFromCheckout: Boolean(process.argv[2]), executable: originalExecutable, uiRendered: true, nodeIntegrationDisabled: true, projectTree: true, terminalInputOutput: true, filePreview: true, projectSyncDialog: true, docktermFixture: { rendering: true, markdown: true, model: true, attachment: true, send: true, viewSwitch: true }, rendererErrors: 0, realLinuxServer: false };
  socket.send(JSON.stringify({ id: ++id, method: 'Browser.close' }));
  for (let i = 0; i < 60 && alive(desktopPid); i++) await delay(100);
  assert(!alive(desktopPid), '桌面进程应退出');
  await delay(1000);
  for (const port of [uiPort, mcpPort]) { let online = false; try { online = (await fetch(`http://127.0.0.1:${port}/${port === uiPort ? 'api/health' : 'health'}`, { signal: AbortSignal.timeout(1000) })).ok; } catch {} assert(!online, '退出后服务端口应关闭'); }
  report.shutdownCleanup = true;
  report.singleInstanceSafe = !path.basename(executable).includes('win-x64') ? true : null;
  fs.writeFileSync(path.join(root, 'build/desktop-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  if (!desktopPid) { try { desktopPid = JSON.parse(fs.readFileSync(path.join(home, 'run/desktop.json'), 'utf8')).pid; } catch {} }
  if (Number.isInteger(desktopPid) && alive(desktopPid)) {
    const kill = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(desktopPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((r) => { kill.on('close', r); kill.on('error', r); });
  }
  if (child && child.exitCode === null) {
    const kill = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((r) => { kill.on('close', r); kill.on('error', r); });
  }
  await delay(500);
  fs.rmSync(home, { recursive: true, force: true });
});
