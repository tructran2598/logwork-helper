# Logwork Helper

Local MCP server for AI assistants to query, preview, and submit Resource Optimiser logwork.

Logwork Helper is designed for Cursor, Codex, Google Antigravity, GitHub Copilot / VS Code, and other MCP clients. It runs locally over `stdio`, reads your Resource Optimiser session from Safari, and stores only local project matching hints.

## Quick Start

1. Install the helper:

```bash
 npx -y logwork-helper setup-user
```

2. Log in to Resource Optimiser in Safari:

```text
 https://app.resourceoptimiser.com
```

3. Enable Safari auth access:

```text
 Safari -> Settings -> Advanced -> Show features for web developers
 Develop -> Allow JavaScript from Apple Events
```

4. Copy the MCP config printed by the installer into your IDE.
5. Restart or reload your IDE MCP tools.
6. Ask your AI assistant:

```text
 double check log work this week
```

## Requirements

- macOS
- Node.js 20+
- npm, or yarn if you prefer `yarn dlx`
- Safari
- Logged-in Resource Optimiser session in Safari

## Install

Recommended one-time install:

```bash
npx -y logwork-helper setup-user
```

Equivalent options:

```bash
npm install -g logwork-helper
logwork-helper setup-user
```

```bash
yarn dlx logwork-helper setup-user
```

```bash
yarn global add logwork-helper
logwork-helper setup-user
```

The installer copies the runtime into `~/.logwork-helper`, installs production dependencies, and prints ready-to-paste MCP configs using your actual macOS path.

## Safari Auth Setup

Logwork Helper does not accept or store Bearer tokens. It reads your Resource Optimiser token locally from Safari `localStorage`.

Enable Safari JavaScript from Apple Events:

```text
Safari -> Settings -> Advanced -> Show features for web developers
Develop -> Allow JavaScript from Apple Events
```

Then quit and reopen Safari once. If macOS asks for Automation permissions, allow your terminal or IDE to control Safari.

## MCP Setup

Use the exact config printed by `logwork-helper setup-user` when possible. The examples below use `/Users/<user>` as a placeholder.

### Cursor

Add this to Cursor MCP settings:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
    }
  }
}
```

### Codex

Add this to `~/.codex/config.toml`, or to project `.codex/config.toml`:

```toml
[mcp_servers.logwork-helper]
command = "node"
args = ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

### Google Antigravity

Add this to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
    }
  }
}
```

### GitHub Copilot / VS Code

Add this to workspace `.vscode/mcp.json` or your VS Code user MCP config:

```json
{
  "servers": {
    "logworkHelper": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
    }
  }
}
```

After editing config, restart/reload the IDE. The MCP server should expose:

- `query_logwork`
- `preview_logwork_batch`
- `apply_logwork_batch`
- `list_logwork_projects`
- `upsert_project_mapping`

Templates are also available in `examples/mcp/`.

## Verify With AI Prompts

Use these prompts after your IDE sees `logwork-helper`:

```text
kiểm tra log work tuần này
```

```text
repo này đang logwork cho dự án nào trên RO
```

```text
preview logwork sau rồi hỏi tôi trước khi submit:
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
```

```text
setup mapping SCB vào project 2621A-SIT-HTML BUILDER-PRJ
```

## Common Workflows

### Query Logwork

Ask your assistant:

```text
kiểm tra hôm nay tôi đã log gì chưa
```

```text
trong tuần này tôi đã log work ngày nào và cho dự án nào, liệt kê chi tiết
```

The assistant should call `query_logwork`. This is read-only and does not need confirmation.

### Preview Then Apply

Use weekly text like this:

```text
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213, SCB-227)
+1 System page updates
Tuesday, 02 Jun 2026
+2.5 Password reset validation and UI improvements (SCB-228)
```

Expected flow:

1. Assistant calls `preview_logwork_batch`.
2. Assistant shows the summary and asks for approval.
3. Assistant calls `apply_logwork_batch` only after you approve.

`apply_logwork_batch` requires `confirm: true`.

### Setup Project Mapping

You do not need to create `.logwork-helper.json` manually.

If preview cannot resolve a ticket like `SCB-213`, ask your assistant to list projects or choose the correct project. The assistant can call:

- `list_logwork_projects` to fetch your Resource Optimiser project memberships.
- `upsert_project_mapping` to save ticket/keyword mapping after approval.

Default mapping storage:

```text
~/.logwork-helper/.logwork-helper.json
```

Example mapping created by MCP:

```json
{
  "projectMappings": [
    {
      "projectName": "2621A-SIT-HTML BUILDER-PRJ",
      "projectMemberId": 5234,
      "tickets": ["SCB"],
      "keywords": ["question bank", "programme", "cluster"]
    }
  ]
}
```

This file stores matching hints only. It never stores Resource Optimiser tokens.

### Allow Unbooked Logging

If a task matches one of your Resource Optimiser project memberships but is not booked for that date, preview marks it as `UNBOOKED`.

Only allow this when the matched project is correct. Applying unbooked entries requires both:

```json
{
  "confirm": true,
  "allowUnbooked": true
}
```

## Stored Files And Security

Installed runtime:

```text
~/.logwork-helper
```

Project mapping config:

```text
~/.logwork-helper/.logwork-helper.json
```

Security model:

- Token is read locally from Safari `localStorage`.
- Token is not stored in MCP config.
- Token is not stored in `.logwork-helper.json`.
- MCP writes logwork only after an assistant calls `apply_logwork_batch` with explicit confirmation.
- `query_logwork` and `list_logwork_projects` are read-only.

## Update

For `npx` users:

```bash
npx -y logwork-helper setup-user
```

For global npm users:

```bash
npm update -g logwork-helper
logwork-helper setup-user
```

Restart/reload your IDE after updating.

## Troubleshooting

- **IDE does not show tools**: restart/reload the MCP client and check the server path points to `~/.logwork-helper/mcp-server.mjs`.
- **`query_logwork` or `allowUnbooked` missing**: reload the MCP tool cache or restart the IDE.
- **Safari localStorage error**: enable `Develop -> Allow JavaScript from Apple Events`, then quit and reopen Safari.
- **macOS Automation prompt**: allow your terminal or IDE to control Safari in `System Settings -> Privacy & Security -> Automation`.
- **No project matched**: ask the assistant to call `list_logwork_projects`, choose the correct project, then call `upsert_project_mapping`.
- **Do not paste Bearer tokens**: auth is read from Safari; MCP config should only contain `command` and `args`.

## Legacy / Advanced CLI

Git hook and manual CLI workflows still exist for compatibility, but they are not required for MCP users.

Manual log:

```bash
logwork-helper manual --message "Fix login bug"
```

Optional Git hook install:

```bash
~/.logwork-helper/setup.sh /path/to/repo-that-you-commit-in
```

Dry run:

```bash
LOGWORK_DRY_RUN=1 logwork-helper manual --message "Dry run task"
```
