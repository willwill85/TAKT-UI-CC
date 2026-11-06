'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeProject } = require('../lib/project-sync');
for (const failure of [false, true]) test('remove project preserves files' + (failure ? ' and rolls back partial failure' : ''), async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-remove-'));
  const sentinel = path.join(temporary, 'keep.txt'); fs.writeFileSync(sentinel, 'preserve');
  const mapping = { id: 'test-project', localPath: temporary, remotePath: '/root/work/test' };
  const initial = side => [{ id: 'parent', paused: true }, { id: mapping.id, path: side === 'local' ? temporary : mapping.remotePath, paused: false }];
  const stores = { local: initial('local'), remote: initial('remote') };
  let committed = false, failed = false;
  const api = async (side, url, method = 'GET', body) => {
    if (method === 'GET') return structuredClone(stores[side]);
    const id = url.split('/').pop();
    if (method === 'PATCH') Object.assign(stores[side].find(f => f.id === id), body);
    if (method === 'DELETE') {
      if (failure && side === 'remote' && !failed) { failed = true; throw Error('injected failure'); }
      stores[side] = stores[side].filter(f => f.id !== id);
    }
    if (method === 'PUT') stores[side] = [...stores[side].filter(f => f.id !== id), structuredClone(body)];
    return {};
  };
  const operation = removeProject({ node: { id: 'node', syncthingFolderId: 'parent' }, mapping, cfg: { TAKT_HOME: temporary }, api, commit: async () => { committed = true; } });
  if (failure) {
    await assert.rejects(operation, /已恢复两端/);
    assert.equal(committed, false);
    for (const side of ['local', 'remote']) assert.deepEqual(stores[side], initial(side));
  } else {
    await operation; assert.equal(committed, true);
    for (const side of ['local', 'remote']) assert.deepEqual(stores[side], [{ id: 'parent', paused: true }]);
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  fs.rmSync(temporary, { recursive: true });
});
