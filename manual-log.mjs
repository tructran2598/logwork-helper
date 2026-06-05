#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { safeJsonParse, nowIso } from './lib/util.mjs';

const helperDir = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { message, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const runDir = await fs.mkdtemp(join(tmpdir(), 'logwork-manual-'));
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const msgFile = join(runDir, 'COMMIT_EDITMSG');
  const lockFile = join(runDir, 'logwork.lock');
  const resultFile = join(runDir, 'logwork.result');
  const terminalTitle = `Logwork Helper Manual ${nonce}`;

  await fs.writeFile(msgFile, `${message || 'Work update'}\n`, 'utf8');
  await fs.writeFile(lockFile, JSON.stringify({
    nonce,
    pid: process.pid,
    created_at: nowIso(),
    manual: true
  }, null, 2), 'utf8');

  const helperArgs = [
    join(helperDir, 'logwork-helper.mjs'),
    '--repo', resolve(process.cwd()),
    '--msg-file', msgFile,
    '--lock', lockFile,
    '--result', resultFile,
    '--nonce', nonce,
    '--terminal-title', terminalTitle,
    '--close-terminal', 'false'
  ];

  const exitCode = await runNode(helperArgs);
  const result = await readResult(resultFile);

  if (!result) {
    process.exitCode = exitCode || 1;
    return;
  }

  if (result.nonce !== nonce) {
    console.error('Logwork Helper: result nonce mismatch.');
    process.exitCode = 1;
    return;
  }

  process.exitCode = result.status === CONFIG.resultValues.ok || result.status === CONFIG.resultValues.skip
    ? 0
    : 1;
}

function parseArgs(argv) {
  let message = '';
  let help = false;
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--message' || arg === '-m') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value.`);
      }
      message = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--message=')) {
      message = arg.slice('--message='.length);
      continue;
    }

    positional.push(arg);
  }

  if (!message && positional.length) {
    message = positional.join(' ');
  }

  return { message, help };
}

function runNode(args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: helperDir,
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        resolveValue(1);
        return;
      }
      resolveValue(code ?? 1);
    });
  });
}

async function readResult(resultFile) {
  try {
    const text = await fs.readFile(resultFile, 'utf8');
    return safeJsonParse(text, null);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function printHelp() {
  console.log(`Usage:
  node manual-log.mjs
  node manual-log.mjs --message "Fix login bug"
  npm run log -- "Fix login bug"

Options:
  -m, --message <text>  Default task message
  -h, --help            Show this help
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
