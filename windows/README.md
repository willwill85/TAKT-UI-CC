# Windows desktop

- `main.cjs`: sandboxed Electron shell and owned backend process lifecycle.
- `package.json`: desktop version and build date; keep in sync with the root package.
- `prepare.js`: stage backend production dependencies and the build machine's Node x64 runtime.
- `electron-builder.json`: x64 NSIS installer and portable executable configuration.
- `verify-package.js`: fail the build if bundled dependencies are missing or resolve outside the package.

Run `npm run desktop` or `npm run build:windows` from the repository root. No user state belongs in this directory. See [Windows 11 guide](../docs/WINDOWS11.md).
