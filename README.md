# Logwork Helper

[![npm version](https://img.shields.io/npm/v/logwork-helper.svg)](https://www.npmjs.com/package/logwork-helper)
[![npm downloads](https://img.shields.io/npm/dm/logwork-helper.svg)](https://www.npmjs.com/package/logwork-helper)
[![license](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)

Local MCP server and terminal CLI for Resource Optimiser logwork.

Logwork Helper lets Cursor, Codex, Google Antigravity, GitHub Copilot / VS Code, Claude Code, and other MCP clients work with Resource Optimiser from your machine. It can query logged work, preview and submit approved logwork, map ticket prefixes to Resource Optimiser projects, and run a guided terminal flow through `logwork`.

Credentials stay local. Passwords and 2FA codes are entered in Terminal only, never in MCP config or AI chat.

## Install

Requirements:

- macOS
- Node.js 20+
- npm

Install globally:

```bash
npm install -g logwork-helper
```

Prepare the local runtime used by MCP configs:

```bash
logwork-helper setup-user --no-login
```

This creates `~/.logwork-helper`, installs runtime dependencies there, links the terminal commands, and prints copy-ready MCP config snippets using your real local path.

## Authenticate

Log in to Resource Optimiser from Terminal:

```bash
logwork-helper auth login
```

Follow the prompts for email, password, 2FA device, and 2FA code. The helper stores only the final Resource Optimiser session in macOS Keychain.

Check auth status:

```bash
logwork-helper auth status
```

## Set Up MCP

The easiest way to get the right config is from the terminal UI:

```bash
logwork
```

Then type:

```text
/mcp
```

Choose your MCP client and copy the printed config. Supported clients:

- Cursor
- Google Antigravity
- GitHub Copilot / VS Code
- Claude Code
- Codex

You can also jump directly:

```text
/mcp cursor
/mcp antigravity
/mcp copilot
/mcp claude-code
/mcp codex
```

After saving the config, restart or reload your IDE MCP tools.

Verify from your assistant:

```text
Check my logwork for this week.
```

Full client examples are in [docs/mcp-setup.md](docs/mcp-setup.md).

## Daily Use

Ask your assistant:

```text
Check whether I have logged anything today.
```

```text
Preview this logwork and ask for my approval before submitting:
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
```

```text
Set up the SCB ticket mapping to project 2621A-SIT-HTML BUILDER-PRJ.
```

To log work directly from Terminal:

```bash
logwork
```

Useful terminal commands:

```text
/query today
/query this-week
/logwork
/mcp
/projects
/projects 5234
/map SCB 5234
/diagnostics
```

## More Docs

- [MCP setup](docs/mcp-setup.md): full client configs, exposed tools, verification prompts, and common MCP workflows.
- [Security and auth](docs/security.md): Keycloak flow, macOS Keychain storage, stored files, and safety model.
- [Advanced usage](docs/advanced.md): environment overrides, manual REPL details, updates, troubleshooting, legacy git hook, and release checks.
- [Release checklist](RELEASE.md): publish and manual verification checklist.

## License

This project is proprietary and not open source. See [LICENSE](LICENSE).
