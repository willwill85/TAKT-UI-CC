(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripAnsi(str) {
    return String(str || '').replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g, '');
  }

  function looksLikeFilePath(str) {
    const s = String(str || '').trim();
    if (!s || s.length > 260 || /\s/.test(s) || /^https?:\/\//i.test(s)) return false;
    const bare = s.replace(/(?::\d+){1,2}$/, '');
    if (/^\d+(?:[\/.-]\d+)+$/.test(bare)) return false;
    if (bare.startsWith('/') && bare.length > 1) return true;
    if (/^(?:\.\.?\/|[a-zA-Z0-9._-]+\/)/.test(bare)) return true;
    if (/\.(?:js|mjs|cjs|ts|tsx|jsx|py|sh|go|rs|java|c|cpp|h|hpp|swift|json|yaml|yml|toml|md|txt|css|scss|html|sql|csv|pdf|png|jpg|jpeg|webp|svg|step|stp|stl|kicad_pcb|kicad_sch|fcstd)$/i.test(bare)) {
      return !/^\d+\.\d+$/.test(bare);
    }
    return false;
  }

  // Protect dollar amounts ($100, $5-$10) while recognizing $...$ and $$...$$ math
  function protectMathAndCode(src) {
    const tokens = [];
    const pushToken = (html) => {
      const idx = tokens.length;
      tokens.push(html);
      return `\uE000TOK${idx}\uE001`;
    };

    // 1. Fenced code blocks (```lang ... ```)
    let text = String(src || '').replace(/\r\n/g, '\n');
    text = text.replace(/^[ \t]*```([a-zA-Z0-9_+-]*)[ \t]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_, lang, code) => {
      const cleanLang = (lang || '').toLowerCase();
      const body = code.replace(/\n$/, '');
      if (cleanLang === 'svg' && /<svg[\s>]/i.test(body)) {
        const encoded = encodeURIComponent(body);
        return pushToken(
          `<div class="md-code cc-svg-card">`
          + `<div class="cc-code-head"><span>svg</span><div class="cc-code-acts">`
          + `<button type="button" class="cc-code-btn cc-svg-toggle">查看源码</button>`
          + `<button type="button" class="cc-code-btn md-code-copy">复制</button>`
          + `</div></div>`
          + `<div class="cc-svg-preview"><img src="data:image/svg+xml;charset=utf-8,${encoded}" alt="SVG 预览" /></div>`
          + `<pre class="cc-code-pre cc-svg-src" hidden><code>${escapeHtml(body)}</code></pre>`
          + `</div>`
        );
      }
      return pushToken(
        `<div class="md-code cc-code">`
        + `<div class="cc-code-head"><span>${escapeHtml(cleanLang || 'text')}</span>`
        + `<button type="button" class="cc-code-btn md-code-copy">复制</button></div>`
        + `<pre class="cc-code-pre"><code>${escapeHtml(body)}</code></pre>`
        + `</div>`
      );
    });

    // 2. Display math ($$...$$)
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
      return pushToken(`<div class="cc-math-block"><code>${escapeHtml(math.trim())}</code></div>`);
    });

    // 3. Inline code (`...`)
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      if (looksLikeFilePath(code)) {
        return pushToken(`<a href="#" class="md-file-link cc-file-chip" data-file-path="${escapeHtml(code)}" title="点击预览 · ⌘点击在 Mac 打开 · ⌥点击在 Finder 中显示">${escapeHtml(code)}</a>`);
      }
      return pushToken(`<code class="cc-inline-code">${escapeHtml(code)}</code>`);
    });

    // 4. Inline math ($...$) — avoid currency ($100, $5.00, etc.)
    text = text.replace(/(^|[^\\$])\$(?!\d+(?:[.,]\d+)?(?:\s|$|[.,;:!?)]))([^\s$][^$\n]*?[^\s$\\]|\S)\$/g, (m, pre, math) => {
      if (/^\d/.test(math) && !/[a-zA-Z\\^_{}=+\-*/]/.test(math)) return m;
      return `${pre}${pushToken(`<span class="cc-math">${escapeHtml(math)}</span>`)}`;
    });

    return { text, tokens };
  }

  function restoreTokens(html, tokens) {
    return html.replace(/\uE000TOK(\d+)\uE001/g, (_, idx) => tokens[Number(idx)] || '');
  }

  function formatInlineEmphasis(text) {
    return text
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  }

  function renderInline(raw, tokens) {
    let s = escapeHtml(raw);
    const linkTokens = [];
    const holdLink = (html) => {
      const idx = linkTokens.length;
      linkTokens.push(html);
      return `\uE002LNK${idx}\uE003`;
    };

    // Safe external links — `s` is already HTML-escaped, so preserve &amp; as-is
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      return holdLink(`<a href="${url}" target="_blank" rel="noopener noreferrer" class="cc-ext-link">${formatInlineEmphasis(label)}</a>`);
    });
    // Bare URLs — stop before whitespace or CJK / fullwidth punctuation
    s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<)\]}，。；：！？、》」』】）]+)/g, (m, pre, url) => {
      let clean = url;
      let trail = '';
      while (/[.,;:!?'"`]+$/.test(clean)) {
        trail = clean.slice(-1) + trail;
        clean = clean.slice(0, -1);
      }
      if (!clean || /^https?:\/\/$/i.test(clean)) return m;
      return `${pre}${holdLink(`<a href="${clean}" target="_blank" rel="noopener noreferrer" class="cc-ext-link">${clean}</a>`)}${trail}`;
    });
    s = formatInlineEmphasis(s);
    s = s.replace(/\uE002LNK(\d+)\uE003/g, (_, idx) => linkTokens[Number(idx)] || '');
    return restoreTokens(s, tokens);
  }

  const LIST_LINE_RE = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;

  function measureIndent(ws) {
    let n = 0;
    for (let k = 0; k < ws.length; k++) n += ws[k] === '\t' ? 2 : 1;
    return n;
  }

  function serializeList(list) {
    const cls = list.tag === 'ol' ? 'cc-ol' : 'cc-ul';
    const lis = list.items.map((it) => {
      const nested = it.children.map(serializeList).join('');
      if (it.isTask) {
        return `<li class="cc-task-li"><div class="cc-task-row">${it.html}</div>${nested}</li>`;
      }
      return `<li>${it.html}${nested}</li>`;
    }).join('');
    return `<${list.tag} class="${cls}">${lis}</${list.tag}>`;
  }

  function renderMarkdown(md) {
    if (!md) return '';
    const { text, tokens } = protectMathAndCode(md);
    const lines = text.split('\n');
    const out = [];
    let i = 0;

    const isBlockToken = (line) => /^\s*\uE000TOK\d+\uE001\s*$/.test(line);

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      if (isBlockToken(line)) {
        const html = restoreTokens(line.trim(), tokens);
        if (html.startsWith('<div')) {
          out.push(html);
          i += 1;
          continue;
        }
      }

      // Headings
      const hm = line.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        const lvl = hm[1].length;
        out.push(`<h${lvl} class="cc-h cc-h${lvl}">${renderInline(hm[2].trim(), tokens)}</h${lvl}>`);
        i += 1;
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
        out.push('<hr class="cc-hr" />');
        i += 1;
        continue;
      }

      // GFM Table
      if (i + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const parseRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const headers = parseRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(parseRow(lines[i]));
          i += 1;
        }
        const ths = headers.map((h) => `<th>${renderInline(h, tokens)}</th>`).join('');
        const trs = rows.map((row) => {
          const tds = headers.map((_, ci) => `<td>${renderInline(row[ci] || '', tokens)}</td>`).join('');
          return `<tr>${tds}</tr>`;
        }).join('');
        out.push(`<div class="cc-table-wrap"><table class="cc-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
        continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote class="cc-quote">${renderInline(quoteLines.join('\n'), tokens).replace(/\n/g, '<br/>')}</blockquote>`);
        continue;
      }

      // Nested Unordered / Ordered / Task list
      const lm = line.match(LIST_LINE_RE);
      if (lm) {
        const rootTag = /^\d/.test(lm[2]) ? 'ol' : 'ul';
        const root = { tag: rootTag, indent: measureIndent(lm[1]), items: [] };
        const stack = [root];

        while (i < lines.length) {
          const m = lines[i].match(LIST_LINE_RE);
          if (!m) break;
          const indent = measureIndent(m[1]);
          const tag = /^\d/.test(m[2]) ? 'ol' : 'ul';
          if (indent < stack[0].indent) break;

          while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
            stack.pop();
          }

          let cur = stack[stack.length - 1];
          if (indent === cur.indent && cur.tag !== tag) {
            if (stack.length === 1) break;
            stack.pop();
            cur = stack[stack.length - 1];
          }

          if (indent > cur.indent || cur.tag !== tag) {
            const parentItems = cur.items;
            if (!parentItems.length) break;
            const child = { tag, indent, items: [] };
            parentItems[parentItems.length - 1].children.push(child);
            stack.push(child);
            cur = child;
          }

          const rawItem = m[3];
          const cb = rawItem.match(/^\[( |x|X)\]\s+(.*)$/);
          if (cb) {
            const checked = cb[1].toLowerCase() === 'x';
            cur.items.push({
              isTask: true,
              html: `<span class="cc-task-box${checked ? ' is-checked' : ''}">${checked ? '✓' : ''}</span><span>${renderInline(cb[2], tokens)}</span>`,
              children: [],
            });
          } else {
            cur.items.push({
              isTask: false,
              html: renderInline(rawItem, tokens),
              children: [],
            });
          }
          i += 1;
        }
        out.push(serializeList(root));
        continue;
      }

      // Paragraph (stops on blank line, heading, blockquote, list, hr, or block code token)
      const pLines = [];
      while (
        i < lines.length
        && lines[i].trim()
        && !/^[ \t]*(?:#{1,6}\s|>\s?|[-*+]\s+|\d+[.)]\s+|(?:---|\*\*\*|___)\s*$)/.test(lines[i])
        && !(isBlockToken(lines[i]) && restoreTokens(lines[i].trim(), tokens).startsWith('<div'))
      ) {
        if (i + 1 < lines.length && lines[i].includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
          break;
        }
        pLines.push(lines[i]);
        i += 1;
      }
      out.push(`<p class="cc-p">${renderInline(pLines.join('\n'), tokens).replace(/\n/g, '<br/>')}</p>`);
    }

    return out.join('');
  }

  function renderDiffHtml(oldStr, newStr, maxLines = 180) {
    const a = typeof oldStr === 'string' && oldStr ? oldStr.split('\n') : [];
    const b = typeof newStr === 'string' && newStr ? newStr.split('\n') : [];
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

    const lines = [];
    const ctxStart = Math.max(0, head - 2);
    for (let k = ctxStart; k < head; k++) {
      lines.push(`<div class="cc-diff-line ctx"><span class="cc-diff-sig"> </span><code>${escapeHtml(a[k])}</code></div>`);
    }
    const remEnd = a.length - tail;
    for (let k = head; k < remEnd && lines.length < maxLines; k++) {
      lines.push(`<div class="cc-diff-line del"><span class="cc-diff-sig">-</span><code>${escapeHtml(a[k])}</code></div>`);
    }
    const addEnd = b.length - tail;
    for (let k = head; k < addEnd && lines.length < maxLines; k++) {
      lines.push(`<div class="cc-diff-line add"><span class="cc-diff-sig">+</span><code>${escapeHtml(b[k])}</code></div>`);
    }
    const tailCtxEnd = Math.min(a.length, remEnd + 2);
    for (let k = remEnd; k < tailCtxEnd && lines.length < maxLines; k++) {
      lines.push(`<div class="cc-diff-line ctx"><span class="cc-diff-sig"> </span><code>${escapeHtml(a[k])}</code></div>`);
    }
    const omitted = (remEnd - head) + (addEnd - head) > maxLines;
    return `<div class="cc-diff">${lines.join('')}${omitted ? '<div class="cc-diff-more">… 其余变更已折叠</div>' : ''}</div>`;
  }

  function buildImageThumbUrl(img, tabState) {
    if (!img) return '';
    if (img.dataUrl) return img.dataUrl;
    if (typeof img.off === 'number' && typeof img.idx === 'number' && tabState && tabState.jsonlPath) {
      const q = new URLSearchParams({
        nodeId: tabState.nodeId || '',
        path: tabState.jsonlPath,
        off: String(img.off),
        idx: String(img.idx),
        u: String(img.u || ''),
      });
      return `/api/chat-image?${q.toString()}`;
    }
    return '';
  }

  window.TaktChatMarkdown = {
    escapeHtml,
    stripAnsi,
    renderMarkdown,
    renderDiffHtml,
    buildImageThumbUrl,
    looksLikeFilePath,
  };
})();
