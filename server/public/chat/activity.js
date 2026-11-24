(function () {
  'use strict';

  const PERMISSION_MODES = [
    {
      id: 'auto',
      label: '自动审批',
      shortLabel: '自动审批',
      desc: '自动放行安全工具调用，仅高风险操作询问',
      danger: false,
    },
    {
      id: 'default',
      label: '手动审批',
      shortLabel: '手动审批',
      desc: '每次写文件或运行命令前都由你确认',
      danger: false,
    },
    {
      id: 'acceptEdits',
      label: '接受编辑',
      shortLabel: '接受编辑',
      desc: '自动允许编辑与新建文件，命令仍需确认',
      danger: false,
    },
    {
      id: 'plan',
      label: '计划模式',
      shortLabel: '计划模式',
      desc: '先只读调研并制定计划，批准后再执行',
      danger: false,
    },
    {
      id: 'bypassPermissions',
      label: '绕过权限',
      shortLabel: '绕过权限',
      desc: '跳过全部权限检查（root 账户受 CLI 限制不可用）',
      danger: true,
    },
  ];

  const PERMISSION_MAP = new Map(PERMISSION_MODES.map((m) => [m.id, m]));

  function getPermissionModeMeta(id) {
    return PERMISSION_MAP.get(id) || PERMISSION_MODES[0];
  }

  function basename(p) {
    if (typeof p !== 'string' || !p) return '';
    const clean = p.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    return parts[parts.length - 1] || clean || p;
  }

  function trimOne(s, max = 72) {
    if (typeof s !== 'string') return '';
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  }

  function countLines(str) {
    if (typeof str !== 'string' || !str) return 0;
    return str.split('\n').length;
  }

  function diffCounts(oldStr, newStr) {
    const a = typeof oldStr === 'string' && oldStr ? oldStr.split('\n') : [];
    const b = typeof newStr === 'string' && newStr ? newStr.split('\n') : [];
    if (!a.length && !b.length) return { added: 0, removed: 0 };
    if (!a.length) return { added: b.length, removed: 0 };
    if (!b.length) return { added: 0, removed: a.length };

    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
      tail < (a.length - head)
      && tail < (b.length - head)
      && a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
      tail++;
    }
    return {
      removed: Math.max(0, a.length - head - tail),
      added: Math.max(0, b.length - head - tail),
    };
  }

  function parseHostname(rawUrl) {
    try {
      return new URL(String(rawUrl || '')).hostname;
    } catch {
      return trimOne(rawUrl, 60);
    }
  }

  function formatMcpName(name) {
    const clean = String(name || '').replace(/^mcp__/, '');
    const parts = clean.split('__');
    if (parts.length >= 2) return `${parts[0]} · ${parts.slice(1).join('/')}`;
    return clean;
  }

  function describe(tool, active = false) {
    const name = (tool && tool.toolName) || 'Tool';
    const inp = (tool && tool.input && typeof tool.input === 'object') ? tool.input : {};

    switch (name) {
      case 'Read': {
        const target = basename(inp.file_path || inp.path);
        const detail = inp.offset || inp.limit
          ? `L${inp.offset || 1}${inp.limit ? `–${Number(inp.offset || 1) + Number(inp.limit) - 1}` : ''}`
          : '';
        return {
          category: 'read',
          verb: active ? '正在读取' : '读取',
          target,
          filePath: inp.file_path || inp.path || '',
          detail,
          added: 0,
          removed: 0,
        };
      }
      case 'Edit': {
        const d = diffCounts(inp.old_string, inp.new_string);
        return {
          category: 'edit',
          verb: active ? '正在编辑' : '编辑',
          target: basename(inp.file_path),
          filePath: inp.file_path || '',
          detail: '',
          added: d.added,
          removed: d.removed,
        };
      }
      case 'MultiEdit': {
        const edits = Array.isArray(inp.edits) ? inp.edits : [];
        let added = 0;
        let removed = 0;
        for (const e of edits) {
          if (!e || typeof e !== 'object') continue;
          const d = diffCounts(e.old_string, e.new_string);
          added += d.added;
          removed += d.removed;
        }
        return {
          category: 'edit',
          verb: active ? '正在批量编辑' : '批量编辑',
          target: basename(inp.file_path),
          filePath: inp.file_path || '',
          detail: edits.length ? `${edits.length} 处` : '',
          added,
          removed,
        };
      }
      case 'Write': {
        const lines = countLines(inp.content);
        return {
          category: 'write',
          verb: active ? '正在写入' : '写入',
          target: basename(inp.file_path),
          filePath: inp.file_path || '',
          detail: '',
          added: lines,
          removed: 0,
        };
      }
      case 'NotebookEdit':
        return {
          category: 'edit',
          verb: active ? '正在编辑 Notebook' : '编辑 Notebook',
          target: basename(inp.notebook_path),
          filePath: inp.notebook_path || '',
          detail: inp.edit_mode || '',
          added: countLines(inp.new_source),
          removed: 0,
        };
      case 'Bash':
      case 'bash':
      case 'mcp__magpie__Bash':
        return {
          category: 'bash',
          verb: active ? '正在执行' : '执行',
          target: trimOne(inp.description || inp.command, 88),
          filePath: '',
          detail: inp.description && inp.command ? trimOne(inp.command, 60) : '',
          added: 0,
          removed: 0,
        };
      case 'mcp__mac-industrial__mac_host_exec':
        return {
          category: 'bash',
          verb: active ? '正在执行 Mac 命令' : 'Mac 执行',
          target: trimOne(inp.command || inp.description, 88),
          filePath: '',
          detail: inp.cwd ? basename(inp.cwd) : '',
          added: 0,
          removed: 0,
        };
      case 'Monitor':
        return {
          category: 'bash',
          verb: active ? '正在监听' : '监听',
          target: trimOne(inp.description || inp.command, 80),
          filePath: '',
          detail: inp.description && inp.command ? trimOne(inp.command, 60) : '',
          added: 0,
          removed: 0,
        };
      case 'Skill':
        return {
          category: 'skill',
          verb: active ? '正在加载技能' : '加载技能',
          target: String(inp.skill || ''),
          filePath: '',
          detail: trimOne(inp.args, 48),
          added: 0,
          removed: 0,
        };
      case 'SendMessage':
        return {
          category: 'agent',
          verb: active ? '正在发消息给子代理' : '发消息给子代理',
          target: trimOne(inp.summary || inp.to, 72),
          filePath: '',
          detail: inp.summary && inp.to ? String(inp.to) : '',
          added: 0,
          removed: 0,
        };
      case 'TaskStop':
        return {
          category: 'other',
          verb: '停止后台任务',
          target: String(inp.task_id || ''),
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'EnterWorktree':
        return {
          category: 'other',
          verb: '切换工作树',
          target: String(inp.name || ''),
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'Grep':
        return {
          category: 'search',
          verb: active ? '正在搜索' : '搜索',
          target: trimOne(inp.pattern, 64),
          filePath: inp.path || '',
          detail: inp.path ? basename(inp.path) : '',
          added: 0,
          removed: 0,
        };
      case 'Glob':
        return {
          category: 'search',
          verb: active ? '正在查找文件' : '查找文件',
          target: trimOne(inp.pattern, 64),
          filePath: inp.path || '',
          detail: inp.path ? basename(inp.path) : '',
          added: 0,
          removed: 0,
        };
      case 'Agent':
      case 'Task': {
        const subLast = tool.task && tool.task.lastToolName ? `· ${tool.task.lastToolName}` : '';
        return {
          category: 'agent',
          verb: active ? '子代理执行中' : '子代理',
          target: trimOne(inp.description || inp.subagent_type || inp.prompt, 72),
          filePath: '',
          detail: subLast || (inp.subagent_type ? String(inp.subagent_type) : ''),
          added: 0,
          removed: 0,
        };
      }
      case 'WebFetch':
        return {
          category: 'web',
          verb: active ? '正在抓取网页' : '抓取网页',
          target: parseHostname(inp.url),
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'WebSearch':
        return {
          category: 'web',
          verb: active ? '正在联网搜索' : '联网搜索',
          target: trimOne(inp.query, 72),
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'TodoWrite': {
        const todos = Array.isArray(inp.todos) ? inp.todos : [];
        const doneCount = todos.filter((x) => x && x.status === 'completed').length;
        return {
          category: 'plan',
          verb: active ? '正在更新任务列表' : '更新任务列表',
          target: todos.length ? `${doneCount}/${todos.length} 项` : '',
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      }
      case 'TaskCreate':
        return {
          category: 'plan',
          verb: '新建任务',
          target: trimOne(inp.subject || inp.description, 72),
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'TaskUpdate':
        return {
          category: 'plan',
          verb: '更新计划',
          target: trimOne(inp.subject || (inp.taskId ? `#${inp.taskId}${inp.status ? ` → ${inp.status}` : ''}` : inp.status), 72),
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'AskUserQuestion':
        return {
          category: 'question',
          verb: '询问问题',
          target: '',
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'ExitPlanMode':
        return {
          category: 'plan',
          verb: '提交计划等待审批',
          target: '',
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      case 'EnterPlanMode':
        return {
          category: 'plan',
          verb: '进入计划模式',
          target: '',
          filePath: '',
          detail: '',
          added: 0,
          removed: 0,
        };
      default: {
        if (/(?:^|_)update_plan$/i.test(name)) {
          const items = Array.isArray(inp.items) ? inp.items : [];
          const doneCount = items.filter((x) => x && x.status === 'completed').length;
          return {
            category: 'plan',
            verb: active ? '正在更新计划' : '更新计划',
            target: items.length ? `${doneCount}/${items.length} 步` : '',
            filePath: '',
            detail: '',
            added: 0,
            removed: 0,
          };
        }
        const label = name.startsWith('mcp__') ? formatMcpName(name) : name;
        const target = basename(inp.file_path || inp.path) || trimOne(inp.command || inp.query || inp.pattern || inp.url || inp.description, 72);
        return {
          category: 'other',
          verb: label,
          target,
          filePath: inp.file_path || inp.path || '',
          detail: '',
          added: 0,
          removed: 0,
        };
      }
    }
  }

  function summarize(tools, active) {
    const list = Array.isArray(tools) ? tools : [];
    if (!list.length) return '';
    if (active) {
      const running = list.filter((t) => t.status === 'running' || (t.approval && t.approval.status === 'pending'));
      const cur = running[running.length - 1] || list[list.length - 1];
      const d = describe(cur, true);
      const countNote = list.length > 1 ? `（第 ${list.length} 步）` : '';
      return `${d.verb}${d.target ? ` ${d.target}` : ''}${countNote}`;
    }

    const counts = {
      read: 0,
      edit: 0,
      write: 0,
      bash: 0,
      search: 0,
      agent: 0,
      web: 0,
      skill: 0,
      plan: 0,
      other: 0,
    };
    let errs = 0;
    for (const t of list) {
      if (t.isError || t.status === 'error') errs += 1;
      const c = describe(t, false).category;
      if (Object.prototype.hasOwnProperty.call(counts, c)) counts[c] += 1;
      else counts.other += 1;
    }

    const parts = [];
    if (counts.read) parts.push(`读取 ${counts.read} 个文件`);
    if (counts.search) parts.push(`搜索 ${counts.search} 次`);
    if (counts.edit) parts.push(`编辑 ${counts.edit} 处`);
    if (counts.write) parts.push(`写入 ${counts.write} 个文件`);
    if (counts.bash) parts.push(`执行 ${counts.bash} 条命令`);
    if (counts.agent) parts.push(`运行 ${counts.agent} 个子代理`);
    if (counts.web) parts.push(`检索网页 ${counts.web} 次`);
    if (counts.skill) parts.push(`加载 ${counts.skill} 个技能`);
    if (counts.plan) parts.push('更新计划');
    if (counts.other) parts.push(`${counts.other} 个工具调用`);
    if (errs) parts.push(`${errs} 项失败`);
    return parts.join(' · ') || `${list.length} 个操作`;
  }

  function duration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1000) return `${Math.round(n)}ms`;
    const sec = n / 1000;
    if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  function formatTokens(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v >= 1000000) {
      const m = v / 1000000;
      return `${Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m) : m.toFixed(1)}M`;
    }
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k`;
    return String(Math.round(v));
  }

  function formatModelName(id) {
    const s = String(id || '').trim();
    if (!s) return '默认模型';
    return s
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '')
      .replace(/(\d)-(\d)/g, '$1.$2')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  window.TaktChatActivity = {
    PERMISSION_MODES,
    getPermissionModeMeta,
    describe,
    summarize,
    duration,
    formatTokens,
    formatModelName,
    basename,
  };
})();
