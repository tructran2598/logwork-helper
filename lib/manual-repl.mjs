import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { confirm, isCancel } from '@clack/prompts';
import { getStoredAuthStatus, loginResourceOptimiser } from './auth.mjs';
import { isAuthRequiredError } from './auth-errors.mjs';
import { applyLogworkBatch, previewLogworkBatch } from './batch-workflow.mjs';
import {
  buildLogworkText,
  buildProjectOverrides,
  formatHours,
  parseTaskLine
} from './manual-logwork-wizard.mjs';
import { findManualCommand, formatManualHelp } from './manual-commands.mjs';
import {
  buildManualApplyConfirmation,
  buildManualUnbookedConfirmation,
  getManualApplyBlocker,
  manualUnbookedEntryCount
} from './manual-apply-state.mjs';
import { runManualInkApp } from './manual-ink-app.mjs';
import { createManualLineReader } from './manual-input.mjs';
import { generateDiagnosticsReport } from './diagnostics.mjs';
import { listLogworkProjects, upsertProjectMapping } from './project-mapping-workflow.mjs';
import { queryLogwork } from './query-workflow.mjs';
import {
  projectIdentityKey,
  projectMatchesFilter,
  sameProjectIdentity
} from './project-identity.mjs';

export const MANUAL_HELP = formatManualHelp();

export function createManualSession() {
  return {
    lastPreview: null,
    logworkDraft: null
  };
}

export async function runManualRepl({
  input = defaultInput,
  output = defaultOutput,
  cwd = process.cwd(),
  workflows = defaultWorkflows(),
  prompts = createManualPrompts(),
  showIntro = true
} = {}) {
  if (input?.isTTY && output?.isTTY) {
    await runManualInkApp({
      input,
      output,
      cwd,
      workflows,
      controller: {
        createManualSession,
        executeManualCommand,
        parseManualCommand
      },
      showIntro
    });
    return;
  }

  const lineReader = createManualLineReader({
    input,
    output
  });
  const session = createManualSession();
  const context = {
    cwd,
    workflows,
    prompts,
    print(message = '') {
      output.write(`${message}\n`);
    },
    readLine(prompt = '') {
      return lineReader.readLine(prompt);
    }
  };

  try {
    if (showIntro) {
      context.print('Logwork Helper manual session. Type /help for commands.');
    }

    while (true) {
      let line;
      try {
        line = await context.readLine('logwork> ');
      } catch (error) {
        if (error.code === 'ERR_USE_AFTER_CLOSE' || /closed|end of input|EOF/i.test(error.message)) {
          break;
        }
        throw error;
      }
      let command;
      try {
        command = parseManualCommand(line);
        const result = await executeManualCommand(command, session, context);
        if (result.exit) {
          break;
        }
      } catch (error) {
        context.print(`Error: ${error.message}`);
      }
    }
  } finally {
    lineReader.close();
  }
}

export function parseManualCommand(line) {
  const input = String(line || '').trim();
  if (!input) {
    return { type: 'noop' };
  }

  if (!input.startsWith('/')) {
    throw new Error(`Unknown command: ${input}. Type /help for commands.`);
  }

  const [rawCommand, ...parts] = input.split(/\s+/);
  const commandInfo = findManualCommand(rawCommand);
  const command = commandInfo?.name;

  if (command === '/help') {
    return { type: 'help' };
  }

  if (command === '/auth') {
    return { type: 'auth' };
  }

  if (command === '/status') {
    return { type: 'status' };
  }

  if (command === '/diagnostics') {
    return { type: 'diagnostics' };
  }

  if (command === '/projects') {
    return {
      type: 'projects',
      project: parts.join(' ').trim() || undefined
    };
  }

  if (command === '/logwork') {
    return {
      type: 'logwork',
      text: parts.join(' ').trim() || undefined
    };
  }

  if (command === '/apply') {
    return { type: 'apply' };
  }

  if (command === '/query') {
    return {
      type: 'query',
      args: parseQueryArgs(parts.join(' ').trim())
    };
  }

  if (command === '/map') {
    return parseMapCommand(parts);
  }

  throw new Error(`Unknown command: ${rawCommand}. Type /help for commands.`);
}

