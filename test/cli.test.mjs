import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLoginArgs, runLoginCommand } from '../auth-cli.mjs';
import { createAuthDiagnosticsRecorder } from '../lib/auth-diagnostics.mjs';
import {
  formatSetupUserInstructions,
  formatTerminalCommandInstructions,
  installUserRuntime,
  linkGlobalBinaries,
  parseSetupUserArgs,
  sanitizeRuntimeMetadata
} from '../install-user.mjs';
import { isMainModule } from '../lib/entrypoint.mjs';
import { parseManualArgs } from '../manual-log.mjs';

test('package exposes logwork binary for manual REPL shortcut', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.bin.logwork, 'manual-log.mjs');
  assert.equal(packageJson.bin['logwork-helper-manual'], 'manual-log.mjs');
});

test('entrypoint detection supports direct paths, symlinks, and unrelated paths', () => {
  const manualPath = new URL('../manual-log.mjs', import.meta.url).pathname;
  const manualUrl = pathToFileURL(realpathSync(manualPath)).href;
  const tmpDir = mkdtempSync(join(tmpdir(), 'logwork-entrypoint-'));
  const symlinkPath = join(tmpDir, 'logwork');
  symlinkSync(manualPath, symlinkPath);

  assert.equal(isMainModule(manualUrl, ['node', manualPath]), true);
  assert.equal(isMainModule(manualUrl, ['node', symlinkPath]), true);
  assert.equal(isMainModule(manualUrl, ['node', new URL('../package.json', import.meta.url).pathname]), false);
});

test('manual binary starts through a symlink like an npm global bin', () => {
  const manualPath = new URL('../manual-log.mjs', import.meta.url).pathname;
  const tmpDir = mkdtempSync(join(tmpdir(), 'logwork-bin-'));
  const symlinkPath = join(tmpDir, 'logwork');
  symlinkSync(manualPath, symlinkPath);

  const help = spawnSync(process.execPath, [symlinkPath, '--help'], {
    encoding: 'utf8'
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Preferred shortcut:\n  logwork/);

  const repl = spawnSync(process.execPath, [symlinkPath], {
    input: '/help\n',
    encoding: 'utf8'
  });
  assert.equal(repl.status, 0);
  assert.match(repl.stdout, /Logwork Helper manual session/);
  assert.match(repl.stdout, /\/logwork\s+Create logwork with date\/project\/task wizard/);
});

test('CLI dispatcher prints top-level help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper setup-user/);
  assert.match(result.stdout, /logwork-helper auth login/);
  assert.match(result.stdout, /logwork-helper mcp/);
  assert.match(result.stdout, /\n  logwork\n/);
  assert.match(result.stdout, /Primary setup:/);
  assert.match(result.stdout, /Check my logwork for this week/);
});

test('CLI dispatcher prints command help without executing setup', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'setup-user', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /setup-user \[--login\|--no-login\]/);
  assert.match(result.stdout, /prints MCP configs/);
  assert.match(result.stdout, /Paste one printed MCP config into your IDE/);
  assert.match(result.stdout, /--login/);
  assert.equal(result.stderr, '');
});

test('CLI dispatcher prints API-only auth help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'auth', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper auth login/);
  assert.match(result.stdout, /Keycloak API flow/);
  assert.doesNotMatch(result.stdout, /--browser/);
  assert.doesNotMatch(result.stdout, /auth record/);
});

test('CLI dispatcher prints diagnostics help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'diagnostics', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper diagnostics/);
  assert.match(result.stdout, /sanitized support report/);
});

test('CLI dispatcher runs diagnostics command and writes report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-diagnostics-cli-'));
  const result = spawnSync(process.execPath, ['cli.mjs', 'diagnostics'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LOGWORK_HELPER_HOME: dir
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Diagnostics report written to/);
  const reportPath = result.stdout.match(/Diagnostics report written to (.+)/)?.[1]?.trim();
  assert.ok(reportPath);
  assert.equal(existsSync(reportPath), true);
  assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /eyJ/);
});

