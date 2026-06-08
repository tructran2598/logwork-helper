import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseLoginArgs } from '../auth-cli.mjs';
import { parseSetupUserArgs } from '../install-user.mjs';

test('CLI dispatcher prints top-level help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper setup-user/);
  assert.match(result.stdout, /logwork-helper auth login/);
  assert.match(result.stdout, /logwork-helper mcp/);
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
