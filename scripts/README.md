# Scripts

Cross-platform Node entry points: `runtime.js` (start/stop/doctor), `check.js`, `ssh-session.js`, `desktop.js`, `smoke-test.js`, `desktop-smoke.js`.

Legacy `.sh` scripts remain available for macOS/Linux; `remote-bootstrap.sh` runs on Linux servers. Windows does not use these shell scripts for local startup, terminals, or packaging. Use `start-windows.cmd` at the repository root for source checkout startup.

Tests use temporary data directories and produce ignored reports under `build/`.
