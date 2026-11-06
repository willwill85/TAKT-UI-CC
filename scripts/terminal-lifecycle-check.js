'use strict';
// Against a running installation; owns only its uniquely named test tabs.
const { WebSocket } = require('ws');
const base = process.argv[2];
const rounds = Number(process.argv[3] || 6);
const pauseMs = Number(process.argv[4] || 1200);
let nodeId, cwd;
if (!base) throw Error('Usage: node scripts/terminal-lifecycle-check.js http://127.0.0.1:PORT');
async function round(mode, index) {
  const tabId = 'lifecycle-' + Date.now() + '-' + index;
  const marker = 'LIFECYCLE_OK_' + index;
  const query = new URLSearchParams({ tabId, nodeId, mode, cwd, title: '终端生命周期验收', ephemeral: '1' });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/term?' + query);
    let text = '', sent = false, done = false;
    const timer = setTimeout(() => { ws.send(JSON.stringify({ type: 'kill' })); ws.close(); reject(Error(mode + ': timeout')); }, 20000);
    ws.on('error', error => { clearTimeout(timer); reject(error); });
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'exit') { ws.close(); return; }
      text += message.data || '';
      if (!sent && (mode === 'local' ? /PS [^>]*>/.test(text) : /#/.test(text))) {
        sent = true;
        setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: mode === 'local' ? `Write-Output ('LIFECYCLE_' + 'OK_${index}')\r` : `\x15printf 'LIFECYCLE_%s\\n' 'OK_${index}'\r` })), 1200);
      }
      if (!done && text.includes(marker)) {
        done = true;
        ws.send(JSON.stringify(index % 4 < 2 ? { type: 'kill' } : { type: 'input', data: 'exit\r' }));
      }
    });
    ws.on('close', () => { clearTimeout(timer); done ? resolve() : reject(Error(mode + ': closed before output')); });
  });
  if (mode !== 'local') await fetch(base + '/api/sessions?' + new URLSearchParams({ id: tabId, nodeId }), { method: 'DELETE' });
}
(async () => {
  const initial = await (await fetch(base + '/api/health')).json();
  const tree = await (await fetch(base + '/api/tree')).json();
  const node = tree.nodes.find(n => n.id === process.argv[5]) || tree.nodes.find(n => n.enabled && n.sshHost);
  if (!node) throw Error('No configured SSH node');
  nodeId = node.id; cwd = process.argv[6] || node.remoteWorkDir;
  for (let index = 0; index < rounds; index++) {
    const mode = index % 2 ? 'shell' : 'local';
    await round(mode, index);
    await new Promise(resolve => setTimeout(resolve, pauseMs));
    const health = await (await fetch(base + '/api/health')).json();
    if (health.pid !== initial.pid) throw Error('Workbench restarted');
    console.log(new Date().toISOString() + ' round ' + (index + 1) + '/' + rounds + ' ' + mode + ' output and close passed; workbench PID ' + health.pid);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
