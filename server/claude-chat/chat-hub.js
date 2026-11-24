'use strict';

const {
  readRemoteTranscriptChunk,
  readRemoteTranscriptOlder,
} = require('./remote-jsonl');
const { parseJsonlRecordsToEvents } = require('./terminal-transcript');
const {
  classifyClaudeScreen,
  buildAskKeys,
  sendTmuxInput,
  launchClaudeInTmux,
} = require('./tmux-bridge');

const SESSION_SWEEP_MS = 5 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 1150;
const PENDING_IDLE_TTL_MS = 8000;

function createChatHub({
  getNodeById,
  runCmd,
  sshOpts,
  sanitizeTmuxSessionId,
  activePtyTabs = null,
  onSessionActivity,
} = {}) {
  const sessions = new Map(); // `${nodeId}::${tabId}` -> session state

  function sweep() {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (s.clients.size > 0) continue;
      if (now - s.touchedAt > SESSION_IDLE_TTL_MS) {
        stopPollTimer(s);
        sessions.delete(key);
      }
    }
  }

  const sweepTimer = setInterval(sweep, SESSION_SWEEP_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  function sessionKey(nodeId, tabId) {
    return `${String(nodeId || 'default')}::${String(tabId || 'default')}`;
  }

  function resolveNode(nodeId, sshHost) {
    const node = typeof getNodeById === 'function' ? getNodeById(nodeId || sshHost) : null;
    return {
      nodeId: (node && node.id) || nodeId || 'default',
      sshHost: sshHost || (node && node.sshHost) || '',
    };
  }

  function buildPublicState(s) {
    return {
      tabId: s.tabId,
      nodeId: s.nodeId,
      sshHost: s.sshHost,
      cwd: s.cwd,
      sessionId: s.resolvedSessionId || s.sessionId,
      jsonlPath: s.jsonlPath,
      hasOlder: s.hasOlder,
      loadingOlder: s.loadingOlder,
      claudeRunning: s.claudeRunning,
      tmuxAlive: s.tmuxAlive,
      status: s.status,
      ask: s.ask,
      tail: s.tail,
      permissionMode: s.screenMode || s.jsonlMode || '',
      model: s.model || '',
      effort: s.effort || '',
      launchModel: s.launchModel || '',
      launchEffort: s.launchEffort || '',
      contextUsage: s.contextUsage || null,
      pendingUsers: s.pendingUsers,
      stale: s.stale,
      error: s.lastError || '',
    };
  }

  function sendWs(ws, msg) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }

  function broadcast(s, msg) {
    const raw = JSON.stringify(msg);
    for (const ws of s.clients) {
      if (ws.readyState === 1) {
        try { ws.send(raw); } catch {}
      }
    }
  }

  function stopPollTimer(s) {
    if (s.pollTimer) {
      clearTimeout(s.pollTimer);
      s.pollTimer = null;
    }
  }

  function schedulePoll(s, delayMs = POLL_INTERVAL_MS) {
    stopPollTimer(s);
    if (s.clients.size === 0) return;
    s.pollTimer = setTimeout(() => {
      s.pollTimer = null;
      if (s.clients.size === 0) return;
      pollSession(s, { incremental: s.events.length > 0 || Boolean(s.jsonlPath) })
        .catch(() => {})
        .finally(() => {
          if (s.clients.size > 0 && !s.pollTimer) {
            schedulePoll(s, POLL_INTERVAL_MS);
          }
        });
    }, delayMs);
  }

  function reconcilePendingUsers(s, emittedUsers) {
    if (!s.pendingUsers.length) return false;
    let changed = false;
    const now = Date.now();
    const unmatched = [];
    for (const p of s.pendingUsers) {
      const hit = emittedUsers.some((u) => (
        (!p.normText || u.text.trim() === p.normText || (p.normAttName && u.text.includes(p.normAttName)))
        && (!u.ts || u.ts >= p.createdAt - 10000)
      ));
      if (hit) {
        changed = true;
        continue;
      }
      if (!p.failed && !p.inflight && s.status === 'idle' && (now - (p.sentAt || p.createdAt)) > PENDING_IDLE_TTL_MS) {
        changed = true;
        continue;
      }
      unmatched.push(p);
    }
    if (changed) s.pendingUsers = unmatched;
    return changed;
  }

  async function pollSession(s, { incremental = false, force = false } = {}) {
    if (!s.sshHost) return;
    if (s.pollInflight) {
      if (force) s.pollAgain = true;
      return s.pollInflight;
    }

    const tmuxSess = typeof sanitizeTmuxSessionId === 'function' ? sanitizeTmuxSessionId(s.tabId) : '';
    const claimedPaths = Array.from(sessions.values())
      .filter((o) => o !== s && o.sshHost === s.sshHost && o.jsonlPath)
      .map((o) => o.jsonlPath);

    s.pollInflight = (async () => {
      const r = await readRemoteTranscriptChunk({
        sshHost: s.sshHost,
        sessionId: s.resolvedSessionId || s.sessionId,
        cwd: s.cwd,
        knownPath: incremental ? s.jsonlPath : '',
        knownEnd: incremental ? s.endOffset : 0,
        claimedPaths,
        tmuxSess,
        runCmd,
        sshOpts,
      });

      if (!r || !r.ok) {
        s.stale = true;
        s.lastError = (r && r.error) || '连接节点超时';
        const localTab = activePtyTabs && activePtyTabs.get(s.tabId);
        if (localTab && Array.isArray(localTab.scrollback) && localTab.scrollback.length) {
          const sc = classifyClaudeScreen(localTab.scrollback.slice(-40).join(''));
          s.status = sc.status;
          s.ask = sc.ask;
          s.tail = sc.tail;
          if (sc.permissionMode) s.screenMode = sc.permissionMode;
        }
        broadcast(s, { type: 'state', state: buildPublicState(s) });
        return;
      }

      s.stale = false;
      s.lastError = '';
      s.loadedAt = Date.now();
      s.claudeRunning = Boolean(r.claudeRunning);
      s.tmuxAlive = Boolean(r.tmuxAlive);
      s.launchModel = r.launchModel || '';
      s.launchEffort = r.launchEffort || '';
      if (r.resolvedSessionId) s.resolvedSessionId = r.resolvedSessionId;

      const sc = classifyClaudeScreen(r.paneText || '');
      const stateSigBefore = JSON.stringify({
        claudeRunning: s.claudeRunning,
        status: s.status,
        ask: s.ask,
        tail: s.tail,
        screenMode: s.screenMode,
        jsonlMode: s.jsonlMode,
        model: s.model,
        effort: s.effort,
        contextUsage: s.contextUsage,
        jsonlPath: s.jsonlPath,
      });

      s.status = sc.status;
      s.ask = sc.ask;
      s.tail = sc.tail;
      s.screenMode = sc.permissionMode || '';

      const prevJsonlPath = s.jsonlPath;
      const wasReset = Boolean(
        (r.jsonlPath && (r.reset || !incremental || r.jsonlPath !== prevJsonlPath))
        || (!r.jsonlPath && prevJsonlPath)
      );
      if (wasReset) {
        s.jsonlPath = r.jsonlPath || '';
        s.startOffset = Number(r.chunkStart || 0);
        s.endOffset = Number(r.chunkEnd || 0);
        s.hasOlder = Boolean(r.hasOlder);
        s.histSeq = 1;
        s.histToolNames.clear();
        s.histSeenMsgIds.clear();
        const parsed = parseJsonlRecordsToEvents(r.records || [], {
          startSeq: s.histSeq,
          idPrefix: 'hist',
        });
        s.histSeq = parsed.nextSeq;
        s.histToolNames = parsed.toolNameById;
        s.histSeenMsgIds = parsed.seenMsgIds || new Set();
        if (parsed.meta.model) s.model = parsed.meta.model;
        if (parsed.meta.effort) s.effort = parsed.meta.effort;
        if (parsed.meta.permissionMode) s.jsonlMode = parsed.meta.permissionMode;
        s.contextUsage = parsed.meta.contextUsage || null;
        s.events = parsed.events;
        reconcilePendingUsers(s, parsed.emittedUserTexts);
        broadcast(s, { type: 'snapshot', state: buildPublicState(s), events: s.events });
      } else {
        s.endOffset = Math.max(s.endOffset, Number(r.chunkEnd || s.endOffset));
        const parsed = parseJsonlRecordsToEvents(r.records || [], {
          startSeq: s.histSeq,
          idPrefix: 'hist',
          existingToolNames: s.histToolNames,
          existingSeenMsgIds: s.histSeenMsgIds,
        });
        s.histSeq = parsed.nextSeq;
        for (const [k, v] of parsed.toolNameById) s.histToolNames.set(k, v);
        if (parsed.seenMsgIds) {
          for (const mid of parsed.seenMsgIds) s.histSeenMsgIds.add(mid);
        }
        if (parsed.meta.model) s.model = parsed.meta.model;
        if (parsed.meta.effort) s.effort = parsed.meta.effort;
        if (parsed.meta.permissionMode) s.jsonlMode = parsed.meta.permissionMode;
        if (parsed.meta.contextUsage !== undefined && parsed.meta.contextUsage !== null) {
          s.contextUsage = parsed.meta.contextUsage;
        } else if (parsed.events.some((e) => e.type === 'native.compact')) {
          s.contextUsage = null;
        }
        const pendingChanged = reconcilePendingUsers(s, parsed.emittedUserTexts);
        if (parsed.events.length > 0) {
          s.events.push(...parsed.events);
          for (const ev of parsed.events) {
            broadcast(s, { type: 'event', event: ev });
          }
          if (parsed.events.some((e) => e.type === 'turn.stats') && typeof onSessionActivity === 'function') {
            onSessionActivity({
              nodeId: s.nodeId,
              cwd: s.cwd,
              sessionId: s.resolvedSessionId || s.sessionId,
              title: s.title,
            });
          }
        }

        const stateSigAfter = JSON.stringify({
          claudeRunning: s.claudeRunning,
          status: s.status,
          ask: s.ask,
          tail: s.tail,
          screenMode: s.screenMode,
          jsonlMode: s.jsonlMode,
          model: s.model,
          effort: s.effort,
          contextUsage: s.contextUsage,
          jsonlPath: s.jsonlPath,
        });
        if (pendingChanged || stateSigBefore !== stateSigAfter) {
          broadcast(s, { type: 'state', state: buildPublicState(s) });
        }
      }
    })().finally(() => {
      s.pollInflight = null;
      if (s.pollAgain) {
        s.pollAgain = false;
        schedulePoll(s, 200);
      }
    });

    return s.pollInflight;
  }

  function getOrCreateSession({ tabId, sessionId, cwd, nodeId, sshHost, title, resume }) {
    const resolved = resolveNode(nodeId, sshHost);
    const key = sessionKey(resolved.nodeId, tabId);
    let s = sessions.get(key);
    if (!s) {
      s = {
        key,
        tabId,
        sessionId: sessionId || tabId,
        resolvedSessionId: '',
        cwd: cwd || '/root/work',
        nodeId: resolved.nodeId,
        sshHost: resolved.sshHost,
        title: title || '',
        resume: resume !== false,
        jsonlPath: '',
        startOffset: 0,
        endOffset: 0,
        hasOlder: false,
        loadingOlder: false,
        loadedAt: 0,
        pollInflight: null,
        pollAgain: false,
        pollTimer: null,
        claudeRunning: false,
        tmuxAlive: false,
        stale: false,
        lastError: '',
        events: [],
        histSeq: 1,
        histToolNames: new Map(),
        histSeenMsgIds: new Set(),
        status: 'idle',
        ask: null,
        tail: '',
        screenMode: '',
        jsonlMode: '',
        model: '',
        effort: '',
        launchModel: '',
        launchEffort: '',
        contextUsage: null,
        pendingUsers: [],
        clients: new Set(),
        touchedAt: Date.now(),
      };
      sessions.set(key, s);
    }
    if (cwd) s.cwd = cwd;
    if (title) s.title = title;
    if (resolved.sshHost) s.sshHost = resolved.sshHost;
    s.touchedAt = Date.now();
    return s;
  }

  async function handleCommand(ws, s, msg) {
    if (!msg || typeof msg !== 'object') return;
    s.touchedAt = Date.now();
    const tmuxSess = typeof sanitizeTmuxSessionId === 'function' ? sanitizeTmuxSessionId(s.tabId) : '';
    const type = msg.type;

    if (type === 'ping') {
      sendWs(ws, { type: 'pong', ts: Date.now() });
      return;
    }

    if (type === 'refresh') {
      s.jsonlPath = '';
      s.endOffset = 0;
      await pollSession(s, { incremental: false, force: true });
      return;
    }

    if (type === 'load_older') {
      if (s.loadingOlder || !s.hasOlder || !s.jsonlPath || s.startOffset <= 0) {
        sendWs(ws, { type: 'history.prepended', events: [], hasOlder: false, state: buildPublicState(s) });
        return;
      }
      s.loadingOlder = true;
      broadcast(s, { type: 'state', state: buildPublicState(s) });
      try {
        const added = [];
        let attempts = 0;
        while (attempts < 3 && s.startOffset > 0 && added.length < 15) {
          attempts += 1;
          const r = await readRemoteTranscriptOlder({
            sshHost: s.sshHost,
            jsonlPath: s.jsonlPath,
            beforeOffset: s.startOffset,
            runCmd,
            sshOpts,
          });
          if (!r || !r.ok) {
            if (!added.length) throw new Error((r && r.error) || '加载更早记录失败');
            break;
          }
          const parsed = parseJsonlRecordsToEvents(r.records || [], {
            startSeq: 1,
            idPrefix: `older-${r.chunkStart}`,
          });
          s.startOffset = Math.min(s.startOffset, Number(r.chunkStart || 0));
          s.hasOlder = Boolean(r.hasOlder && s.startOffset > 0);
          if (parsed.events.length) added.unshift(...parsed.events);
        }
        if (added.length) {
          s.events = added.concat(s.events);
        }
        broadcast(s, {
          type: 'history.prepended',
          events: added,
          hasOlder: s.hasOlder,
          state: buildPublicState(s),
        });
      } catch (err) {
        sendWs(ws, { type: 'toast', level: 'error', message: err.message });
      } finally {
        s.loadingOlder = false;
        broadcast(s, { type: 'state', state: buildPublicState(s) });
      }
      return;
    }

    if (type === 'launch_claude') {
      const r = await launchClaudeInTmux({
        sshHost: s.sshHost,
        tabId: s.tabId,
        tmuxSess,
        cwd: s.cwd,
        sessionId: s.sessionId,
        resume: s.resume,
        resolvedSessionId: s.resolvedSessionId,
        jsonlPath: s.jsonlPath,
        activePtyTabs,
        runCmd,
        sshOpts,
      });
      if (!r.ok) {
        sendWs(ws, { type: 'toast', level: 'error', message: r.error || '在终端启动 Claude 失败' });
      } else {
        sendWs(ws, { type: 'toast', level: 'ok', message: `已在终端执行：${r.cmd}` });
        schedulePoll(s, 600);
      }
      return;
    }

    if (type === 'send') {
      const rawText = String(msg.text || '').trim();
      const atts = (Array.isArray(msg.attachments) ? msg.attachments : []).filter((a) => a && a.remotePath);
      if (!rawText && !atts.length) return;

      const attLines = atts.map((a) => `[附件] ${a.remotePath}`);
      const fullText = [rawText, ...attLines].filter(Boolean).join('\n');

      // Use bracketed paste for multi-line, long text, or slash commands
      const usePaste = fullText.includes('\n') || fullText.length > 400 || fullText.startsWith('/');
      const payload = usePaste ? `\x1b[200~${fullText}\x1b[201~` : fullText;
      const enterDelayMs = Math.min(1500, 90 + Math.ceil(fullText.length / 20));

      const pendingEntry = {
        id: msg.clientId || `pending-${Date.now()}`,
        text: rawText || atts.map((a) => `[附件] ${a.name}`).join('\n'),
        normText: rawText,
        normAttName: atts[0] ? atts[0].remotePath : '',
        attachments: atts,
        inflight: true,
        failed: '',
        createdAt: Date.now(),
        sentAt: 0,
      };
      s.pendingUsers.push(pendingEntry);
      broadcast(s, { type: 'state', state: buildPublicState(s) });

      const sent = await sendTmuxInput({
        sshHost: s.sshHost,
        tabId: s.tabId,
        tmuxSess,
        text: payload,
        submitEnter: true,
        enterDelayMs,
        activePtyTabs,
        runCmd,
        sshOpts,
      });

      pendingEntry.inflight = false;
      pendingEntry.sentAt = Date.now();
      if (!sent.ok && sent.stuck) {
        pendingEntry.failed = 'pasting';
        sendWs(ws, { type: 'toast', level: 'error', message: 'Claude Code 一直显示「Pasting…」，消息没有提交，可切到终端查看' });
      } else if (!sent.ok) {
        pendingEntry.failed = 'error';
        sendWs(ws, { type: 'toast', level: 'error', message: sent.error || '发送失败' });
      }
      broadcast(s, { type: 'state', state: buildPublicState(s) });

      if (typeof onSessionActivity === 'function') {
        onSessionActivity({
          nodeId: s.nodeId,
          cwd: s.cwd,
          sessionId: s.resolvedSessionId || s.sessionId,
          title: s.title,
        });
      }
      schedulePoll(s, 300);
      return;
    }

    if (type === 'answer_ask') {
      const keys = buildAskKeys(s.ask, msg.action || {});
      if (!keys) return;
      const r = await sendTmuxInput({
        sshHost: s.sshHost,
        tabId: s.tabId,
        tmuxSess,
        text: keys,
        submitEnter: false,
        activePtyTabs,
        runCmd,
        sshOpts,
      });
      if (!r.ok) sendWs(ws, { type: 'toast', level: 'error', message: r.error || '提交确认失败' });
      schedulePoll(s, 250);
      return;
    }

    if (type === 'interrupt') {
      await sendTmuxInput({
        sshHost: s.sshHost,
        tabId: s.tabId,
        tmuxSess,
        text: '\x1b',
        submitEnter: false,
        activePtyTabs,
        runCmd,
        sshOpts,
      });
      sendWs(ws, { type: 'toast', level: 'ok', message: '已发送 Esc 中断' });
      schedulePoll(s, 300);
      return;
    }

    if (type === 'cycle_permission_mode') {
      const r = await sendTmuxInput({
        sshHost: s.sshHost,
        tabId: s.tabId,
        tmuxSess,
        rawKeys: ['BTab'],
        activePtyTabs,
        runCmd,
        sshOpts,
      });
      if (!r.ok) sendWs(ws, { type: 'toast', level: 'error', message: r.error || '切换权限模式失败' });
      schedulePoll(s, 300);
      return;
    }

    if (type === 'set_model' || type === 'set_effort') {
      if (!s.claudeRunning) {
        sendWs(ws, { type: 'toast', level: 'error', message: '终端中尚未运行 Claude，无法切换' });
        return;
      }
      if (s.status !== 'idle') {
        sendWs(ws, { type: 'toast', level: 'error', message: 'Claude 正在运行中，请等待空闲后再切换' });
        return;
      }
      const cmdName = type === 'set_model' ? '/model' : '/effort';
      const val = String(type === 'set_model' ? (msg.model || '') : (msg.effort || '')).trim();
      if (!val) return;
      const r = await sendTmuxInput({
        sshHost: s.sshHost,
        tabId: s.tabId,
        tmuxSess,
        text: `${cmdName} ${val}`,
        submitEnter: true,
        activePtyTabs,
        runCmd,
        sshOpts,
      });
      if (!r.ok) {
        sendWs(ws, { type: 'toast', level: 'error', message: r.error || `执行 ${cmdName} 失败` });
      } else {
        if (type === 'set_model') s.model = val;
        else s.effort = val;
        broadcast(s, { type: 'state', state: buildPublicState(s) });
      }
      schedulePoll(s, 450);
    }
  }

  function handleConnection(ws, _req, u) {
    const tabId = String(u.searchParams.get('tabId') || '').trim() || 'default';
    const sessionId = String(u.searchParams.get('sessionId') || tabId).trim();
    const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
    const nodeId = String(u.searchParams.get('nodeId') || '').trim();
    const sshHost = String(u.searchParams.get('sshHost') || '').trim();
    const title = String(u.searchParams.get('title') || '').trim();
    const resume = u.searchParams.get('resume') !== '0';

    const s = getOrCreateSession({ tabId, sessionId, cwd, nodeId, sshHost, title, resume });
    s.clients.add(ws);

    sendWs(ws, { type: 'snapshot', state: buildPublicState(s), events: s.events });

    if (s.events.length === 0 || Date.now() - s.loadedAt > 1200) {
      pollSession(s, { incremental: s.events.length > 0 && Boolean(s.jsonlPath) })
        .catch(() => {})
        .finally(() => {
          if (s.clients.size > 0 && !s.pollTimer) schedulePoll(s, POLL_INTERVAL_MS);
        });
    } else {
      schedulePoll(s, POLL_INTERVAL_MS);
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      handleCommand(ws, s, msg).catch((err) => {
        sendWs(ws, { type: 'toast', level: 'error', message: err.message });
      });
    });

    ws.on('close', () => {
      s.clients.delete(ws);
      s.touchedAt = Date.now();
      if (s.clients.size === 0) {
        stopPollTimer(s);
      }
    });
  }

  function closeTab(tabId, explicitNodeId = '') {
    const suffix = `::${tabId}`;
    for (const [key, s] of sessions) {
      if (explicitNodeId ? key === sessionKey(explicitNodeId, tabId) : key.endsWith(suffix)) {
        stopPollTimer(s);
        for (const ws of s.clients) {
          try { ws.close(); } catch {}
        }
        s.clients.clear();
        sessions.delete(key);
      }
    }
  }

  return {
    handleConnection,
    closeTab,
    getSession: (nodeId, tabId) => sessions.get(sessionKey(nodeId, tabId)) || null,
  };
}

module.exports = {
  createChatHub,
};
