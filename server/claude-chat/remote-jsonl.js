'use strict';

// Reads remote ~/.claude/projects/<slug>/<session>.jsonl bytes and captures the visible
// tmux pane + running interactive `claude` process metadata without writing anything to the node.
const REMOTE_JSONL_PY = String.raw`
import os, sys, json, glob, re, time, base64, subprocess

cfg = json.loads(base64.b64decode(CFG_B64).decode("utf-8"))
mode = cfg.get("mode", "chunk")
home = os.path.expanduser("~")
proj_root = os.path.join(home, ".claude", "projects")
proj_root_real = os.path.realpath(proj_root)
MAX_STR = 60000
MAX_INPUT_STR = 200000
UUID_RE = re.compile(r"(?:--resume|--session-id|-r)[ =]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
CLAUDE_RE = re.compile(r"(^|/)claude(\s|$)|claude-code/cli|@anthropic-ai/claude")

def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()

def safe_jsonl(p):
    if not p:
        return ""
    real = os.path.realpath(p)
    if not real.startswith(proj_root_real + os.sep) or not real.endswith(".jsonl") or not os.path.isfile(real):
        return ""
    return real

def clip_str(s, limit=MAX_STR):
    if not isinstance(s, str) or len(s) <= limit:
        return s
    head = int(limit * 0.65)
    tail = limit - head
    return s[:head] + "\n… [已截断 %d 字符] …\n" % (len(s) - limit) + s[-tail:]

def img_ref(b, off, k, uuid):
    src = b.get("source") if isinstance(b.get("source"), dict) else {}
    if src.get("type") == "base64" and isinstance(src.get("data"), str) and off is not None:
        return {
            "type": "image",
            "source": {
                "type": "takt_ref",
                "off": off,
                "idx": k,
                "mt": src.get("media_type") or "image/png",
                "u": uuid or "",
            },
        }
    return {"type": "image", "source": {"type": "unknown"}}

def queued_prompt(obj):
    a = obj.get("attachment") if isinstance(obj.get("attachment"), dict) else {}
    if a.get("type") != "queued_command" or a.get("commandMode", "prompt") != "prompt" or a.get("isMeta"):
        return None
    origin = a.get("origin") if isinstance(a.get("origin"), dict) else {}
    if origin.get("kind") != "human" and not a.get("humanTurn"):
        return None
    p = a.get("prompt")
    return p if isinstance(p, (str, list)) else None

def compact_input(inp):
    if not isinstance(inp, dict):
        return {}
    out_d = {}
    for key, val in inp.items():
        if isinstance(val, str):
            out_d[key] = clip_str(val, MAX_INPUT_STR)
        elif isinstance(val, (int, float, bool)) or val is None:
            out_d[key] = val
        elif isinstance(val, list) or isinstance(val, dict):
            try:
                raw = json.dumps(val, ensure_ascii=False)
                if len(raw) <= MAX_INPUT_STR:
                    out_d[key] = val
                else:
                    out_d[key] = clip_str(raw, MAX_INPUT_STR)
            except Exception:
                pass
    return out_d

def compact_record(obj, off=None):
    t = obj.get("type")
    uuid = obj.get("uuid") or ""
    if t == "attachment" and not obj.get("isSidechain"):
        p = queued_prompt(obj)
        if p is None:
            return None
        obj = {"type": "user", "uuid": uuid, "timestamp": obj.get("timestamp"), "message": {"content": p}}
        t = "user"

    if t in ("file-history-snapshot", "file-history-delta", "progress", "queue-operation",
             "api-request-blob", "api-request-shape", "api-request", "data-flow-records",
             "atis-latch", "session-owner", "tools-used", "last-prompt"):
        return None

    if t in ("permission-mode", "mode", "repl-mode", "ai-title", "custom-title", "cost-state"):
        return obj

    if obj.get("isSidechain") or obj.get("isCompactSummary") or obj.get("isVisibleInTranscriptOnly"):
        return None

    if t == "system":
        return obj

    if t not in ("user", "assistant"):
        return None

    msg = obj.get("message")
    if not isinstance(msg, dict):
        return None
    c = msg.get("content")
    k = 0
    if isinstance(c, str):
        cc = clip_str(c)
    elif isinstance(c, list):
        cc = []
        for b in c:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and isinstance(b.get("text"), str):
                cc.append({"type": "text", "text": clip_str(b["text"])})
            elif bt == "thinking" and isinstance(b.get("thinking"), str):
                cc.append({"type": "thinking", "thinking": clip_str(b["thinking"], MAX_INPUT_STR)})
            elif bt == "tool_use":
                cc.append({
                    "type": "tool_use",
                    "id": b.get("id"),
                    "name": b.get("name"),
                    "input": compact_input(b.get("input")),
                })
            elif bt == "tool_result":
                r = {"type": "tool_result", "tool_use_id": b.get("tool_use_id"), "is_error": bool(b.get("is_error"))}
                inner = b.get("content")
                if isinstance(inner, str):
                    r["content"] = clip_str(inner)
                elif isinstance(inner, list):
                    rc = []
                    for ib in inner:
                        if not isinstance(ib, dict):
                            continue
                        ibt = ib.get("type")
                        if ibt == "text" and isinstance(ib.get("text"), str):
                            rc.append({"type": "text", "text": clip_str(ib["text"])})
                        elif ibt == "image":
                            rc.append(img_ref(ib, off, k, uuid))
                            k += 1
                    r["content"] = rc
                cc.append(r)
            elif bt == "image":
                cc.append(img_ref(b, off, k, uuid))
                k += 1
    else:
        return None

    rec = {
        "type": t,
        "uuid": uuid,
        "timestamp": obj.get("timestamp"),
        "isMeta": bool(obj.get("isMeta")),
        "message": {
            "id": msg.get("id"),
            "role": msg.get("role"),
            "model": msg.get("model"),
            "usage": msg.get("usage"),
            "content": cc,
        },
    }
    if obj.get("requestedModel"):
        rec["requestedModel"] = obj.get("requestedModel")
    if obj.get("effort"):
        rec["effort"] = obj.get("effort")
    if obj.get("perTurnEffort"):
        rec["perTurnEffort"] = obj.get("perTurnEffort")
    if isinstance(obj.get("toolUseResult"), dict):
        tur = {}
        if isinstance(obj["toolUseResult"].get("answers"), dict):
            tur["answers"] = obj["toolUseResult"]["answers"]
        if isinstance(obj["toolUseResult"].get("plan"), str):
            tur["plan"] = clip_str(obj["toolUseResult"]["plan"], MAX_INPUT_STR)
        if tur:
            rec["toolUseResult"] = tur
    return rec

def records_from(data, base=0):
    recs = []
    pos = 0
    n = len(data)
    while pos < n:
        nl = data.find(b"\n", pos)
        if nl < 0:
            nl = n
        line = data[pos:nl]
        off = base + pos
        pos = nl + 1
        if line[:1] != b"{":
            line = line.strip()
            if line[:1] != b"{":
                continue
            off = None
        try:
            obj = json.loads(line.decode("utf-8", "ignore"))
        except Exception:
            continue
        if isinstance(obj, dict):
            r = compact_record(obj, off)
            if r:
                recs.append(r)
    return recs

def next_line_start(f, pos):
    if pos <= 0:
        return 0
    f.seek(pos - 1)
    base = pos - 1
    while True:
        block = f.read(65536)
        if not block:
            return None
        i = block.find(b"\n")
        if i >= 0:
            return base + i + 1
        base += len(block)

def prev_line_start(f, pos):
    p = pos - 1
    while p > 0:
        step = min(65536, p)
        f.seek(p - step)
        block = f.read(step)
        i = block.rfind(b"\n")
        if i >= 0:
            return p - step + i + 1
        p -= step
    return 0

def read_lines(f, start, stop):
    f.seek(start)
    data = f.read(max(0, stop - start))
    i = data.rfind(b"\n")
    if i < 0:
        return b"", start
    return data[:i + 1], start + i + 1

if mode == "older":
    fp = safe_jsonl(cfg.get("path", ""))
    before = int(cfg.get("before", 0))
    chunk = int(cfg.get("chunkBytes", 2097152))
    if not fp or before <= 0:
        out({"ok": False, "error": "没有更早的对话记录"})
        sys.exit(0)
    with open(fp, "rb") as f:
        start = 0 if before - chunk <= 0 else next_line_start(f, before - chunk)
        if start is None or start >= before:
            start = prev_line_start(f, before)
        data, _ = read_lines(f, start, before)
    out({"ok": True, "jsonlPath": fp, "chunkStart": start, "chunkEnd": before, "hasOlder": start > 0, "records": records_from(data, start)})
    sys.exit(0)

# mode == "chunk": tmux screen + running claude process + incremental transcript read
tmux_sess = cfg.get("tmuxSess", "")
tab_cwd = (cfg.get("cwd") or "").rstrip("/") or home
sid = (cfg.get("sessionId") or "").strip()
known_path = safe_jsonl(cfg.get("knownPath", ""))
known_end = int(cfg.get("knownEnd", 0))
claimed_paths = set(os.path.realpath(p) for p in (cfg.get("claimedPaths") or []) if p)

def run_q(args, timeout=2):
    try:
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""

pane_pid = 0
pane_cwd = ""
pane_text = ""
if tmux_sess:
    target = "=" + tmux_sess + ":"
    info = run_q(["tmux", "display-message", "-p", "-t", target, "#{pane_pid}\t#{pane_current_path}"]).strip()
    if info:
        parts = info.split("\t")
        try:
            pane_pid = int(parts[0])
        except Exception:
            pane_pid = 0
        pane_cwd = parts[1] if len(parts) > 1 else ""
    if pane_pid:
        pane_text = run_q(["tmux", "capture-pane", "-p", "-J", "-t", target])

procs = {}
children = {}
for line in run_q(["ps", "-eo", "pid=,ppid=,etimes=,args="]).splitlines():
    p = line.strip().split(None, 3)
    if len(p) < 3:
        continue
    try:
        pid, ppid, et = int(p[0]), int(p[1]), int(p[2])
    except Exception:
        continue
    args = p[3] if len(p) > 3 else ""
    procs[pid] = (ppid, et, args)
    children.setdefault(ppid, []).append(pid)

claude_pid = 0
if pane_pid:
    queue = [pane_pid]
    seen = set()
    while queue and not claude_pid:
        cur = queue.pop(0)
        if cur in seen:
            continue
        seen.add(cur)
        pr = procs.get(cur)
        if pr and CLAUDE_RE.search(pr[2]):
            claude_pid = cur
            break
        queue.extend(children.get(cur, []))

claimed_by_others = set()
for pid, pr in procs.items():
    if pid != claude_pid and CLAUDE_RE.search(pr[2]):
        m = UUID_RE.search(pr[2])
        if m:
            claimed_by_others.add(m.group(1))

claude_running = bool(claude_pid)
claude_start = 0
claude_cwd = ""
hint_ids = []
launch_model = ""
launch_effort = ""
if claude_pid:
    ppid, et, args = procs[claude_pid]
    claude_start = time.time() - et
    try:
        claude_cwd = os.readlink("/proc/%d/cwd" % claude_pid)
    except Exception:
        claude_cwd = ""
    m = UUID_RE.search(args)
    if m:
        hint_ids.append(m.group(1))
    m = re.search(r"--model[ =](\S+)", args)
    launch_model = m.group(1) if m else ""
    m = re.search(r"--effort[ =](\S+)", args)
    launch_effort = m.group(1) if m else ""
elif pane_text and ("esc to interrupt" in pane_text.lower() or "? for shortcuts" in pane_text):
    claude_running = True
if sid and sid not in hint_ids:
    hint_ids.append(sid)

def slug(p):
    return re.sub(r"[^a-zA-Z0-9]", "-", p)

def mtime(p):
    try:
        return os.path.getmtime(p)
    except Exception:
        return 0

def first_ts(p):
    try:
        with open(p, "rb") as f:
            head = f.read(65536)
        for line in head.split(b"\n"):
            try:
                ts = json.loads(line.decode("utf-8", "ignore")).get("timestamp")
            except Exception:
                continue
            if isinstance(ts, str) and len(ts) >= 19:
                import calendar
                return calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        pass
    return mtime(p)

def follow_clear(current, pool):
    best = current
    for p in sorted(pool, key=mtime, reverse=True):
        if p == current or mtime(p) <= mtime(current):
            continue
        if first_ts(p) >= mtime(current) - 5:
            best = p
            break
    return best

cwd_opts = []
for c in (claude_cwd, pane_cwd, tab_cwd):
    if c and c not in cwd_opts:
        cwd_opts.append(c)
if tab_cwd.startswith("/root/") and home != "/root":
    cwd_opts.append(os.path.join(home, tab_cwd[6:]))
dirs = []
for c in cwd_opts:
    d = os.path.join(proj_root, slug(c.rstrip("/") or "/"))
    if os.path.isdir(d) and d not in dirs:
        dirs.append(d)

hinted = ""
for hid in hint_ids:
    for d in dirs:
        p = os.path.join(d, hid + ".jsonl")
        if os.path.isfile(p):
            hinted = p
            break
    if not hinted:
        g = glob.glob(os.path.join(proj_root, "*", hid + ".jsonl"))
        if g:
            hinted = max(g, key=mtime)
    if hinted:
        break

chosen = ""
if claude_pid:
    window = claude_start - 5
    pool = []
    for d in dirs:
        for p in glob.glob(os.path.join(d, "*.jsonl")):
            if mtime(p) < window:
                continue
            if os.path.splitext(os.path.basename(p))[0] in claimed_by_others or os.path.realpath(p) in claimed_paths:
                continue
            pool.append(p)
    if hinted and mtime(hinted) >= window:
        chosen = follow_clear(hinted, pool)
    elif known_path and known_path in pool:
        chosen = follow_clear(known_path, pool)
    elif pool:
        chosen = max(pool, key=mtime)
    elif hinted:
        chosen = hinted
elif hinted:
    chosen = hinted
elif known_path:
    chosen = known_path
chosen = safe_jsonl(chosen)

res = {
    "ok": True,
    "claudeRunning": claude_running,
    "paneText": pane_text,
    "paneCwd": claude_cwd or pane_cwd,
    "tmuxAlive": bool(pane_pid),
    "jsonlPath": chosen,
    "resolvedSessionId": os.path.splitext(os.path.basename(chosen))[0] if chosen else "",
    "launchModel": launch_model,
    "launchEffort": launch_effort,
    "reset": True,
    "chunkStart": 0,
    "chunkEnd": 0,
    "hasOlder": False,
    "size": 0,
    "records": [],
}

if chosen:
    size = os.path.getsize(chosen)
    res["size"] = size
    with open(chosen, "rb") as f:
        if chosen == known_path and size >= known_end > 0:
            stop = min(size, known_end + int(cfg.get("maxBytes", 8388608)))
            data, end = read_lines(f, known_end, stop)
            if not data and size - known_end > int(cfg.get("maxBytes", 8388608)):
                nxt = next_line_start(f, known_end + 1)
                end = nxt if nxt is not None else known_end
            res.update({
                "reset": False,
                "chunkStart": known_end,
                "chunkEnd": end,
                "records": records_from(data, known_end),
            })
        else:
            initial = int(cfg.get("initialBytes", 2097152))
            start = 0 if size <= initial else next_line_start(f, size - initial)
            if start is None:
                start = prev_line_start(f, size)
            data, end = read_lines(f, start, size)
            res.update({
                "reset": True,
                "chunkStart": start,
                "chunkEnd": end,
                "hasOlder": start > 0,
                "records": records_from(data, start),
            })

out(res)
`.trim();

