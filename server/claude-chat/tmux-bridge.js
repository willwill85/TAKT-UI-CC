'use strict';

function shSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

const CLAUDE_SPINNER_LINE_RE = /^\s*[·✢✳✶✻✽∗*]\s+\S[^\n]{0,80}…/;
const CLAUDE_NUMBERED_OPT_RE = /^\s*(❯)?\s*(\d+)\.\s*(?:\[(x| )\]\s*)?(.+?)\s*$/;
const CLAUDE_UNNUMBERED_OPT_RE = /^\s*(❯)\s+(?:\[(x| )\]\s*)?(.+?)\s*$/;
const CLAUDE_STEP_CHIP_RE = /[☐✔☒]\s+[^\s☐✔☒]+/g;
const CLAUDE_HINT_LINE_RE = /^(Enter to |↑\/↓|Tab\/Arrow|Esc to cancel)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripAnsiCodes(str) {
  return String(str || '').replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g, '');
}

function isClaudeRuleLine(t) {
  return t.length >= 6 && /^[─━═╌╍┈┉\-]{6,}$/.test(t);
}

function isClaudeBoxEdge(t) {
  return /^[╭╰┌└][─━]/.test(t) || /[─━][╮╯┐┘]$/.test(t);
}

function unframeLine(line) {
  return String(line || '').replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '');
}

function isBinaryAllowDeny(options) {
  if (options.length < 2) return false;
  const first = options[0].toLowerCase();
  const last = options[options.length - 1].toLowerCase();
  if (!/^yes\b|^allow\b/.test(first) || !/^no\b|^deny\b/.test(last)) return false;
  return options.slice(1, -1).every((o) => /^yes\b|^allow\b/i.test(o));
}

