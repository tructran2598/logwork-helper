#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';

const MARKER = 'Logwork Helper managed commit-msg hook';

async function main() {
  const { dryRun, repoArg } = parseInstallArgs(process.argv.slice(2));
  const requestedRepo = resolve(repoArg || process.cwd());
  const helperDir = dirname(fileURLToPath(import.meta.url));

  const repoRoot = await git(requestedRepo, ['rev-parse', '--show-toplevel']);
  const hooksDir = await git(repoRoot, ['rev-parse', '--git-path', 'hooks']);
  const hooksPath = resolve(repoRoot, hooksDir);
  const hookPath = resolve(hooksPath, 'commit-msg');

  let existingHook = '';
  const existing = await readIfExists(hookPath);
  if (existing && !existing.includes(MARKER)) {
    const backupPath = resolve(hooksPath, `commit-msg.logwork-backup.${timestampForFile()}`);
    existingHook = backupPath;

    if (!dryRun) {
      await fs.mkdir(hooksPath, { recursive: true });
      await fs.rename(hookPath, backupPath);
    }
  }

  const templatePath = resolve(helperDir, 'hooks', 'commit-msg.template');
  const template = await fs.readFile(templatePath, 'utf8');
  const hook = template
    .replaceAll('__NODE_BIN__', process.execPath)
    .replaceAll('__HELPER_DIR__', helperDir)
    .replaceAll('__EXISTING_HOOK__', existingHook)
    .replaceAll('__HOOK_TIMEOUT_MS__', String(CONFIG.hookTimeoutMs))
    .replaceAll('__POLL_MS__', String(CONFIG.pollMs));

  if (!dryRun) {
    await fs.mkdir(hooksPath, { recursive: true });
    await fs.writeFile(hookPath, hook, { encoding: 'utf8', mode: 0o755 });
    await fs.chmod(hookPath, 0o755);
  }

  if (dryRun) {
    console.log(`Dry run: would install Logwork Helper commit-msg hook into ${repoRoot}.`);
    if (existingHook) {
      console.log(`Dry run: would back up existing commit-msg hook to ${existingHook}.`);
    }
    return;
  }

  console.log(`Installed Logwork Helper commit-msg hook into ${repoRoot}.`);
}

function parseInstallArgs(argv) {
  let dryRun = false;
  let repoArg = '';

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (repoArg) {
      throw new Error('Expected at most one repo path argument.');
    }

    repoArg = arg;
  }

  return { dryRun, repoArg };
}

function git(cwd, args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveValue(stdout.trim());
        return;
      }

      reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
    });
  });
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