async function runRemoteJsonlPy({ sshHost, cfg, runCmd, sshOpts, timeoutMs = 9000 }) {
  if (!sshHost) return { ok: false, error: '未配置 SSH 主机' };
  const cfgB64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  const py = REMOTE_JSONL_PY.replace('CFG_B64', JSON.stringify(cfgB64));
  const pyB64 = Buffer.from(py, 'utf8').toString('base64');
  const r = await runCmd('ssh', [
    ...(Array.isArray(sshOpts) ? sshOpts : []),
    sshHost,
    `python3 -c "import base64;exec(base64.b64decode('${pyB64}'))"`,
  ], timeoutMs);
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    return { ok: false, error: (r.stderr || '').trim() || `SSH 执行失败 (${r.exitCode})` };
  }
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch (err) {
    return { ok: false, error: `解析远端记录失败: ${err.message}` };
  }
}

async function readRemoteTranscriptChunk({
  sshHost,
  sessionId,
  cwd,
  knownPath = '',
  knownEnd = 0,
  claimedPaths = [],
  initialBytes = 2 * 1024 * 1024,
  maxBytes = 8 * 1024 * 1024,
  tmuxSess = '',
  runCmd,
  sshOpts,
}) {
  return runRemoteJsonlPy({
    sshHost,
    cfg: {
      mode: 'chunk',
      sessionId,
      cwd,
      knownPath,
      knownEnd,
      claimedPaths,
      initialBytes,
      maxBytes,
      tmuxSess,
    },
    runCmd,
    sshOpts,
    timeoutMs: 9000,
  });
}

async function readRemoteTranscriptOlder({
  sshHost,
  jsonlPath,
  beforeOffset,
  historyBytes = 2 * 1024 * 1024,
  runCmd,
  sshOpts,
}) {
  if (!/\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(String(jsonlPath || ''))) {
    return { ok: false, error: '会话记录路径无效' };
  }
  return runRemoteJsonlPy({
    sshHost,
    cfg: {
      mode: 'older',
      path: jsonlPath,
      before: beforeOffset,
      chunkBytes: historyBytes,
    },
    runCmd,
    sshOpts,
    timeoutMs: 15000,
  });
}

module.exports = {
  readRemoteTranscriptChunk,
  readRemoteTranscriptOlder,
};
