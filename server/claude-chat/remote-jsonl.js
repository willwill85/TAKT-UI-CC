'use strict';

const { spawn } = require('child_process');

// Reads remote ~/.claude/projects/<slug>/<session>.jsonl bytes and captures the visible
// tmux pane + running interactive `claude` process metadata without writing anything to the node.
const REMOTE_JSONL_PY = String.raw`
import os, sys, json, glob, re, time, base64, subprocess, hashlib, select

cfg = json.loads(base64.b64decode(CFG_B64).decode("utf-8"))
mode = cfg.get("mode", "chunk")
home = os.path.expanduser("~")
proj_root = os.path.join(home, ".claude", "projects")
proj_root_real = os.path.realpath(proj_root)
MAX_TEXT_STR = 60000
MAX_TOOL_STR = 16000
MAX_INPUT_STR = 12000
MAX_LARGE_INPUT_STR = 120000
UUID_RE = re.compile(r"(?:--resume|--session-id|-r)[ =]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
CLAUDE_RE = re.compile(r"(^|/)claude(\s|$)|claude-code/cli|@anthropic-ai/claude")

def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def safe_jsonl(p):
    if not p:
        return ""
    real = os.path.realpath(p)
    if not real.startswith(proj_root_real + os.sep) or not real.endswith(".jsonl") or not os.path.isfile(real):
        return ""
    return real

def clip_str(s, limit=MAX_TEXT_STR):
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

def compact_input(inp, tool_name=""):
    if not isinstance(inp, dict):
        return {}
    is_large = (tool_name in ("Edit", "MultiEdit", "ExitPlanMode")) or (
        tool_name == "Write"
        and isinstance(inp.get("file_path"), str)
        and "/.claude/plans/" in inp["file_path"]
    )
    limit = MAX_LARGE_INPUT_STR if is_large else MAX_INPUT_STR
    out_d = {}
    for key, val in inp.items():
        if isinstance(val, str):
            out_d[key] = clip_str(val, limit)
        elif isinstance(val, (int, float, bool)) or val is None:
            out_d[key] = val
        elif isinstance(val, list) or isinstance(val, dict):
            try:
                raw = json.dumps(val, ensure_ascii=False)
                if len(raw) <= limit:
                    out_d[key] = val
                else:
                    out_d[key] = clip_str(raw, limit)
            except Exception:
                pass
    return out_d

def extract_tur_text(tur):
    if isinstance(tur, str):
        return clip_str(tur, MAX_TOOL_STR)
    if isinstance(tur, dict):
        if "stdout" in tur or "stderr" in tur:
            parts = []
            if tur.get("stdout"):
                parts.append(str(tur["stdout"]))
            if tur.get("stderr"):
                err = str(tur["stderr"])
                parts.append(("[stderr]\n" + err) if parts else err)
            return clip_str("\n".join(parts), MAX_TOOL_STR) if parts else ""
        if isinstance(tur.get("file"), dict) and isinstance(tur["file"].get("content"), str):
            return clip_str(tur["file"]["content"], MAX_TOOL_STR)
        if isinstance(tur.get("content"), str):
            return clip_str(tur["content"], MAX_TOOL_STR)
        if isinstance(tur.get("filenames"), list) and tur["filenames"]:
            return clip_str("\n".join(str(x) for x in tur["filenames"]), MAX_TOOL_STR)
        if isinstance(tur.get("message"), str):
            return clip_str(tur["message"], MAX_TOOL_STR)
        if tur.get("commandName"):
            return "已加载技能 " + str(tur["commandName"])
        if tur.get("status") == "async_launched" and tur.get("description"):
            return "子代理已启动：" + str(tur["description"])
    return ""

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
        cc = clip_str(c, MAX_TEXT_STR)
    elif isinstance(c, list):
        cc = []
        for b in c:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and isinstance(b.get("text"), str):
                cc.append({"type": "text", "text": clip_str(b["text"], MAX_TEXT_STR)})
            elif bt == "thinking" and isinstance(b.get("thinking"), str):
                cc.append({"type": "thinking", "thinking": clip_str(b["thinking"], 40000)})
            elif bt == "tool_use":
                tool_name = b.get("name") or ""
                cc.append({
                    "type": "tool_use",
                    "id": b.get("id"),
                    "name": b.get("name"),
                    "input": compact_input(b.get("input"), tool_name),
                })
            elif bt == "tool_result":
                r = {"type": "tool_result", "tool_use_id": b.get("tool_use_id"), "is_error": bool(b.get("is_error"))}
                inner = b.get("content")
                if isinstance(inner, str):
                    r["content"] = clip_str(inner, MAX_TOOL_STR)
                elif isinstance(inner, list):
                    rc = []
                    for ib in inner:
                        if not isinstance(ib, dict):
                            continue
                        ibt = ib.get("type")
                        if ibt == "text" and isinstance(ib.get("text"), str):
                            rc.append({"type": "text", "text": clip_str(ib["text"], MAX_TOOL_STR)})
                        elif ibt == "image":
                            rc.append(img_ref(ib, off, k, uuid))
                            k += 1
                    r["content"] = rc
                if not r.get("content") and obj.get("toolUseResult") is not None:
                    tur_txt = extract_tur_text(obj["toolUseResult"])
                    if tur_txt:
                        r["content"] = tur_txt
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
            tur["plan"] = clip_str(obj["toolUseResult"]["plan"], MAX_LARGE_INPUT_STR)
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

def run_q(args, timeout=2):
    try:
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""

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

def discover_state(tmux_sess, tab_cwd, sid, known_path, claimed_paths):
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
            pane_text = run_q(["tmux", "capture-pane", "-p", "-J", "-S", "-120", "-t", target])

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

    return {
        "claudeRunning": claude_running,
        "paneText": pane_text,
        "paneCwd": claude_cwd or pane_cwd,
        "tmuxAlive": bool(pane_pid),
        "chosen": chosen,
        "launchModel": launch_model,
        "launchEffort": launch_effort,
    }

tmux_sess = cfg.get("tmuxSess", "")
tab_cwd = (cfg.get("cwd") or "").rstrip("/") or home
sid = (cfg.get("sessionId") or "").strip()
known_path = safe_jsonl(cfg.get("knownPath", ""))
known_end = int(cfg.get("knownEnd", 0))
claimed_paths = set(os.path.realpath(p) for p in (cfg.get("claimedPaths") or []) if p)
max_bytes = int(cfg.get("maxBytes", 8388608))
initial_bytes = int(cfg.get("initialBytes", 1048576))

if mode == "watch":
    SPINNER_WATCH_RE = re.compile(r"^\s*[·✢✳✶✻✽∗*]\s+\S", re.M)
    last_pane_hash = ""
    last_meta_sig = None
    last_discover_ts = 0.0
    wake_requested = True
    first_tick = True
    fast_until = time.monotonic() + 4.0
    st = None
    stdin_fd = sys.stdin.fileno()
    try:
        while True:
            now = time.monotonic()
            if wake_requested or st is None or not known_path or (now - last_discover_ts >= 2.0):
                st = discover_state(tmux_sess, tab_cwd, sid, known_path, claimed_paths)
                last_discover_ts = now
                wake_requested = False
            else:
                pane_text_fast = run_q(["tmux", "capture-pane", "-p", "-J", "-S", "-120", "-t", "=" + tmux_sess + ":"], timeout=1.5) if tmux_sess else ""
                st = dict(st)
                st["paneText"] = pane_text_fast
                if not st.get("claudeRunning") and pane_text_fast and ("esc to interrupt" in pane_text_fast.lower() or "? for shortcuts" in pane_text_fast):
                    st["claudeRunning"] = True

            pane_text = st.get("paneText") or ""
            pane_hash = hashlib.md5(pane_text.encode("utf-8", "ignore")).hexdigest()
            pane_changed = first_tick or (pane_hash != last_pane_hash)
            pane_busy = ("esc to interrupt" in pane_text.lower()) or bool(SPINNER_WATCH_RE.search(pane_text))
            if pane_busy or pane_hash != last_pane_hash:
                fast_until = max(fast_until, now + 3.0)

            chosen = st.get("chosen") or ""
            records = []
            reset = False
            chunk_start = known_end
            chunk_end = known_end
            has_older = False
            size = 0
            jsonl_changed = False

            if chosen:
                try:
                    size = os.path.getsize(chosen)
                except Exception:
                    size = 0
                if chosen != known_path or size < known_end or (first_tick and known_end == 0):
                    with open(chosen, "rb") as f:
                        start = 0 if size <= initial_bytes else next_line_start(f, size - initial_bytes)
                        if start is None:
                            start = prev_line_start(f, size)
                        data, end = read_lines(f, start, size)
                    reset = True
                    chunk_start = start
                    chunk_end = end
                    has_older = start > 0
                    records = records_from(data, start)
                    known_path = chosen
                    known_end = end
                    jsonl_changed = True
                    fast_until = max(fast_until, now + 3.0)
                elif size > known_end:
                    stop = min(size, known_end + max_bytes)
                    with open(chosen, "rb") as f:
                        data, end = read_lines(f, known_end, stop)
                        if not data and size - known_end > max_bytes:
                            nxt = next_line_start(f, known_end + 1)
                            end = nxt if nxt is not None else known_end
                    records = records_from(data, known_end)
                    chunk_start = known_end
                    chunk_end = end
                    known_end = end
                    if records or end > chunk_start:
                        jsonl_changed = True
                        fast_until = max(fast_until, now + 3.0)
            elif known_path:
                known_path = ""
                known_end = 0
                reset = True
                jsonl_changed = True

            meta_sig = (
                bool(st.get("claudeRunning")),
                bool(st.get("tmuxAlive")),
                st.get("paneCwd") or "",
                known_path,
                st.get("launchModel") or "",
                st.get("launchEffort") or "",
            )
            meta_changed = first_tick or (meta_sig != last_meta_sig)

            if first_tick or jsonl_changed or pane_changed or meta_changed:
                evt = {
                    "ok": True,
                    "claudeRunning": bool(st.get("claudeRunning")),
                    "paneChanged": bool(pane_changed),
                    "paneCwd": st.get("paneCwd") or "",
                    "tmuxAlive": bool(st.get("tmuxAlive")),
                    "jsonlPath": known_path,
                    "resolvedSessionId": os.path.splitext(os.path.basename(known_path))[0] if known_path else "",
                    "launchModel": st.get("launchModel") or "",
                    "launchEffort": st.get("launchEffort") or "",
                    "reset": bool(reset),
                    "chunkStart": chunk_start,
                    "chunkEnd": chunk_end,
                    "hasOlder": bool(has_older),
                    "size": size,
                    "records": records,
                }
                if pane_changed:
                    evt["paneText"] = pane_text
                out(evt)
                last_pane_hash = pane_hash
                last_meta_sig = meta_sig
                first_tick = False

            sleep_s = 0.12 if (pane_busy or now < fast_until) else 0.6
            rlist, _, _ = select.select([stdin_fd], [], [], sleep_s)
            if rlist:
                chunk_in = os.read(stdin_fd, 4096)
                if not chunk_in:
                    break
                wake_requested = True
                fast_until = max(fast_until, time.monotonic() + 5.0)
    except BrokenPipeError:
        pass
    sys.exit(0)

# mode == "chunk": one-shot tmux screen + running claude process + incremental transcript read
st = discover_state(tmux_sess, tab_cwd, sid, known_path, claimed_paths)
chosen = st["chosen"]

res = {
    "ok": True,
    "claudeRunning": st["claudeRunning"],
    "paneText": st["paneText"],
    "paneCwd": st["paneCwd"],
    "tmuxAlive": st["tmuxAlive"],
    "jsonlPath": chosen,
    "resolvedSessionId": os.path.splitext(os.path.basename(chosen))[0] if chosen else "",
    "launchModel": st["launchModel"],
    "launchEffort": st["launchEffort"],
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
            stop = min(size, known_end + max_bytes)
            data, end = read_lines(f, known_end, stop)
            if not data and size - known_end > max_bytes:
                nxt = next_line_start(f, known_end + 1)
                end = nxt if nxt is not None else known_end
            res.update({
                "reset": False,
                "chunkStart": known_end,
                "chunkEnd": end,
                "records": records_from(data, known_end),
            })
        else:
            start = 0 if size <= initial_bytes else next_line_start(f, size - initial_bytes)
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
  initialBytes = 1024 * 1024,
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

function startRemoteStreamWatcher({
  sshHost,
  sessionId,
  cwd,
  knownPath = '',
  knownEnd = 0,
  claimedPaths = [],
  initialBytes = 1024 * 1024,
  maxBytes = 8 * 1024 * 1024,
  tmuxSess = '',
  sshOpts = [],
  onChunk,
  onClose,
}) {
  if (!sshHost) return null;
  const cfg = {
    mode: 'watch',
    sessionId,
    cwd,
    knownPath,
    knownEnd,
    claimedPaths,
    initialBytes,
    maxBytes,
    tmuxSess,
  };
  const cfgB64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  const py = REMOTE_JSONL_PY.replace('CFG_B64', JSON.stringify(cfgB64));
  const pyB64 = Buffer.from(py, 'utf8').toString('base64');

  const child = spawn('ssh', [
    ...(Array.isArray(sshOpts) ? sshOpts : []),
    '-T',
    sshHost,
    `python3 -u -c "import base64;exec(base64.b64decode('${pyB64}'))"`,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let stopped = false;
  let alive = true;
  let killTimer = null;

  if (child.stdin) {
    child.stdin.on('error', () => {});
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (stopped) return;
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && typeof onChunk === 'function') {
          onChunk(obj);
        }
      } catch {}
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderrBuf.length < 2048) {
      stderrBuf += chunk.slice(0, 2048 - stderrBuf.length);
    }
  });

  child.on('error', (err) => {
    alive = false;
    if (stderrBuf.length < 2048) stderrBuf += String((err && err.message) || err || '');
  });

  child.on('close', (code, signal) => {
    alive = false;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (typeof onClose === 'function') {
      onClose({ code, signal, stderr: stderrBuf.trim(), expected: stopped });
    }
  });

  return {
    isAlive: () => alive && !stopped && child.exitCode === null,
    wake: () => {
      if (stopped || !alive || !child.stdin || child.stdin.destroyed) return false;
      try {
        child.stdin.write('{"cmd":"wake"}\n');
        return true;
      } catch {
        return false;
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      alive = false;
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      } catch {}
      if (!killTimer && child.exitCode === null && !child.killed) {
        killTimer = setTimeout(() => {
          killTimer = null;
          try {
            if (child.exitCode === null) child.kill('SIGTERM');
          } catch {}
        }, 400);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    },
  };
}

module.exports = {
  readRemoteTranscriptChunk,
  readRemoteTranscriptOlder,
  startRemoteStreamWatcher,
  REMOTE_JSONL_PY,
};
