#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperHome } from './lib/paths.mjs';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules'
]);

async function main() {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const targetDir = helperHome();
  await fs.mkdir(targetDir, { recursive: true });
  await copyDirectory(sourceDir, targetDir, sourceDir);
  await installDependencies(targetDir);
  printMcpInstructions(targetDir);
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
    const args = ['ci'];
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
  });
}

function printMcpInstructions(targetDir) {
  const serverPath = resolve(targetDir, 'mcp-server.mjs');
  console.log(`\nLogwork Helper installed to ${targetDir}.\n`);
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

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