function parseClaudeAsk(screenText) {
  const framedLines = String(screenText || '').split('\n');
  const rawLines = framedLines.map(unframeLine);
  let footerIdx = -1;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (/esc to cancel/i.test(rawLines[i])) {
      footerIdx = i;
      break;
    }
  }
  const endIdx = footerIdx >= 0 ? footerIdx : rawLines.length;

  let cursorLine = -1;
  for (let i = endIdx - 1; i >= 0; i--) {
    if (/^\s*❯/.test(rawLines[i])) {
      cursorLine = i;
      break;
    }
  }
  let blockStart = 0;
  const anchor = cursorLine >= 0 ? cursorLine : endIdx - 1;
  const frame = anchor >= 0 ? (framedLines[anchor] || '').match(/^(\s*)│/) : null;
  for (let i = anchor - 1; i >= 0; i--) {
    const r = framedLines[i] || '';
    if (frame) {
      const ind = frame[1].length;
      if (r[ind] === '╭' && !r.slice(0, ind).trim()) {
        blockStart = i + 1;
        break;
      }
    } else if (/^\s*[─━]{20,}\s*$/.test(r)) {
      blockStart = i + 1;
      break;
    }
  }

  const parsed = [];
  let cursorPos = 0;
  for (let i = blockStart; i < endIdx; i++) {
    const nm = rawLines[i].match(CLAUDE_NUMBERED_OPT_RE);
    if (nm) {
      const n = Number(nm[2]);
      if (n === 1 && parsed.length > 0 && parsed[0].numbered) {
        parsed.length = 0;
        cursorPos = 0;
      }
      if (n === parsed.length + 1) {
        if (nm[1]) cursorPos = parsed.length;
        parsed.push({
          row: i,
          label: nm[4],
          numbered: true,
          check: nm[3] === 'x' ? true : nm[3] === ' ' ? false : null,
        });
      }
      continue;
    }
    const um = rawLines[i].match(CLAUDE_UNNUMBERED_OPT_RE);
    if (um && parsed.length === 0) {
      cursorPos = 0;
      parsed.push({ row: i, label: um[3], numbered: false, check: um[2] === 'x' ? true : um[2] === ' ' ? false : null });
      for (let j = i + 1; j < endIdx && parsed.length < 12; j++) {
        const raw = rawLines[j];
        const t = raw.trim();
        if (!t || isClaudeRuleLine(t) || isClaudeBoxEdge(t)) break;
        if (CLAUDE_HINT_LINE_RE.test(t)) break;
        const indent = (raw.match(/^\s*/) || [''])[0].length;
        if (indent < 2 || indent > 5) break;
        const cm = t.match(/^\[(x| )\]\s*(.+)$/);
        parsed.push({ row: j, label: cm ? cm[2] : t, numbered: false, check: cm ? cm[1] === 'x' : null });
      }
      break;
    }
  }

  let options = parsed.map((p) => p.label);
  const numbered = parsed.length > 0 ? parsed[0].numbered : true;
  let checkable = parsed.map((p) => p.check !== null);
  let checked = parsed.map((p) => p.check === true);

  let submitIndex = null;
  if (checkable.some(Boolean)) {
    for (let k = parsed.length - 1; k >= 0; k--) {
      if (!checkable[k] && /^(submit|done|continue|confirm|finish)\b/i.test(options[k])) {
        submitIndex = k;
        break;
      }
    }
    if (submitIndex === null) {
      const lastOptRow = parsed[parsed.length - 1].row;
      for (let r = lastOptRow + 1; r < endIdx; r++) {
        const t = rawLines[r].trim().replace(/^❯\s*/, '');
        if (!t || isClaudeRuleLine(t)) continue;
        if (/^(submit|done|continue|confirm|finish)\b/i.test(t) && t.length < 40) {
          if (/^\s*❯/.test(rawLines[r])) cursorPos = options.length;
          submitIndex = options.length;
          options.push(t);
          checkable.push(false);
          checked.push(false);
          parsed.push({ row: r, label: t, numbered: false, check: null });
          break;
        }
      }
    }
  }

  const descriptions = options.map((_, k) => {
    const start = parsed[k].row + 1;
    const stop = k + 1 < parsed.length ? parsed[k + 1].row : endIdx;
    const parts = [];
    for (let r = start; r < stop; r++) {
      const t = rawLines[r].trim();
      if (!t || isClaudeRuleLine(t) || isClaudeBoxEdge(t)) break;
      if (CLAUDE_HINT_LINE_RE.test(t)) break;
      parts.push(t);
    }
    return parts.join(' ');
  });

  if (options.length === 0) {
    options = ['Allow', 'Deny'];
    descriptions.push('', '');
    checkable = [false, false];
    checked = [false, false];
  }

  const firstOptRow = parsed.length > 0 ? parsed[0].row : endIdx;
  let steps = [];
  const above = [];
  for (let i = firstOptRow - 1; i >= blockStart && above.length < 60; i--) {
    const t = rawLines[i].trimEnd();
    const tt = t.trim();
    if (!blockStart && (isClaudeRuleLine(tt) || isClaudeBoxEdge(tt))) break;
    if (/^[·✢✳✶✻✽●⏺]\s/.test(tt)) break;
    const chips = tt.match(CLAUDE_STEP_CHIP_RE);
    if (chips && chips.length >= 1 && (tt.includes('←') || tt.includes('→') || chips.length >= 2)) {
      steps = chips.map((c) => ({ done: c[0] === '✔' || c[0] === '☒', label: c.slice(1).trim() }));
      break;
    }
    above.unshift(t);
  }

  const nonEmpty = above.filter((l) => l.trim());
  const minIndent = nonEmpty.length ? Math.min(...nonEmpty.map((l) => (l.match(/^\s*/) || [''])[0].length)) : 0;
  const bodyLines = [];
  for (const l of above) {
    const v = l.slice(minIndent);
    if (!v.trim() && (!bodyLines.length || !bodyLines[bodyLines.length - 1].trim())) continue;
    bodyLines.push(v);
  }
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
  const title = bodyLines.join('\n') || 'Claude 正在等待你的输入';
  const footer = footerIdx >= 0 ? rawLines.slice(Math.max(0, footerIdx - 1), footerIdx + 1).join(' ') : '';
  const multiSelect = checkable.some(Boolean) || /space to select/i.test(footer);
  const freeTextIndex = options.findIndex((o) => /^(type something|other\b|chat about this)/i.test(o));

  return {
    title,
    options,
    descriptions,
    steps,
    binary: !multiSelect && isBinaryAllowDeny(options),
    multiSelect,
    checkable,
    checked,
    submitIndex,
    freeTextIndex,
    cursorRow: cursorPos,
    numbered,
  };
}

function detectFooterPermissionMode(rawLines) {
  const bottom = rawLines.filter((l) => l.trim()).slice(-4).join('\n');
  if (/\bplan mode on\b/i.test(bottom)) return 'plan';
  if (/accept edits on|auto-accept edits/i.test(bottom)) return 'acceptEdits';
  if (/bypass permissions/i.test(bottom)) return 'bypassPermissions';
  if (/auto mode\b|⏵⏵.*auto\b/i.test(bottom)) return 'auto';
  return '';
}

