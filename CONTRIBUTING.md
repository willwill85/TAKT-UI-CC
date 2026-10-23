# Contributing

Thanks for helping! The project is intentionally small and dependency-light (`node-pty` + `ws`).

## Dev setup

```bash
git clone https://github.com/willwill85/TAKT-UI-CC.git && cd TAKT-UI-CC
bash scripts/install.sh
# Run an isolated instance that doesn't touch your real data / ports:
export TAKT_HOME=/tmp/takt-dev TAKT_PORT=3190 TAKT_MCP_PORT=18890 TAKT_EDA_PORT=49790
bash scripts/start.sh
```

## Before sending a PR

```bash
npm run lint      # eslint (no-undef catches most refactoring slips)
npm run check     # node --check + bash -n on all scripts
```

CI runs the same plus a smoke test (`scripts/smoke-test.sh`): fresh data dir → servers start → API, auth and Host/Origin guards behave.

## Guidelines

- No machine-specific paths, IPs, host names or device ids in code or docs — everything goes through `config.js` / env vars / `nodes.json`.
- Anything that executes commands on the user's machine must stay behind the MCP token and loopback binding.
- The UI is a single file (`server/public/index.html`); keep it dependency-free (no build step).
- i18n: UI strings are currently Chinese. A string-table refactor is the most welcome contribution — open an issue first.
