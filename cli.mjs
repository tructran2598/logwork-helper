#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageVersion } from './lib/package-info.mjs';

const helperDir = dirname(fileURLToPath(import.meta.url));

const COMMANDS = new Map([
  ['setup-user', {
    script: 'install-user.mjs',
    description: 'Install Logwork Helper and print the onboarding checklist plus MCP configs.',
    help: `Usage:
  logwork-helper setup-user [--login|--no-login]

Installs the local helper runtime, links terminal commands, prints MCP configs, and shows the next verification steps.

Options:
  --login     Run Resource Optimiser auth login after installing
  --no-login  Do not prompt for auth login after installing

After setup:
  1. Authenticate if setup did not complete auth for you.
  2. Paste one printed MCP config into your IDE.
  3. Restart or reload the IDE MCP tools.
  4. Ask: Check my logwork for this week.`
  }],
  ['install-user', {
    script: 'install-user.mjs',
    description: 'Alias for setup-user.'
  }],
  ['mcp', {
    script: 'mcp-server.mjs',
    description: 'Run the local MCP stdio server.'
  }],
  ['auth', {
    script: 'auth-cli.mjs',
    description: 'Manage Resource Optimiser authentication.',
    help: `Usage:
  logwork-helper auth login
  logwork-helper auth status
  logwork-helper auth logout

Authentication uses the Resource Optimiser / Keycloak API flow and does not open a browser.`
  }],
  ['diagnostics', {
    script: 'diagnostics-cli.mjs',
    description: 'Write a sanitized support diagnostics report.',
    help: `Usage:
  logwork-helper diagnostics

Writes a sanitized support report under the local helper diagnostics directory.
Send only the generated file to developers; do not send raw curl logs, cookies, passwords, OTPs, or tokens.`
  }],
  ['doctor', {
    script: 'diagnostics-cli.mjs',
    description: 'Alias for diagnostics; write a sanitized setup health report.',
    help: `Usage:
  logwork-helper doctor

Runs the same checks as diagnostics and writes a sanitized support report under the local helper diagnostics directory.
Send only the generated file to developers; do not send raw curl logs, cookies, passwords, OTPs, or tokens.`
  }],
  ['manual', {
    script: 'manual-log.mjs',
    description: 'Open the manual terminal logwork REPL.',
    help: `Usage:
  logwork
  logwork-helper manual
  logwork-helper manual quick --message "Task name"

Preferred shortcut:
  logwork

Commands inside the REPL:
  Type / for live command suggestions.
  /help
  /query today
  /query this-week
  /logwork
  /mcp
  /projects
  /projects 5234
  /map SCB 5234
  /diagnostics
  Press Esc to exit`
  }],
  ['log', {
    script: 'manual-log.mjs',
    description: 'Alias for manual terminal REPL.'
  }],
  ['install-hook', {
    script: 'install.mjs',
    description: 'Install the commit-msg hook into a Git repository.'
  }],
  ['install', {
    script: 'install.mjs',
    description: 'Alias for install-hook.'
  }],
  ['hook', {
    script: 'logwork-helper.mjs',
    description: 'Run the commit-msg hook helper.'
  }]
]);

async function main() {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    printHelp();
    return;
  }

  if (firstArg === '--version' || firstArg === '-v') {
    console.log(readPackageVersion());
    return;
  }

  const command = COMMANDS.get(firstArg);
  if (command) {
    const commandArgs = argv.slice(1);
    if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
      printCommandHelp(firstArg, command);
      return;
    }

    process.exitCode = await runScript(command.script, commandArgs);
    return;
  }

  if (firstArg.startsWith('--')) {
    process.exitCode = await runScript('logwork-helper.mjs', argv);
    return;
  }

  console.error(`Unknown command: ${firstArg}`);
  console.error('');
  printHelp();
  process.exitCode = 1;
}

function runScript(script, args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(process.execPath, [join(helperDir, script), ...args], {
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

function printHelp() {
  console.log(`Usage:
  logwork-helper setup-user
  logwork-helper auth login
  logwork-helper diagnostics
  logwork-helper doctor
  logwork-helper mcp
  logwork
  logwork-helper manual
  logwork-helper manual quick --message "Task name"
  logwork-helper install-hook /path/to/repo
  logwork-helper hook --repo <repo> --msg-file <file> --lock <file> --result <file> --nonce <id> --terminal-title <title>

Primary setup:
  1. Run: logwork-helper setup-user
  2. Paste one printed MCP config into your IDE.
  3. Restart or reload the IDE MCP tools.
  4. Ask: Check my logwork for this week.

Commands:
${formatCommands()}

Options:
  -h, --help     Show help
  -v, --version  Show version
`);
}

function printCommandHelp(name, command) {
  if (command.help) {
    console.log(`${command.help}\n`);
    return;
  }

  console.log(`Usage:
  logwork-helper ${name}

${command.description}
`);
}

function formatCommands() {
  return [...COMMANDS.entries()]
    .map(([name, command]) => `  ${name.padEnd(13)} ${command.description}`)
    .join('\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
