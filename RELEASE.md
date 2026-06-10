# Release Checklist

Use this checklist before publishing or tagging a production release.

## Required Gates

Run the local release gate:

```bash
npm run release:check
```

The gate must pass all of the following:

- `npm test`
- `npm audit --omit=dev --audit-level=moderate`
- `npm pack --dry-run`
- `git diff --check`

## Manual Verification

- Install from the packed tarball in a temporary directory.
- Run `logwork-helper setup-user --no-login`.
- Confirm the printed MCP config uses the resolved `~/.logwork-helper/mcp-server.mjs` path.
- Run `logwork-helper --help`.
- Run `logwork-helper mcp` through an MCP client smoke test.
- Run `logwork-helper auth status` and confirm no token is printed.

## Safety Checks

- Do not include Resource Optimiser tokens, `.env` files, diagnostics reports, or machine-specific MCP configs in the package.
- Confirm `mcp-server.mjs` reports the same version as `package.json`.
- Confirm `README.md` and onboarding output describe the same primary setup flow.
- Confirm no untracked release artifacts are included except intentional documentation.

## Rollback

- Keep the previous npm package version available.
- If a release introduces auth, MCP, or apply-path regressions, roll back by instructing users to install the previous known-good npm version.
- Do not publish a replacement with the same version; publish a new patch version after the fix is verified.