test('CLI dispatcher prints manual REPL help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'manual', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Preferred shortcut:\n  logwork/);
  assert.match(result.stdout, /logwork-helper manual/);
  assert.match(result.stdout, /manual quick --message/);
  assert.match(result.stdout, /\/query this-week/);
  assert.match(result.stdout, /\/logwork/);
  assert.doesNotMatch(result.stdout, /\/apply/);
  assert.doesNotMatch(result.stdout, /\/exit/);
});

test('auth login parser is API-only and rejects browser auth options', () => {
  assert.deepEqual(parseLoginArgs([]), {
    mode: 'api'
  });
  assert.deepEqual(parseLoginArgs(['--api-mode']), {
    mode: 'api'
  });
  assert.throws(() => parseLoginArgs(['--browser-mode']), /Browser auth has been removed/);
  assert.throws(() => parseLoginArgs(['--browser', 'webkit']), /Browser auth has been removed/);
  assert.throws(() => parseLoginArgs(['--browser=webkit']), /Browser auth has been removed/);
});

test('auth login command writes sanitized diagnostics only on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-auth-cli-'));
  const failureLogPath = join(dir, 'auth-debug.log');
  const stdout = [];
  const stderr = [];
  const failure = await runLoginCommand({
    login: async () => {
      const error = new Error(`Invalid OTP otp=654321 password=secret accessToken=${makeJwt()}`);
      error.code = 'API_AUTH_FAILED';
      throw error;
    },
    createRecorder: () => {
      const recorder = createAuthDiagnosticsRecorder({
        attemptId: 'attempt-cli',
        logPath: failureLogPath,
        now: () => '2026-06-09T00:00:00.000Z'
      });
      recorder.event('otp_reprompt', {
        status: 200,
        path: '/auth/realms/resource/login-actions/authenticate',
        formKinds: ['otp']
      });
      return recorder;
    },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message)
  });

  assert.equal(failure.ok, false);
  assert.match(stdout[0], /Starting Resource Optimiser API auth/);
  assert.match(stderr.join('\n'), /Auth failed\. Sanitized diagnostics saved to/);
  assert.match(stderr.join('\n'), /Attempt: attempt-cli/);
  const log = readFileSync(failureLogPath, 'utf8');
  assert.match(log, /otp_reprompt/);
  assert.doesNotMatch(log, /654321/);
  assert.doesNotMatch(log, /secret/);
  assert.doesNotMatch(log, /eyJ/);

  const successLogPath = join(dir, 'success-debug.log');
  const success = await runLoginCommand({
    login: async () => ({
      summary: 'Authenticated as user 115.'
    }),
    createRecorder: () => createAuthDiagnosticsRecorder({
      attemptId: 'attempt-success',
      logPath: successLogPath
    }),
    stdout: () => {},
    stderr: () => {}
  });

  assert.equal(success.ok, true);
  assert.equal(existsSync(successLogPath), false);
});

test('setup-user parser supports login flags', () => {
  assert.deepEqual(parseSetupUserArgs(['--login']), { loginMode: 'required' });
  assert.deepEqual(parseSetupUserArgs(['--no-login']), { loginMode: 'skip' });
  assert.deepEqual(parseSetupUserArgs([]), { loginMode: 'prompt' });
  assert.throws(() => parseSetupUserArgs(['--unknown']), /Unknown setup-user option/);
});

test('setup-user runtime installs dependencies before linking global binaries', async () => {
  const calls = [];
  let printedLinkResult = null;
  let printedCleanupResult = null;

  await installUserRuntime({
    options: { loginMode: 'skip' },
    sourceDir: '/tmp/source-logwork-helper',
    targetDir: '/tmp/target-logwork-helper',
    mkdirFn: async () => calls.push('mkdir'),
    copyFn: async () => calls.push('copy'),
    cleanupFn: async () => {
      calls.push('cleanup');
      return { changed: false, changes: [] };
    },
    installFn: async () => calls.push('install'),
    linkFn: async () => {
      calls.push('link');
      return {
        linked: true,
        commandAvailable: true
      };
    },
    authFn: async () => {
      calls.push('auth');
      return null;
    },
    printFn: async (targetDir, authResult, linkResult, cleanupResult) => {
      calls.push('print');
      printedLinkResult = linkResult;
      printedCleanupResult = cleanupResult;
    }
  });

  assert.deepEqual(calls, ['mkdir', 'copy', 'cleanup', 'install', 'link', 'auth', 'print']);
  assert.deepEqual(printedLinkResult, {
    linked: true,
    commandAvailable: true
  });
  assert.deepEqual(printedCleanupResult, {
    changed: false,
    changes: []
  });
});

