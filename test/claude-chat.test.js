'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { execFileSync } = require('node:child_process');

const {
  parseJsonlRecordsToEvents,
  buildContextUsage,
  resolveMaxContextTokens,
} = require('../server/claude-chat/terminal-transcript');
const {
  classifyClaudeScreen,
  extractLiveStreamText,
  normalizeForStreamCompare,
  parseClaudeAsk,
  buildAskKeys,
} = require('../server/claude-chat/tmux-bridge');
const { REMOTE_JSONL_PY } = require('../server/claude-chat/remote-jsonl');

function loadFrontendModules() {
  const ctx = {
    window: {},
    URL,
    URLSearchParams,
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    Boolean,
  };
  vm.createContext(ctx);
  for (const name of ['activity.js', 'transcript.js', 'markdown.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'chat', name), 'utf8');
    vm.runInContext(code, ctx, { filename: name });
  }
  return ctx.window;
}

test('tmux-bridge classifies working/asking/idle screens, footer modes, multi-select and binary asks', () => {
  const workingScreen = [
    '· Reading server/server.js…',
    '──────────────────────────',
    '❯ ',
    '  plan mode on (shift+tab to cycle) · esc to interrupt',
  ].join('\n');
  const cw = classifyClaudeScreen(workingScreen);
  assert.equal(cw.status, 'working');
  assert.equal(cw.permissionMode, 'plan');

  const acceptScreen = 'Some output\n❯ \n  accept edits on · ? for shortcuts';
  const ca = classifyClaudeScreen(acceptScreen);
  assert.equal(ca.status, 'idle');
  assert.equal(ca.permissionMode, 'acceptEdits');

  const askBinary = [
    '╭────────────────────────────────────────╮',
    '│ Run command `rm -rf /tmp/test`?        │',
    '│ ❯ 1. Yes                               │',
    '│   2. Yes, and don\'t ask again          │',
    '│   3. No                                │',
    '│ Esc to cancel                          │',
    '╰────────────────────────────────────────╯',
  ].join('\n');
  const cb = classifyClaudeScreen(askBinary);
  assert.equal(cb.status, 'asking');
  assert.ok(cb.ask);
  assert.equal(cb.ask.binary, true);
  assert.equal(buildAskKeys(cb.ask, { kind: 'pick', index: 0 }), '1');

  const askMulti = [
    '☐ Scope  ✔ Stack',
    'Pick features to enable:',
    '❯ [ ] Logging',
    '  [x] Metrics',
    '  Submit',
    'Space to select · Enter to submit · Esc to cancel',
  ].join('\n');
  const pm = parseClaudeAsk(askMulti);
  assert.equal(pm.multiSelect, true);
  assert.equal(pm.steps.length, 2);
  assert.deepEqual(pm.checkable, [true, true, false]);
  const keys = buildAskKeys(pm, { kind: 'multi', checked: [true, true, false] });
  assert.ok(keys.includes(' '));
  assert.ok(keys.endsWith('\r'));
});

test('terminal-transcript parses JSONL records, resolves cards, and derives contextUsage from usage tokens', () => {
  const records = [
    { type: 'permission-mode', permissionMode: 'acceptEdits', timestamp: '2026-11-24T01:00:00Z' },
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-11-24T01:00:01Z',
      message: {
        content: [
          { type: 'text', text: '<system-reminder>ignore</system-reminder>Check image' },
          { type: 'image', source: { type: 'takt_ref', off: 120, idx: 0, mt: 'image/png', u: 'u1' } },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-11-24T01:00:02Z',
      requestedModel: 'claude-opus-5-5',
      message: {
        id: 'm1',
        usage: { input_tokens: 1000, cache_read_input_tokens: 45000, cache_creation_input_tokens: 4000, output_tokens: 120 },
        content: [
          { type: 'thinking', thinking: 'Inspecting.' },
          { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Pick?', header: 'Scope', options: [{ label: 'A' }, { label: 'B' }] }] } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-11-24T01:00:05Z',
      toolUseResult: { answers: { 'Pick?': 'A' } },
      message: { content: [{ type: 'tool_result', tool_use_id: 'q1', is_error: false, content: 'A' }] },
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 4200, timestamp: '2026-11-24T01:00:06Z' },
  ];

  const { events, meta } = parseJsonlRecordsToEvents(records);
  assert.equal(meta.permissionMode, 'acceptEdits');
  assert.equal(meta.model, 'claude-opus-5-5');
  assert.ok(meta.contextUsage);
  assert.equal(meta.contextUsage.totalTokens, 50000);
  assert.equal(meta.contextUsage.rawMaxTokens, 1000000);
  assert.equal(meta.contextUsage.percentage, 5);
  assert.ok(events.some((e) => e.type === 'approval.resolved' && e.payload.toolName === 'AskUserQuestion' && e.payload.answers['Pick?'] === 'A'));
  assert.equal(events.find((e) => e.type === 'turn.stats').payload.durationMs, 4200);

  // Compact boundary resets derived contextUsage until newer assistant turn arrives
  const postCompact = parseJsonlRecordsToEvents([
    ...records,
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 50000 }, timestamp: '2026-11-24T01:01:00Z' },
  ]);
  assert.equal(postCompact.meta.contextUsage, null);
});

test('Frontend activity, transcript folding, and markdown rendering behave cleanly', () => {
  const w = loadFrontendModules();
  const editDesc = w.TaktChatActivity.describe({
    toolName: 'Edit',
    input: { file_path: '/root/work/app.js', old_string: 'a\nb', new_string: 'a\nc\nd' },
  }, false);
  assert.equal(editDesc.added, 2);
  assert.equal(editDesc.removed, 1);
  assert.equal(editDesc.target, 'app.js');

  const conv = w.TaktChatTranscript.conversation([
    { id: '1', type: 'message.user', ts: 1000, payload: { text: 'Update files' } },
    { id: '2', type: 'tool.requested', ts: 1100, payload: { toolUseId: 't1', toolName: 'Read', input: { file_path: '/root/work/a.js' } } },
    { id: '3', type: 'tool.result', ts: 1200, payload: { toolUseId: 't1', output: 'ok', isError: false } },
    { id: '4', type: 'tool.requested', ts: 1300, payload: { toolUseId: 't2', toolName: 'Bash', input: { command: 'npm test' } } },
    { id: '5', type: 'tool.result', ts: 1500, payload: { toolUseId: 't2', output: 'pass', isError: false } },
  ]);

  assert.equal(conv.turns.length, 1);
  assert.equal(conv.turns[0].segments[0].kind, 'process');
  assert.equal(conv.turns[0].segments[0].parts[0].kind, 'work');
  assert.equal(conv.turns[0].segments[0].parts[0].tools.length, 2);

  const html = w.TaktChatMarkdown.renderMarkdown('Price is $100 and $5. Check `server/server.js:12` and formula $x + y$.\n\n```svg\n<svg viewBox="0 0 10 10"></svg>\n```');
  assert.ok(html.includes('$100'));
  assert.ok(html.includes('class="md-file-link cc-file-chip"'));
  assert.ok(html.includes('class="cc-math"'));
  assert.ok(html.includes('class="md-code cc-svg-card"'));
});

test('Split-line JSONL records preserve all blocks, skip ToolSearch, and count usage once per message.id', () => {
  const splitRecords = [
    { type: 'user', uuid: 'u-split-1', timestamp: '2026-11-24T10:00:00Z', message: { role: 'user', content: 'Check SRRC' } },
    {
      type: 'assistant',
      uuid: 'a-line-1',
      timestamp: '2026-11-24T10:00:01Z',
      message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 250, cache_read_input_tokens: 1000 }, content: [{ type: 'thinking', thinking: '' }] },
    },
    {
      type: 'assistant',
      uuid: 'a-line-2',
      timestamp: '2026-11-24T10:00:02Z',
      message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 250, cache_read_input_tokens: 1000 }, content: [{ type: 'tool_use', id: 'tu-ts', name: 'ToolSearch', input: { query: 'select:WebSearch' } }] },
    },
    {
      type: 'user',
      uuid: 'u-ts-res',
      timestamp: '2026-11-24T10:00:03Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-ts', is_error: false, content: 'Tool loaded.' }] },
    },
    {
      type: 'assistant',
      uuid: 'a-line-3',
      timestamp: '2026-11-24T10:00:04Z',
      message: { id: 'msg_2', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1250 }, content: [{ type: 'tool_use', id: 'tu-ws', name: 'WebSearch', input: { query: 'SRRC BLE' } }] },
    },
    {
      type: 'user',
      uuid: 'u-ws-res',
      timestamp: '2026-11-24T10:00:06Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-ws', is_error: false, content: 'Links: []\nSummary' }] },
    },
    {
      type: 'assistant',
      uuid: 'a-line-4',
      timestamp: '2026-11-24T10:00:07Z',
      message: { id: 'msg_3', model: 'claude-sonnet-5-5', usage: { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 1500 }, content: [{ type: 'thinking', thinking: '' }] },
    },
    {
      type: 'assistant',
      uuid: 'a-line-5',
      timestamp: '2026-11-24T10:00:08Z',
      message: { id: 'msg_3', model: 'claude-sonnet-5-5', usage: { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 1500 }, content: [{ type: 'text', text: 'final answer' }] },
    },
    { type: 'system', subtype: 'informational', content: 'Code Mode is on, continuing with ordinary tools.', isMeta: false, timestamp: '2026-11-24T10:00:08Z' },
    { type: 'system', subtype: 'turn_duration', durationMs: 8000, timestamp: '2026-11-24T10:00:09Z' },
  ];

  const parsed = parseJsonlRecordsToEvents(splitRecords);
  const toolReqs = parsed.events.filter((e) => e.type === 'tool.requested');
  assert.equal(toolReqs.length, 1);
  assert.equal(toolReqs[0].payload.toolName, 'WebSearch');
  assert.equal(parsed.events.filter((e) => e.type === 'tool.result').length, 1);
  assert.equal(parsed.events.find((e) => e.type === 'text.delta').payload.text, 'final answer');
  assert.equal(parsed.events.some((e) => e.type === 'native.notice'), false);
  const stats = parsed.events.find((e) => e.type === 'turn.stats').payload;
  assert.equal(stats.requests, 3);
  assert.equal(stats.outputTokens, 650);
  assert.equal(parsed.seenMsgIds.has('msg_1'), true);
});

