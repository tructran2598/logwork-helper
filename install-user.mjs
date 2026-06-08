#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { helperHome } from './lib/paths.mjs';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules'
]);

async function main() {
  const options = parseSetupUserArgs(process.argv.slice(2));
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const targetDir = helperHome();
  await fs.mkdir(targetDir, { recursive: true });
  if (resolve(sourceDir) !== resolve(targetDir)) {
    await copyDirectory(sourceDir, targetDir, sourceDir);
  }
  await installDependencies(targetDir);
  const authResult = await maybeRunAuthLogin(targetDir, options);
  printMcpInstructions(targetDir, authResult);
}

async function copyDirectory(sourceDir, targetDir, rootDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, relative(rootDir, sourcePath));

    if (entry.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      await copyDirectory(sourcePath, targetDir, rootDir);
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

function installDependencies(targetDir) {
  return new Promise((resolveValue, reject) => {
    const command = 'npm';
    resolveInstallArgs(targetDir)
      .then((args) => {
        const child = spawn(command, args, {
          cwd: targetDir,
          stdio: 'inherit'
        });

        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            resolveValue();
            return;
          }

          reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.`));
        });
      })
      .catch(reject);
  });
}

async function resolveInstallArgs(targetDir) {
  try {
    await fs.access(join(targetDir, 'package-lock.json'));
    return ['ci', '--omit=dev'];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return ['install', '--omit=dev'];
  }
}

export function parseSetupUserArgs(args = []) {
  let loginMode = 'prompt';

  for (const arg of args) {
    if (arg === '--login') {
      loginMode = 'required';
      continue;
    }
    if (arg === '--no-login') {
      loginMode = 'skip';
      continue;
    }
    throw new Error(`Unknown setup-user option: ${arg}`);
  }

  return { loginMode };
}

async function maybeRunAuthLogin(targetDir, { loginMode }) {
  if (loginMode === 'skip') {
    return null;
  }

  const shouldRun = loginMode === 'required' || await shouldPromptLogin();
  if (!shouldRun) {
    return null;
  }

  try {
    await runAuthLogin(targetDir);
    return { ok: true };
  } catch (error) {
    if (loginMode === 'required') {
      throw error;
    }
    return {
      ok: false,
      error: error.message
    };
  }
}

async function shouldPromptLogin() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const { confirm, isCancel } = await import('@clack/prompts');
  const { getStoredAuthStatus } = await import('./lib/auth.mjs');
  const status = await getStoredAuthStatus().catch(() => ({ authenticated: false }));
  if (status.authenticated) {
    return false;
  }

  const answer = await confirm({
    message: 'Log in to Resource Optimiser now?',
    initialValue: true
  });
  if (isCancel(answer)) {
    return false;
  }

  return Boolean(answer);
}

function runAuthLogin(targetDir) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(process.execPath, [resolve(targetDir, 'auth-cli.mjs'), 'login'], {
      cwd: targetDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        LOGWORK_HELPER_HOME: targetDir
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveValue();
        return;
      }
      reject(new Error(`Resource Optimiser auth login failed with exit code ${code}.`));
    });
  });
}

function printMcpInstructions(targetDir, authResult = null) {
  const serverPath = resolve(targetDir, 'mcp-server.mjs');
  console.log(`\nLogwork Helper installed to ${targetDir}.\n`);
  if (authResult?.ok) {
    console.log('Resource Optimiser authentication completed.');
    console.log('');
  } else if (authResult?.ok === false) {
    console.log(`Resource Optimiser authentication did not complete: ${authResult.error}`);
    console.log('Retry later with:');
    console.log('  logwork-helper auth login');
    console.log('');
  }
  console.log('Authenticate Resource Optimiser:');
  console.log('  logwork-helper auth login');
  console.log('');
  console.log('Cursor / Antigravity MCP config:');
  console.log(JSON.stringify({
    mcpServers: {
      'logwork-helper': {
        command: 'node',
        args: [serverPath]
      }
    }
  }, null, 2));
  console.log('\nCodex config.toml:');
  console.log(`[mcp_servers.logwork-helper]\ncommand = "node"\nargs = ["${serverPath}"]`);
  console.log('\nGitHub Copilot / VS Code mcp.json:');
  console.log(JSON.stringify({
    servers: {
      logworkHelper: {
        type: 'stdio',
        command: 'node',
        args: [serverPath]
      }
    }
  }, null, 2));
  console.log('\nOptional Git hook install:');
  console.log(`  ${resolve(targetDir, 'setup.sh')} /path/to/project-repo`);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
