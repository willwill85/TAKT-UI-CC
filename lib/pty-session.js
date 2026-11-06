'use strict';
const { fork, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
function spawnTerminal(file, args, options) {
  if (process.platform !== 'win32') return require('node-pty').spawn(file, args, options);
  const events = new EventEmitter();
  const worker = fork(path.join(__dirname, 'pty-worker.js'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env });
  let ended = false, errorText = '', killTimer;
  function finish(code) {
    if (ended) return;
    ended = true; clearTimeout(killTimer);
    events.emit('exit', { exitCode: code, signal: 0 });
  }
  function send(message) { if (!ended && worker.connected) worker.send(message, () => {}); }
  const terminal = {
    _worker: worker,
    pid: worker.pid,
    onData(callback) { events.on('data', callback); return { dispose: () => events.off('data', callback) }; },
    onExit(callback) { events.on('exit', callback); return { dispose: () => events.off('exit', callback) }; },
    write(data) { send({ type: 'write', data }); },
    resize(cols, rows) { send({ type: 'resize', cols, rows }); },
    kill() {
      send({ type: 'kill' });
      if (!ended && !killTimer) killTimer = setTimeout(() => {
        spawn('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => worker.kill());
      }, 3000);
    },
  };
  worker.stderr.on('data', data => { errorText = (errorText + data.toString()).slice(-2000); });
  worker.on('message', message => {
    if (message.type === 'data') events.emit('data', message.data);
    if (message.type === 'exit') finish(message.exitCode);
    if (message.type === 'error') events.emit('data', '\r\n[TAKT] 终端启动失败：' + message.message + '\r\n');
  });
  worker.on('error', error => { events.emit('data', '\r\n[TAKT] 终端进程错误：' + error.message + '\r\n'); finish(-1); });
  worker.on('exit', (code, signal) => {
    if (!ended) {
      events.emit('data', `\r\n[TAKT] 终端子进程异常退出 (${code ?? signal})。工作台仍运行，可新建终端恢复远端 tmux。\r\n${errorText}`);
      finish(code ?? -1);
    }
  });
  send({ type: 'start', file, args, options });
  return terminal;
}
module.exports = { spawnTerminal };