test('formatModelName preserves dotted versions and Markdown nests lists & ignores numeric labels', () => {
  const w = loadFrontendModules();
  assert.equal(w.TaktChatActivity.formatModelName('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(w.TaktChatActivity.formatModelName('claude-opus-4-6'), 'Opus 4.6');
  assert.equal(w.TaktChatActivity.formatModelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');

  assert.equal(w.TaktChatMarkdown.looksLikeFilePath('01/02/03'), false);
  assert.equal(w.TaktChatMarkdown.looksLikeFilePath('server/server.js'), true);

  const nestedHtml = w.TaktChatMarkdown.renderMarkdown('1. One\n   - Sub A\n   - Sub B\n2. Two');
  assert.match(nestedHtml, /^<ol class="cc-ol"><li>One<ul class="cc-ul"><li>Sub A<\/li><li>Sub B<\/li><\/ul><\/li><li>Two<\/li><\/ol>$/);
  assert.ok(!w.TaktChatMarkdown.renderMarkdown('Code `01/02/03` here').includes('md-file-link'));
});

test('1M context window heuristic, Code Mode filtering, task-notification preservation, todos, plan writes, links & spinner', () => {
  // Context window resolution
  assert.equal(resolveMaxContextTokens('claude-opus-5-5', 83700), 1000000);
  assert.equal(resolveMaxContextTokens('claude-sonnet-5-5', 50000), 1000000);
  assert.equal(resolveMaxContextTokens('claude-opus-4-6[1m]', 50000), 1000000);
  assert.equal(resolveMaxContextTokens('claude-haiku-4-5', 50000), 200000);
  assert.equal(resolveMaxContextTokens('claude-opus-4-6', 250000), 1000000);

  const haikuCtx = buildContextUsage({ input_tokens: 10000, cache_read_input_tokens: 40000 }, 'claude-haiku-4-5');
  assert.equal(haikuCtx.rawMaxTokens, 200000);
  assert.equal(haikuCtx.percentage, 25);

  // Task notification inside type: "user" does NOT create a fake user bubble & preserves closing reply
  const w = loadFrontendModules();
  const taskRecords = [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-24T11:00:00Z', message: { role: 'user', content: 'Check 200k vs 1M' } },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-11-24T11:00:05Z',
      requestedModel: 'claude-opus-5-5',
      message: {
        id: 'm1',
        usage: { input_tokens: 4, cache_read_input_tokens: 80600, cache_creation_input_tokens: 2200, output_tokens: 1100 },
        content: [
          { type: 'tool_use', id: 'tu-repl', name: 'REPL', input: { code: 'x' } },
          { type: 'tool_use', id: 'tu-poll', name: 'Poll', input: {} },
          { type: 'tool_use', id: 'tu-st', name: 'searchTools', input: { q: 'a' } },
          { type: 'tool_use', id: 'tu-dt', name: 'describeTool', input: { name: 'a' } },
          { type: 'tool_use', id: 'repl_5a77e6af', name: 'Agent', input: { description: 'Inspect CLI context' } },
          { type: 'text', text: '应该是 1M 上下文。' },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u-notif',
      timestamp: '2026-11-24T11:00:30Z',
      message: {
        role: 'user',
        content: [
          '<task-notification>',
          '<task-id>aaec4e30574c15235</task-id>',
          '<tool-use-id>repl_5a77e6af</tool-use-id>',
          '<status>completed</status>',
          '<summary>Agent "Claude Code context window" finished</summary>',
          '<usage><subagent_tokens>72568</subagent_tokens><tool_uses>4</tool_uses><duration_ms>24897</duration_ms></usage>',
          '</task-notification>',
        ].join('\n'),
      },
    },
  ];

  const parsedTask = parseJsonlRecordsToEvents(taskRecords);
  assert.equal(parsedTask.events.filter((e) => e.type === 'message.user').length, 1);
  assert.equal(parsedTask.events.filter((e) => e.type === 'tool.requested').length, 1);
  assert.equal(parsedTask.events.find((e) => e.type === 'tool.requested').payload.toolName, 'Agent');
  const taskNotice = parsedTask.events.find((e) => e.type === 'native.notice' && e.payload.kind === 'task');
  assert.ok(taskNotice);
  assert.ok(taskNotice.payload.text.includes('子代理完成'));
  assert.ok(taskNotice.payload.text.includes('Agent "Claude Code context window" finished'));
  assert.ok(taskNotice.payload.text.includes('4 次工具'));
  assert.ok(taskNotice.payload.text.includes('25s'));
  assert.ok(parsedTask.events.some((e) => e.type === 'tool.task' && e.payload.toolUseId === 'repl_5a77e6af'));

  const convTask = w.TaktChatTranscript.conversation(parsedTask.events);
  assert.equal(convTask.turns.length, 1);
  assert.equal(convTask.turns[0].closing.text, '应该是 1M 上下文。');
  assert.equal(convTask.turns[0].trailingNotices.length, 1);
  assert.equal(w.TaktChatActivity.formatTokens(1000000), '1M');

  // Todos, plan Write promotion, link escaping & CJK boundary, spinner activity
  const todoPlanConv = w.TaktChatTranscript.conversation([
    { id: '1', type: 'message.user', ts: 1000, payload: { text: 'Plan and build' } },
    {
      id: '2',
      type: 'tool.requested',
      ts: 1100,
      payload: { toolUseId: 'p1', toolName: 'Write', input: { file_path: '/root/.claude/plans/my-plan.md', content: '# My Plan\n1. Step 1' } },
    },
    { id: '3', type: 'tool.result', ts: 1200, payload: { toolUseId: 'p1', output: 'ok', isError: false } },
    {
      id: '4',
      type: 'tool.requested',
      ts: 1300,
      payload: { toolUseId: 'td1', toolName: 'TodoWrite', input: { todos: [{ content: 'Read files', status: 'completed' }, { content: 'Write tests', status: 'in_progress' }] } },
    },
    {
      id: '5',
      type: 'tool.requested',
      ts: 1400,
      payload: { toolUseId: 'td2', toolName: 'TaskCreate', input: { taskId: '9', subject: 'Verify UI' } },
    },
    {
      id: '6',
      type: 'tool.requested',
      ts: 1500,
      payload: { toolUseId: 'td3', toolName: 'TaskUpdate', input: { taskId: '9', status: 'completed' } },
    },
  ]);
  assert.equal(todoPlanConv.turns[0].segments[0].kind, 'plan');
  assert.equal(todoPlanConv.todos.length, 3);
  assert.equal(todoPlanConv.todos[1].status, 'in_progress');
  assert.equal(todoPlanConv.todos[2].status, 'completed');

  const linkHtml = w.TaktChatMarkdown.renderMarkdown('查看 https://example.com/a?x=1&y=2，说明 [文档](https://example.com/doc?k=v&z=1)。');
  assert.ok(linkHtml.includes('href="https://example.com/a?x=1&amp;y=2"'));
  assert.ok(!linkHtml.includes('&amp;amp;'));
  assert.ok(linkHtml.includes('>https://example.com/a?x=1&amp;y=2</a>，说明'));
  assert.ok(linkHtml.includes('href="https://example.com/doc?k=v&amp;z=1"'));

  const spinner = classifyClaudeScreen('· Reading server/server.js…\n──────────────────────────\n❯ \n  default · esc to interrupt');
  assert.equal(spinner.status, 'working');
  assert.equal(spinner.activity, 'Reading server/server.js…');
  assert.equal(spinner.liveText, '');
});

test('extractLiveStreamText extracts streaming pane prose cleanly and REMOTE_JSONL_PY compiles', () => {
  // Active streaming prose with 2-space continuation lines + long wrapped CJK + spinner below
  const wrappedCjkLine = '● 这是一段正在实时流式输出的长中文回答，用于测试前端和服务端在终端软换行发生时能否完整地拼接起来而不出现多';
  const activePane = [
    '❯ 请分析一下流式输出架构',
    '',
    wrappedCjkLine,
    '  余的空格或折断。',
    '',
    '  - 保持单进程 tmux 共存',
    '  - 降低延迟到 120ms',
    '· Flowing… (esc to interrupt)',
    '────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');

  const extracted = extractLiveStreamText(activePane);
  assert.ok(extracted.includes('完整地拼接起来而不出现多余的空格或折断。'));
  assert.ok(extracted.includes('- 保持单进程 tmux 共存'));
  assert.ok(!extracted.includes('Flowing'));
  assert.ok(!extracted.includes('esc to interrupt'));

  const scActive = classifyClaudeScreen(activePane);
  assert.equal(scActive.status, 'working');
  assert.equal(scActive.liveText, extracted);

  // Completed turn must return ''
  const donePane = [
    '● 已经完成了全部修改。',
    '✻ Cooked for 50s · done 9:18 PM',
    '──────────────────────────',
    '❯ ',
  ].join('\n');
  assert.equal(extractLiveStreamText(donePane), '');

  // Tool bullet must return ''
  const toolBulletPane = [
    '● Bash(npm test)',
    '  ⎿ Running suite...',
    '· Running… (esc to interrupt)',
  ].join('\n');
  assert.equal(extractLiveStreamText(toolBulletPane), '');

  // Un-bulleted Code Mode summary after prose must return ''
  const codeModeSupersededPane = [
    '● 我先检查设备列表：',
    '  Called mac-industrial 2 times',
    '· Thinking… (esc to interrupt)',
  ].join('\n');
  assert.equal(extractLiveStreamText(codeModeSupersededPane), '');

  // Previous turn prose must never leak past a newer user prompt
  const turnBoundaryPane = [
    '● 上一轮的回答正文内容在这里。',
    '❯ 请开始下一轮新的问题',
    '· Thinking… (esc to interrupt)',
  ].join('\n');
  assert.equal(extractLiveStreamText(turnBoundaryPane), '');

  // Markdown normalization for deduplication
  assert.equal(
    normalizeForStreamCompare('这是 **1M 上下文** 的 [详细说明](https://example.com/docs?a=1)'),
    normalizeForStreamCompare('这是 1M 上下文 的 详细说明'),
  );

  // Ensure embedded Python watcher + chunk script has zero syntax errors
  execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "remote_jsonl.py", "exec")'], {
    input: REMOTE_JSONL_PY,
    encoding: 'utf8',
  });
});
