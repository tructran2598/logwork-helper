import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLoginArgs } from '../auth-cli.mjs';
import {
  formatTerminalCommandInstructions,
  installUserRuntime,
  linkGlobalBinaries,
  parseSetupUserArgs
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
});

test('CLI dispatcher prints command help without executing setup', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'setup-user', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /setup-user \[--login\|--no-login\]/);
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

test('setup-user parser supports login flags', () => {
  assert.deepEqual(parseSetupUserArgs(['--login']), { loginMode: 'required' });
  assert.deepEqual(parseSetupUserArgs(['--no-login']), { loginMode: 'skip' });
  assert.deepEqual(parseSetupUserArgs([]), { loginMode: 'prompt' });
  assert.throws(() => parseSetupUserArgs(['--unknown']), /Unknown setup-user option/);
});

test('setup-user runtime installs dependencies before linking global binaries', async () => {
  const calls = [];
  let printedLinkResult = null;

  await installUserRuntime({
    options: { loginMode: 'skip' },
    sourceDir: '/tmp/source-logwork-helper',
    targetDir: '/tmp/target-logwork-helper',
    mkdirFn: async () => calls.push('mkdir'),
    copyFn: async () => calls.push('copy'),
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
    printFn: async (targetDir, authResult, linkResult) => {
      calls.push('print');
      printedLinkResult = linkResult;
    }
  });

  assert.deepEqual(calls, ['mkdir', 'copy', 'install', 'link', 'auth', 'print']);
  assert.deepEqual(printedLinkResult, {
    linked: true,
    commandAvailable: true
  });
});

test('global binary link failure is reported without throwing', async () => {
  const result = await linkGlobalBinaries('/tmp/logwork-helper', {
    runner: async () => {
      throw new Error('EACCES: permission denied');
    },
    commandFinder: async () => true
  });

  assert.equal(result.linked, false);
  assert.equal(result.commandAvailable, false);
  assert.match(result.error, /EACCES/);
});

test('global binary link warns when logwork is not visible on PATH', async () => {
  const result = await linkGlobalBinaries('/tmp/logwork-helper', {
    runner: async () => {},
    commandFinder: async () => false
  });

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
    error: 'EACCES'
  }), /Fallback:\n  npm install -g logwork-helper/);
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
