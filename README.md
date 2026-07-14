# Logwork Helper

[npm version](https://www.npmjs.com/package/logwork-helper)
[npm downloads](https://www.npmjs.com/package/logwork-helper)
[license](LICENSE)

Local MCP server and terminal CLI for Resource Optimiser logwork and Jira self-hosted worklogs.

Logwork Helper lets Cursor, Codex, Google Antigravity, GitHub Copilot / VS Code, Claude Code, and other MCP clients work with Resource Optimiser from your machine. It can query logged work, preview and submit approved Resource Optimiser logwork, preview and submit approved Jira worklogs, map ticket prefixes to Resource Optimiser projects, and run a guided terminal flow through `logwork`.

Credentials stay local. Resource Optimiser passwords and 2FA codes, and Jira Personal Access Tokens, are entered in Terminal only, never in MCP config or AI chat.

## Install

Requirements:

- macOS or Windows 10/11
- Node.js 20+
- npm

Install globally:

```bash
npm install -g logwork-helper
```

Prepare the local runtime used by MCP configs:

```bash
logwork-helper setup-user
```

This creates the local Logwork Helper runtime (`~/.logwork-helper` on macOS, `%USERPROFILE%\.logwork-helper` on Windows), installs runtime dependencies there, links the terminal commands, and prints copy-ready MCP config snippets using your real local path.

## Authenticate

Log in to Resource Optimiser from Terminal:

```bash
logwork-helper auth login
```

Follow the prompts for email, password, 2FA device, and 2FA code. The helper stores only the final Resource Optimiser session in your OS credential store: macOS Keychain on macOS, or Windows Credential Manager on Windows.

Check auth status:

```bash
logwork-helper auth status
```

For Jira self-hosted worklogs, create a Jira Personal Access Token in Jira, then save it from Terminal:

```bash
logwork-helper jira login
```

The default Jira URL is `https://jira-vnv.vinova.sg`. Override it with:

```bash
logwork-helper jira login --base-url https://jira.example.com
```

Check or delete Jira auth without printing the token:

```bash
logwork-helper jira status
logwork-helper jira logout
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
Preview this Jira worklog and ask for my approval before submitting:
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

Inside the terminal UI, `/logwork` opens a target picker. Use `/logwork ro` for Resource Optimiser, `/logwork jira` for Jira worklogs, or `/logwork both` to preview/apply both with separate approvals.

Useful terminal commands:

```text
/query today
/query yesterday
/query this-week
/query last-week
/query this-month
/query last-month
/logwork
/logwork ro
/logwork jira
/logwork both
/mcp
/projects
/projects 5234
/map SCB 5234
/diagnostics
```

## More Docs

- [MCP setup](docs/mcp-setup.md): full client configs, exposed tools, verification prompts, and common MCP workflows.
- [Security and auth](docs/security.md): Keycloak flow, Jira PAT flow, OS credential storage, stored files, and safety model.
- [Advanced usage](docs/advanced.md): environment overrides, manual REPL details, updates, troubleshooting, legacy git hook, and release checks.
- [Release checklist](RELEASE.md): publish and manual verification checklist.

## License

This project is proprietary and not open source. See [LICENSE](LICENSE).
