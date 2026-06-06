# Repository Guidelines

## Project Structure & Module Organization

This is a private Node.js 20+ ESM project for a macOS Git `commit-msg` hook, interactive CLI, and local MCP server that log work to Resource Optimiser.

- `logwork-helper.mjs`, `manual-log.mjs`, `mcp-server.mjs`, and `install.mjs` are executable entry points.
- `lib/` contains reusable modules for API access, auth, project resolution, parsing, workflows, UI, and macOS integration.
- `test/` contains Node test runner suites named `*.test.mjs`.
- `hooks/` contains the Git hook template installed into target repositories.
- `examples/mcp/` contains MCP client configuration templates.
- `config.mjs` centralizes API paths, timeouts, defaults, and allowed Safari hosts.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from `package-lock.json`.
- `npm test`: run all tests with `node --test`.
- `npm run start`: run the commit-message helper directly.
- `npm run dry-run`: run the helper without writing logtime.
- `npm run log`: start the manual log workflow.
- `npm run log:dry-run`: preview manual logging without API writes.
- `npm run install-hook -- /path/to/repo`: install the `commit-msg` hook into another repository.

## Coding Style & Naming Conventions

Use ESM syntax and `.mjs` files. Keep indentation at two spaces, prefer single quotes, and include semicolons. Functions and variables use `camelCase`; constants use `UPPER_SNAKE_CASE` when they represent regexes, maps, or fixed configuration. Keep shared behavior in `lib/` and entry-point orchestration in the root executables. No formatter or linter is currently configured, so match nearby style.

## Testing Guidelines

Tests use the built-in `node:test` framework with `node:assert/strict`. Place new tests in `test/` with the pattern `feature-name.test.mjs`. Prefer focused tests for parsers, workflows, and API payload behavior. Run `npm test` before opening a PR. Use dry-run commands when validating logging flows that would otherwise call Resource Optimiser.

## Commit & Pull Request Guidelines

The current Git history is minimal (`Initial commit`, `add source`), so use concise imperative commit messages such as `add batch parser validation` or `fix MCP query range handling`. Pull requests should include a short summary, test results, and any manual validation performed. Link related issues when available. Include screenshots or terminal excerpts only for UI prompts, hook behavior, or MCP client setup changes.

## Security & Configuration Tips

Do not commit Resource Optimiser tokens, `.env` files, or machine-specific MCP paths. Auth is read from Safari `localStorage`; keep MCP `cwd` pointed at this repository so optional `.logwork-helper.json` project mappings resolve predictably.
