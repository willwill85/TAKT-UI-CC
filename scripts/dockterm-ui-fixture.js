'use strict';
/* global window, document, location */
// Browser fixture for the real Electron renderer; no external server or Claude login.
module.exports = async function docktermUiFixture() {
  const nativeFetch = window.fetch.bind(window);
  const NativeSocket = window.WebSocket;
  const fixture = window.taktChatFixture = { inputs: [], uploads: 0 };
  const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      if (!String(url).includes('fixture.invalid')) { super(url, protocols); return; }
      // A fake terminal transport only for the fixture node; local terminal remains real.
      const socket = new EventTarget();
      socket.readyState = NativeSocket.OPEN;
      socket.send = raw => { const message = JSON.parse(raw); if (message.type === 'input') fixture.inputs.push({ text: message.data }); };
      socket.close = () => { socket.readyState = NativeSocket.CLOSED; };
      setTimeout(() => socket.dispatchEvent(new Event('open')), 10);
      return socket;
    }
  };
  window.fetch = async (url, options = {}) => {
    const u = new URL(String(url), location.href);
    if (u.pathname === '/api/tree') {
      const data = await (await nativeFetch(url, options)).json();
      data.nodes = data.nodes.map(n => ({ ...n, sshHost: 'fixture.invalid', enabled: true }));
      return json(data);
    }
    if (u.pathname === '/api/chat-view') return json({
      ok: true, epoch: 'fixture', ver: 3, reset: u.searchParams.get('epoch') !== 'fixture',
      claudeRunning: true, status: 'idle', hasOlder: false, stale: false,
      model: { model: 'fixture-model', effort: 'high', ts: Date.now() },
      messages: [
        { id: 'u', seq: 1, ver: 1, role: 'user', text: 'Fixture question' },
        { id: 'a', seq: 2, ver: 2, role: 'assistant', text: '## Fixture reply\n\n```js\nconst answer = 42;\n```\n\n[preview.txt](/root/work/Windows 验证/preview.txt)' },
        { id: 't', seq: 3, ver: 3, role: 'tool', tool: { name: 'Read', summary: 'preview.txt', path: '/root/work/Windows 验证/preview.txt', ok: true } },
      ],
    });
    if (u.pathname === '/api/claude-meta') return json({ ok: true,
      usage: { fiveHour: { pct: 25 }, week: { pct: 40 } }, usageCheckedAt: Date.now(),
      models: [{ id: 'fixture-model', name: 'Fixture model', line: 'sonnet', efforts: ['low', 'high'] }],
      settings: { model: 'fixture-model', effortLevel: 'high' },
    });
    if (u.pathname === '/api/chat-input') { fixture.inputs.push(JSON.parse(options.body)); return json({ ok: true }); }
    if (u.pathname === '/api/chat-upload') { fixture.uploads++; return json({ ok: true, remotePath: '/root/work/.takt/uploads/fixture.txt' }); }
    return nativeFetch(url, options);
  };
  document.getElementById('btnRefreshTree').click();
};