function classifyClaudeScreen(rawScreen) {
  const clean = stripAnsiCodes(rawScreen);
  const lines = clean.split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const lastLines = lines.filter((l) => l.trim()).slice(-14);
  const lastText = lastLines.join('\n');

  let status = 'idle';
  const asking = /\bEsc to cancel\b/i.test(lastText) || lastLines.some((l) => /^\s*❯\s*\d+\.\s+\S/.test(unframeLine(l)));
  if (asking) status = 'asking';
  else if (/\besc to interrupt\b/i.test(lastText) || lastLines.some((l) => CLAUDE_SPINNER_LINE_RE.test(l))) status = 'working';

  const ask = status === 'asking' ? parseClaudeAsk(lines.join('\n')) : null;
  const permissionMode = detectFooterPermissionMode(lines);

  const tailLines = lines
    .map(unframeLine)
    .filter((l) => {
      const t = l.trim();
      if (!t || isClaudeRuleLine(t) || isClaudeBoxEdge(t)) return false;
      if (/^[>›❯](\s|$)/.test(t)) return false;
      if (/\? for shortcuts|shift\+tab|⏵⏵|bypass permissions|auto-accept edits|plan mode on/i.test(t)) return false;
      return true;
    })
    .slice(-8);

  return { status, ask, permissionMode, tail: tailLines.join('\n') };
}

function moveKeys(delta) {
  if (delta === 0) return '';
  return (delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta));
}

function buildAskKeys(ask, action = {}) {
  if (!action || action.kind === 'cancel') return '\x1b';
  if (!ask) return '\r';
  if (action.kind === 'pick') {
    const i = Number(action.index || 0);
    if (ask.numbered !== false) return String(i + 1);
    return `${moveKeys(i - (ask.cursorRow || 0))}\r`;
  }
  if (action.kind === 'text') {
    const i = Number(action.index ?? (ask.freeTextIndex >= 0 ? ask.freeTextIndex : 0));
    const clean = String(action.text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!clean) return '';
    if (ask.numbered !== false) return `${i + 1}${clean}\r`;
    return `${moveKeys(i - (ask.cursorRow || 0))}${clean}\r`;
  }
  if (action.kind === 'multi') {
    const desired = Array.isArray(action.checked) ? action.checked : [];
    let pos = ask.cursorRow || 0;
    let out = '';
    for (let i = 0; i < (ask.options || []).length; i++) {
      if (!ask.checkable || !ask.checkable[i]) continue;
      if (Boolean(desired[i]) !== Boolean(ask.checked && ask.checked[i])) {
        out += `${moveKeys(i - pos)} `;
        pos = i;
      }
    }
    if (ask.submitIndex !== null && ask.submitIndex !== undefined) {
      out += `${moveKeys(ask.submitIndex - pos)}\r`;
    } else {
      out += '\r';
    }
    return out;
  }
  return '';
}