test('setup-user cleanup removes stale local self tarball dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-stale-metadata-'));
  const packagePath = join(dir, 'package.json');
  const lockPath = join(dir, 'package-lock.json');
  const stale = 'file:logwork-helper-0.1.5.tgz';
  await import('node:fs/promises').then(async ({ writeFile }) => {
    await writeFile(packagePath, JSON.stringify({
      name: 'logwork-helper',
      dependencies: {
        '@clack/prompts': '^1.5.0',
        'logwork-helper': stale
      }
    }, null, 2));
    await writeFile(lockPath, JSON.stringify({
      name: 'logwork-helper',
      packages: {
        '': {
          dependencies: {
            '@clack/prompts': '^1.5.0',
            'logwork-helper': stale
          }
        },
        'node_modules/logwork-helper': {
          version: stale
        }
      },
      dependencies: {
        'logwork-helper': {
          version: stale
        },
        'node_modules/logwork-helper': {
          version: stale
        }
      }
    }, null, 2));
  });

  const result = await sanitizeRuntimeMetadata(dir);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const lockJson = JSON.parse(readFileSync(lockPath, 'utf8'));

  assert.equal(result.changed, true);
  assert.equal(packageJson.dependencies['logwork-helper'], undefined);
  assert.equal(lockJson.packages[''].dependencies['logwork-helper'], undefined);
  assert.equal(lockJson.packages['node_modules/logwork-helper'], undefined);
  assert.equal(lockJson.dependencies['logwork-helper'], undefined);
  assert.equal(lockJson.dependencies['node_modules/logwork-helper'], undefined);
});

test('setup-user cleanup leaves clean metadata unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-clean-metadata-'));
  const packagePath = join(dir, 'package.json');
  const text = JSON.stringify({
    name: 'logwork-helper',
    dependencies: {
      '@clack/prompts': '^1.5.0'
    }
  }, null, 2);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(packagePath, text));

  const result = await sanitizeRuntimeMetadata(dir);

  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  assert.equal(readFileSync(packagePath, 'utf8'), text);
});

test('global binary link failure is reported without throwing', async () => {
  const calls = [];
  const result = await linkGlobalBinaries('/tmp/logwork-helper', {
    runner: async (command, args) => {
      calls.push([command, args]);
      throw new Error('EACCES: permission denied');
    },
    commandFinder: async () => true
  });

  assert.deepEqual(calls, [['npm', ['link']]]);
  assert.equal(result.linked, false);
  assert.equal(result.commandAvailable, false);
  assert.match(result.error, /EACCES/);
});

test('global binary link warns when logwork is not visible on PATH', async () => {
  const calls = [];
  const result = await linkGlobalBinaries('/tmp/logwork-helper', {
    runner: async (command, args) => {
      calls.push([command, args]);
    },
    commandFinder: async () => false
  });

  assert.deepEqual(calls, [['npm', ['link']]]);
  assert.equal(result.linked, true);
  assert.equal(result.commandAvailable, false);
  assert.match(result.warning, /not visible on PATH/);
});

test('setup-user output explains terminal commands and fallback install', () => {
  assert.match(formatTerminalCommandInstructions({
    linked: true,
    commandAvailable: true
  }), /Terminal commands installed:\n  logwork\n  logwork-helper auth login/);

  assert.match(formatTerminalCommandInstructions({
    linked: false,
    commandAvailable: false,
    error: 'ELINKGLOBAL'
  }), /Fallback:\n  npm install -g logwork-helper/);
  assert.doesNotMatch(formatTerminalCommandInstructions({
    linked: false,
    commandAvailable: false,
    error: 'ELINKGLOBAL'
  }), /npm link --global/);
});

