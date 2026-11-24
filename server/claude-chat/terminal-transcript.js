'use strict';

const MAX_TOOL_RESULT_CHARS = 60000;

function clipText(str, max = MAX_TOOL_RESULT_CHARS) {
  const s = typeof str === 'string' ? str : String(str == null ? '' : str);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [已截断 ${s.length - max} 字符] …\n${s.slice(-tail)}`;
}

function extractToolResultContent(rawContent) {
  const images = [];
  if (typeof rawContent === 'string') {
    return { output: clipText(rawContent), images };
  }
  if (!Array.isArray(rawContent)) {
    if (rawContent == null) return { output: '', images };
    try {
      return { output: clipText(JSON.stringify(rawContent, null, 2)), images };
    } catch {
      return { output: clipText(String(rawContent)), images };
    }
  }
  const parts = [];
  for (const b of rawContent) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'image' && b.source && typeof b.source === 'object') {
      const src = b.source;
      if (src.type === 'base64' && typeof src.data === 'string') {
        images.push({
          mediaType: src.media_type || 'image/png',
          dataUrl: `data:${src.media_type || 'image/png'};base64,${src.data}`,
        });
      } else if (src.type === 'takt_ref') {
        images.push({
          off: src.off,
          idx: src.idx,
          mt: src.mt || src.media_type || 'image/png',
          u: src.u || src.uuid || '',
        });
      }
    }
  }
  return { output: clipText(parts.join('\n')), images };
}

const NOISE_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-caveat',
  'system-reminder',
];
const NOISE_RE = new RegExp(`<(${NOISE_TAGS.join('|')})>[\\s\\S]*?<\\/\\1>`, 'g');

function stripNoise(s) {
  return String(s || '')
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_, cmd) => `! ${cmd.trim()}`)
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/g, '')
    .replace(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/g, '')
    .replace(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/g, '')
    .replace(NOISE_RE, '')
    .replace(/\[Request interrupted by user[^\]]*\]/g, '')
    .trim();
}

function extractLocalCommandOutputs(raw) {
  const notices = [];
  const s = String(raw || '');
  const re = /<(local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const text = m[2].trim();
    if (text) notices.push(text);
  }
  return notices;
}

function parseTs(raw, fallback = Date.now()) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

function buildContextUsage(usage, model) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheCreate = Number(usage.cache_creation_input_tokens || 0);
  const totalTokens = input + cacheRead + cacheCreate;
  if (totalTokens <= 0) return null;
  const rawMaxTokens = /1m/i.test(String(model || '')) ? 1000000 : 200000;
  const percentage = Math.min(100, Math.max(0, Math.round((totalTokens / rawMaxTokens) * 100)));
  return {
    percentage,
    totalTokens,
    rawMaxTokens,
    fromJsonl: true,
    categories: [
      { name: '直传输入', tokens: input },
      { name: '缓存读取', tokens: cacheRead },
      { name: '缓存写入', tokens: cacheCreate },
    ],
  };
}

const HIDDEN_INTERNAL_TOOLS = new Set(['ToolSearch']);

function parseJsonlRecordsToEvents(records, { startSeq = 1, idPrefix = 'hist', existingToolNames, existingSeenMsgIds } = {}) {
  const events = [];
  let seq = startSeq;
  const toolNameById = existingToolNames ? new Map(existingToolNames) : new Map();
  const seenMsgIds = existingSeenMsgIds ? new Set(existingSeenMsgIds) : new Set();
  const emittedByMsg = new Map();
  const emittedUserTexts = [];

  let openTurn = null;
  let lastUserText = null;

  const push = (type, payload, ts, suffix = '') => {
    const ev = {
      id: `${idPrefix}-${seq}${suffix ? `-${suffix}` : ''}`,
      seq: seq++,
      ts,
      type,
      payload,
    };
    events.push(ev);
    return ev;
  };

  const flushTurnStats = (ts, durationOverrideMs = null) => {
    if (!openTurn) return;
    if (openTurn.requests > 0 || openTurn.outputTokens > 0) {
      const durationMs = typeof durationOverrideMs === 'number' && durationOverrideMs >= 0
        ? durationOverrideMs
        : Math.max(0, (openTurn.lastTs || ts) - openTurn.startedAt);
      push('turn.stats', {
        durationMs,
        apiMs: 0,
        ttftMs: null,
        requests: openTurn.requests || 1,
        inputTokens: openTurn.inputTokens,
        outputTokens: openTurn.outputTokens,
        cacheReadTokens: openTurn.cacheReadTokens,
        cacheCreationTokens: openTurn.cacheCreationTokens,
        costUsd: null,
        model: openTurn.model || '',
        stopReason: 'end_turn',
      }, ts, 'stats');
    }
    openTurn = null;
  };

  const meta = {
    permissionMode: '',
    model: '',
    effort: '',
    modelTs: 0,
    title: '',
    totalCostUsd: null,
    modelUsage: null,
    contextUsage: null,
  };

  for (let i = 0; i < (Array.isArray(records) ? records.length : 0); i++) {
    const obj = records[i];
    if (!obj || typeof obj !== 'object') continue;
    const t = obj.type;
    const ts = parseTs(obj.timestamp);

    if (t === 'permission-mode' && obj.permissionMode) {
      meta.permissionMode = String(obj.permissionMode);
      push('native.mode', { permissionMode: meta.permissionMode }, ts);
      continue;
    }
    if ((t === 'custom-title' || t === 'ai-title') && (obj.customTitle || obj.aiTitle)) {
      meta.title = String(obj.customTitle || obj.aiTitle);
      continue;
    }
    if (t === 'cost-state') {
      if (typeof obj.totalCostUSD === 'number') meta.totalCostUsd = obj.totalCostUSD;
      if (obj.modelUsage && typeof obj.modelUsage === 'object') meta.modelUsage = obj.modelUsage;
      continue;
    }

    if (t === 'system') {
      const sub = obj.subtype;
      if (sub === 'compact_boundary') {
        flushTurnStats(ts);
        meta.contextUsage = null;
        const cm = obj.compactMetadata && typeof obj.compactMetadata === 'object' ? obj.compactMetadata : {};
        push('native.compact', {
          status: 'completed',
          trigger: cm.trigger || 'auto',
          preTokens: Number(cm.preTokens || cm.pre_tokens || 0),
        }, ts);
      } else if (sub === 'turn_duration') {
        flushTurnStats(ts, Number(obj.durationMs || 0));
      } else if (sub === 'informational' && obj.content && !obj.isMeta) {
        const text = String(obj.content).trim();
        if (text && !/^Code Mode is on,/i.test(text)) {
          push('native.notice', { kind: 'info', text }, ts);
        }
      }
      continue;
    }

    if (obj.isSidechain || obj.isCompactSummary || obj.isVisibleInTranscriptOnly) continue;

    if (t === 'user') {
      const msg = obj.message;
      const content = msg && msg.content;
      const textParts = [];
      const userImages = [];
      const noticeTexts = [];

      if (typeof content === 'string') {
        noticeTexts.push(...extractLocalCommandOutputs(content));
        const clean = stripNoise(content);
        if (clean) textParts.push(clean);
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_result' && b.tool_use_id) {
            const toolUseId = String(b.tool_use_id);
            const toolName = toolNameById.get(toolUseId) || '';
            if (HIDDEN_INTERNAL_TOOLS.has(toolName)) continue;
            const { output, images } = extractToolResultContent(b.content);
            push('tool.result', {
              toolUseId,
              output,
              isError: Boolean(b.is_error),
              images,
              parentToolUseId: null,
            }, ts);

            if (toolName === 'AskUserQuestion') {
              const answers = obj.toolUseResult && typeof obj.toolUseResult.answers === 'object'
                ? obj.toolUseResult.answers
                : null;
              push('approval.resolved', {
                approvalId: `hist-${toolUseId}`,
                toolUseId,
                toolName,
                decision: b.is_error ? 'deny' : 'allow',
                answers: answers || undefined,
              }, ts);
            } else if (toolName === 'ExitPlanMode') {
              push('approval.resolved', {
                approvalId: `hist-${toolUseId}`,
                toolUseId,
                toolName,
                decision: b.is_error ? 'reject' : 'approve',
              }, ts);
            }
          } else if (b.type === 'text' && typeof b.text === 'string') {
            noticeTexts.push(...extractLocalCommandOutputs(b.text));
            const clean = stripNoise(b.text);
            if (clean) textParts.push(clean);
          } else if (b.type === 'image' && b.source && b.source.type === 'takt_ref') {
            const s = b.source;
            userImages.push({ off: s.off, idx: s.idx, mt: s.mt || 'image/png', u: s.u || obj.uuid || '' });
          }
        }
      }

      for (const n of noticeTexts) {
        push('native.notice', { kind: 'command', text: n }, ts);
      }

      if (!obj.isMeta && (textParts.length > 0 || userImages.length > 0)) {
        const joined = textParts.join('\n\n');
        if (userImages.length > 0 || joined !== lastUserText) {
          flushTurnStats(ts);
          lastUserText = joined;
          emittedUserTexts.push({ text: joined, ts });
          openTurn = { startedAt: ts, lastTs: ts, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: '' };
          push('message.user', {
            uuid: obj.uuid || '',
            text: joined,
            images: userImages.slice(0, 12),
          }, ts);
        }
      }
      continue;
    }

    if (t === 'assistant' && obj.message && typeof obj.message === 'object') {
      if (obj.isMeta) continue;
      const m = obj.message;
      const mid = m.id || obj.uuid || `asst-${i}`;
      const rawModel = obj.requestedModel || m.model;
      if (typeof rawModel === 'string' && rawModel && !rawModel.startsWith('<')) {
        meta.model = rawModel;
        meta.modelTs = ts;
      }
      if (typeof obj.effort === 'string' && obj.effort) {
        meta.effort = obj.effort;
      } else if (typeof obj.perTurnEffort === 'string' && obj.perTurnEffort) {
        meta.effort = obj.perTurnEffort;
      }

      if (!openTurn) {
        openTurn = { startedAt: ts, lastTs: ts, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: meta.model };
      }
      openTurn.lastTs = ts;
      if (meta.model) openTurn.model = meta.model;

      const ctx = buildContextUsage(m.usage, meta.model);
      if (ctx) meta.contextUsage = ctx;

      let seen = emittedByMsg.get(mid);
      if (!seen) {
        seen = {
          uuids: new Set(),
          toolIds: new Set(),
          texts: new Set(),
          thinkings: new Set(),
          countedUsage: seenMsgIds.has(mid),
        };
        emittedByMsg.set(mid, seen);
      }
      if (obj.uuid) {
        if (seen.uuids.has(obj.uuid)) continue;
        seen.uuids.add(obj.uuid);
      }
      seenMsgIds.add(mid);
      if (!seen.countedUsage && m.usage && typeof m.usage === 'object') {
        seen.countedUsage = true;
        openTurn.requests += 1;
        openTurn.inputTokens += Number(m.usage.input_tokens || 0);
        openTurn.outputTokens += Number(m.usage.output_tokens || 0);
        openTurn.cacheReadTokens += Number(m.usage.cache_read_input_tokens || 0);
        openTurn.cacheCreationTokens += Number(m.usage.cache_creation_input_tokens || 0);
      }

      const content = m.content;
      if (typeof content === 'string') {
        const clean = stripNoise(content);
        if (clean && clean !== 'No response requested.' && !seen.texts.has(clean)) {
          seen.texts.add(clean);
          lastUserText = null;
          push('text.delta', { text: clean, parentToolUseId: null }, ts);
        }
      } else if (Array.isArray(content)) {
        for (let bIdx = 0; bIdx < content.length; bIdx++) {
          const b = content[bIdx];
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'thinking' && typeof b.thinking === 'string') {
            if (!b.thinking.trim() || seen.thinkings.has(b.thinking)) continue;
            seen.thinkings.add(b.thinking);
            lastUserText = null;
            push('thinking.delta', { text: clipText(b.thinking, 120000), parentToolUseId: null }, ts);
          } else if (b.type === 'text' && typeof b.text === 'string') {
            const clean = stripNoise(b.text);
            if (!clean || clean === 'No response requested.' || seen.texts.has(clean)) continue;
            seen.texts.add(clean);
            lastUserText = null;
            push('text.delta', { text: clean, parentToolUseId: null }, ts);
          } else if (b.type === 'tool_use' && b.name) {
            const toolUseId = String(b.id || `hist-tool-${i}-${bIdx}`);
            const toolName = String(b.name);
            toolNameById.set(toolUseId, toolName);
            if (HIDDEN_INTERNAL_TOOLS.has(toolName) || seen.toolIds.has(toolUseId)) continue;
            seen.toolIds.add(toolUseId);
            lastUserText = null;
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            push('tool.requested', { toolUseId, toolName, input, parentToolUseId: null }, ts);
            if (Object.keys(input).length > 0) {
              push('tool.input', { toolUseId, toolName, input, parentToolUseId: null }, ts);
            }
          }
        }
      }
    }
  }

  return {
    events,
    nextSeq: seq,
    toolNameById,
    seenMsgIds,
    emittedUserTexts,
    meta,
  };
}

module.exports = {
  parseJsonlRecordsToEvents,
  stripNoise,
  clipText,
  extractToolResultContent,
  buildContextUsage,
};
