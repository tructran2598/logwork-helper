# MCP Setup

Use `/mcp` inside the `logwork` terminal UI when possible. It prints copy-ready config with your actual `mcp-server.mjs` path.

```bash
logwork
```

```text
/mcp
```

The examples below use `/Users/<user>` as a macOS placeholder. On Windows, use the path printed by setup or `/mcp`, usually `C:\\Users\\<user>\\.logwork-helper\\mcp-server.mjs` inside JSON/TOML strings.

## Cursor

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

## Codex

Add this to `~/.codex/config.toml`, or to project `.codex/config.toml`:

```toml
[mcp_servers.logwork-helper]
command = "node"
args = ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

## Google Antigravity

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

## GitHub Copilot / VS Code

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

## Claude Code

Add the server from Terminal:

```bash
claude mcp add --transport stdio logwork-helper -- node "/Users/<user>/.logwork-helper/mcp-server.mjs"
```

From Windows PowerShell:

```powershell
claude mcp add --transport stdio logwork-helper -- node 'C:\Users\<user>\.logwork-helper\mcp-server.mjs'
```

Or add this to project `.mcp.json`:

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

## Exposed Tools

After editing config, restart or reload the IDE. The MCP server should expose:

- `query_logwork`
- `preview_logwork_batch`
- `apply_logwork_batch`
- `list_logwork_projects`
- `upsert_project_mapping`
- `start_auth_login`

If an MCP tool says auth is required, ask your assistant to call `start_auth_login` or run this yourself:

```bash
logwork-helper auth login
```

On Windows, run the same command from PowerShell.

Do not paste passwords, 2FA codes, Bearer tokens, cookies, or raw auth logs into AI chat.

Templates are also available in [examples/mcp](../examples/mcp/).

## Verify Setup

Use these prompts after your IDE sees `logwork-helper`:

```text
Check my logwork for this week.
```

```text
Which Resource Optimiser project should this repo log work to?
```

```text
Preview this logwork and ask for my approval before submitting:
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
```

```text
Set up the SCB ticket mapping to project 2621A-SIT-HTML BUILDER-PRJ.
```

## Common MCP Workflows

### Query Logwork

Ask your assistant:

```text
Check whether I have logged anything today.
```

```text
List the days and projects I logged work for this week, including task details.
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
2. Assistant shows the summary, including the approval checklist with total hours, date range, and project breakdown, then asks for approval.
3. Assistant calls `apply_logwork_batch` with the returned `batchId` only after you approve.

`apply_logwork_batch` requires `confirm: true` and a cached `batchId` from the preview step. If the preview expired or changed, rerun `preview_logwork_batch` before applying.

### Set Up Project Mapping

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
