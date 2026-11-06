'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
test('abrupt native terminal worker failure does not kill its host', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { spawnTerminal } = require('../lib/pty-session');
  const terminal = spawnTerminal('cmd.exe', ['/d', '/k', 'echo ISOLATION_READY'], { cols: 80, rows: 24, env: process.env });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { terminal.kill(); reject(Error('worker crash timeout')); }, 15000);
    let killed = false;
    terminal.onData(data => { if (!killed && data.includes('ISOLATION_READY')) { killed = true; terminal._worker.kill(); } });
    terminal.onExit(exit => { clearTimeout(timer); resolve(exit); });
  });
  assert.notEqual(result.exitCode, 0);
});
test('Windows ConPTY output workers release after normal exit and kill', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const source = `
    const {spawnTerminal}=require('./lib/pty-session');
    const delay=ms=>new Promise(r=>setTimeout(r,ms));
    (async()=>{for(let i=0;i<4;i++){
      const p=spawnTerminal('cmd.exe',['/d','/c',i%2?'echo CLEANUP_OK & ping -n 20 127.0.0.1 >nul':'echo CLEANUP_OK'],{cols:80,rows:24,env:process.env});
      let text=''; const exit=new Promise(r=>p.onExit(r)); p.onData(d=>text+=d);
      for(let retry=0;retry<60&&!text.includes('CLEANUP_OK');retry++)await delay(100);
      if(!text.includes('CLEANUP_OK'))throw Error('missing output');
      if(i%2)p.kill(); await exit;
    }console.log('ALL_RELEASED')})().catch(e=>{console.error(e);process.exitCode=1});
  `;
  const result = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', source], { cwd: path.join(__dirname, '..'), timeout: 35000, windowsHide: true }, (error, stdout, stderr) => error ? reject(Error(error.message + stderr)) : resolve({ stdout, stderr })));
  assert.match(result.stdout, /ALL_RELEASED/);
  assert.doesNotMatch(result.stderr, /AttachConsole failed/);
});
