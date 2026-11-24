(function () {
  'use strict';

  function createConversationView({ mountEl, actions }) {
    const Act = window.TaktChatActivity;
    const Md = window.TaktChatMarkdown;
    const Tr = window.TaktChatTranscript;

    mountEl.innerHTML = `
      <div class="cc-reading">
        <div class="cc-launch-banner" hidden>
          <span class="cc-launch-dot"></span>
          <span class="cc-launch-msg">此标签页终端尚未启动 Claude（对话与终端共享同一个 tmux 会话，可随时 ⌘E 无缝切换）</span>
          <div class="cc-tmux-actions">
            <button type="button" class="cc-btn cc-btn--sm cc-btn--primary" data-act="launch-claude">在终端中启动 Claude</button>
            <button type="button" class="cc-btn cc-btn--sm" data-act="switch-term">切到终端</button>
          </div>
        </div>

        <div class="cc-findbar" hidden>
          <input type="text" class="cc-find-input" placeholder="在当前对话中查找… (⌘F)" />
          <span class="cc-find-count">0 / 0</span>
          <button type="button" class="cc-btn cc-btn--icon" data-find="prev" title="上一个 (⇧↵)">↑</button>
          <button type="button" class="cc-btn cc-btn--icon" data-find="next" title="下一个 (↵)">↓</button>
          <button type="button" class="cc-btn cc-btn--icon" data-find="close" title="关闭 (Esc)">✕</button>
        </div>

        <div class="cc-scroll scroller">
          <div class="cc-inner">
            <button type="button" class="cc-older-btn" hidden>加载更早的对话</button>
            <div class="cc-begin" hidden>— 对话开始 —</div>
            <div class="cc-empty" hidden>
              <div class="cc-empty-title">准备就绪</div>
              <div class="cc-empty-sub">在下方输入指令即可直接发给同一标签页中的 Claude，与「终端」视图实时共享上下文；也可输入 <code>/</code> 查看命令或拖入文件。</div>
            </div>
            <div class="cc-turns"></div>
            <div class="cc-pending-users" hidden></div>
            <div class="cc-live-stream cc-md" hidden></div>
            <div class="cc-run-status" hidden>
              <span class="cc-claude-burst" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M12 2v20M3.34 7l17.32 10M20.66 7L3.34 17"/>
                </svg>
              </span>
              <span class="cc-run-status-text">Claude 正在思考…</span>
              <span class="cc-run-status-timer"></span>
            </div>
            <div class="cc-live-ask cc-card is-pending" hidden></div>
          </div>
        </div>

        <div class="cc-todo-dock" hidden></div>

        <button type="button" class="cc-jump" hidden>↓ 回到最新</button>

        <div class="cc-plan-modal" hidden>
          <div class="cc-plan-modal-card">
            <div class="cc-plan-modal-head">
              <span>实现计划全文</span>
              <button type="button" class="cc-btn cc-btn--sm" data-plan-modal-close>关闭 (Esc)</button>
            </div>
            <div class="cc-plan-modal-body scroller"></div>
          </div>
        </div>
      </div>
    `;

    const launchBanner = mountEl.querySelector('.cc-launch-banner');
    const findBar = mountEl.querySelector('.cc-findbar');
    const findInput = mountEl.querySelector('.cc-find-input');
    const findCount = mountEl.querySelector('.cc-find-count');
    const scrollEl = mountEl.querySelector('.cc-scroll');
    const olderBtn = mountEl.querySelector('.cc-older-btn');
    const beginEl = mountEl.querySelector('.cc-begin');
    const emptyEl = mountEl.querySelector('.cc-empty');
    const turnsEl = mountEl.querySelector('.cc-turns');
    const pendingEl = mountEl.querySelector('.cc-pending-users');
    const liveStreamEl = mountEl.querySelector('.cc-live-stream');
    const runStatusEl = mountEl.querySelector('.cc-run-status');
    const runStatusText = mountEl.querySelector('.cc-run-status-text');
    const runStatusTimer = mountEl.querySelector('.cc-run-status-timer');
    const todoDockEl = mountEl.querySelector('.cc-todo-dock');
    const liveAskEl = mountEl.querySelector('.cc-live-ask');
    const jumpBtn = mountEl.querySelector('.cc-jump');
    const planModal = mountEl.querySelector('.cc-plan-modal');
    const planModalBody = mountEl.querySelector('.cc-plan-modal-body');

    let currentTab = null;
    let lastConversation = null;
    let pinnedToBottom = true;
    let openStatsTurnId = '';
    const turnSigs = new Map();
    let lastPendingSig = '';
    let lastTodoSig = '';
    let lastAskSig = '';
    let lastAskCoreSig = '';

    // Smooth 60fps streaming & reveal state
    const CARET_HTML = '<span class="cc-stream-caret" aria-hidden="true"></span>';
    let streamTarget = '';
    let streamShown = 0;
    let streamRaf = 0;
    let streamLastTs = 0;
    let streamPeakChars = 0;
    let peakTurnId = '';

    let revealTurnId = '';
    let revealFullText = '';
    let revealShown = 0;
    let revealRaf = 0;
    let revealLastTs = 0;

    let statusTickTimer = 0;

    // Find bar state
    let findRanges = [];
    let findIdx = -1;

    function clearFindHighlights() {
      findRanges = [];
      findIdx = -1;
      findCount.textContent = '0 / 0';
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        try {
          CSS.highlights.delete('cc-find-all');
          CSS.highlights.delete('cc-find-current');
        } catch {}
      }
    }

    function runFind() {
      const q = findInput.value.trim().toLowerCase();
      clearFindHighlights();
      if (!q) return;

      const walker = document.createTreeWalker(turnsEl, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue || '';
        const lower = text.toLowerCase();
        let pos = 0;
        while (pos < lower.length) {
          const hit = lower.indexOf(q, pos);
          if (hit < 0) break;
          try {
            const range = document.createRange();
            range.setStart(node, hit);
            range.setEnd(node, hit + q.length);
            findRanges.push(range);
          } catch {}
          pos = hit + q.length;
        }
      }
      if (!findRanges.length) {
        findCount.textContent = '0 / 0';
        return;
      }
      findIdx = 0;
      applyFindHighlight();
    }

    function applyFindHighlight() {
      if (!findRanges.length) return;
      findCount.textContent = `${findIdx + 1} / ${findRanges.length}`;
      const cur = findRanges[findIdx];

      let el = cur.startContainer && cur.startContainer.parentElement;
      while (el && el !== turnsEl) {
        if (el.tagName === 'DETAILS' && !el.open) {
          el.open = true;
        }
        el = el.parentElement;
      }

      if (typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && CSS.highlights) {
        try {
          CSS.highlights.set('cc-find-all', new Highlight(...findRanges));
          CSS.highlights.set('cc-find-current', new Highlight(cur));
        } catch {}
      } else {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(cur);
        } catch {}
      }

      try {
        const rect = cur.getBoundingClientRect();
        const sRect = scrollEl.getBoundingClientRect();
        if (rect.top < sRect.top + 40 || rect.bottom > sRect.bottom - 40) {
          scrollEl.scrollTop += (rect.top - sRect.top) - (sRect.height * 0.35);
        }
      } catch {}
    }

    function stepFind(delta) {
      if (!findRanges.length) {
        runFind();
        return;
      }
      findIdx = (findIdx + delta + findRanges.length) % findRanges.length;
      applyFindHighlight();
    }

    function toggleFind(forceOpen) {
      const open = typeof forceOpen === 'boolean' ? forceOpen : findBar.hidden;
      findBar.hidden = !open;
      if (open) {
        findInput.focus();
        findInput.select();
        runFind();
      } else {
        clearFindHighlights();
      }
    }

    findInput.addEventListener('input', runFind);
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        toggleFind(false);
      }
    });
    findBar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-find]')?.dataset.find;
      if (act === 'prev') stepFind(-1);
      else if (act === 'next') stepFind(1);
      else if (act === 'close') toggleFind(false);
    });

    launchBanner.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'switch-term') actions.onSwitchTerminal();
      else if (act === 'launch-claude') actions.onLaunchClaude();
    });

    olderBtn.addEventListener('click', () => actions.onLoadOlder());
    jumpBtn.addEventListener('click', () => scrollToBottom(true));

    planModal.addEventListener('click', (e) => {
      if (e.target === planModal || e.target.closest('[data-plan-modal-close]')) {
        planModal.hidden = true;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !planModal.hidden) {
        e.preventDefault();
        e.stopPropagation();
        planModal.hidden = true;
      }
    }, true);

    scrollEl.addEventListener('scroll', () => {
      const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      pinnedToBottom = dist < 44;
      jumpBtn.hidden = pinnedToBottom;
      if (currentTab) currentTab.scrollTop = scrollEl.scrollTop;
    }, { passive: true });

    function scrollToBottom(smooth = false) {
      pinnedToBottom = true;
      jumpBtn.hidden = true;
      scrollEl.scrollTo({
        top: scrollEl.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }

    function isDetailsOpen(key, defaultOpen) {
      if (!currentTab) return defaultOpen;
      if (currentTab.openKeys.has(key)) return true;
      if (currentTab.closedKeys.has(key)) return false;
      return defaultOpen;
    }

    function setDetailsOpen(key, open) {
      if (!currentTab) return;
      if (open) {
        currentTab.openKeys.add(key);
        currentTab.closedKeys.delete(key);
      } else {
        currentTab.openKeys.delete(key);
        currentTab.closedKeys.add(key);
      }
    }

    function renderImagesStrip(images) {
      if (!Array.isArray(images) || !images.length) return '';
      const thumbs = images.map((img) => {
        const src = Md.buildImageThumbUrl(img, currentTab);
        if (!src) return '';
        if (typeof img.off === 'number' && typeof img.idx === 'number') {
          const refJson = Md.escapeHtml(JSON.stringify({ off: img.off, idx: img.idx, u: img.u || '' }));
          return `<button type="button" class="reading__thumb cc-thumb" data-thumb-ref="${refJson}" title="点击放大"><img src="${Md.escapeHtml(src)}" alt="图片" loading="lazy" /></button>`;
        }
        return `<button type="button" class="reading__thumb cc-thumb" title="点击放大"><img src="${Md.escapeHtml(src)}" alt="图片" /></button>`;
      }).filter(Boolean).join('');
      return thumbs ? `<div class="cc-thumbs">${thumbs}</div>` : '';
    }

    function renderFileChip(filePath) {
      const clean = String(filePath || '').trim();
      if (!clean) return '';
      return `<a href="#" class="md-file-link cc-file-chip" data-file-path="${Md.escapeHtml(clean)}" title="点击预览 · ⌘点击在 Mac 打开 · ⌥点击在 Finder 中显示">${Md.escapeHtml(clean)}</a>`;
    }

    function safeHttpUrl(raw) {
      const s = String(raw || '').trim();
      if (!s) return '';
      try {
        const u = new URL(s);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
      } catch {}
      return '';
    }

    function parseWebSearchOutput(outputText) {
      let text = String(outputText || '').trim();
      if (!text) return { links: [], summaryMd: '' };

      text = text.replace(/^\s*Web search results for query:\s*"[^\n]*"\s*\n*/i, '');

      const links = [];
      const seenUrls = new Set();
      text = text.replace(/^\s*Links:\s*(\[[^\n]*\])\s*\n*/gm, (m, jsonStr) => {
        try {
          const arr = JSON.parse(jsonStr);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (!item || typeof item !== 'object') continue;
              const url = safeHttpUrl(item.url);
              if (!url || seenUrls.has(url)) continue;
              seenUrls.add(url);
              let host = '';
              try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
              const title = String(item.title || host || url).trim();
              links.push({ title, url, host: host || title });
            }
            return '';
          }
        } catch {}
        return m;
      });

      text = text.replace(/\n*REMINDER:\s*You MUST include the sources above[\s\S]*$/i, '').trim();
      return { links, summaryMd: text };
    }

    function isRedundantMutationOutput(text) {
      const s = String(text || '').trim();
      if (!s) return true;
      return /^(?:The file .+ has been (?:updated|created|written)(?:\s+successfully)?\.?|File (?:created|updated|written) successfully(?:\s+at:?.+)?)$/i.test(s);
    }

    function formatToolOutputPre(outputText, isError) {
      if (!outputText) return '';
      return `<pre class="cc-io-pre${isError ? ' is-error' : ''}">${Md.escapeHtml(outputText.slice(0, 12000))}${outputText.length > 12000 ? '\n… [输出已截断]' : ''}</pre>`;
    }

    function renderTodoInlineHtml(list) {
      const items = Array.isArray(list) ? list : [];
      if (!items.length) return '';
      return `<div class="cc-todo-inline">${items.map((it) => {
        const st = String(it.status || 'pending').toLowerCase();
        const cls = st === 'completed' || st === 'done'
          ? 'is-done'
          : (st === 'in_progress' || st === 'in-progress' || st === 'running')
            ? 'is-active'
            : 'is-pending';
        const mark = cls === 'is-done' ? '✓' : '';
        const label = it.content || it.step || it.title || '';
        return `<div class="cc-todo-item ${cls}"><span class="cc-todo-dot">${mark}</span><span class="cc-todo-txt">${Md.escapeHtml(label)}</span></div>`;
      }).join('')}</div>`;
    }

    const TOOL_CAT_SVGS = {
      read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h5.5L12.5 5.5v8a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><path d="M9.5 2.5v3h3"/><path d="M5.5 8.5h5M5.5 11h3.5"/></svg>',
      edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.5a1.6 1.6 0 0 1 2.3 2.3L6.2 12.1 3 13l.9-3.2 7.3-7.3z"/></svg>',
      write: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.5a1.6 1.6 0 0 1 2.3 2.3L6.2 12.1 3 13l.9-3.2 7.3-7.3z"/></svg>',
      bash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5l3 3-3 3"/><path d="M8 11.5h4.5"/></svg>',
      search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M10.2 10.2l3.3 3.3"/></svg>',
      web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.8 8h10.4"/><path d="M8 2.5c1.8 1.7 1.8 9.3 0 11M8 2.5c-1.8 1.7-1.8 9.3 0 11"/></svg>',
      agent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.2 3.3L12.5 6.5l-3.3 1.2L8 11l-1.2-3.3L3.5 6.5l3.3-1.2L8 2z"/><path d="M12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z"/></svg>',
      plan: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l1.3 1.3L6.5 3.5"/><path d="M8.5 4.8h4.5"/><path d="M3 8.5l1.3 1.3L6.5 7.5"/><path d="M8.5 8.8h4.5"/><circle cx="4.3" cy="12" r="1"/><path d="M8.5 12h4.5"/></svg>',
      skill: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8.5a1.2 1.2 0 0 0-1.2-1.2H3V3.5z"/><path d="M13 3.5H9A1.5 1.5 0 0 0 7.5 5v8.5a1.2 1.2 0 0 1 1.2-1.2H13V3.5z"/></svg>',
      other: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 2.5v1.3M8 12.2v1.3M2.5 8h1.3M12.2 8h1.3M4.1 4.1l.9.9M11 11l.9.9M11.9 4.1l-.9.9M5 11l-.9.9"/></svg>',
    };

    function renderToolIcon(tool, category) {
      if (tool.status === 'running') {
        return '<span class="cc-ti cc-ti-spin"></span>';
      }
      if (tool.isError) {
        return '<span class="cc-ti cc-ti-err"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></span>';
      }
      const cat = Object.prototype.hasOwnProperty.call(TOOL_CAT_SVGS, category) ? category : 'other';
      return `<span class="cc-ti cc-ti-cat is-${cat}">${TOOL_CAT_SVGS[cat]}</span>`;
    }

    function renderToolBodyHtml(tool) {
      const inp = tool.input && typeof tool.input === 'object' ? tool.input : {};
      const outputText = tool.output ? Md.stripAnsi(tool.output).trim() : '';
      const imgsHtml = renderImagesStrip(tool.images);
      const name = String(tool.toolName || '');
      const chunks = [];

      if (name === 'WebSearch') {
        const ws = parseWebSearchOutput(outputText);
        if (ws.links.length) {
          chunks.push(
            `<div class="cc-web-sources">${ws.links.map((lk) => {
              const showTitle = lk.title && lk.title.toLowerCase() !== lk.host.toLowerCase();
              return `<a href="${Md.escapeHtml(lk.url)}" target="_blank" rel="noopener noreferrer" class="cc-web-pill" title="${Md.escapeHtml(lk.url)}"><span class="cc-web-host">${Md.escapeHtml(lk.host)}</span>${showTitle ? `<span class="cc-web-title">${Md.escapeHtml(lk.title)}</span>` : ''}</a>`;
            }).join('')}</div>`
          );
        }
        if (ws.summaryMd) {
          chunks.push(`<div class="cc-web-summary cc-md">${Md.renderMarkdown(ws.summaryMd)}</div>`);
        } else if (outputText && !ws.links.length) {
          chunks.push(formatToolOutputPre(outputText, tool.isError));
        }
      } else if (name === 'WebFetch') {
        const href = safeHttpUrl(inp.url);
        if (href) {
          chunks.push(`<div class="cc-io-path"><a href="${Md.escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="cc-ext-link">${Md.escapeHtml(href)}</a></div>`);
        }
        if (outputText) chunks.push(formatToolOutputPre(outputText, tool.isError));
      } else if (
        name === 'Bash'
        || name === 'bash'
        || name === 'mcp__magpie__Bash'
        || name === 'mcp__mac-industrial__mac_host_exec'
      ) {
        const cmd = String(inp.command || '').trim();
        const cmdHtml = cmd ? `<div class="cc-term-cmd"><span class="cc-term-prompt">$</span><code>${Md.escapeHtml(cmd)}</code></div>` : '';
        const outHtml = outputText ? formatToolOutputPre(outputText, tool.isError) : '';
        if (cmdHtml || outHtml) {
          chunks.push(`<div class="cc-term-block">${cmdHtml}${outHtml}</div>`);
        }
      } else if (name === 'Edit') {
        if (inp.file_path) chunks.push(`<div class="cc-io-path">${renderFileChip(inp.file_path)}</div>`);
        chunks.push(Md.renderDiffHtml(inp.old_string || '', inp.new_string || ''));
        if (outputText && (tool.isError || !isRedundantMutationOutput(outputText))) {
          chunks.push(formatToolOutputPre(outputText, tool.isError));
        }
      } else if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
        if (inp.file_path) chunks.push(`<div class="cc-io-path">${renderFileChip(inp.file_path)}</div>`);
        chunks.push(inp.edits.slice(0, 8).map((ed) => Md.renderDiffHtml(ed.old_string || '', ed.new_string || '')).join(''));
        if (outputText && (tool.isError || !isRedundantMutationOutput(outputText))) {
          chunks.push(formatToolOutputPre(outputText, tool.isError));
        }
      } else if (name === 'Write') {
        if (inp.file_path) chunks.push(`<div class="cc-io-path">${renderFileChip(inp.file_path)}</div>`);
        const content = String(inp.content || '');
        if (content) {
          chunks.push(`<pre class="cc-io-pre">${Md.escapeHtml(content.slice(0, 6000))}${content.length > 6000 ? '\n… [内容已截断]' : ''}</pre>`);
        }
        if (outputText && (tool.isError || !isRedundantMutationOutput(outputText))) {
          chunks.push(formatToolOutputPre(outputText, tool.isError));
        }
      } else if (name === 'TodoWrite' && Array.isArray(inp.todos)) {
        const listHtml = renderTodoInlineHtml(inp.todos);
        if (listHtml) chunks.push(listHtml);
      } else if (/(?:^|_)update_plan$/i.test(name) && Array.isArray(inp.items)) {
        const listHtml = renderTodoInlineHtml(inp.items);
        if (listHtml) chunks.push(listHtml);
        if (outputText) chunks.push(formatToolOutputPre(outputText, tool.isError));
      } else if (name === 'Skill') {
        if (outputText) chunks.push(`<div class="cc-muted">${Md.escapeHtml(outputText)}</div>`);
      } else if (name === 'Read' || name === 'Grep' || name === 'Glob') {
        if (outputText) chunks.push(formatToolOutputPre(outputText, tool.isError));
      } else {
        if (Object.keys(inp).length > 0) {
          try {
            chunks.push(`<div class="cc-io-section"><div class="cc-io-label">参数</div><pre class="cc-io-pre">${Md.escapeHtml(JSON.stringify(inp, null, 2).slice(0, 4000))}</pre></div>`);
          } catch {}
        }
        if (outputText) {
          chunks.push(`<div class="cc-io-section"><div class="cc-io-label">${tool.isError ? '错误输出' : '输出'}</div>${formatToolOutputPre(outputText, tool.isError)}</div>`);
        }
      }

      if (imgsHtml) chunks.push(imgsHtml);
      return chunks.join('');
    }

    function renderToolRowHtml(tool) {
      const active = tool.status === 'running';
      const d = Act.describe(tool, active);
      const detailKey = `tool:${tool.id}`;
      const bodyHtml = renderToolBodyHtml(tool);
      const hasBody = Boolean(bodyHtml);
      const open = hasBody && isDetailsOpen(detailKey, false);

      const statusCls = tool.status === 'running'
        ? 'is-running'
        : tool.isError
          ? 'is-error'
          : 'is-done';

      const iconHtml = renderToolIcon(tool, d.category);

      const targetHtml = d.target
        ? (d.filePath
          ? `<a href="#" class="md-file-link cc-tool-target" data-file-path="${Md.escapeHtml(d.filePath)}" title="${Md.escapeHtml(d.filePath)}">${Md.escapeHtml(d.target)}</a>`
          : `<span class="cc-tool-target" title="${Md.escapeHtml(d.target)}">${Md.escapeHtml(d.target)}</span>`)
        : '';

      const diffBadge = (d.added > 0 || d.removed > 0)
        ? `<span class="cc-diff-badge">${d.added ? `<span class="add">+${d.added}</span>` : ''}${d.removed ? `<span class="del">-${d.removed}</span>` : ''}</span>`
        : '';

      const elapsedMs = tool.finishedAt && tool.startedAt
        ? Math.max(0, tool.finishedAt - tool.startedAt)
        : 0;
      const elapsedStr = elapsedMs >= 500 ? Act.duration(elapsedMs) : '';

      return `
        <details class="cc-tool ${statusCls}${hasBody ? ' is-expandable' : ' is-static'}" data-key="${Md.escapeHtml(detailKey)}"${open ? ' open' : ''}>
          <summary class="cc-tool-head">
            ${iconHtml}
            <span class="cc-tool-verb">${Md.escapeHtml(d.verb)}</span>
            ${targetHtml ? `<span class="cc-tool-sep" aria-hidden="true"></span>${targetHtml}` : ''}
            ${d.detail ? `<span class="cc-tool-detail">${Md.escapeHtml(d.detail)}</span>` : ''}
            ${diffBadge}
            <span class="cc-tool-elapsed">${Md.escapeHtml(elapsedStr)}</span>
            ${hasBody ? '<span class="cc-tool-chev" aria-hidden="true">▸</span>' : ''}
          </summary>
          ${hasBody ? `<div class="cc-tool-body">${bodyHtml}</div>` : ''}
        </details>
      `;
    }

    function renderQuestionCardHtml(tool) {
      const inp = tool.input && typeof tool.input === 'object' ? tool.input : {};
      const questions = Array.isArray(inp.questions) ? inp.questions : [];
      const approval = tool.approval;
      const answers = (approval && approval.answers) || inp.answers || null;
      const summaryRows = questions.map((q) => {
        const ans = answers && answers[q.question] ? answers[q.question] : (tool.output ? '已回答' : '等待回答');
        return `<div class="cc-q-done-row"><span class="cc-q-header">${Md.escapeHtml(q.header || q.question)}</span><span class="cc-q-done-val">${Md.escapeHtml(ans)}</span></div>`;
      }).join('');
      return `
        <div class="cc-card cc-q-card is-resolved">
          <div class="cc-card-head">
            <span class="cc-card-badge">问答</span>
            <span class="cc-card-status">${approval && approval.decision === 'deny' ? '已跳过' : tool.status === 'running' ? '等待回答' : '已回答'}</span>
          </div>
          ${summaryRows || `<div class="cc-q-done-val">${Md.escapeHtml(tool.output || '已处理')}</div>`}
        </div>
      `;
    }

    function renderPlanCardHtml(tool) {
      const inp = tool.input && typeof tool.input === 'object' ? tool.input : {};
      const planText = String(inp.plan || inp.content || (tool.approval && tool.approval.plan) || '');
      const planFileName = inp.file_path ? Act.basename(inp.file_path) : '';
      const approval = tool.approval;
      if (!currentTab.planExpanded) currentTab.planExpanded = new Set();
      const expanded = currentTab.planExpanded.has(tool.id);

      let statusText = planFileName || '计划方案';
      if (approval && approval.decision === 'approve') statusText = '已批准执行';
      else if (approval && approval.decision === 'reject') statusText = '已退回修改';
      else if (tool.status === 'running') statusText = '等待确认';

      return `
        <div class="cc-card cc-plan-card is-resolved">
          <div class="cc-card-head">
            <div class="cc-card-head-l">
              <span class="cc-card-badge cc-card-badge--plan">实现计划</span>
              <span class="cc-card-status">${Md.escapeHtml(statusText)}</span>
            </div>
            <div class="cc-card-head-r">
              ${planText ? `<button type="button" class="cc-mini-btn" data-plan-toggle-expand="${Md.escapeHtml(tool.id)}">${expanded ? '收起' : '展开全文'}</button>` : ''}
              ${planText ? `<button type="button" class="cc-mini-btn" data-plan-fullscreen="${Md.escapeHtml(tool.id)}">全屏查看</button>` : ''}
            </div>
          </div>
          <div class="cc-plan-body cc-md${expanded ? ' is-expanded' : ''}">${planText ? Md.renderMarkdown(planText) : '<p class="cc-muted">暂无计划正文</p>'}</div>
        </div>
      `;
    }

    function renderSegmentHtml(seg, turn) {
      if (seg.kind === 'compact') {
        const lbl = seg.status === 'compacting'
          ? '正在压缩对话上下文…'
          : `上下文已压缩${seg.preTokens ? ` · 压缩前 ${Act.formatTokens(seg.preTokens)} tokens` : ''}${seg.trigger === 'manual' ? '（手动）' : ''}`;
        return `<div class="cc-compact ${seg.status === 'compacting' ? 'is-running' : ''}"><span class="cc-compact-line"></span><span>${Md.escapeHtml(lbl)}</span><span class="cc-compact-line"></span></div>`;
      }

      if (seg.kind === 'notice') {
        return `<div class="cc-notice cc-notice--${Md.escapeHtml(seg.noticeKind || 'info')}">${Md.escapeHtml(seg.text)}</div>`;
      }

      if (seg.kind === 'question') return renderQuestionCardHtml(seg.tool);
      if (seg.kind === 'plan') return renderPlanCardHtml(seg.tool);

      if (seg.kind === 'process') {
        if (seg.parts.length === 1 && seg.parts[0].kind === 'work' && seg.parts[0].tools.length === 1) {
          return renderToolRowHtml(seg.parts[0].tools[0]);
        }

        const defaultOpen = turn.active || Boolean(currentTab && currentTab.globalExpand);
        const open = isDetailsOpen(seg.id, defaultOpen);
        const allTools = [];
        for (const part of seg.parts) {
          if (part.kind === 'work' && Array.isArray(part.tools)) {
            allTools.push(...part.tools);
          }
        }
        const toolSum = allTools.length ? Act.summarize(allTools, Boolean(seg.hasPendingTool && turn.active)) : '';
        const durPart = turn.durationMs ? `用时 ${Act.duration(turn.durationMs)}` : (turn.active ? '进行中' : '');
        const procLabel = toolSum
          ? (durPart ? `${toolSum} · ${durPart}` : toolSum)
          : `${durPart || '执行过程'}${seg.notes ? ` · ${seg.notes} 条思考与说明` : ''}`;

        const innerHtml = seg.parts.map((part) => {
          if (part.kind === 'thinking') {
            const firstLine = (part.text.split('\n').find((l) => l.trim()) || '思考过程').trim().slice(0, 72);
            const thinkOpen = isDetailsOpen(`think:${part.id}`, Boolean(part.active));
            return `
              <details class="cc-thinking" data-key="think:${Md.escapeHtml(part.id)}"${thinkOpen ? ' open' : ''}>
                <summary class="cc-thinking-sum">
                  <span class="cc-think-tag">思考</span>
                  <span class="cc-think-preview">${Md.escapeHtml(firstLine)}</span>
                </summary>
                <div class="cc-thinking-body">${Md.renderMarkdown(part.text)}</div>
              </details>
            `;
          }
          if (part.kind === 'text') {
            return `<div class="cc-mid-text cc-md">${Md.renderMarkdown(part.text)}</div>`;
          }
          if (part.kind === 'work') {
            return part.tools.map(renderToolRowHtml).join('');
          }
          return '';
        }).join('');

        return `
          <details class="cc-process${seg.hasPendingTool && turn.active ? ' is-running' : ''}" data-key="${Md.escapeHtml(seg.id)}"${open ? ' open' : ''}>
            <summary class="cc-process-sum">
              <span class="cc-process-label">${Md.escapeHtml(procLabel)}</span>
              <svg class="cc-process-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 6 8 10 12 6"/></svg>
            </summary>
            <div class="cc-process-body">${innerHtml}</div>
          </details>
        `;
      }

      return '';
    }

    function renderTurnFooterHtml(turn) {
      const hasClosing = Boolean(turn.closing && turn.closing.text);
      const s = turn.stats;
      if (!hasClosing && !s) return '';

      let statsInlineHtml = '';
      let statsPopoverHtml = '';
      if (s) {
        const durStr = s.durationMs ? Act.duration(s.durationMs) : '';
        const outTok = Number(s.outputTokens || 0);
        const inTok = Number(s.inputTokens || 0);
        const cacheRead = Number(s.cacheReadTokens || 0);
        const cacheCreate = Number(s.cacheCreationTokens || 0);
        const totalIn = inTok + cacheRead + cacheCreate;
        const cacheHit = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
        const modelShort = s.model ? Act.formatModelName(s.model) : '';

        const isOpen = openStatsTurnId === turn.id;
        const summaryParts = [
          durStr && `用时 ${durStr}`,
          outTok && `输出 ${Act.formatTokens(outTok)}`,
          modelShort,
        ].filter(Boolean);

        statsInlineHtml = `
          <div class="cc-stats-line">
            <span>${Md.escapeHtml(summaryParts.join(' · ') || '已完成')}</span>
            <button type="button" class="cc-stats-btn" data-stats-toggle="${Md.escapeHtml(turn.id)}">${isOpen ? '收起统计' : '详情'}</button>
          </div>
        `;
        if (isOpen) {
          statsPopoverHtml = `
            <div class="cc-stats-popover">
              <div class="cc-stat-cell"><label>总耗时</label><span>${Md.escapeHtml(durStr || '—')}</span></div>
              <div class="cc-stat-cell"><label>请求轮次</label><span>${Number(s.requests || 1)}</span></div>
              <div class="cc-stat-cell"><label>直传输入 / 输出</label><span>${Act.formatTokens(inTok)} / ${Act.formatTokens(outTok)}</span></div>
              <div class="cc-stat-cell"><label>缓存读取 / 写入</label><span>${Act.formatTokens(cacheRead)} / ${Act.formatTokens(cacheCreate)}</span></div>
              <div class="cc-stat-cell"><label>缓存命中率</label><span>${cacheHit}%</span></div>
              <div class="cc-stat-cell"><label>模型</label><span>${Md.escapeHtml(s.model ? Act.formatModelName(s.model) : '—')}</span></div>
            </div>
          `;
        }
      }

      const copyHtml = hasClosing
        ? `<button type="button" class="cc-copy-btn" data-copy-turn="${Md.escapeHtml(turn.id)}" title="复制回复 Markdown"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11"/></svg><span>复制</span></button>`
        : '<span></span>';

      return `
        <div class="cc-stats-wrap">
          <div class="cc-turn-foot">
            <div class="cc-turn-foot-l">${copyHtml}</div>
            ${statsInlineHtml}
          </div>
          ${statsPopoverHtml}
        </div>
      `;
    }

    function renderTurnHtml(turn) {
      const chunks = [];
      if (turn.user) {
        const txt = turn.user.text || '';
        const long = txt.split('\n').length > 6 || txt.length > 360;
        const expanded = Boolean(currentTab && currentTab.expandedUsers.has(turn.user.id));
        chunks.push(`
          <div class="cc-user" data-user-id="${Md.escapeHtml(turn.user.id)}">
            <div class="cc-user-bubble${long && !expanded ? ' is-clamped' : ''}">${Md.escapeHtml(txt)}</div>
            ${long ? `<button type="button" class="cc-user-expand" data-user-expand="${Md.escapeHtml(turn.user.id)}">${expanded ? '收起' : '展开全部'}</button>` : ''}
            ${renderImagesStrip(turn.user.images)}
          </div>
        `);
      }

      if (turn.segments.length) {
        chunks.push(`<div class="cc-segments">${turn.segments.map((seg) => renderSegmentHtml(seg, turn)).join('')}</div>`);
      }

      if (turn.closing && turn.closing.text) {
        chunks.push(`<div class="cc-closing cc-md">${Md.renderMarkdown(turn.closing.text)}</div>`);
      }

      if (Array.isArray(turn.trailingNotices) && turn.trailingNotices.length) {
        chunks.push(turn.trailingNotices.map((n) => renderSegmentHtml(n, turn)).join(''));
      }

      const footerHtml = renderTurnFooterHtml(turn);
      if (footerHtml) chunks.push(footerHtml);

      return chunks.join('');
    }

    function computeTurnSig(turn) {
      const segSig = turn.segments.map((s) => {
        if (s.kind === 'process') {
          const pSig = s.parts.map((p) => {
            if (p.kind === 'work') {
              return p.tools.map((t) => `${t.id}:${t.status}:${(t.output || '').length}`).join(',');
            }
            return `${p.kind}:${p.id}:${(p.text || '').length}`;
          }).join('|');
          return `proc:${s.id}:${pSig}`;
        }
        if (s.kind === 'plan' || s.kind === 'question') {
          const exp = currentTab && currentTab.planExpanded && currentTab.planExpanded.has(s.tool.id) ? 1 : 0;
          return `${s.kind}:${s.tool.id}:${s.tool.status}:${exp}:${JSON.stringify(s.tool.input || {}).length}`;
        }
        return `${s.kind}:${s.id}:${s.status || ''}:${s.text || ''}`;
      }).join(';');

      const closingLen = turn.closing ? turn.closing.text.length : 0;
      const trailLen = Array.isArray(turn.trailingNotices) ? turn.trailingNotices.length : 0;
      const userExp = turn.user && currentTab.expandedUsers.has(turn.user.id) ? 1 : 0;
      return `${turn.active ? 1 : 0}|${currentTab.globalExpand ? 1 : 0}|${openStatsTurnId === turn.id ? 1 : 0}|${userExp}|${segSig}|${closingLen}|${trailLen}|${turn.stats ? 's' : ''}`;
    }

    function renderTurns(turns, isWorking) {
      const wantIds = new Set(turns.map((t) => t.id));
      for (const child of Array.from(turnsEl.children)) {
        if (!wantIds.has(child.dataset.turnId)) {
          turnSigs.delete(child.dataset.turnId);
          child.remove();
        }
      }

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        turn.active = Boolean(isWorking && i === turns.length - 1);
        const sig = computeTurnSig(turn);
        let el = turnsEl.children[i];
        if (!el || el.dataset.turnId !== turn.id) {
          el = turnsEl.querySelector(`.cc-turn[data-turn-id="${CSS.escape(turn.id)}"]`);
          if (!el) {
            el = document.createElement('section');
            el.className = 'cc-turn';
            el.dataset.turnId = turn.id;
          }
          turnsEl.insertBefore(el, turnsEl.children[i] || null);
        }

        if (turnSigs.get(turn.id) !== sig) {
          el.innerHTML = renderTurnHtml(turn);
          turnSigs.set(turn.id, sig);
        }
      }
    }

    function renderPendingUsers(pendingList) {
      const list = Array.isArray(pendingList) ? pendingList : [];
      const sig = JSON.stringify(list);
      if (sig === lastPendingSig) return;
      lastPendingSig = sig;

      if (!list.length) {
        pendingEl.hidden = true;
        pendingEl.innerHTML = '';
        return;
      }
      pendingEl.hidden = false;
      pendingEl.innerHTML = list.map((p) => {
        const statText = p.failed === 'pasting'
          ? 'Claude 卡在 Pasting…，请切到终端确认'
          : p.failed
            ? '发送失败'
            : p.inflight
              ? '发送中…'
              : '';
        return `
          <div class="cc-user is-pending">
            <div class="cc-user-bubble">${Md.escapeHtml(p.text || '')}</div>
            ${statText ? `<span class="cc-delivery${p.failed ? ' is-failed' : ''}">${Md.escapeHtml(statText)}</span>` : ''}
          </div>
        `;
      }).join('');
    }

    function renderTodoDock(todos) {
      const list = Array.isArray(todos) ? todos : [];
      const open = Boolean(currentTab && currentTab.todoDockOpen);
      const sig = JSON.stringify({ list, open });
      if (sig === lastTodoSig) return;
      lastTodoSig = sig;

      if (!list.length) {
        todoDockEl.hidden = true;
        todoDockEl.innerHTML = '';
        return;
      }

      const done = list.filter((x) => x.status === 'completed').length;
      const total = list.length;
      const activeItem = list.find((x) => x.status === 'in_progress') || list.find((x) => x.status !== 'completed');
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const headTitle = activeItem
        ? (activeItem.activeForm || activeItem.content)
        : `计划已完成（${done}/${total}）`;

      todoDockEl.hidden = false;
      todoDockEl.innerHTML = `
        <div class="cc-todo-dock-inner">
          <button type="button" class="cc-todo-dock-bar" data-todo-dock-toggle aria-expanded="${open ? 'true' : 'false'}">
            <span class="cc-todo-dock-icon" aria-hidden="true">${TOOL_CAT_SVGS.plan}</span>
            <span class="cc-todo-dock-title">${Md.escapeHtml(headTitle)}</span>
            <span class="cc-todo-dock-count">${done} / ${total}</span>
            <svg class="cc-todo-dock-chev${open ? ' is-open' : ''}" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 6 8 10 12 6"/></svg>
          </button>
          <div class="cc-todo-progress"><div class="cc-todo-progress-fill" style="width:${pct}%"></div></div>
          ${open ? `<div class="cc-todo-dock-list">${renderTodoInlineHtml(list)}</div>` : ''}
        </div>
      `;
    }

    function renderLiveAsk(ask, asking) {
      if (!asking || !ask) {
        if (!liveAskEl.hidden) {
          liveAskEl.hidden = true;
          liveAskEl.innerHTML = '';
          lastAskSig = '';
          lastAskCoreSig = '';
        }
        return;
      }

      const coreSig = JSON.stringify([ask.title, ask.options, ask.steps, ask.multiSelect]);
      const fullSig = JSON.stringify(ask);
      if (fullSig === lastAskSig) return;
      lastAskSig = fullSig;

      if (!currentTab.askDraft || coreSig !== lastAskCoreSig) {
        lastAskCoreSig = coreSig;
        currentTab.askDraft = {
          checked: Array.isArray(ask.checked) ? [...ask.checked] : [],
          freeText: '',
        };
      }

      const activeInFree = document.activeElement && document.activeElement.classList.contains('cc-live-ask-input');
      if (activeInFree) return;

      const stepsHtml = Array.isArray(ask.steps) && ask.steps.length
        ? `<div class="cc-live-ask-steps">${ask.steps.map((s) => `<span class="cc-live-step${s.done ? ' is-done' : ''}">${s.done ? '✓' : '·'} ${Md.escapeHtml(s.label)}</span>`).join('')}</div>`
        : '';

      const optionsHtml = (ask.options || []).map((label, i) => {
        const desc = (ask.descriptions && ask.descriptions[i]) || '';
        const isLast = i === ask.options.length - 1;
        if (ask.multiSelect) {
          if (ask.checkable && ask.checkable[i]) {
            const on = Boolean(currentTab.askDraft.checked[i]);
            return `
              <button type="button" class="cc-live-opt${on ? ' is-selected' : ''}" data-ask-toggle="${i}">
                <input type="checkbox" ${on ? 'checked' : ''} tabindex="-1" />
                <div class="cc-live-opt-body">
                  <div class="cc-live-opt-lbl">${Md.escapeHtml(label)}</div>
                  ${desc ? `<div class="cc-live-opt-desc">${Md.escapeHtml(desc)}</div>` : ''}
                </div>
              </button>
            `;
          }
          if (i === ask.submitIndex) {
            return `<button type="button" class="cc-btn cc-btn--primary cc-btn--sm" data-ask-submit-multi>${Md.escapeHtml(label)}</button>`;
          }
          return '';
        }
        if (i === ask.freeTextIndex) return '';

        const cls = ask.binary
          ? (isLast ? 'cc-btn--danger' : 'cc-btn--primary')
          : (i === ask.cursorRow ? 'is-selected' : '');
        const keyHint = ask.numbered !== false ? `<span class="cc-live-key">${i + 1}</span>` : '';
        return `
          <button type="button" class="cc-live-opt ${cls}" data-ask-pick="${i}">
            ${keyHint}
            <div class="cc-live-opt-body">
              <div class="cc-live-opt-lbl">${Md.escapeHtml(label)}</div>
              ${desc ? `<div class="cc-live-opt-desc">${Md.escapeHtml(desc)}</div>` : ''}
            </div>
          </button>
        `;
      }).join('');

      const needSubmitFallback = ask.multiSelect && (ask.submitIndex === null || ask.submitIndex === undefined);
      const freeHtml = ask.freeTextIndex >= 0
        ? `
          <div class="cc-live-ask-free">
            <input type="text" class="cc-live-ask-input" placeholder="${Md.escapeHtml((ask.options && ask.options[ask.freeTextIndex]) || '输入其他回答…')}" value="${Md.escapeHtml(currentTab.askDraft.freeText || '')}" />
            <button type="button" class="cc-btn cc-btn--sm cc-btn--primary" data-ask-send-free="${ask.freeTextIndex}">发送</button>
          </div>
        `
        : '';

      liveAskEl.innerHTML = `
        <div class="cc-card-head">
          <div class="cc-card-head-l">
            <span class="cc-card-badge cc-card-badge--ask">需要你的确认</span>
          </div>
          <div class="cc-card-head-r">
            <button type="button" class="cc-mini-btn" data-ask-switch-term>去终端</button>
            <button type="button" class="cc-mini-btn" data-ask-cancel>Esc 取消</button>
          </div>
        </div>
        ${stepsHtml}
        <div class="cc-live-ask-title">${Md.escapeHtml(ask.title || 'Claude 需要你确认')}</div>
        <div class="cc-live-ask-opts">${optionsHtml}</div>
        ${needSubmitFallback ? '<button type="button" class="cc-btn cc-btn--primary cc-btn--sm" data-ask-submit-multi>提交选择</button>' : ''}
        ${freeHtml}
      `;
      liveAskEl.hidden = false;
    }

    function injectCaretHtml(html) {
      if (!html) return CARET_HTML;
      const m = /(<\/(?:p|li|h[1-6]|blockquote)>)\s*$/i.exec(html);
      if (m) {
        const idx = m.index;
        return `${html.slice(0, idx)}${CARET_HTML}${html.slice(idx)}`;
      }
      return `${html}${CARET_HTML}`;
    }

    function renderLiveStreamFrame() {
      const slice = streamTarget.slice(0, streamShown);
      liveStreamEl.innerHTML = injectCaretHtml(Md.renderMarkdown(slice));
      liveStreamEl.hidden = false;
      if (pinnedToBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function stopLiveStream({ resetPeak = false } = {}) {
      if (streamRaf) {
        cancelAnimationFrame(streamRaf);
        streamRaf = 0;
      }
      streamTarget = '';
      streamShown = 0;
      streamLastTs = 0;
      if (resetPeak) streamPeakChars = 0;
      liveStreamEl.hidden = true;
      liveStreamEl.innerHTML = '';
    }

    function updateLiveStream(tabView, isWorking, liveText) {
      if (!isWorking || !liveText) {
        stopLiveStream({ resetPeak: false });
        return;
      }
      const prefixLen = Math.min(16, streamTarget.length, liveText.length);
      const sameBlock = Boolean(
        streamTarget
        && prefixLen > 0
        && liveText.slice(0, prefixLen) === streamTarget.slice(0, prefixLen)
      );
      if (!sameBlock) {
        streamShown = 0;
      } else if (streamShown > liveText.length) {
        streamShown = liveText.length;
      }
      streamTarget = liveText;
      streamPeakChars = Math.max(streamPeakChars, liveText.length);

      if (!streamRaf) {
        if (streamShown === 0) {
          streamShown = Math.min(streamTarget.length, 4);
          renderLiveStreamFrame();
        }
        const tickStream = (now) => {
          streamRaf = 0;
          if (!currentTab || currentTab !== tabView || !streamTarget) return;
          const dt = streamLastTs ? Math.min(48, Math.max(8, now - streamLastTs)) : 16;
          streamLastTs = now;
          const backlog = streamTarget.length - streamShown;
          if (backlog > 0) {
            const step = Math.max(2, Math.ceil((backlog * dt) / 130));
            streamShown = Math.min(streamTarget.length, streamShown + step);
            renderLiveStreamFrame();
          }
          if (streamShown < streamTarget.length) {
            streamRaf = requestAnimationFrame(tickStream);
          } else {
            streamLastTs = 0;
          }
        };
        streamRaf = requestAnimationFrame(tickStream);
      }
    }

    function stopReveal({ renderFull = false } = {}) {
      if (revealRaf) {
        cancelAnimationFrame(revealRaf);
        revealRaf = 0;
      }
      if (renderFull && revealTurnId && revealFullText) {
        try {
          const el = turnsEl.querySelector(`.cc-turn[data-turn-id="${CSS.escape(revealTurnId)}"] .cc-closing`);
          if (el) el.innerHTML = Md.renderMarkdown(revealFullText);
        } catch {}
      }
      revealTurnId = '';
      revealFullText = '';
      revealShown = 0;
      revealLastTs = 0;
    }

    function applyCurrentRevealSlice(turn) {
      if (!revealTurnId || !turn || turn.id !== revealTurnId || !turn.closing || turn.closing.text !== revealFullText) {
        return;
      }
      try {
        const el = turnsEl.querySelector(`.cc-turn[data-turn-id="${CSS.escape(revealTurnId)}"] .cc-closing`);
        if (el) el.innerHTML = Md.renderMarkdown(revealFullText.slice(0, revealShown));
      } catch {}
    }

    function startReveal(tabView, turn, fullText) {
      stopReveal({ renderFull: false });
      if (!turn || !fullText) return;
      revealTurnId = turn.id;
      revealFullText = fullText;
      revealShown = Math.min(fullText.length, 8);
      applyCurrentRevealSlice(turn);
      if (pinnedToBottom) scrollEl.scrollTop = scrollEl.scrollHeight;

      const tickReveal = (now) => {
        revealRaf = 0;
        if (!currentTab || currentTab !== tabView || !revealTurnId) return;
        const dt = revealLastTs ? Math.min(48, Math.max(8, now - revealLastTs)) : 16;
        revealLastTs = now;
        const durationMs = Math.min(450, Math.max(180, revealFullText.length * 1.2));
        const step = Math.max(4, Math.ceil((revealFullText.length * dt) / durationMs));
        revealShown = Math.min(revealFullText.length, revealShown + step);
        try {
          const el = turnsEl.querySelector(`.cc-turn[data-turn-id="${CSS.escape(revealTurnId)}"] .cc-closing`);
          if (el) {
            el.innerHTML = revealShown >= revealFullText.length
              ? Md.renderMarkdown(revealFullText)
              : Md.renderMarkdown(revealFullText.slice(0, revealShown));
          }
        } catch {}
        if (pinnedToBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
        if (revealShown < revealFullText.length) {
          revealRaf = requestAnimationFrame(tickReveal);
        } else {
          revealTurnId = '';
          revealFullText = '';
          revealShown = 0;
          revealLastTs = 0;
        }
      };
      revealRaf = requestAnimationFrame(tickReveal);
    }

    function syncStatusTicker(tabView, isWorking) {
      if (isWorking) {
        if (!statusTickTimer) {
          statusTickTimer = setInterval(() => {
            if (!currentTab || currentTab !== tabView || !lastConversation) return;
            const st = currentTab.state || {};
            if (st.status !== 'working') return;
            const turns = lastConversation.turns || [];
            const lastTurn = turns[turns.length - 1];
            runStatusTimer.textContent = lastTurn && lastTurn.startedAt
              ? Act.duration(Math.max(0, Date.now() - lastTurn.startedAt))
              : '';
          }, 1000);
        }
      } else if (statusTickTimer) {
        clearInterval(statusTickTimer);
        statusTickTimer = 0;
      }
    }

    function render(tabView, { full = false } = {}) {
      if (!tabView) return;
      const prevTab = currentTab;
      currentTab = tabView;
      if (prevTab !== tabView || full) {
        stopReveal({ renderFull: false });
        stopLiveStream({ resetPeak: true });
        peakTurnId = '';
        tabView._revealedTextSeq = Number(tabView.liveTextEventSeq || 0);
        turnsEl.innerHTML = '';
        turnSigs.clear();
        lastPendingSig = '';
        lastTodoSig = '';
        lastAskSig = '';
        lastAskCoreSig = '';
        openStatsTurnId = '';
      }

      const conv = Tr.conversation(tabView.events);
      lastConversation = conv;
      const st = tabView.state || {};
      const isWorking = st.status === 'working';
      const isAsking = st.status === 'asking';

      const lastTurn = conv.turns[conv.turns.length - 1];
      const curTurnId = (lastTurn && lastTurn.id) || '';
      if (curTurnId !== peakTurnId) {
        peakTurnId = curTurnId;
        streamPeakChars = 0;
      }

      launchBanner.hidden = Boolean(st.claudeRunning);
      olderBtn.hidden = !st.hasOlder;
      olderBtn.disabled = Boolean(st.loadingOlder);
      olderBtn.textContent = st.loadingOlder ? '加载中…' : '加载更早的对话';
      beginEl.hidden = Boolean(st.hasOlder || conv.turns.length === 0);
      emptyEl.hidden = conv.turns.length > 0 || (st.pendingUsers && st.pendingUsers.length > 0);

      renderTurns(conv.turns, isWorking);
      if (revealRaf && lastTurn && lastTurn.id === revealTurnId) {
        applyCurrentRevealSlice(lastTurn);
      }
      renderPendingUsers(st.pendingUsers);
      renderTodoDock(conv.todos);

      const curTextSeq = Number(tabView.liveTextEventSeq || 0);
      const prevTextSeq = Number(tabView._revealedTextSeq || 0);
      if (curTextSeq > prevTextSeq) {
        tabView._revealedTextSeq = curTextSeq;
        if (!full && prevTab === tabView && lastTurn && lastTurn.closing && lastTurn.closing.text) {
          const fullText = lastTurn.closing.text;
          const alreadyStreamed = streamPeakChars >= Math.min(40, fullText.length * 0.3);
          if (!alreadyStreamed) {
            startReveal(tabView, lastTurn, fullText);
          }
        }
      }

      const liveStreamText = String(st.liveStreamText || '');
      updateLiveStream(tabView, isWorking, liveStreamText);
      if (!isWorking && !liveStreamText) {
        streamPeakChars = 0;
      }

      runStatusEl.hidden = !isWorking;
      syncStatusTicker(tabView, isWorking);
      if (isWorking) {
        let label = '';
        if (liveStreamText) {
          label = 'Claude 正在回复…';
        } else if (lastTurn && lastTurn.segments.length) {
          const lastSeg = lastTurn.segments[lastTurn.segments.length - 1];
          if (lastSeg.kind === 'process' && lastSeg.parts.length) {
            const lp = lastSeg.parts[lastSeg.parts.length - 1];
            if (lp.kind === 'work') label = Act.summarize(lp.tools, true) || '';
            else if (lp.kind === 'thinking') label = 'Claude 正在思考…';
          }
        }
        runStatusText.textContent = label || st.activity || 'Claude 正在思考…';
        runStatusTimer.textContent = lastTurn && lastTurn.startedAt
          ? Act.duration(Math.max(0, Date.now() - lastTurn.startedAt))
          : '';
      }

      renderLiveAsk(st.ask, isAsking);

      if (pinnedToBottom) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      } else if (prevTab !== tabView) {
        scrollEl.scrollTop = tabView.scrollTop || scrollEl.scrollHeight;
      }

      if (!findBar.hidden && findInput.value.trim()) {
        runFind();
      }
      return conv;
    }

    function prependEventsPreserveScroll(tabView) {
      if (currentTab !== tabView) return;
      const prevH = scrollEl.scrollHeight;
      const prevTop = scrollEl.scrollTop;
      render(tabView, { full: true });
      const delta = scrollEl.scrollHeight - prevH;
      if (delta > 0) {
        pinnedToBottom = false;
        scrollEl.scrollTop = prevTop + delta;
      }
    }

    // Delegated <details> open/closed preservation
    mountEl.addEventListener('toggle', (e) => {
      const det = e.target;
      if (det && det.tagName === 'DETAILS' && det.dataset.key) {
        setDetailsOpen(det.dataset.key, det.open);
      }
    }, true);

    liveAskEl.addEventListener('input', (e) => {
      if (currentTab && currentTab.askDraft && e.target.classList.contains('cc-live-ask-input')) {
        currentTab.askDraft.freeText = e.target.value;
      }
    });

    liveAskEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('cc-live-ask-input')) {
        e.preventDefault();
        const btn = liveAskEl.querySelector('[data-ask-send-free]');
        if (btn) btn.click();
      }
    });

    liveAskEl.addEventListener('click', (e) => {
      if (!currentTab || !currentTab.state) return;

      if (e.target.closest('[data-ask-switch-term]')) {
        actions.onSwitchTerminal();
        return;
      }
      if (e.target.closest('[data-ask-cancel]')) {
        actions.onAnswerAsk({ kind: 'cancel' });
        return;
      }
      const toggleBtn = e.target.closest('[data-ask-toggle]');
      if (toggleBtn && currentTab.askDraft) {
        const i = Number(toggleBtn.dataset.askToggle);
        const on = !currentTab.askDraft.checked[i];
        currentTab.askDraft.checked[i] = on;
        toggleBtn.classList.toggle('is-selected', on);
        const cb = toggleBtn.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = on;
        return;
      }
      if (e.target.closest('[data-ask-submit-multi]')) {
        actions.onAnswerAsk({ kind: 'multi', checked: (currentTab.askDraft && currentTab.askDraft.checked) || [] });
        return;
      }
      const pickBtn = e.target.closest('[data-ask-pick]');
      if (pickBtn) {
        actions.onAnswerAsk({ kind: 'pick', index: Number(pickBtn.dataset.askPick) });
        return;
      }
      const sendFree = e.target.closest('[data-ask-send-free]');
      if (sendFree) {
        const inp = liveAskEl.querySelector('.cc-live-ask-input');
        const txt = inp ? inp.value.trim() : '';
        if (!txt) {
          if (inp) inp.focus();
          return;
        }
        actions.onAnswerAsk({ kind: 'text', index: Number(sendFree.dataset.askSendFree), text: txt });
      }
    });

    mountEl.addEventListener('click', (e) => {
      if (!currentTab) return;

      const svgToggle = e.target.closest('.cc-svg-toggle');
      if (svgToggle) {
        const card = svgToggle.closest('.cc-svg-card');
        const pv = card.querySelector('.cc-svg-preview');
        const src = card.querySelector('.cc-svg-src');
        const showingSrc = !src.hidden;
        src.hidden = showingSrc;
        pv.hidden = !showingSrc;
        svgToggle.textContent = showingSrc ? '查看源码' : '查看预览';
        return;
      }

      const planToggleExp = e.target.closest('[data-plan-toggle-expand]');
      if (planToggleExp) {
        if (!currentTab.planExpanded) currentTab.planExpanded = new Set();
        const tid = planToggleExp.dataset.planToggleExpand;
        if (currentTab.planExpanded.has(tid)) currentTab.planExpanded.delete(tid);
        else currentTab.planExpanded.add(tid);
        render(currentTab);
        return;
      }

      const todoToggle = e.target.closest('[data-todo-dock-toggle]');
      if (todoToggle) {
        currentTab.todoDockOpen = !currentTab.todoDockOpen;
        renderTodoDock(lastConversation && lastConversation.todos);
        return;
      }

      const copyTurnBtn = e.target.closest('[data-copy-turn]');
      if (copyTurnBtn) {
        stopReveal({ renderFull: true });
        const tid = copyTurnBtn.dataset.copyTurn;
        const conv = lastConversation || Tr.conversation(currentTab.events);
        const turn = conv.turns.find((t) => t.id === tid);
        const mdText = (turn && turn.closing && turn.closing.text) || '';
        if (mdText && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(mdText).then(() => {
            const sp = copyTurnBtn.querySelector('span');
            if (sp) sp.textContent = '已复制';
            copyTurnBtn.classList.add('is-copied');
            setTimeout(() => {
              if (sp) sp.textContent = '复制';
              copyTurnBtn.classList.remove('is-copied');
            }, 1500);
          }).catch(() => {});
        }
        return;
      }

      const planFs = e.target.closest('[data-plan-fullscreen]');
      if (planFs) {
        const tid = planFs.dataset.planFullscreen;
        const conv = lastConversation || Tr.conversation(currentTab.events);
        let planMd = '';
        for (const t of conv.turns) {
          for (const s of t.segments) {
            if (s.kind === 'plan' && s.tool.id === tid) {
              planMd = (s.tool.input && (s.tool.input.plan || s.tool.input.content)) || '';
            }
          }
        }
        planModalBody.innerHTML = `<div class="cc-md">${Md.renderMarkdown(planMd)}</div>`;
        planModal.hidden = false;
        return;
      }

      const statsToggle = e.target.closest('[data-stats-toggle]');
      if (statsToggle) {
        const tid = statsToggle.dataset.statsToggle;
        openStatsTurnId = openStatsTurnId === tid ? '' : tid;
        turnSigs.delete(tid);
        render(currentTab);
        return;
      }

      const userExp = e.target.closest('[data-user-expand]');
      if (userExp) {
        const uid = userExp.dataset.userExpand;
        if (currentTab.expandedUsers.has(uid)) currentTab.expandedUsers.delete(uid);
        else currentTab.expandedUsers.add(uid);
        render(currentTab);
      }
    });

    return {
      render,
      prependEventsPreserveScroll,
      scrollToBottom,
      toggleFind,
      destroy: () => {
        stopLiveStream({ resetPeak: true });
        stopReveal({ renderFull: false });
        if (statusTickTimer) {
          clearInterval(statusTickTimer);
          statusTickTimer = 0;
        }
      },
    };
  }

  window.TaktChatConversation = {
    createConversationView,
  };
})();
