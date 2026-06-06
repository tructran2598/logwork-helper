# Logwork Helper

macOS Git `commit-msg` hook plus an interactive Node.js CLI for logging work to Resource Optimiser.

The helper reads the Resource Optimiser token from Safari `localStorage`, shows only projects booked for today, and submits logtime to the selected booked project.

## Requirements

- macOS
- Node.js 20+
- npm
- Safari
- Logged-in Resource Optimiser session in Safari

## Quick Setup

```bash
git clone <your-logwork-helper-repo-url>
cd logwork-helper
./setup.sh /path/to/repo-that-you-commit-in
```

Keep this `logwork-helper` folder on disk after setup. The installed Git hook calls the helper from this folder.

## Safari Setup

Enable Safari JavaScript from Apple Events:

```text
Safari -> Settings -> Advanced -> Show features for web developers
Develop -> Allow JavaScript from Apple Events
```

Then quit and reopen Safari once. If macOS asks for Automation permissions, allow Terminal or your Git client to control Safari and Terminal.

## Manual Setup

Use this if you do not want to run `setup.sh`:

```bash
npm ci
node install.mjs /path/to/repo-that-you-commit-in
```

The installer backs up an existing `commit-msg` hook and chains it before Logwork Helper.

## Usage

Commit normally from Terminal, VS Code, or GitLens. The `commit-msg` hook opens a Terminal window and waits for the helper result.

Result behavior:

```text
ok    => commit allowed
skip  => commit allowed
abort => commit blocked
```

## Manual Log

Run the same log-work flow without making a Git commit:

```bash
npm run log
npm run log -- "Fix login bug"
node manual-log.mjs --message "Fix login bug"
```

The project picker only shows projects with a Resource Optimiser timesheet booking for today. Assigned percent is calculated as booked hours per day divided by 8 hours.

## MCP Workflow

Run Logwork Helper as a local MCP server from Cursor, Codex, Antigravity, GitHub Copilot, or another MCP client. The server uses `stdio`:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/absolute/path/to/logwork-helper/mcp-server.mjs"],
      "cwd": "/absolute/path/to/logwork-helper"
    }
  }
}
```

Use the templates in `examples/mcp/` and replace `/absolute/path/to/logwork-helper` with this repository path.

### Cursor

Add the server to Cursor MCP settings using the `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/absolute/path/to/logwork-helper/mcp-server.mjs"],
      "cwd": "/absolute/path/to/logwork-helper"
    }
  }
}
```

### Codex

Add the server to `~/.codex/config.toml`, or project-scoped `.codex/config.toml` for trusted projects:

```toml
[mcp_servers.logwork-helper]
command = "node"
args = ["/absolute/path/to/logwork-helper/mcp-server.mjs"]
cwd = "/absolute/path/to/logwork-helper"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Equivalent template: `examples/mcp/codex.config.toml`.

### Google Antigravity

