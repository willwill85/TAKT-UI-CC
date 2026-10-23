#!/usr/bin/env node
'use strict';
// node-pty ships a prebuilt `spawn-helper` binary without the executable bit on some npm versions,
// which makes every terminal fail with "posix_spawnp failed". Make sure it is executable.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const candidates = [
  path.join(root, 'build', 'Release', 'spawn-helper'),
  path.join(root, 'build', 'Debug', 'spawn-helper'),
  ...['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'].map((d) => path.join(root, 'prebuilds', d, 'spawn-helper')),
];
let fixed = 0;
for (const f of candidates) {
  try {
    if (fs.existsSync(f)) {
      fs.chmodSync(f, 0o755);
      fixed++;
    }
  } catch (err) {
    console.warn(`[takt] could not chmod ${f}: ${err.message}`);
  }
}
console.log(`[takt] node-pty spawn-helper permissions ok (${fixed} file(s))`);