export async function executeManualCommand(command, session, context) {
  const {
    cwd = process.cwd(),
    workflows = defaultWorkflows(),
    prompts = createManualPrompts(),
    print = console.log,
    readLine
  } = context;

  if (command.type === 'noop') {
    return { exit: false };
  }

  if (command.type === 'help') {
    print(MANUAL_HELP);
    return { exit: false };
  }

  if (command.type === 'auth') {
    const result = await workflows.loginResourceOptimiser();
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'status') {
    const result = await workflows.getStoredAuthStatus();
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'diagnostics') {
    const result = await workflows.generateDiagnosticsReport({ cwd });
    print(result.summary);
    print('Send this sanitized file to the developer. Do not send raw curl logs, cookies, passwords, OTPs, or tokens.');
    return { exit: false };
  }

  if (command.type === 'query') {
    const result = await runWithInlineAuth(() => workflows.queryLogwork({
      ...command.args,
      cwd,
      includeEntries: true
    }), { workflows, print });
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'projects') {
    const result = await runWithInlineAuth(async () => {
      const projectsResult = await workflows.listLogworkProjects({ cwd });
      const weekly = await workflows.queryLogwork({
        period: 'this_week',
        project: command.project,
        cwd,
        includeEntries: false
      });
      return { projectsResult, weekly };
    }, { workflows, print });
    print(formatProjects(result.projectsResult, result.weekly, command.project));
    return { exit: false };
  }

  if (command.type === 'map') {
    const ok = await prompts.confirm(`Map ${command.tickets.join(', ')} to projectMemberId ${command.projectMemberId}?`);
    if (!ok) {
      print('Mapping cancelled.');
      return { exit: false };
    }

    const result = await runWithInlineAuth(() => workflows.upsertProjectMapping({
      projectMemberId: command.projectMemberId,
      tickets: command.tickets,
      keywords: [],
      scope: 'user',
      confirm: true,
      cwd
    }), { workflows, print });
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'logwork') {
    const text = command.text || await readPasteBlock({ readLine, print });
    const preview = await runWithInlineAuth(() => workflows.previewLogworkBatch({
      text,
      projectOverrides: command.projectOverrides || {},
      cwd
    }), { workflows, print });
    session.lastPreview = preview;
    print(preview.summary);
    return { exit: false };
  }

  if (command.type === 'apply') {
    const blocker = getManualApplyBlocker(session.lastPreview);
    if (blocker) {
      print(blocker);
      return { exit: false };
    }

    const confirmed = await prompts.confirm(buildManualApplyConfirmation(session.lastPreview));
    if (!confirmed) {
      print('Apply cancelled.');
      return { exit: false };
    }

    let allowUnbooked = false;
    if (manualUnbookedEntryCount(session.lastPreview)) {
      allowUnbooked = await prompts.confirm(buildManualUnbookedConfirmation(session.lastPreview));
      if (!allowUnbooked) {
        print('Apply cancelled because unbooked entries were not approved.');
        return { exit: false };
      }
    }

    const result = await runWithInlineAuth(() => workflows.applyLogworkBatch({
      batch: session.lastPreview,
      confirm: true,
      allowUnbooked,
      cwd
    }), { workflows, print });
    print(result.summary);
    if (result.verification?.summary) {
      print('');
      print(result.verification.summary);
    }
    session.lastPreview = null;
    session.logworkDraft = null;
    return { exit: false };
  }

  throw new Error(`Unsupported command type: ${command.type}`);
}

export function createManualPrompts() {
  return {
    async confirm(message, initialValue = true) {
      const answer = await confirm({
        message,
        initialValue
      });
      if (isCancel(answer)) {
        throw new Error('User cancelled Logwork Helper manual session.');
      }
      return Boolean(answer);
    }
  };
}

async function readPasteBlock({ readLine, print }) {
  if (typeof readLine !== 'function') {
    throw new Error('/logwork requires an interactive terminal.');
  }

  print('Paste weekly logwork text. Finish with /end on its own line.');
  const lines = [];
  while (true) {
    const line = await readLine('');
    if (line.trim() === '/end') {
      break;
    }
    lines.push(line);
  }

  const text = lines.join('\n').trim();
  if (!text) {
    throw new Error('Preview text is empty.');
  }
  return text;
}

export async function previewManualLogworkDraft({
  date,
  project,
  tasks,
  cwd = process.cwd(),
  workflows = defaultWorkflows(),
  print = console.log
}) {
  const text = buildLogworkText({ date, tasks });
  const projectOverrides = buildProjectOverrides({
    date,
    tasks,
    projectMemberId: project.projectMemberId
  });
  return runWithInlineAuth(() => workflows.previewLogworkBatch({
    text,
    projectOverrides,
    cwd
  }), { workflows, print });
}

export function addDraftTask({ draft, line }) {
  const task = parseTaskLine(line);
  return {
    ...draft,
    tasks: [...(draft.tasks || []), task]
  };
}

export function removeDraftTask({ draft, index }) {
  const taskIndex = Number(index) - 1;
  if (!Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= (draft.tasks || []).length) {
    throw new Error(`No task found at index ${index}.`);
  }
  return {
    ...draft,
    tasks: draft.tasks.filter((_, currentIndex) => currentIndex !== taskIndex)
  };
}

async function runWithInlineAuth(action, { workflows, print }) {
  try {
    return await action();
  } catch (error) {
    if (!isAuthRequiredError(error)) {
      throw error;
    }
    print('Resource Optimiser authentication required. Starting terminal auth...');
    const result = await workflows.loginResourceOptimiser();
    print(result.summary);
    return action();
  }
}

function parseQueryArgs(value) {
  if (!value || value === 'today') {
    return { period: 'today' };
  }

  if (value === 'this-week' || value === 'this_week' || value === 'week') {
    return { period: 'this_week' };
  }

  const range = value.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range) {
    return {
      from: range[1],
      to: range[2]
    };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value };
  }

  throw new Error('Usage: /query today | this-week | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD');
}

