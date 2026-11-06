'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const platform = require('../lib/platform');

// Exercise the imported implementation without starting services or reading real nodes.
const source = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
const section = source.slice(source.indexOf('const DOCKTERM_NOISE_TAGS'), source.indexOf('function readJsonBody'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-chat-test-'));
const ctx = vm.createContext({ fs, fsp: fs.promises, os, path, crypto, Buffer, platform,
  BASE_TAKT_DIR: home, WORKSPACE_LINK_DIR: '', setTimeout, clearTimeout,
});
vm.runInContext(section, ctx);
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const run = code => vm.runInContext(code, ctx);

test('incremental chat deduplicates records and updates tool results and model in later chunks', () => {
  run(`var transcript = newTranscriptState('fixture', '/fixture.jsonl', 0);
    var reply = {type:'assistant',uuid:'a',model:'fixture-model',effort:'high',message:{content:[
      {type:'text',text:'Hello'}, {type:'tool_use',id:'read-1',name:'Read',input:{file_path:'/root/work/main.c'}}]}};
    appendTranscriptRecords(transcript, [reply], 0); appendTranscriptRecords(transcript, [reply], 0);`);
  assert.equal(run('transcript.messages.length'), 2);
  assert.equal(run('transcript.model'), 'fixture-model');
  assert.equal(run('transcript.effort'), 'high');
  const oldVer = run('transcript.ver');
  run(`appendTranscriptRecords(transcript, [{type:'user',uuid:'result',message:{content:[
    {type:'tool_result',tool_use_id:'read-1',is_error:false}]}}], 200)`);
  assert.equal(run("transcript.byId.get('read-1').tool.ok"), true);
  assert(run("transcript.byId.get('read-1').ver") > oldVer);
  assert.equal(run("transcript.byId.get('read-1').tool.path"), '/root/work/main.c');
});

test('history prepend preserves message identity and resolves results loaded before tool use', () => {
  run(`var older = newTranscriptState('fixture', '/history.jsonl', 200);
    appendTranscriptRecords(older, [{type:'user',uuid:'r',message:{content:[
      {type:'tool_result',tool_use_id:'older-tool',is_error:true}]}}], 200);
    prependTranscriptRecords(older, [{type:'assistant',uuid:'old',message:{content:[
      {type:'tool_use',id:'older-tool',name:'Bash',input:{command:'false'}}]}}], 0);`);
  assert.equal(run('older.messages.length'), 1);
  assert.equal(run('older.messages[0].tool.ok'), false);
  assert.equal(run("older.toolById.get('older-tool') === older.messages[0]"), true);
});

test('Windows chat SSH uses batch mode without Unix ControlMaster sockets', () => {
  assert(run("DOCKTERM_SSH_OPTS.includes('BatchMode=yes')"));
  assert.equal(run("DOCKTERM_SSH_OPTS.some(s => s.startsWith('ControlMaster=') || s.startsWith('ControlPath='))"), !platform.isWindows);
});

test('remote Python reader compacts history and retrieves referenced images with UUID validation', () => {
  const project = path.join(home, '.claude/projects/fixture');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'fixture.jsonl');
  const data = Buffer.from('fixture image').toString('base64');
  const record = { type: 'user', uuid: 'image-uuid', message: { content: [
    { type: 'text', text: '你好' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ] } };
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
  function python(config) {
    ctx.fixtureConfig = config;
    const script = run('buildDocktermRemotePy(fixtureConfig)');
    const result = spawnSync(process.env.TAKT_PYTHON || 'python', ['-c', script], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONIOENCODING: 'utf-8' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const history = python({ mode: 'history', path: file, before: fs.statSync(file).size });
  assert.equal(history.records[0].message.content[0].text, '你好');
  const ref = history.records[0].message.content[1];
  assert.equal(ref.type, 'image');
  assert.equal(ref.off, 0);
  assert.equal(JSON.stringify(history).includes(data), false, 'polls carry references rather than base64 image bodies');
  assert.equal(python({ mode: 'image', path: file, off: 0, idx: ref.idx, uuid: record.uuid }).data, data);
  assert.equal(python({ mode: 'image', path: file, off: 0, idx: ref.idx, uuid: 'changed' }).error, 'moved');
  assert.equal(python({ mode: 'image', path: path.join(home, 'outside.jsonl'), off: 0, idx: 0 }).error, 'bad-ref');
  const firstPoll = python({ mode: 'poll', cwd: '/fixture', sessionId: 'fixture' });
  assert.equal(firstPoll.records.length, 1);
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'next', message: { content: 'incremental reply' } }) + '\n');
  const nextPoll = python({ mode: 'poll', cwd: '/fixture', sessionId: 'fixture', knownPath: firstPoll.jsonlPath, knownEnd: firstPoll.chunkEnd });
  assert.equal(nextPoll.reset, false);
  assert.equal(nextPoll.records.length, 1);
  assert.equal(nextPoll.records[0].uuid, 'next');
  assert.equal(nextPoll.chunkStart, firstPoll.chunkEnd);
});