test('setup-user checklist omits auth retry after successful login', () => {
  const output = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    authResult: { ok: true },
    linkResult: {
      linked: true,
      commandAvailable: true
    },
    cleanupResult: {
      changed: false,
      changes: []
    }
  });

  assert.match(output, /Install status/);
  assert.match(output, /Next steps/);
  assert.match(output, /MCP config/);
  assert.match(output, /Verify/);
  assert.match(output, /Safety/);
  assert.match(output, /- Auth: completed/);
  assert.doesNotMatch(nextStepsSection(output), /logwork-helper auth login/);
  assert.match(output, /Cursor \/ Antigravity mcp_config\.json:/);
  assert.match(output, /Codex config\.toml:/);
  assert.match(output, /GitHub Copilot \/ VS Code mcp\.json:/);
  assert.match(output, /\/tmp\/target-logwork-helper\/mcp-server\.mjs/);
});

test('setup-user checklist gives auth retry only when auth is skipped or fails', () => {
  const skipped = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    authResult: null,
    linkResult: {
      linked: true,
      commandAvailable: true
    },
    cleanupResult: {
      changed: false,
      changes: []
    }
  });

  assert.match(skipped, /- Auth: not run/);
  assert.match(nextStepsSection(skipped), /logwork-helper auth login/);

  const failed = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    authResult: {
      ok: false,
      error: `Invalid password=secret accessToken=${makeJwt()}`
    },
    linkResult: {
      linked: true,
      commandAvailable: true
    },
    cleanupResult: {
      changed: false,
      changes: []
    }
  });

  assert.match(failed, /- Auth: not completed/);
  assert.match(failed, /password=<redacted>/);
  assert.doesNotMatch(failed, /password=secret/);
  assert.doesNotMatch(failed, /eyJ/);
  assert.match(nextStepsSection(failed), /logwork-helper auth login/);
});

test('setup-user checklist preserves link warnings and fallback install guidance', () => {
  const missingPath = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    linkResult: {
      linked: true,
      commandAvailable: false,
      warning: '`logwork` was linked, but it is not visible on PATH in this shell.'
    }
  });

  assert.match(missingPath, /Warning: `logwork` was linked, but it is not visible on PATH/);

  const failedLink = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    linkResult: {
      linked: false,
      commandAvailable: false,
      error: 'ELINKGLOBAL'
    }
  });

  assert.match(failedLink, /Terminal command link did not complete/);
  assert.match(failedLink, /Fallback:\n  npm install -g logwork-helper/);
  assert.doesNotMatch(failedLink, /npm link --global/);
});

test('manual parser defaults to REPL and keeps quick compatibility', () => {
  assert.deepEqual(parseManualArgs([]), {
    mode: 'repl',
    message: '',
    help: false
  });
  assert.deepEqual(parseManualArgs(['quick', '--message', 'Fix login bug']), {
    mode: 'quick',
    message: 'Fix login bug',
    help: false
  });
  assert.deepEqual(parseManualArgs(['--message', 'Fix login bug']), {
    mode: 'quick',
    message: 'Fix login bug',
    help: false
  });
  assert.deepEqual(parseManualArgs(['Fix login bug']), {
    mode: 'quick',
    message: 'Fix login bug',
    help: false
  });
});

test('CLI dispatcher rejects browser auth options before login', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'auth', 'login', '--browser', 'internet-explorer'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Browser auth has been removed/);
});

test('CLI dispatcher rejects removed auth record command', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'auth', 'record'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown auth command: record/);
});

test('CLI dispatcher rejects unknown commands', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'unknown-command'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: unknown-command/);
});

function makeJwt() {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: 115, exp: 1781495600 })).toString('base64url'),
    'signature'
  ].join('.');
}

function nextStepsSection(output) {
  return String(output).match(/Next steps\n([\s\S]*?)\n\nMCP config/)?.[1] || '';
}
