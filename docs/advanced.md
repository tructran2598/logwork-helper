# Advanced Usage

This file keeps technical details out of the main README. Most users only need `npm install -g logwork-helper`, `logwork-helper setup-user --no-login`, `logwork-helper auth login`, and `/mcp`.

## Environment Configuration

Defaults target the current Resource Optimiser / Vinova profile. For non-default deployments, configure the runtime with environment variables instead of editing source:

```bash
LOGWORK_HELPER_PROFILE=vinova
LOGWORK_API_BASE=https://api.resourceoptimiser.com/api/v1
LOGWORK_LOGIN_URL=https://app.resourceoptimiser.com/vinova
LOGWORK_JIRA_BASE_URL=https://jira-vnv.vinova.sg
LOGWORK_KEYCLOAK_AUTH_URL=https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/auth
LOGWORK_KEYCLOAK_TOKEN_URL=https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/token
LOGWORK_KEYCLOAK_REDIRECT_URI=https://app.resourceoptimiser.com/vinova/check-login
```

In Windows PowerShell, set the same values with `$env:NAME = "value"` before running Logwork Helper.

Supported overrides:

```text
LOGWORK_HELPER_PROFILE
LOGWORK_API_BASE
LOGWORK_LOGIN_URL
LOGWORK_JIRA_BASE_URL
LOGWORK_TOKEN_KEY
LOGWORK_ALLOWED_SAFARI_HOSTS
LOGWORK_KEYCLOAK_AUTH_URL
LOGWORK_KEYCLOAK_TOKEN_URL
LOGWORK_KEYCLOAK_CLIENT_ID
LOGWORK_KEYCLOAK_REDIRECT_URI
LOGWORK_KEYCLOAK_SCOPE
LOGWORK_KEYCLOAK_RESPONSE_MODE
LOGWORK_KEYCLOAK_RESPONSE_TYPE
LOGWORK_HTTP_TIMEOUT_MS
LOGWORK_HTTP_READ_RETRIES
LOGWORK_HTTP_RETRY_DELAY_MS
LOGWORK_DAY_LOG_CONCURRENCY
```

URL and numeric overrides are validated on startup. Invalid values fail fast so the helper does not log work against an unintended endpoint.

## Install Alternatives

The recommended install path is:

```bash
npm install -g logwork-helper
logwork-helper setup-user --no-login
```

One-off setup without a prior global install:

```bash
npx -y logwork-helper setup-user --no-login
```

Yarn global install:

```bash
yarn global add logwork-helper
logwork-helper setup-user --no-login
```

To install and start auth immediately:

```bash
logwork-helper setup-user --login
```

Use `--no-login` when installing in scripts or CI.

## Update

For global npm users:

```bash
npm update -g logwork-helper
logwork-helper setup-user --no-login
```

For `npx` users:

```bash
npx -y logwork-helper setup-user --no-login
```

Restart or reload your IDE after updating.

## Manual Terminal REPL

If you want to log work directly from Terminal without an MCP client, use the React + Ink manual session:

```bash
logwork
```

Compatibility commands still work:

```bash
logwork-helper manual
logwork-helper log
```

Prompt preview:

```text
Logwork Helper
cwd: /path/to/repo

logwork > /
> /help        Show this help
  /auth        Authenticate Resource Optimiser or show Jira login command
  /status      Show Resource Optimiser and Jira auth status
  /diagnostics Write a sanitized report
  /query       Query logwork by preset period
  /logwork     Create Resource Optimiser, Jira, or combined logwork
  /mcp         Show copy-ready MCP setup
```

Useful commands inside the session:

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

`/logwork` opens a target picker for Resource Optimiser, Jira, or Both. `/logwork ro` starts the Resource Optimiser wizard: pick a day in the current week, pick a Resource Optimiser project, then enter one task per line:

```text
+2 check ui/ux
+1.5 polish reset password state
```

`/logwork jira` starts the Jira worklog wizard: pick a day, then enter tasks with exactly one Jira issue key:

