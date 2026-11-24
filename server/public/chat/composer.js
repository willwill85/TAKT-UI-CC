(function () {
  'use strict';

  const FALLBACK_COMMANDS = [
    { name: 'clear', description: '清空当前对话上下文（开始新会话）' },
    { name: 'compact', description: '压缩对话上下文，节省 Token' },
    { name: 'resume', description: '恢复历史会话（会切回终端选择）' },
    { name: 'model', description: '切换模型（会切回终端选择）' },
    { name: 'status', description: '查看会话与账户状态' },
    { name: 'cost', description: '查看本次会话的 Token 与费用' },
    { name: 'context', description: '查看上下文占用' },
    { name: 'diff', description: '查看未提交的 Git 变更' },
    { name: 'review', description: '审查当前代码变更' },
    { name: 'init', description: '为项目生成 / 更新 CLAUDE.md' },
    { name: 'memory', description: '编辑 CLAUDE.md 记忆' },
    { name: 'permissions', description: '查看或修改工具权限（会切回终端）' },
    { name: 'mcp', description: '管理 MCP 服务（会切回终端）' },
    { name: 'doctor', description: '诊断 Claude Code 环境' },
    { name: 'help', description: '显示内置命令帮助' },
  ];

  const TUI_PICKER_SLASH_RE = /^\/(resume|permissions|theme|config|mcp|agents|hooks|vim|login|logout|rewind|export)\b/i;

  function createComposerView({ mountEl, actions }) {
    const Act = window.TaktChatActivity;
    const Md = window.TaktChatMarkdown;

    mountEl.innerHTML = `
      <div class="cc-composer">
        <div class="cc-composer-inner">
          <div class="cc-slash-menu scroller" hidden></div>

          <div class="cc-composer-box">
            <div class="cc-attach-strip" hidden></div>
            <textarea
              class="cc-input"
              rows="1"
              placeholder="给 Claude 发消息… 输入 / 查看命令，支持粘贴或拖入图片和文件"
            ></textarea>
            <div class="cc-composer-foot">
              <div class="cc-foot-left">
                <button type="button" class="cc-pick-btn cc-perm-btn" title="切换终端 Claude 权限模式 (⇧Tab)">
                  <span class="cc-perm-dot"></span>
                  <span class="cc-perm-label">默认模式</span>
                  <span class="cc-perm-kbd">⇧Tab</span>
                </button>

                <div class="cc-pick cc-model-pick">
                  <button type="button" class="cc-pick-btn cc-model-btn" aria-haspopup="true" aria-expanded="false">
                    <span class="cc-model-label">模型</span>
                    <svg class="cc-pick-chev" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="cc-popover cc-model-menu scroller" hidden></div>
                </div>

                <div class="cc-pick cc-effort-pick">
                  <button type="button" class="cc-pick-btn cc-effort-btn" aria-haspopup="true" aria-expanded="false">
                    <span class="cc-effort-label">effort</span>
                    <svg class="cc-pick-chev" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="cc-popover cc-effort-menu scroller" hidden></div>
                </div>
              </div>

              <div class="cc-foot-right">
                <div class="cc-usage-rings" hidden></div>
                <div class="cc-pick cc-ctx-pick">
                  <button type="button" class="cc-ctx-btn" title="上下文占用（根据对话记录估算）" hidden>
                    <svg class="cc-ctx-svg" viewBox="0 0 24 24">
                      <circle class="cc-ctx-track" cx="12" cy="12" r="9" />
                      <circle class="cc-ctx-arc" cx="12" cy="12" r="9" />
                    </svg>
                    <span class="cc-ctx-pct">0%</span>
                  </button>
                  <div class="cc-popover cc-ctx-menu" hidden></div>
                </div>

                <button type="button" class="cc-icon-toggle cc-expand-all-btn" title="切换展开 / 折叠过程步骤">
                  <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
                </button>

                <button type="button" class="cc-btn cc-btn--danger cc-stop-btn" hidden>■ 中断</button>
                <button type="button" class="cc-send-btn" disabled>
                  <span class="cc-send-lbl">发送</span>
                  <span class="cc-send-kbd">↵</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const slashMenu = mountEl.querySelector('.cc-slash-menu');
    const composerBox = mountEl.querySelector('.cc-composer-box');
    const attachStrip = mountEl.querySelector('.cc-attach-strip');
    const textarea = mountEl.querySelector('.cc-input');
    const permBtn = mountEl.querySelector('.cc-perm-btn');
    const permDot = mountEl.querySelector('.cc-perm-dot');
    const permLabel = mountEl.querySelector('.cc-perm-label');
    const modelBtn = mountEl.querySelector('.cc-model-btn');
    const modelLabel = mountEl.querySelector('.cc-model-label');
    const modelMenu = mountEl.querySelector('.cc-model-menu');
    const effortBtn = mountEl.querySelector('.cc-effort-btn');
    const effortLabel = mountEl.querySelector('.cc-effort-label');
    const effortMenu = mountEl.querySelector('.cc-effort-menu');
    const usageRingsEl = mountEl.querySelector('.cc-usage-rings');
    const ctxBtn = mountEl.querySelector('.cc-ctx-btn');
    const ctxArc = mountEl.querySelector('.cc-ctx-arc');
    const ctxPct = mountEl.querySelector('.cc-ctx-pct');
    const ctxMenu = mountEl.querySelector('.cc-ctx-menu');
    const expandAllBtn = mountEl.querySelector('.cc-expand-all-btn');
    const stopBtn = mountEl.querySelector('.cc-stop-btn');
    const sendBtn = mountEl.querySelector('.cc-send-btn');

    let currentTab = null;
    let openPopover = '';
    let slashMatches = [];
    let slashIdx = 0;

    function closePopovers() {
      openPopover = '';
      modelMenu.hidden = true;
      effortMenu.hidden = true;
      ctxMenu.hidden = true;
      modelBtn.setAttribute('aria-expanded', 'false');
      effortBtn.setAttribute('aria-expanded', 'false');
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.cc-pick')) closePopovers();
      if (!e.target.closest('.cc-composer-inner')) slashMenu.hidden = true;
    });

    function autoGrow() {
      textarea.style.height = 'auto';
      const next = Math.min(200, Math.max(38, textarea.scrollHeight));
      textarea.style.height = `${next}px`;
    }

    function updateSendState() {
      if (!currentTab) return;
      const st = currentTab.state || {};
      const hasText = Boolean(textarea.value.trim());
      const hasAtt = currentTab.attachments.length > 0;
      const uploading = currentTab.attachments.some((a) => a.uploading);
      const isBusy = st.status === 'working' || st.status === 'asking';
      stopBtn.hidden = !isBusy;
      sendBtn.disabled = uploading || (!hasText && !hasAtt);
    }

    function renderAttachments() {
      if (!currentTab || !currentTab.attachments.length) {
        attachStrip.hidden = true;
        attachStrip.innerHTML = '';
        updateSendState();
        return;
      }
      attachStrip.hidden = false;
      attachStrip.innerHTML = currentTab.attachments.map((att, idx) => `
        <div class="cc-att-chip${att.error ? ' is-error' : ''}">
          ${att.thumbUrl ? `<img class="cc-att-thumb" src="${Md.escapeHtml(att.thumbUrl)}" alt="" />` : ''}
          <span class="cc-att-name" title="${Md.escapeHtml(att.remotePath || att.name)}">${Md.escapeHtml(att.name)}</span>
          ${att.uploading ? '<span class="cc-att-stat">上传中…</span>' : (att.error ? `<span class="cc-att-stat">${Md.escapeHtml(att.error)}</span>` : '')}
          <button type="button" class="cc-att-rm" data-att-rm="${idx}" title="移除">×</button>
        </div>
      `).join('');
      updateSendState();
    }

    attachStrip.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-att-rm]');
      if (!btn || !currentTab) return;
      currentTab.attachments.splice(Number(btn.dataset.attRm), 1);
      renderAttachments();
    });

    function allSlashCommands() {
      const localCmds = (currentTab && currentTab.offlineMeta && Array.isArray(currentTab.offlineMeta.commands))
        ? currentTab.offlineMeta.commands
        : [];
      const seen = new Set();
      const out = [{ name: 'refresh', description: '重新加载对话记录', argumentHint: '' }];
      seen.add('refresh');
      for (const c of FALLBACK_COMMANDS) {
        if (!seen.has(c.name)) {
          seen.add(c.name);
          out.push(c);
        }
      }
      for (const c of localCmds) {
        if (!c || !c.name || seen.has(c.name)) continue;
        seen.add(c.name);
        out.push(c);
      }
      return out;
    }

    function updateSlashMenu() {
      const val = textarea.value;
      if (!val.startsWith('/') || val.includes('\n') || val.slice(1).includes(' ')) {
        slashMenu.hidden = true;
        slashMatches = [];
        return;
      }
      const query = val.slice(1).toLowerCase();
      slashMatches = allSlashCommands().filter((c) => (
        !query || c.name.toLowerCase().includes(query) || (c.description && c.description.toLowerCase().includes(query))
      )).slice(0, 40);

      if (!slashMatches.length) {
        slashMenu.hidden = true;
        return;
      }
      if (slashIdx >= slashMatches.length) slashIdx = 0;
      slashMenu.innerHTML = slashMatches.map((c, idx) => `
        <button type="button" class="cc-slash-item${idx === slashIdx ? ' is-focus' : ''}" data-slash-idx="${idx}">
          <span class="cc-slash-name">/${Md.escapeHtml(c.name)}</span>
          <span class="cc-slash-desc">${Md.escapeHtml(c.description || '')}</span>
        </button>
      `).join('');
      slashMenu.hidden = false;
    }

    function acceptSlash(idx) {
      const cmd = slashMatches[idx];
      if (!cmd) return;
      textarea.value = `/${cmd.name} `;
      if (currentTab) currentTab.draft = textarea.value;
      slashMenu.hidden = true;
      autoGrow();
      updateSendState();
      textarea.focus();
    }

    slashMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-slash-idx]');
      if (item) acceptSlash(Number(item.dataset.slashIdx));
    });

    function submit() {
      if (!currentTab) return;
      const text = textarea.value.trim();
      if (text === '/refresh') {
        textarea.value = '';
        currentTab.draft = '';
        slashMenu.hidden = true;
        autoGrow();
        updateSendState();
        actions.onRefresh();
        return;
      }
      const readyAtts = currentTab.attachments.filter((a) => !a.uploading && !a.error && a.remotePath);
      if (!text && !readyAtts.length) return;

      if (text) {
        currentTab.promptHistory.push(text);
        if (currentTab.promptHistory.length > 60) currentTab.promptHistory.shift();
        currentTab.histCursor = -1;
      }

      const openTerminalAfter = TUI_PICKER_SLASH_RE.test(text);
      textarea.value = '';
      currentTab.draft = '';
      currentTab.attachments = [];
      slashMenu.hidden = true;
      renderAttachments();
      autoGrow();
      updateSendState();
      actions.onSend({ text, attachments: readyAtts });
      if (openTerminalAfter) {
        actions.onSwitchTerminal();
      }
    }

    sendBtn.addEventListener('click', submit);
    stopBtn.addEventListener('click', () => actions.onInterrupt());
    expandAllBtn.addEventListener('click', () => actions.onToggleExpandAll());
    permBtn.addEventListener('click', () => actions.onCyclePermissionMode());

    textarea.addEventListener('input', () => {
      if (currentTab) currentTab.draft = textarea.value;
      autoGrow();
      updateSendState();
      updateSlashMenu();
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const st = (currentTab && currentTab.state) || {};

      if (!slashMenu.hidden && slashMatches.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashIdx = (slashIdx + 1) % slashMatches.length;
          updateSlashMenu();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashIdx = (slashIdx - 1 + slashMatches.length) % slashMatches.length;
          updateSlashMenu();
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          acceptSlash(slashIdx);
          return;
        }
      }

      // Single-key 1-9 answer when a non-multi tmux ask prompt is waiting and input is empty
      if (st.status === 'asking' && st.ask && !textarea.value && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const idx = Number(e.key) - 1;
        if (idx < (st.ask.options || []).length && !st.ask.multiSelect && idx !== st.ask.freeTextIndex) {
          e.preventDefault();
          actions.onAnswerAsk({ kind: 'pick', index: idx });
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        submit();
        return;
      }

      if (e.key === 'Escape') {
        if (!slashMenu.hidden) {
          slashMenu.hidden = true;
          return;
        }
        if (st.status === 'working' || st.status === 'asking') {
          e.preventDefault();
          actions.onInterrupt();
          return;
        }
      }

      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && currentTab && !e.shiftKey && !e.metaKey && !e.altKey) {
        const hist = currentTab.promptHistory;
        if (!hist.length) return;
        const browsing = currentTab.histCursor >= 0;
        if (!browsing && textarea.value !== '') return;
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          currentTab.histCursor = browsing ? Math.max(0, currentTab.histCursor - 1) : hist.length - 1;
          textarea.value = hist[currentTab.histCursor] || '';
        } else if (browsing) {
          e.preventDefault();
          if (currentTab.histCursor >= hist.length - 1) {
            currentTab.histCursor = -1;
            textarea.value = '';
          } else {
            currentTab.histCursor += 1;
            textarea.value = hist[currentTab.histCursor] || '';
          }
        }
        currentTab.draft = textarea.value;
        autoGrow();
        updateSendState();
      }
    });

    async function handleFiles(fileList) {
      if (!currentTab || !fileList || !fileList.length) return;
      for (const file of Array.from(fileList)) {
        const item = {
          name: file.name || 'image.png',
          uploading: true,
          remotePath: '',
          error: '',
          thumbUrl: file.type && file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
        };
        currentTab.attachments.push(item);
        renderAttachments();
        try {
          const r = await actions.onUploadFile(file);
          item.uploading = false;
          if (r && r.ok && r.remotePath) {
            item.remotePath = r.remotePath;
            item.name = r.name || item.name;
          } else {
            item.error = (r && r.error) || '上传失败';
          }
        } catch (err) {
          item.uploading = false;
          item.error = err.message || '上传失败';
        }
        renderAttachments();
      }
    }

    textarea.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length > 0) {
        e.preventDefault();
        handleFiles(files);
      }
    });

    composerBox.addEventListener('dragover', (e) => {
      e.preventDefault();
      composerBox.classList.add('is-drag');
    });
    composerBox.addEventListener('dragleave', () => composerBox.classList.remove('is-drag'));
    composerBox.addEventListener('drop', (e) => {
      composerBox.classList.remove('is-drag');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }
    });

    function resolvedModelAndEffort() {
      const st = (currentTab && currentTab.state) || {};
      const off = (currentTab && currentTab.offlineMeta) || {};
      const sets = off.settings || {};
      const model = st.model || st.launchModel || sets.model || 'default';
      const effort = st.effort || st.launchEffort || sets.effortLevel || '';
      return { model, effort };
    }

    function renderModelMenu() {
      const off = (currentTab && currentTab.offlineMeta) || {};
      const { model: curModel } = resolvedModelAndEffort();
      const baseModels = Array.isArray(off.models) && off.models.length
        ? off.models
        : [
          { id: 'default', name: 'Default (CLI 默认)' },
          { id: 'opus', name: 'Opus' },
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'haiku', name: 'Haiku' },
        ];
      const extra = Array.isArray(off.extraModels) ? off.extraModels : [];
      const seen = new Set(baseModels.map((m) => m.id));
      const all = [...baseModels, ...extra.filter((m) => m.id && !seen.has(m.id))];

      modelMenu.innerHTML = all.map((m) => `
        <button type="button" class="cc-menu-item${m.id === curModel || curModel.includes(m.id) ? ' is-current' : ''}" data-pick-model="${Md.escapeHtml(m.id)}">
          <div class="cc-menu-item-top">
            <span>${Md.escapeHtml(m.name || m.id)}</span>
            <span class="cc-menu-tag">${Md.escapeHtml(m.id)}</span>
          </div>
          ${m.description ? `<div class="cc-menu-desc">${Md.escapeHtml(m.description)}</div>` : ''}
        </button>
      `).join('');
    }

    function renderEffortMenu() {
      const { effort: curEff } = resolvedModelAndEffort();
      const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
      const labels = {
        low: 'Low · 快速响应',
        medium: 'Medium · 均衡思考',
        high: 'High · 深度推理',
        xhigh: 'XHigh · 极深推理',
        max: 'Max · 最大思考上限',
        auto: 'Auto · 自动适应',
      };
      effortMenu.innerHTML = levels.map((lv) => `
        <button type="button" class="cc-menu-item${lv === curEff ? ' is-current' : ''}" data-pick-effort="${Md.escapeHtml(lv)}">
          <div class="cc-menu-item-top">
            <span>${Md.escapeHtml(labels[lv] || lv)}</span>
            <span class="cc-menu-tag">${lv === curEff ? '当前' : ''}</span>
          </div>
        </button>
      `).join('');
    }

    function renderCtxMenu() {
      const st = (currentTab && currentTab.state) || {};
      const ctx = st.contextUsage;
      if (!ctx) {
        ctxMenu.innerHTML = '<div class="cc-menu-empty">暂无对话记录的上下文估算</div>';
        return;
      }
      const total = Number(ctx.totalTokens || 0);
      const max = Number(ctx.rawMaxTokens || 200000);
      const pct = Math.min(100, Math.round(Number(ctx.percentage || (max ? (total / max) * 100 : 0))));
      const cats = Array.isArray(ctx.categories) ? ctx.categories : [];
      ctxMenu.innerHTML = `
        <div class="cc-ctx-head">
          <span>上下文估算 ${pct}%</span>
          <span class="cc-ctx-nums">${Act.formatTokens(total)} / ${Act.formatTokens(max)}</span>
        </div>
        <div class="cc-ctx-cats">
          ${cats.map((c) => `
            <div class="cc-ctx-cat-row">
              <span>${Md.escapeHtml(c.name)}</span>
              <span>${Act.formatTokens(c.tokens)}</span>
            </div>
          `).join('')}
        </div>
        <button type="button" class="cc-btn cc-btn--sm cc-ctx-compact-btn" data-ctx-compact>压缩上下文 (/compact)</button>
      `;
    }

    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = openPopover !== 'model';
      closePopovers();
      if (willOpen) {
        openPopover = 'model';
        renderModelMenu();
        modelMenu.hidden = false;
        modelBtn.setAttribute('aria-expanded', 'true');
      }
    });

    effortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = openPopover !== 'effort';
      closePopovers();
      if (willOpen) {
        openPopover = 'effort';
        renderEffortMenu();
        effortMenu.hidden = false;
        effortBtn.setAttribute('aria-expanded', 'true');
      }
    });

    ctxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = openPopover !== 'ctx';
      closePopovers();
      if (willOpen) {
        openPopover = 'ctx';
        renderCtxMenu();
        ctxMenu.hidden = false;
      }
    });

    modelMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pick-model]');
      if (!btn) return;
      closePopovers();
      actions.onSetModel(btn.dataset.pickModel);
    });

    effortMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pick-effort]');
      if (!btn) return;
      closePopovers();
      actions.onSetEffort(btn.dataset.pickEffort);
    });

    ctxMenu.addEventListener('click', (e) => {
      if (e.target.closest('[data-ctx-compact]')) {
        closePopovers();
        actions.onSend({ text: '/compact', attachments: [] });
      }
    });

    function renderUsageRings(usage) {
      if (!usage || (!usage.fiveHour && !usage.week)) {
        usageRingsEl.hidden = true;
        usageRingsEl.innerHTML = '';
        return;
      }
      const mkRing = (label, item) => {
        if (!item || typeof item.pct !== 'number') return '';
        const pct = Math.max(0, Math.min(100, Math.round(item.pct)));
        const tone = pct >= 90 ? 'is-crit' : pct >= 70 ? 'is-warn' : '';
        return `<span class="cc-usage-pill ${tone}" title="本地缓存用量 · ${label} ${pct}%">${label} <strong>${pct}%</strong></span>`;
      };
      usageRingsEl.innerHTML = [mkRing('5h', usage.fiveHour), mkRing('7d', usage.week)].filter(Boolean).join('');
      usageRingsEl.hidden = !usageRingsEl.innerHTML;
    }

    function render(tabView) {
      const changedTab = currentTab !== tabView;
      currentTab = tabView;
      if (!tabView) return;
      const st = tabView.state || {};

      if (changedTab) {
        textarea.value = tabView.draft || '';
        autoGrow();
        renderAttachments();
        closePopovers();
        slashMenu.hidden = true;
      }

      const modeId = st.permissionMode || 'default';
      const modeMeta = Act.getPermissionModeMeta(modeId);
      permLabel.textContent = modeMeta.shortLabel;
      permDot.className = `cc-perm-dot${modeId === 'plan' ? ' is-plan' : modeMeta.danger ? ' is-danger' : ''}`;
      permBtn.disabled = !st.claudeRunning;

      const { model, effort } = resolvedModelAndEffort();
      modelLabel.textContent = model && model !== 'default' ? Act.formatModelName(model) : '默认模型';
      effortLabel.textContent = effort ? `思考: ${effort}` : 'effort';
      const busy = st.status === 'working' || st.status === 'asking';
      modelBtn.disabled = !st.claudeRunning || busy;
      effortBtn.disabled = !st.claudeRunning || busy;

      expandAllBtn.classList.toggle('is-active', Boolean(tabView.globalExpand));

      const ctx = st.contextUsage;
      if (ctx && typeof ctx.percentage === 'number') {
        const pct = Math.min(100, Math.max(0, Math.round(ctx.percentage)));
        const circ = 2 * Math.PI * 9;
        ctxArc.style.strokeDasharray = `${circ}`;
        ctxArc.style.strokeDashoffset = `${circ * (1 - pct / 100)}`;
        ctxBtn.classList.toggle('is-warn', pct >= 75 && pct < 90);
        ctxBtn.classList.toggle('is-crit', pct >= 90);
        ctxPct.textContent = `${pct}%`;
        ctxBtn.hidden = false;
      } else {
        ctxBtn.hidden = true;
      }

      renderUsageRings(tabView.offlineMeta && tabView.offlineMeta.usage);
      updateSendState();
    }

    function insertText(snippet) {
      if (!snippet) return;
      const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
      const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : textarea.value.length;
      const next = textarea.value.slice(0, start) + snippet + textarea.value.slice(end);
      textarea.value = next;
      const caret = start + snippet.length;
      textarea.setSelectionRange(caret, caret);
      if (currentTab) currentTab.draft = next;
      autoGrow();
      updateSendState();
      textarea.focus();
    }

    function focusInput() {
      setTimeout(() => { try { textarea.focus(); } catch {} }, 25);
    }

    return {
      render,
      insertText,
      uploadFiles: handleFiles,
      focusInput,
      isFocused: () => document.activeElement === textarea,
    };
  }

  window.TaktChatComposer = {
    createComposerView,
  };
})();
