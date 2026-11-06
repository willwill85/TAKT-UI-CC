'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env, TAKT_DEV_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, '../windows'), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false });
child.on('error', (err) => { console.error(err.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
