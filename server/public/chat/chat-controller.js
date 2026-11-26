(function () {
  'use strict';

  function createController() {
    const tabViews = new Map();
    const metaByNode = new Map(); // `${nodeId}::${cwd}` -> { usage, models, extraModels, settings, commands, fetchedAt }
    let callbacks = {};
    let mountEl = null;
    let convSlot = null;
    let compSlot = null;
    let convView = null;
    let compView = null;
    let activeTabId = '';
    let renderRaf = 0;

    function activeView() {
      return activeTabId ? (tabViews.get(activeTabId) || null) : null;
    }

    function sendWs(tv, payload) {
      if (!tv || !tv.ws || tv.ws.readyState !== WebSocket.OPEN) {
        if (callbacks.showToast) callbacks.showToast('对话连接尚未就绪，正在重连…');
        if (tv) ensureConnected(tv);
        return false;
      }
      try {
        tv.ws.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    }

    function syncTabObj(tv) {
      if (!tv || !tv.tabObj) return;
      const st = tv.state || {};
      const status = st.status || 'idle';
      tv.nodeId = st.nodeId || tv.tabObj.nodeId || '';
      tv.jsonlPath = st.jsonlPath || '';
      const prev = tv.tabObj.chat || {};
      const changed = prev.status !== status
        || prev.connected !== tv.connected
        || prev.jsonlPath !== tv.jsonlPath
        || prev.claudeRunning !== Boolean(st.claudeRunning);
      tv.tabObj.chat = {
        status,
        connected: tv.connected,
        claudeRunning: Boolean(st.claudeRunning),
        resolvedSessionId: st.sessionId || tv.tabObj.sessionId,
        jsonlPath: tv.jsonlPath,
      };
      if (changed && callbacks.onTabMetaChange) {
        callbacks.onTabMetaChange(tv.tabObj);
      }
    }

    function scheduleRender(full = false) {
      const tv = activeView();
      if (!tv || !convView || !compView || mountEl.hidden) return;
      if (full) {
        if (renderRaf) {
          cancelAnimationFrame(renderRaf);
          renderRaf = 0;
        }
        convView.render(tv, { full: true });
        compView.render(tv);
        return;
      }
      if (renderRaf) return;
      renderRaf = requestAnimationFrame(() => {
        renderRaf = 0;
        const cur = activeView();
        if (!cur || mountEl.hidden) return;
        convView.render(cur);
        compView.render(cur);
      });
    }

    async function loadOfflineMeta(tv, force = false) {
      const t = tv && tv.tabObj;
      if (!t || !t.nodeId) return;
      const key = `${t.nodeId}::${t.cwd || ''}`;
      const cached = metaByNode.get(key);
      if (!force && cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
        tv.offlineMeta = cached;
        if (activeView() === tv && compView) compView.render(tv);
        return;
      }
      try {
        const q = new URLSearchParams({
          nodeId: t.nodeId || '',
          cwd: t.cwd || '',
          parts: 'usage,models,current,commands',
        });
        if (force) q.set('force', '1');
        const res = await fetch(`/api/claude-meta?${q.toString()}`, { cache: 'no-store' });
        const data = await res.json();
        const meta = {
          usage: (data && data.usage) || null,
          models: (data && Array.isArray(data.models) && data.models) || [],
          extraModels: (data && Array.isArray(data.extraModels) && data.extraModels) || [],
          settings: (data && data.settings) || {},
          commands: (data && Array.isArray(data.commands) && data.commands) || [],
          fetchedAt: Date.now(),
        };
        metaByNode.set(key, meta);
        tv.offlineMeta = meta;
        if (activeView() === tv && compView) compView.render(tv);
      } catch {}
    }

    function ensureConnected(tv) {
      if (!tv || !tv.tabObj) return;
      if (tv.ws && (tv.ws.readyState === WebSocket.OPEN || tv.ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (tv.reconnectTimer) {
        clearTimeout(tv.reconnectTimer);
        tv.reconnectTimer = null;
      }

      const t = tv.tabObj;
      const qs = new URLSearchParams({
        tabId: t.tabId,
        sessionId: t.sessionId || t.tabId,
        cwd: t.cwd || '/root/work',
        nodeId: t.nodeId || '',
        sshHost: t.sshHost || '',
        title: t.title || '',
        resume: t.resume ? '1' : '0',
      });
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/chat?${qs.toString()}`);
      tv.ws = ws;

      ws.addEventListener('open', () => {
        if (tv.ws !== ws) return;
        tv.connected = true;
        tv.reconnectDelay = 1000;
        if (activeTabId === tv.tabId) {
          try { ws.send(JSON.stringify({ type: 'focus', active: true })); } catch {}
        }
        syncTabObj(tv);
        scheduleRender();
      });

      ws.addEventListener('message', (ev) => {
        if (tv.ws !== ws) return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'snapshot') {
          tv.events = Array.isArray(msg.events) ? msg.events : [];
          tv.state = msg.state || {};
          tv.lastLiveTextId = '';
          tv.eventsVersion = (tv.eventsVersion || 0) + 1;
          tv.visibleTurnLimit = 24;
          syncTabObj(tv);
          if (activeView() === tv) scheduleRender(true);
          return;
        }

        if (msg.type === 'event' && msg.event) {
          tv.events.push(msg.event);
          tv.eventsVersion = (tv.eventsVersion || 0) + 1;
          if (msg.event.type === 'text.delta') {
            tv.lastLiveTextId = msg.event.id || '';
            tv.liveTextEventSeq = (tv.liveTextEventSeq || 0) + 1;
          }
          if (msg.event.type === 'turn.stats' && callbacks.onSessionActivity) {
            callbacks.onSessionActivity(tv.tabObj);
          }
          if (activeView() === tv) scheduleRender(false);
          return;
        }

        if (msg.type === 'history.prepended') {
          const older = Array.isArray(msg.events) ? msg.events : [];
          if (older.length) {
            tv.events = older.concat(tv.events);
            tv.eventsVersion = (tv.eventsVersion || 0) + 1;
            const addedUsers = older.filter((e) => e.type === 'message.user').length;
            tv.visibleTurnLimit = (tv.visibleTurnLimit || 24) + Math.max(12, addedUsers + 4);
          }
          if (msg.state) tv.state = msg.state;
          tv.lastLiveTextId = '';
          syncTabObj(tv);
          if (activeView() === tv && convView) {
            convView.prependEventsPreserveScroll(tv);
            compView.render(tv);
          }
          return;
        }

        if (msg.type === 'state' && msg.state) {
          tv.state = msg.state;
          syncTabObj(tv);
          if (activeView() === tv) scheduleRender(false);
          return;
        }

        if (msg.type === 'toast' && msg.message && callbacks.showToast) {
          callbacks.showToast(msg.message);
        }
      });

      ws.addEventListener('close', () => {
        if (tv.ws !== ws) return;
        tv.connected = false;
        syncTabObj(tv);
        if (activeView() === tv) scheduleRender(false);
        if (tabViews.has(tv.tabId) && activeTabId === tv.tabId) {
          const delay = Math.min(8000, tv.reconnectDelay || 1000);
          tv.reconnectDelay = delay * 1.5;
          tv.reconnectTimer = setTimeout(() => ensureConnected(tv), delay);
        }
      });
    }

    function getOrCreateView(tabObj) {
      let tv = tabViews.get(tabObj.tabId);
      if (!tv) {
        tv = {
          tabId: tabObj.tabId,
          tabObj,
          nodeId: tabObj.nodeId || '',
          jsonlPath: '',
          events: [],
          state: {
            tabId: tabObj.tabId,
            nodeId: tabObj.nodeId || '',
            cwd: tabObj.cwd || '/root/work',
            claudeRunning: true,
            status: 'idle',
            permissionMode: 'default',
            pendingUsers: [],
          },
          ws: null,
          connected: false,
          reconnectTimer: null,
          reconnectDelay: 1000,
          draft: '',
          attachments: [],
          promptHistory: [],
          histCursor: -1,
          openKeys: new Set(),
          closedKeys: new Set(),
          expandedUsers: new Set(),
          planExpanded: new Set(),
          askDraft: null,
          globalExpand: false,
          scrollTop: 0,
          offlineMeta: null,
          liveTextEventSeq: 0,
          lastLiveTextId: '',
          eventsVersion: 0,
          visibleTurnLimit: 24,
        };
        tabViews.set(tabObj.tabId, tv);
      } else {
        tv.tabObj = tabObj;
      }
      return tv;
    }

    function init(opts = {}) {
      callbacks = opts;
      mountEl = opts.mountEl || document.getElementById('docktermChatStage');
      if (!mountEl) return;

      mountEl.innerHTML = '';
      convSlot = document.createElement('div');
      convSlot.className = 'cc-conv-slot';
      compSlot = document.createElement('div');
      compSlot.className = 'cc-comp-slot';
      mountEl.appendChild(convSlot);
      mountEl.appendChild(compSlot);

      convView = window.TaktChatConversation.createConversationView({
        mountEl: convSlot,
        actions: {
          onSwitchTerminal: () => {
            if (callbacks.onSwitchToTerminal && activeTabId) {
              callbacks.onSwitchToTerminal(activeTabId);
            }
          },
          onLaunchClaude: () => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'launch_claude' });
          },
          onLoadOlder: () => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'load_older' });
          },
          onAnswerAsk: (action) => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'answer_ask', action });
          },
          onInterrupt: () => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'interrupt' });
          },
        },
      });

      compView = window.TaktChatComposer.createComposerView({
        mountEl: compSlot,
        actions: {
          onSend: ({ text, attachments }) => {
            const tv = activeView();
            if (!tv) return;
            const sent = sendWs(tv, {
              type: 'send',
              text,
              attachments: (attachments || []).map((a) => ({ name: a.name, remotePath: a.remotePath })),
              clientId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            });
            if (sent && convView) convView.scrollToBottom(false);
          },
          onInterrupt: () => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'interrupt' });
          },
          onRefresh: () => refreshActiveTab(),
          onCyclePermissionMode: () => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'cycle_permission_mode' });
          },
          onSetModel: (model) => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'set_model', model });
          },
          onSetEffort: (effort) => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'set_effort', effort });
          },
          onAnswerAsk: (action) => {
            const tv = activeView();
            if (tv) sendWs(tv, { type: 'answer_ask', action });
          },
          onSwitchTerminal: () => {
            if (callbacks.onSwitchToTerminal && activeTabId) {
              callbacks.onSwitchToTerminal(activeTabId);
            }
          },
          onToggleExpandAll: () => {
            const tv = activeView();
            if (!tv) return;
            tv.globalExpand = !tv.globalExpand;
            tv.openKeys.clear();
            tv.closedKeys.clear();
            scheduleRender(true);
          },
          onUploadFile: async (file) => {
            const tv = activeView();
            if (!tv || !tv.tabObj) return { ok: false, error: '未选中标签页' };
            const q = new URLSearchParams({
              nodeId: tv.tabObj.nodeId || '',
              cwd: tv.tabObj.cwd || '',
              name: file.name || 'image.png',
            });
            const res = await fetch(`/api/chat-upload?${q.toString()}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: file,
            });
            return res.json();
          },
        },
      });
    }

    function activateTab(tabObj) {
      if (!tabObj || !mountEl) return;
      const prevView = activeView();
      if (prevView && prevView.tabObj && prevView.tabObj.tabId !== tabObj.tabId && prevView.ws && prevView.ws.readyState === WebSocket.OPEN) {
        try { prevView.ws.send(JSON.stringify({ type: 'focus', active: false })); } catch {}
      }
      activeTabId = tabObj.tabId;
      const tv = getOrCreateView(tabObj);
      ensureConnected(tv);
      if (tv.ws && tv.ws.readyState === WebSocket.OPEN) {
        try { tv.ws.send(JSON.stringify({ type: 'focus', active: true })); } catch {}
      }
      syncTabObj(tv);
      if (convView && compView) {
        convView.render(tv, { full: true });
        compView.render(tv);
        compView.focusInput();
      }
      loadOfflineMeta(tv, false);
    }

    function deactivate() {
      const prevView = activeView();
      activeTabId = '';
      if (prevView && prevView.ws && prevView.ws.readyState === WebSocket.OPEN) {
        try { prevView.ws.send(JSON.stringify({ type: 'focus', active: false })); } catch {}
      }
    }

    function refreshActiveTab() {
      const tv = activeView();
      if (!tv) return;
      sendWs(tv, { type: 'refresh' });
      loadOfflineMeta(tv, true);
    }

    function closeTab(tabId) {
      const tv = tabViews.get(tabId);
      if (!tv) return;
      if (tv.reconnectTimer) clearTimeout(tv.reconnectTimer);
      try { if (tv.ws) tv.ws.close(); } catch {}
      tabViews.delete(tabId);
      if (activeTabId === tabId) activeTabId = '';
    }

    function insertText(snippet) {
      if (compView) compView.insertText(snippet);
    }

    function uploadFiles(files) {
      if (compView) compView.uploadFiles(files);
    }

    function toggleFind() {
      if (convView) convView.toggleFind();
    }

    function hasActiveFocus() {
      return Boolean(compView && compView.isFocused());
    }

    return {
      init,
      activateTab,
      deactivate,
      refreshActiveTab,
      closeTab,
      insertText,
      uploadFiles,
      toggleFind,
      hasActiveFocus,
    };
  }

  window.TaktChat = createController();
})();
