# Agent Cluster Workbench

Agent Cluster Workbench is a local-first multi-model agent cluster console for orchestrating controller/worker workflows, visualizing task traces and call chains, managing workspace tool execution, and tracking session memory, retries, circuit breakers, and estimated cost.

## Attribution

- Author: 想画世界送给你

## License

- License: `GPL-2.0-only`
- Full text: [LICENSE](./LICENSE)

## Features

- Task Trace and call-chain visualization
- Workspace tool layer for worker models
- Session memory, token and cost statistics, retries, and circuit breakers
- Scheme-based multi-model routing and staged execution
- Chinese / English runtime language switch
- Workspace cache clearing and stricter task-scope restrictions

## Requirements

- Node.js 20+
- Windows / PowerShell recommended for the packaged workflow

## Quick Start

```powershell
npm install
npm start
```

Development mode:

```powershell
npm run dev
```

Default address:

```text
http://127.0.0.1:4040
```

## Validation

```powershell
npm test
```

Smoke tests only:

```powershell
npm run test:smoke
```

Unit tests only:

```powershell
npm run test:unit
```

Syntax checks only:

```powershell
npm run check
```

## Build Windows EXE

```powershell
npm run build:win-exe
```

By default, the EXE embeds `cluster.config.blank.json`, not your local `cluster.config.json` or `runtime.settings.json`.

If you explicitly override the base config before building, the packaged EXE may include your custom config data:

```powershell
$env:AGENT_CLUSTER_BASE_CONFIG = "cluster.config.json"
npm run build:win-exe
```

## Privacy and Git Safety

The repo ignores local secrets and private runtime artifacts, including:

- `.env` and local env variants
- `cluster.config.json`
- `runtime.settings.json`
- `dist/runtime.settings.json`
- local encryption key files
- workspace cache and bot connector folders
- packaged binaries such as `dist/*.exe`

Important:

- `runtime.settings.json` stores secrets in encrypted form, but it still should not be committed.
- `.gitignore` only affects untracked files. If a sensitive file was already tracked before, remove it from the Git index:

```powershell
git rm --cached cluster.config.json dist/runtime.settings.json dist/AgentClusterWorkbench.exe
```

## Project Structure

```text
src/
  cluster/      orchestration, routing, synthesis
  http/         HTTP routes
  providers/    model provider adapters
  session/      runtime session, trace, memory, stats
  static/       frontend modules and visualization
  system/       desktop/runtime integration
  workspace/    workspace file and command tools
scripts/        build scripts
test/           smoke tests and unit tests
```
