'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mapper } = require('../lib/workspace-paths');
const { contains, childEnv, psArgs, psQuote } = require('../lib/platform');
const { interactiveArgs, sessionName, tunnelArgs } = require('../lib/ssh');
const { TunnelManager } = require('../lib/ssh-tunnels');
const { EventEmitter } = require('node:events');

const nodes = [
  { id: 'one', localWorkDir: 'C:\\Users\\开发者\\.takt-ai\\work', remoteWorkDir: '/home/dev/work', sshHost: 'server-one', enabled: true },
  { id: 'two', localWorkDir: 'D:\\TAKT 工作区\\work2', remoteWorkDir: '/root/work', sshHost: 'server-two', enabled: true },
];
test('Windows mirror mapping accepts drive letters, Chinese, slashes and line references', () => {
  const m = mapper(nodes, nodes[0].localWorkDir, '', path.win32);
  const local = 'C:\\Users\\开发者\\.takt-ai\\work\\project\\a.c';
  assert.equal(m.resolve('/home/dev/work/project/a.c:12:4', '', 'one').localPath, local);
  assert.equal(m.resolve(local, '', 'one').remotePath, '/home/dev/work/project/a.c');
  assert.equal(m.resolve(local.replaceAll('\\', '/'), '', 'one').remotePath, '/home/dev/work/project/a.c');
  assert.equal(m.resolve(local, '', 'one').lineNum, null);
  assert.equal(m.resolve('/home/dev/work/project/a.c:12:4', '', 'one').lineNum, 12);
  assert.equal(m.resolve('file.txt', '/root/work/工程', 'two').localPath, 'D:\\TAKT 工作区\\work2\\工程\\file.txt');
  assert.equal(m.resolve('D:\\TAKT 工作区\\work2\\file.txt', '', 'one').node.id, 'two');
});
test('project mappings resolve original local folders and remote project paths', () => {
  const mapped = [{ ...nodes[1], projectMappings: [{ localPath: 'E:\\项目\\控制器', remotePath: '/root/work/controller' }] }];
  const m = mapper(mapped, mapped[0].localWorkDir, '', path.win32);
  assert.equal(m.resolve('/root/work/controller/src/main.c:12', '', 'two').localPath, 'E:\\项目\\控制器\\src\\main.c');
  assert.equal(m.resolve('E:\\项目\\控制器\\src\\main.c', '', 'two').remotePath, '/root/work/controller/src/main.c');
  assert.equal(m.resolve('main.c', '/root/work/controller/src', 'two').remotePath, '/root/work/controller/src/main.c');
  assert.equal(m.resolve('/root/work/controller-other/a.c', '', 'two').localPath, 'D:\\TAKT 工作区\\work2\\controller-other\\a.c');
});
test('Windows containment rejects siblings, parent traversal and other drives', () => {
  const root = nodes[0].localWorkDir;
  assert(contains(root, root.toUpperCase() + '\\子目录', path.win32));
  assert(!contains(root, root + '-other\\secret', path.win32));
  assert(!contains(root, root + '\\..\\secret', path.win32));
  assert(!contains(root, 'D:\\secret', path.win32));
  assert(contains('\\\\server\\share\\work', '\\\\server\\share\\work\\file', path.win32));
});

test('conversation paths outside the mirror stay remote instead of resolving in local work', () => {
  const m = mapper(nodes, nodes[0].localWorkDir, '', path.win32);
  const outside = m.resolve('src/main.c:8', '/opt/project', 'one');
  assert.equal(outside.localPath, '');
  assert.equal(outside.remotePath, '/opt/project/src/main.c');
  assert.equal(outside.lineNum, 8);
  assert.equal(m.resolve('~/notes.txt', '/opt/project', 'one').localPath, '');
  assert.equal(m.resolve('~/notes.txt', '/opt/project', 'one').remotePath, '~/notes.txt');
});
test('SSH sessions quote untrusted paths and isolate terminal forwards', () => {
  const args = interactiveArgs('a.b;$x', "/home/dev/it's a project; $(touch /tmp/bad)", 'my-server');
  assert.equal(sessionName('a.b;$x'), 'takt_abx');
  assert(args.includes('ClearAllForwardings=yes'));
  assert(args.at(-1).includes("CWD='/home/dev/it'\\''s a project; $(touch /tmp/bad)'"));
  assert.throws(() => interactiveArgs('a', '/', '-oProxyCommand=bad'));
  const tunnel = tunnelArgs(nodes[0], 18765, 49620);
  assert(!tunnel.some((a) => ['-S', '-M', '-Nf'].includes(a)));
  assert(tunnel.includes('127.0.0.1:18765:127.0.0.1:18765'));
});
test('Windows environment preserves PATH and encoded PowerShell treats apostrophes literally', () => {
  const env = childEnv();
  assert.equal(Object.keys(env).filter((k) => k.toLowerCase() === 'path').length, 1);
  const source = `Write-Output ${psQuote("a'b $()")}`;
  assert(Buffer.from(psArgs(source).at(-1), 'base64').toString('utf16le').includes("'a''b $()'"));
});
test('Tunnel owner reuses live children, replaces changed hosts, and closes disabled nodes', () => {
  const children = [];
  const manager = new TunnelManager(18765, 49620, () => {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('close', 0); };
    children.push(child); return child;
  });
  manager.ensure(nodes[0]); manager.ensure(nodes[0]); assert.equal(children.length, 1);
  manager.ensure({ ...nodes[0], sshHost: 'new-host' }); assert.equal(children.length, 2); assert(children[0].killed);
  manager.reconcile([{ ...nodes[0], enabled: false }]); assert(children[1].killed);
  manager.ensure(nodes[1]); children[2].emit('error', new Error('connection reset')); manager.ensure(nodes[1]); assert.equal(children.length, 4);
  manager.stopAll(); assert(children[3].killed); assert.equal(manager.tunnels.size, 0);
});
