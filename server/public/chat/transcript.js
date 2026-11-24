(function () {
  'use strict';

  function mergeInput(prev, next) {
    if (!next || typeof next !== 'object') return prev || {};
    if (!prev || typeof prev !== 'object') return { ...next };
    return { ...prev, ...next };
  }

  function transcript(events) {
    const items = [];
    const toolsById = new Map();
    const pendingApprovals = new Map();
    const deliveryByClientId = new Map();
    const activeTasksMap = new Map();
    let runState = 'idle';
    let contextUsage = null;
    const sessionMeta = {
      claudeSessionId: '',
      model: '',
      cwd: '',
      permissionMode: '',
      tools: [],
      slashCommands: [],
      totalCostUsd: null,
    };

    const appendText = (kind, text, ts, id) => {
      if (!text) return;
      const last = items[items.length - 1];
      if (last && last.kind === kind) {
        last.text += text;
        last.ts = ts || last.ts;
        return;
      }
      items.push({
        kind,
        id: id || `${kind}-${items.length}`,
        text,
        ts: ts || 0,
        active: kind === 'thinking',
      });
    };

    const closeActiveThinking = () => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === 'thinking') {
          if (items[i].active) items[i].active = false;
          else break;
        }
      }
    };

    const list = Array.isArray(events) ? events : [];
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      if (!ev || typeof ev !== 'object') continue;
      const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
      const ts = Number(ev.ts || 0);

      switch (ev.type) {
        case 'message.user': {
          closeActiveThinking();
          items.push({
            kind: 'user',
            id: p.uuid || p.clientId || ev.id || `u-${i}`,
            clientId: p.clientId || '',
            text: String(p.text || ''),
            attachments: Array.isArray(p.attachments) ? p.attachments : [],
            images: Array.isArray(p.images) ? p.images : [],
            ts,
          });
          break;
        }
        case 'message.delivery': {
          if (p.clientId) {
            deliveryByClientId.set(p.clientId, { state: p.state || '', error: p.error || '' });
          }
          break;
        }
        case 'thinking.delta': {
          if (p.parentToolUseId) break;
          appendText('thinking', String(p.text || ''), ts, ev.id);
          break;
        }
        case 'text.delta': {
          if (p.parentToolUseId) break;
          closeActiveThinking();
          appendText('text', String(p.text || ''), ts, ev.id);
          break;
        }
        case 'tool.requested': {
          const id = String(p.toolUseId || ev.id || `tool-${i}`);
          const toolObj = {
            kind: 'tool',
            id,
            toolName: String(p.toolName || 'Tool'),
            input: p.input && typeof p.input === 'object' ? { ...p.input } : {},
            rawInputJson: '',
            status: 'running',
            output: '',
            images: [],
            isError: false,
            elapsedSeconds: 0,
            task: null,
            subtools: [],
            approval: null,
            startedAt: ts,
            finishedAt: null,
            parentToolUseId: p.parentToolUseId || null,
          };
          toolsById.set(id, toolObj);
          if (p.parentToolUseId && toolsById.has(p.parentToolUseId)) {
            toolsById.get(p.parentToolUseId).subtools.push(toolObj);
          } else {
            closeActiveThinking();
            items.push(toolObj);
          }
          break;
        }
        case 'tool.input.delta': {
          const tool = p.toolUseId ? toolsById.get(p.toolUseId) : null;
          if (tool && typeof p.partialJson === 'string') {
            tool.rawInputJson += p.partialJson;
          }
          break;
        }
        case 'tool.input': {
          const tool = p.toolUseId ? toolsById.get(p.toolUseId) : null;
          if (tool && p.input && typeof p.input === 'object') {
            tool.input = mergeInput(tool.input, p.input);
          }
          break;
        }
        case 'tool.progress': {
          const tool = p.toolUseId ? toolsById.get(p.toolUseId) : null;
          if (tool && Number.isFinite(Number(p.elapsedSeconds))) {
            tool.elapsedSeconds = Number(p.elapsedSeconds);
          }
          break;
        }
        case 'tool.task': {
          const tool = p.toolUseId ? toolsById.get(p.toolUseId) : null;
          if (tool) {
            tool.task = {
              ...(tool.task || {}),
              taskId: p.taskId || (tool.task && tool.task.taskId) || '',
              status: p.status || '',
              description: p.description || (tool.task && tool.task.description) || '',
              summary: p.summary || (tool.task && tool.task.summary) || '',
              lastToolName: p.lastToolName || (tool.task && tool.task.lastToolName) || '',
              outputFile: p.outputFile || (tool.task && tool.task.outputFile) || '',
            };
          }
          if (p.taskId) {
            if (p.status === 'started' || p.status === 'progress') {
              activeTasksMap.set(p.taskId, {
                taskId: p.taskId,
                toolUseId: p.toolUseId || null,
                description: p.description || p.summary || '',
                summary: p.summary || '',
                lastToolName: p.lastToolName || '',
                status: 'running',
              });
            } else {
              activeTasksMap.delete(p.taskId);
            }
          }
          break;
        }
        case 'tool.result': {
          const tool = p.toolUseId ? toolsById.get(p.toolUseId) : null;
          if (tool) {
            tool.output = String(p.output || '');
            tool.isError = Boolean(p.isError);
            tool.status = tool.isError ? 'error' : 'done';
            tool.images = Array.isArray(p.images) ? p.images : [];
            tool.finishedAt = ts || tool.finishedAt;
          }
          break;
        }
        case 'approval.requested': {
          const aid = String(p.approvalId || ev.id);
          let tool = p.toolUseId ? toolsById.get(p.toolUseId) : null;
          if (!tool) {
            tool = {
              kind: 'tool',
              id: String(p.toolUseId || aid),
              toolName: String(p.toolName || 'Tool'),
              input: p.input && typeof p.input === 'object' ? { ...p.input } : {},
              rawInputJson: '',
              status: 'running',
              output: '',
              images: [],
              isError: false,
              elapsedSeconds: 0,
              task: null,
              subtools: [],
              approval: null,
              startedAt: ts,
              finishedAt: null,
              parentToolUseId: null,
            };
            toolsById.set(tool.id, tool);
            items.push(tool);
          } else if (p.input && typeof p.input === 'object' && Object.keys(p.input).length) {
            tool.input = mergeInput(tool.input, p.input);
          }
          tool.approval = {
            approvalId: aid,
            toolUseId: tool.id,
            toolName: tool.toolName,
            reason: p.reason || '',
            reasonType: p.reasonType || '',
            suggestions: Array.isArray(p.suggestions) ? p.suggestions : [],
            status: 'pending',
          };
          pendingApprovals.set(aid, tool);
          break;
        }
        case 'approval.resolved': {
          const aid = String(p.approvalId || '');
          let tool = aid && pendingApprovals.get(aid);
          if (!tool && p.toolUseId) tool = toolsById.get(p.toolUseId);
          if (aid) pendingApprovals.delete(aid);
          if (tool) {
            tool.approval = {
              ...(tool.approval || {}),
              approvalId: aid || (tool.approval && tool.approval.approvalId) || '',
              status: 'resolved',
              decision: p.decision || 'allow',
              answers: p.answers,
              targetMode: p.targetMode,
              feedback: p.feedback,
              plan: p.plan,
            };
            if (typeof p.plan === 'string' && p.plan.trim() && tool.input) {
              tool.input.plan = p.plan;
            }
          }
          break;
        }
        case 'native.compact': {
          closeActiveThinking();
          const last = items[items.length - 1];
          if (last && last.kind === 'compact' && last.status === 'compacting' && p.status === 'completed') {
            last.status = 'completed';
            last.trigger = p.trigger || last.trigger;
            last.preTokens = Number(p.preTokens || last.preTokens || 0);
            last.ts = ts || last.ts;
          } else {
            items.push({
              kind: 'compact',
              id: ev.id || `cmp-${i}`,
              status: p.status || 'completed',
              trigger: p.trigger || 'auto',
              preTokens: Number(p.preTokens || 0),
              ts,
            });
          }
          break;
        }
        case 'native.notice': {
          items.push({
            kind: 'notice',
            id: ev.id || `notice-${i}`,
            noticeKind: p.kind || 'info',
            text: String(p.text || ''),
            detail: String(p.detail || ''),
            ts,
          });
          break;
        }
        case 'native.tasks': {
          activeTasksMap.clear();
          for (const t of (Array.isArray(p.tasks) ? p.tasks : [])) {
            if (t && t.taskId) activeTasksMap.set(t.taskId, t);
          }
          break;
        }
        case 'native.context': {
          contextUsage = p;
          break;
        }
        case 'native.session': {
          if (p.claudeSessionId) sessionMeta.claudeSessionId = p.claudeSessionId;
          if (p.model) sessionMeta.model = p.model;
          if (p.cwd) sessionMeta.cwd = p.cwd;
          if (p.permissionMode) sessionMeta.permissionMode = p.permissionMode;
          if (Array.isArray(p.tools) && p.tools.length) sessionMeta.tools = p.tools;
          if (Array.isArray(p.slashCommands) && p.slashCommands.length) sessionMeta.slashCommands = p.slashCommands;
          break;
        }
        case 'native.mode': {
          if (p.permissionMode) sessionMeta.permissionMode = p.permissionMode;
          break;
        }
        case 'native.metrics': {
          if (typeof p.totalCostUsd === 'number') sessionMeta.totalCostUsd = p.totalCostUsd;
          break;
        }
        case 'turn.stats': {
          closeActiveThinking();
          items.push({ kind: 'stats', id: ev.id || `stats-${i}`, stats: p, ts });
          break;
        }
        case 'run.status': {
          runState = p.state || 'idle';
          if (runState !== 'running') closeActiveThinking();
          break;
        }
        case 'run.error': {
          closeActiveThinking();
          items.push({
            kind: 'error',
            id: ev.id || `err-${i}`,
            message: String(p.message || '执行失败'),
            ts,
          });
          break;
        }
        default:
          break;
      }
    }

    return {
      items,
      pendingApprovals,
      deliveryByClientId,
      activeTasks: Array.from(activeTasksMap.values()),
      runState,
      contextUsage,
      sessionMeta,
    };
  }

  function isPlanFileWrite(item) {
    if (!item || item.kind !== 'tool' || item.toolName !== 'Write') return false;
    const fp = String((item.input && item.input.file_path) || '');
    return /\/\.claude\/plans\/[^/]+\.md$/i.test(fp);
  }

  function isInteractiveCardTool(item) {
    return Boolean(item && item.kind === 'tool' && (
      item.toolName === 'AskUserQuestion'
      || item.toolName === 'ExitPlanMode'
      || isPlanFileWrite(item)
    ));
  }

  function normalizeTodoStatus(raw) {
    const s = String(raw || '').toLowerCase();
    if (s === 'completed' || s === 'done') return 'completed';
    if (s === 'in_progress' || s === 'in-progress' || s === 'running') return 'in_progress';
    if (s === 'deleted') return 'deleted';
    return 'pending';
  }

  function extractTodos(items) {
    let todos = [];
    let taskSeq = 1;
    for (const it of items) {
      if (!it || it.kind !== 'tool') continue;
      const inp = it.input && typeof it.input === 'object' ? it.input : {};
      if (it.toolName === 'TodoWrite' && Array.isArray(inp.todos)) {
        todos = inp.todos
          .filter((x) => x && (x.content || x.step || x.title))
          .map((x, idx) => ({
            id: String(x.id || `td-${idx}`),
            content: String(x.content || x.step || x.title || ''),
            status: normalizeTodoStatus(x.status),
            activeForm: String(x.activeForm || ''),
          }))
          .filter((x) => x.status !== 'deleted');
      } else if (/(?:^|_)update_plan$/i.test(String(it.toolName || '')) && Array.isArray(inp.items)) {
        todos = inp.items
          .filter((x) => x && (x.content || x.step || x.title))
          .map((x, idx) => ({
            id: String(x.id || `plan-${idx}`),
            content: String(x.content || x.step || x.title || ''),
            status: normalizeTodoStatus(x.status),
            activeForm: '',
          }))
          .filter((x) => x.status !== 'deleted');
      } else if (it.toolName === 'TaskCreate') {
        const content = String(inp.subject || inp.description || '').trim();
        if (content) {
          todos.push({
            id: String(inp.taskId || taskSeq++),
            content,
            status: normalizeTodoStatus(inp.status),
            activeForm: String(inp.activeForm || ''),
          });
        }
      } else if (it.toolName === 'TaskUpdate') {
        const tid = inp.taskId != null ? String(inp.taskId) : '';
        const subj = inp.subject ? String(inp.subject) : '';
        const target = todos.find((x) => (tid && x.id === tid) || (subj && x.content === subj));
        if (target) {
          if (inp.status) target.status = normalizeTodoStatus(inp.status);
          if (inp.subject) target.content = String(inp.subject);
          if (inp.activeForm) target.activeForm = String(inp.activeForm);
          if (target.status === 'deleted') {
            todos = todos.filter((x) => x !== target);
          }
        }
      }
    }
    return todos;
  }

  function countWorkSteps(parts) {
    let steps = 0;
    let notes = 0;
    for (const part of parts) {
      if (part.kind === 'work') steps += part.tools.length;
      else if (part.kind === 'text' || part.kind === 'thinking') notes += 1;
    }
    return { steps, notes };
  }

  function conversation(events) {
    const t = transcript(events);
    const turns = [];
    let current = null;

    const ensureTurn = (seedItem, idx) => {
      if (!current) {
        current = {
          id: `turn-${(seedItem && seedItem.id) || idx}`,
          user: null,
          rawItems: [],
          startedAt: (seedItem && seedItem.ts) || 0,
          finishedAt: 0,
          stats: null,
          errors: [],
          active: false,
          heldOpen: false,
          hasError: false,
        };
        turns.push(current);
      }
      return current;
    };

    for (let i = 0; i < t.items.length; i++) {
      const item = t.items[i];
      if (item.kind === 'user') {
        current = {
          id: `turn-${item.id}`,
          user: {
            ...item,
            delivery: item.clientId ? (t.deliveryByClientId.get(item.clientId) || null) : null,
          },
          rawItems: [],
          startedAt: item.ts || 0,
          finishedAt: 0,
          stats: null,
          errors: [],
          active: false,
          heldOpen: false,
          hasError: false,
        };
        turns.push(current);
        continue;
      }

      const turn = ensureTurn(item, i);
      if (item.kind === 'stats') {
        turn.stats = item.stats;
        if (item.ts) turn.finishedAt = item.ts;
      } else if (item.kind === 'error') {
        turn.errors.push(item);
        turn.hasError = true;
        if (item.ts) turn.finishedAt = item.ts;
      } else {
        turn.rawItems.push(item);
        if (item.ts) turn.finishedAt = Math.max(turn.finishedAt || 0, item.ts);
      }
    }

    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti];
      const isLast = ti === turns.length - 1;
      turn.active = Boolean(isLast && t.runState === 'running');

      const raw = turn.rawItems;
      // Closing prose is the trailing text block at the end (preserving any post-reply notices after it)
      let closing = null;
      let bodyEnd = raw.length;
      const trailingNotices = [];
      while (bodyEnd > 0 && raw[bodyEnd - 1].kind === 'notice') {
        trailingNotices.unshift(raw[bodyEnd - 1]);
        bodyEnd -= 1;
      }
      if (bodyEnd > 0 && raw[bodyEnd - 1].kind === 'text') {
        closing = raw[bodyEnd - 1];
        bodyEnd -= 1;
      } else {
        bodyEnd = raw.length;
        trailingNotices.length = 0;
      }
      turn.closing = closing;
      turn.trailingNotices = trailingNotices;

      // Segment body into process groups vs standalone QuestionCard / PlanCard / Compact / Notice
      const segments = [];
      let procBuf = [];
      let workBuf = null;

      const flushWork = () => {
        if (workBuf && workBuf.tools.length) {
          procBuf.push(workBuf);
          workBuf = null;
        }
      };

      const flushProc = (segIdx) => {
        flushWork();
        if (!procBuf.length) return;
        const { steps, notes } = countWorkSteps(procBuf);
        const hasPendingTool = procBuf.some((p) => {
          if (p.kind === 'work') {
            return p.tools.some((tl) => tl.status === 'running' || (tl.approval && tl.approval.status === 'pending'));
          }
          return Boolean(p.active);
        });
        const hasPendingApproval = procBuf.some((p) =>
          p.kind === 'work' && p.tools.some((tl) => tl.approval && tl.approval.status === 'pending')
        );
        if (hasPendingApproval) turn.heldOpen = true;
        segments.push({
          kind: 'process',
          id: `${turn.id}:proc:${segIdx}`,
          parts: procBuf,
          steps,
          notes,
          hasPendingTool,
          hasPendingApproval,
        });
        procBuf = [];
      };

      for (let idx = 0; idx < bodyEnd; idx++) {
        const it = raw[idx];
        if (isInteractiveCardTool(it)) {
          flushProc(idx);
          if (it.approval && it.approval.status === 'pending') {
            turn.heldOpen = true;
          }
          segments.push({
            kind: it.toolName === 'AskUserQuestion' ? 'question' : 'plan',
            id: `${turn.id}:${it.id}`,
            tool: it,
          });
        } else if (it.kind === 'compact' || it.kind === 'notice') {
          flushProc(idx);
          segments.push(it);
        } else if (it.kind === 'tool') {
          if (!workBuf) {
            workBuf = { kind: 'work', id: `${turn.id}:work:${it.id}`, tools: [] };
          }
          workBuf.tools.push(it);
          if (it.approval && it.approval.status === 'pending') {
            turn.heldOpen = true;
          }
        } else {
          flushWork();
          procBuf.push(it);
        }
      }
      flushProc(bodyEnd);

      // Compute turn total elapsed duration for the process summary
      const durationMs = turn.stats && Number(turn.stats.durationMs) > 0
        ? Number(turn.stats.durationMs)
        : (turn.startedAt && turn.finishedAt && turn.finishedAt > turn.startedAt
          ? turn.finishedAt - turn.startedAt
          : 0);
      turn.durationMs = durationMs;
      turn.segments = segments;
      delete turn.rawItems;
    }

    return {
      turns,
      todos: extractTodos(t.items),
      pendingApprovals: t.pendingApprovals,
      activeTasks: t.activeTasks,
      runState: t.runState,
      contextUsage: t.contextUsage,
      sessionMeta: t.sessionMeta,
    };
  }

  window.TaktChatTranscript = {
    transcript,
    conversation,
  };
})();