Open Antigravity MCP raw config at `~/.gemini/antigravity/mcp_config.json` and add:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/absolute/path/to/logwork-helper/mcp-server.mjs"],
      "cwd": "/absolute/path/to/logwork-helper"
    }
  }
}
```

Equivalent template: `examples/mcp/antigravity.mcp_config.json`.

### GitHub Copilot / VS Code

Open workspace `.vscode/mcp.json` or the VS Code user MCP configuration and add:

```json
{
  "servers": {
    "logworkHelper": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/logwork-helper/mcp-server.mjs"],
      "cwd": "/absolute/path/to/logwork-helper"
    }
  }
}
```

Equivalent template: `examples/mcp/copilot.mcp.json`.

The MCP server exposes five tools:

- `preview_logwork_batch`: parses a weekly text block, resolves booked projects by date, and returns a human-readable preview plus structured JSON. If a task is not booked that day but matches a project membership through `.logwork-helper.json`, it is returned as `resolved_unbooked`.
- `apply_logwork_batch`: submits an approved preview. It requires `confirm: true` and refuses to run while entries are unresolved. Entries with `resolved_unbooked` require an additional `allowUnbooked: true` flag.
- `query_logwork`: checks booked/logged work by date, range, period, and optional project filter without changing data. It fetches task-level log details from `/member-logtime` when entries are requested.
- `list_logwork_projects`: lists your Resource Optimiser project memberships and current local project mappings.
- `upsert_project_mapping`: creates or updates a local ticket/keyword mapping after explicit approval with `confirm: true`.

Supported weekly text format:

```text
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213, SCB-227)
+1 System page updates
Tuesday, 02 Jun 2026
+2.5 Password reset validation and UI improvements (SCB-228)
```

MCP can generate or update project matching config for you. When preview cannot resolve a ticket like `SCB-213`, choose a project from `list_logwork_projects`, then call `upsert_project_mapping`:

```json
{
  "projectMemberId": 5234,
  "tickets": ["SCB"],
  "keywords": ["question bank", "programme", "cluster"],
  "confirm": true
}
```

This creates or updates `.logwork-helper.json` in the MCP server `cwd`:

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

The config is only for project matching hints. MCP never stores Resource Optimiser tokens in it.

Mapping setup flow:

1. Run `preview_logwork_batch`.
2. If the preview is unresolved, inspect `setupSuggestions`.
3. Run `list_logwork_projects` if you want to see all project candidates.
4. After user approval, run `upsert_project_mapping`.
5. Run `preview_logwork_batch` again.

Unbooked MCP logwork flow:

1. Run `preview_logwork_batch`.
2. Check any `UNBOOKED` lines in the summary and verify the matched project is correct.
3. Only after explicit user approval, run `apply_logwork_batch` with both `confirm: true` and `allowUnbooked: true`.

This unbooked flow is only available through MCP. The Git hook and manual CLI still only log against projects booked for the selected day.

Query examples:

```text
Check what I logged today.
Check my logwork from 2026-05-18 to 2026-06-29 for SCB.
List detailed logwork for this week by day and project.
Check 2026-06-05 and include entries.
```

MCP troubleshooting:

- Restart or reload the MCP client after changing config.
- If a client does not show `query_logwork` or `allowUnbooked`, reset/reload its MCP tool cache.
- Keep `cwd` pointed at the `logwork-helper` repo so `.logwork-helper.json` is resolved consistently.
- Do not paste Resource Optimiser Bearer tokens into MCP config or `.logwork-helper.json`; auth is still read from Safari localStorage.

## Dry Run

```bash
LOGWORK_DRY_RUN=1 git commit
npm run log:dry-run
```

Dry run builds the payload but does not call the write API.

## Update

```bash
cd logwork-helper
git pull
npm ci
./setup.sh /path/to/repo-that-you-commit-in
```

Re-run setup after changing Node versions because the hook captures the absolute Node path at install time.

## Uninstall

In the target Git repo:

```bash
cd /path/to/repo-that-you-commit-in
ls .git/hooks/commit-msg.logwork-backup.*
```

If a backup exists, restore it:

```bash
mv .git/hooks/commit-msg.logwork-backup.<timestamp> .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

If there was no previous hook, remove the Logwork Helper hook:

```bash
rm .git/hooks/commit-msg
```

## Troubleshooting

- **No projects shown**: you are not booked in Resource Optimiser today.
- **Safari localStorage error**: confirm `Develop -> Allow JavaScript from Apple Events`, then quit and reopen Safari.
- **macOS Automation prompt**: allow Terminal or your Git client to control Safari and Terminal in `System Settings -> Privacy & Security -> Automation`.
- **Hook timeout**: the hook removes stale lock files automatically; retry the commit after fixing the visible error.
- **Existing commit hook**: the installer backs it up as `commit-msg.logwork-backup.<timestamp>` and runs it first.
- **Token safety**: the token is read locally from Safari and is never printed, passed through argv, or written to lock/result files.

## API Notes

- Read today bookings: `GET /member-logtime/timesheet`
- Write logtime: `PATCH /member-logtime/:project_member_id`
- Payload shape:

```json
{
  "add_data": [
    {
      "project_member_id": 5352,
      "logtimes": 0.5,
      "task_name": "Fix login bug",
      "logdate": "2026-06-05T00:00:00.000Z"
    }
  ]
}
```