function parseMapCommand(parts) {
  if (parts.length < 2) {
    throw new Error('Usage: /map <TICKET_PREFIX[,PREFIX...]> <projectMemberId>');
  }

  const tickets = parts[0]
    .split(',')
    .map((ticket) => ticket.trim().toUpperCase())
    .filter(Boolean);
  const projectMemberId = parts[1];

  if (!tickets.length || !projectMemberId) {
    throw new Error('Usage: /map <TICKET_PREFIX[,PREFIX...]> <projectMemberId>');
  }

  return {
    type: 'map',
    tickets,
    projectMemberId
  };
}

export function formatProjects(result, weekly = null, projectFilter = undefined) {
  const lines = [result.summary];
  const projects = filterProjects(result.projects || [], projectFilter);
  const chartedProjectKeys = new Set();
  const chartBlocks = formatWeeklyProjectCharts(projects, weekly, projectFilter, chartedProjectKeys);

  if (chartBlocks.length) {
    lines.push('');
    lines.push('This week:');
    lines.push(...chartBlocks);
  } else if (projectFilter) {
    lines.push('');
    lines.push(`No weekly booking/logwork chart found for "${projectFilter}".`);
  }

  const otherProjects = projects.filter((project) => !chartedProjectKeys.has(projectIdentityKey(project)));
  if (otherProjects.length) {
    lines.push('');
    lines.push(chartBlocks.length ? 'Other memberships:' : 'Projects:');
    for (const project of otherProjects) {
      lines.push(`- ${project.projectMemberId}: ${project.projectName} (projectId: ${project.projectId ?? 'unknown'})`);
    }
  }

  if (result.mappings?.length) {
    lines.push('');
    lines.push('Mappings:');
    for (const mapping of result.mappings) {
      lines.push(`- ${mapping.tickets.join(', ')} -> ${mapping.projectName}${mapping.projectMemberId ? ` (${mapping.projectMemberId})` : ''}`);
    }
  }

  return lines.join('\n');
}

export function formatWeeklyProjectCharts(projects, weekly, projectFilter, chartedProjectKeys = new Set()) {
  if (!weekly?.projects?.length) {
    return [];
  }

  const lines = [];
  const weeklyProjects = weekly.projects.filter((project) => (
    !projectFilter || projectMatchesFilter(project, projectFilter)
  ));

  for (const weeklyProject of weeklyProjects) {
    const membership = projects.find((project) => sameProjectIdentity(project, weeklyProject)) || weeklyProject;
    const key = projectIdentityKey(membership);
    chartedProjectKeys.add(key);
    if (lines.length) {
      lines.push('');
    }
    lines.push(...formatProjectChart({
      project: {
        ...membership,
        bookedHours: weeklyProject.bookedHours,
        loggedHours: weeklyProject.loggedHours
      },
      days: projectDays(weekly?.days || [], weeklyProject)
    }));
  }

  return lines;
}

export function formatProjectChart({ project, days = [], width = 20 }) {
  const bookedHours = Number(project.bookedHours || 0);
  const loggedHours = Number(project.loggedHours || 0);
  const ratio = bookedHours > 0 ? loggedHours / bookedHours : (loggedHours > 0 ? 1 : 0);
  const filled = Math.max(0, Math.min(width, Math.round(Math.min(ratio, 1) * width)));
  const percent = bookedHours > 0 ? `${Math.round(ratio * 100)}%` : (loggedHours > 0 ? 'unbooked' : '0%');
  const over = bookedHours > 0 && loggedHours > bookedHours
    ? ` (+${formatHours(loggedHours - bookedHours)}h over)`
    : '';

  return [
    project.projectName,
    `memberId: ${project.projectMemberId ?? 'unknown'} · projectId: ${project.projectId ?? 'unknown'}`,
    `This week: ${formatHours(loggedHours)}h logged / ${formatHours(bookedHours)}h booked${over}`,
    `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${percent}`,
    formatDayChips(days)
  ];
}

function projectDays(days, project) {
  return days
    .map((day) => {
      const matching = (day.projects || []).find((candidate) => sameProjectIdentity(candidate, project));
      if (!matching) {
        return null;
      }
      return {
        date: day.date,
        bookedHours: matching.bookedHours,
        loggedHours: matching.loggedHours
      };
    })
    .filter(Boolean);
}

function formatDayChips(days) {
  if (!days.length) {
    return 'No booking/logwork found this week.';
  }

  return days.map((day) => (
    `${weekdayName(day.date)} ${formatHours(day.loggedHours)}/${formatHours(day.bookedHours)}`
  )).join('  ');
}

function weekdayName(localDateISO) {
  const [year, month, day] = String(localDateISO).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()] || localDateISO;
}

function filterProjects(projects, projectFilter) {
  if (!projectFilter) {
    return projects;
  }
  return projects.filter((project) => projectMatchesFilter(project, projectFilter));
}

function defaultWorkflows() {
  return {
    queryLogwork,
    previewLogworkBatch,
    applyLogworkBatch,
    listLogworkProjects,
    upsertProjectMapping,
    loginResourceOptimiser,
    getStoredAuthStatus,
    generateDiagnosticsReport
  };
}