async function sendTmuxInput({
  sshHost,
  tabId,
  tmuxSess,
  text = '',
  submitEnter = false,
  enterDelayMs = 120,
  rawKeys = null,
  activePtyTabs = null,
  runCmd,
  sshOpts = [],
}) {
  if (!sshHost) return { ok: false, error: '未配置 SSH 主机' };

  if (Array.isArray(rawKeys) && rawKeys.length > 0) {
    const keyArgs = rawKeys.map((k) => shSingleQuote(k)).join(' ');
    const r = await runCmd('ssh', [
      ...sshOpts,
      sshHost,
      `tmux send-keys -t ${shSingleQuote(`=${tmuxSess}:`)} ${keyArgs}`,
    ], 5000);
    return { ok: r.exitCode === 0, via: 'tmux-key' };
  }

  const rawText = String(text || '');
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';
  const isPaste = rawText.startsWith(PASTE_START) && rawText.endsWith(PASTE_END);
  const delay = Math.max(60, Math.min(1500, Number(enterDelayMs) || (90 + Math.ceil(rawText.length / 20))));

  const localTab = activePtyTabs && tabId ? activePtyTabs.get(tabId) : null;
  if (localTab && !localTab.exited && !(isPaste && submitEnter)) {
    if (rawText) localTab.ptyProc.write(rawText);
    if (submitEnter) {
      setTimeout(() => {
        try { localTab.ptyProc.write('\r'); } catch {}
      }, delay);
    }
    return { ok: true, via: 'pty', stuck: false, waited: 0 };
  }

  const body64 = Buffer.from(isPaste ? rawText.slice(PASTE_START.length, -PASTE_END.length) : rawText, 'utf8').toString('base64');
  const PASTE_WAIT_S = 8;
  const py = `
import base64, json, subprocess, time
sess = "=" + ${JSON.stringify(tmuxSess)} + ":"
raw = base64.b64decode(${JSON.stringify(body64)}).decode("utf-8", errors="ignore")
is_paste = ${isPaste ? 'True' : 'False'}
def pasting():
    try:
        r = subprocess.run(["tmux", "capture-pane", "-p", "-t", sess], capture_output=True, text=True, timeout=2)
    except Exception:
        return False
    tail = [l.strip() for l in r.stdout.splitlines() if l.strip()][-4:]
    return any(l.startswith("Pasting\\u2026") or l.startswith("Pasting...") for l in tail)
if raw:
    if is_paste:
        subprocess.run(["tmux", "set-buffer", "-b", "takt_dockterm", "--", raw], timeout=2)
        subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", "takt_dockterm", "-t", sess], timeout=2)
    else:
        subprocess.run(["tmux", "send-keys", "-t", sess, "-l", "--", raw], timeout=2)
stuck = False
waited = 0.0
if ${submitEnter ? 'True' : 'False'}:
    time.sleep(${(delay / 1000).toFixed(3)})
    if is_paste and raw:
        t0 = time.time()
        while pasting():
            if time.time() - t0 > ${PASTE_WAIT_S}:
                stuck = True
                break
            time.sleep(0.12)
        waited = time.time() - t0
        if not stuck and waited > 0.2:
            time.sleep(0.15)
    if not stuck:
        subprocess.run(["tmux", "send-keys", "-t", sess, "Enter"], timeout=2)
print(json.dumps({"stuck": stuck, "waited": round(waited, 2)}))
`.trim();
  const pyB64 = Buffer.from(py, 'utf8').toString('base64');
  const r = await runCmd('ssh', [
    ...sshOpts,
    sshHost,
    `python3 -c "import base64;exec(base64.b64decode('${pyB64}'))"`,
  ], 5000 + delay + (isPaste && submitEnter ? PASTE_WAIT_S * 1000 + 1500 : 0));
  let info = {};
  try { info = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}'); } catch {}
  return { ok: r.exitCode === 0 && !info.stuck, via: 'tmux', stuck: Boolean(info.stuck), waited: info.waited || 0 };
}

function buildClaudeLaunchCmd({ sessionId, resolvedSessionId, jsonlPath, resume = true }) {
  if (resolvedSessionId && jsonlPath) return `claude -r ${resolvedSessionId}`;
  const sid = String(sessionId || '').trim();
  if (!UUID_RE.test(sid)) return 'claude';
  if (!resume) return `claude --session-id ${sid}`;
  return `claude -r ${sid} || claude --session-id ${sid}`;
}

async function launchClaudeInTmux({
  sshHost,
  tabId,
  tmuxSess,
  cwd,
  sessionId,
  resume = true,
  resolvedSessionId = '',
  jsonlPath = '',
  activePtyTabs = null,
  runCmd,
  sshOpts = [],
}) {
  if (!sshHost) return { ok: false, error: '未配置 SSH 主机' };
  const cmd = buildClaudeLaunchCmd({ sessionId, resolvedSessionId, jsonlPath, resume });
  const localTab = activePtyTabs && tabId ? activePtyTabs.get(tabId) : null;
  if (localTab && !localTab.exited) {
    localTab.ptyProc.write(`${cmd}\r`);
    return { ok: true, cmd, via: 'pty' };
  }

  // Ensure tmux session exists before launching claude (e.g. if user opened Chat before Terminal)
  const qc = shSingleQuote(cwd || '/root/work');
  const qs = shSingleQuote(tmuxSess);
  const ensureCmd = `mkdir -p ${qc} 2>/dev/null || true; tmux has-session -t ${shSingleQuote(`=${tmuxSess}:`)} 2>/dev/null || tmux new-session -d -s ${qs} -c ${qc} 'bash -l'; tmux send-keys -t ${shSingleQuote(`=${tmuxSess}:`)} -l -- ${shSingleQuote(cmd)}; tmux send-keys -t ${shSingleQuote(`=${tmuxSess}:`)} Enter`;
  const r = await runCmd('ssh', [...sshOpts, sshHost, ensureCmd], 6000);
  return { ok: r.exitCode === 0, cmd, via: 'tmux', error: r.exitCode === 0 ? '' : (r.stderr || '').trim() };
}

module.exports = {
  stripAnsiCodes,
  parseClaudeAsk,
  classifyClaudeScreen,
  buildAskKeys,
  sendTmuxInput,
  launchClaudeInTmux,
  buildClaudeLaunchCmd,
  shSingleQuote,
};