```text
+2 check ui/ux (SCB-213)
+1.5 polish reset password state (SCB-214)
```

`/logwork both` uses one date/task draft, builds separate Resource Optimiser and Jira previews, then asks for separate approvals when applying.

Inside `/logwork`, press Enter on an empty input to apply the ready preview. Use `/remove` to open a multi-select task remover, `/edit` to replace a task, `/save` to persist a local draft, or `Esc` to cancel with confirmation.

While the `task >` prompt is active, type `/` to see task-only actions:

```text
/save        Save this draft locally
/drafts      Resume or delete saved drafts
/diagnostics Write a sanitized support report
/remove      Select tasks to delete
/edit        Select one task and replace it
/clear       Clear current task list
/back        Return to project picker
/cancel      Discard this logwork session
```

Resource Optimiser drafts saved with `/save` are stored locally at `~/.logwork-helper/manual-drafts.json` on macOS or `%USERPROFILE%\.logwork-helper\manual-drafts.json` on Windows. Drafts never contain tokens, passwords, or OTPs.

## Troubleshooting

- **IDE does not show tools**: restart or reload the MCP client and check the server path points to `~/.logwork-helper/mcp-server.mjs` on macOS or `%USERPROFILE%\.logwork-helper\mcp-server.mjs` on Windows.
- **`logwork: command not found` after `setup-user`**: open a new terminal first. If it still fails, run `npm install -g logwork-helper` or ensure your npm global bin directory is on `PATH`.
- **`npm error ELINKGLOBAL` during `setup-user`**: update to `logwork-helper@0.1.6` or newer, then rerun setup. The installer uses `npm link`, not `npm link --global`.
- **`query_logwork` or `allowUnbooked` missing**: reload the MCP tool cache or restart the IDE.
- **Not authenticated to Resource Optimiser**: run `logwork-helper auth login`, or ask the assistant to call `start_auth_login`; enter secrets only in Terminal.
- **Not authenticated to Jira**: run `logwork-helper jira login`, or ask the assistant to call `start_jira_auth`; paste the Jira PAT only in Terminal.
- **Auth error after 2FA**: retry `logwork-helper auth login`. If it still fails, run `logwork-helper diagnostics` and send only the generated sanitized report.
- **Jira worklog preview is blocked**: every Jira entry must include exactly one issue key, such as `SCB-213`. Duplicate Jira worklogs are blocking and cannot be overridden in v1.
- **Support needs logs**: run `logwork-helper doctor` or `logwork-helper diagnostics`; the report is saved under the helper diagnostics directory.
- **No project matched**: ask the assistant to call `list_logwork_projects`, choose the correct project, then call `upsert_project_mapping`.
- **Do not paste Bearer tokens, cookies, passwords, OTPs, or raw curl auth logs**: auth is handled locally and MCP config should only contain `command` and `args`.

## Legacy CLI

Git hook and quick manual workflows still exist for compatibility, but they are not required for MCP users.

Quick manual log:

```bash
logwork-helper manual quick --message "Fix login bug"
```

Optional Git hook install:

```bash
~/.logwork-helper/setup.sh /path/to/repo-that-you-commit-in
```

On Windows, use:

```powershell
logwork-helper install-hook C:\path\to\repo-that-you-commit-in
```

Dry run:

```bash
LOGWORK_DRY_RUN=1 logwork-helper manual quick --message "Dry run task"
```

In Windows PowerShell:

```powershell
$env:LOGWORK_DRY_RUN = "1"; logwork-helper manual quick --message "Dry run task"
```

## Release Checks

Before publishing or tagging a release, run:

```bash
npm run release:check
```

This runs tests, production dependency audit, package dry run, and whitespace checks. See [RELEASE.md](../RELEASE.md) for the full checklist and manual verification steps.

## GitHub About Metadata

Suggested repository description:

```text
Local-first MCP server and terminal CLI for safe Resource Optimiser logwork automation.
```

Suggested topics:

```text
resource-optimiser
logwork
mcp-server
nodejs
macos
windows
keycloak
codex
cursor
vscode
claude-code
```
