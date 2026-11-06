'use strict';
// Native ConPTY is isolated from the workbench HTTP process.
const pty = require('node-pty');
let terminal, exiting = false;
function send(message) { if (process.connected) process.send(message, () => {}); }
function finish(code) {
  if (exiting) return;
  exiting = true;
  send({ type: 'exit', exitCode: code });
  setTimeout(() => process.exit(0), 100);
}
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  try {
    if (message.type === 'start' && !terminal) {
      terminal = pty.spawn(message.file, message.args, { ...message.options, useConpty: true, useConptyDll: true });
      terminal.onData(data => send({ type: 'data', data }));
      terminal.onExit(({ exitCode }) => finish(exitCode));
    } else if (message.type === 'write') terminal?.write(message.data);
    else if (message.type === 'resize') terminal?.resize(message.cols, message.rows);
    else if (message.type === 'kill') terminal ? terminal.kill() : finish(0);
  } catch (error) { send({ type: 'error', message: error.message }); finish(-1); }
});
