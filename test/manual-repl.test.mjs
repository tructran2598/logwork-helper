import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToString } from 'ink';
import {
  addDraftTask,
  createManualSession,
  executeManualCommand,
  formatProjectChart,
  formatProjects,
  previewManualLogworkDraft,
  parseManualCommand
} from '../lib/manual-repl.mjs';
import {
  buildLogworkText,
  buildProjectOptions,
  buildProjectOverrides,
  buildWeekDateOptions,
  canApplyPreview,
  formatDraftPreview,
  parseTaskLine,
  removeDraftTasks,
  replaceDraftTask,
  toggleTaskSelection
} from '../lib/manual-logwork-wizard.mjs';
import { createAuthRequiredError } from '../lib/auth-errors.mjs';
import {
  formatManualHelp,
  getCommandSuggestions,
  renderCommandSuggestions,
  TASK_COMMANDS
} from '../lib/manual-commands.mjs';
import {
  deleteManualDraft,
  formatManualDraftLabel,
  loadManualDrafts,
  saveManualDraft
} from '../lib/manual-drafts.mjs';
import {
  AuthPrompt,
  CurrentPanel,
  createInkCredentialProvider,
  DatePicker,
  DraftPicker,
  HeaderBar,
  OutputPanel,
  ProjectPicker,
  ProjectChart,
  SlashMenu,
  StatusBar,
  TaskEditPicker,
  TaskRemovePicker
} from '../lib/manual-ink-app.mjs';
import {
  StatusBar as DirectStatusBar,
  commandItems,
  loadingMessageForCommand,
  sameProjectIdentity
} from '../lib/manual-ink-ui.mjs';
import {
  AuthPrompt as DirectAuthPrompt
} from '../lib/manual-ink-auth.mjs';

const h = React.createElement;

test('manual command registry renders help and slash suggestions', () => {
  assert.match(formatManualHelp(), /\/query today/);
  assert.match(formatManualHelp(), /\/logwork/);
  assert.match(formatManualHelp(), /\/diagnostics/);
  assert.doesNotMatch(formatManualHelp(), /\/apply/);
  assert.doesNotMatch(formatManualHelp(), /\/exit|\/quit/);
  assert.doesNotMatch(formatManualHelp(), /\/preview/);
  assert.match(formatManualHelp(), /\/projects \[projectMemberId\|projectId\|name\]/);
  assert.deepEqual(getCommandSuggestions('/q').map((command) => command.name), ['/query']);
  assert.deepEqual(getCommandSuggestions('/lo').map((command) => command.name), ['/logwork']);
  assert.deepEqual(getCommandSuggestions('/ap').map((command) => command.name), []);
  assert.deepEqual(getCommandSuggestions('/e').map((command) => command.name), []);
  assert.deepEqual(getCommandSuggestions('/pre').map((command) => command.name), []);
  assert.deepEqual(getCommandSuggestions('/pro').map((command) => command.name), ['/projects']);
  assert.deepEqual(getCommandSuggestions('/di').map((command) => command.name), ['/diagnostics']);
  assert.match(renderCommandSuggestions('/pro'), /\/projects\s+List projects with weekly booked\/logged chart/);
  assert.deepEqual(getCommandSuggestions('/a', TASK_COMMANDS).map((command) => command.name), []);
  assert.deepEqual(getCommandSuggestions('/s', TASK_COMMANDS).map((command) => command.name), ['/save']);
  assert.deepEqual(getCommandSuggestions('/d', TASK_COMMANDS).map((command) => command.name), ['/drafts', '/diagnostics']);
  assert.deepEqual(getCommandSuggestions('/e', TASK_COMMANDS).map((command) => command.name), ['/edit']);
  assert.match(renderCommandSuggestions('/re', 0, TASK_COMMANDS), /\/remove\s+Select tasks to delete/);
});

test('Ink manual components render shell, current panel, pickers, menu, status, and chart text', () => {
  assert.match(renderToString(h(HeaderBar, { cwd: '/tmp/repo' })), /Logwork Helper/);
  assert.match(renderToString(h(HeaderBar, { cwd: '/tmp/repo' })), /cwd: \/tmp\/repo/);
  assert.match(renderToString(h(SlashMenu, {
    suggestions: getCommandSuggestions('/pro'),
    selectedIndex: 0
  })), /\/projects/);
  assert.match(renderToString(h(CurrentPanel, {
    panel: { kind: 'error', title: 'Current', text: 'Something failed' }
  })), /Something failed/);
  assert.match(renderToString(h(OutputPanel, {
    items: [{ kind: 'error', text: 'Something failed' }]
  })), /Something failed/);
  assert.match(renderToString(h(StatusBar, {
    preview: readyPreview(),
    dryRun: true,
    wizard: { step: 'edit_tasks' }
  })), /mode: edit-tasks · preview: ready · 1 entries · DRY RUN/);
  assert.match(renderToString(h(StatusBar, {
    preview: null,
    dryRun: false,
    wizard: null,
    authPrompt: { step: 'credentials' }
  })), /mode: auth-credentials/);
  const authPasswordOutput = renderToString(h(AuthPrompt, {
    prompt: { step: 'credentials', field: 'password', email: 'malco' },
    inputValue: 'secret-password',
    onInputChange() {},
    onPromptChange() {},
    onResolve() {},
    onReject() {}
  }));
  assert.match(authPasswordOutput, /password/);
  assert.doesNotMatch(authPasswordOutput, /secret-password/);
  const authOtpOutput = renderToString(h(AuthPrompt, {
    prompt: { step: 'otp' },
    inputValue: '123456',
    onInputChange() {},
    onPromptChange() {},
    onResolve() {},
    onReject() {}
  }));
  assert.match(authOtpOutput, /2FA/);
  assert.doesNotMatch(authOtpOutput, /123456/);
  assert.match(renderToString(h(AuthPrompt, {
    prompt: {
      step: 'device',
      selectedIndex: 0,
      devices: [{ label: 'iPhone' }, { label: '14 PRM' }]
    },
    onPromptChange() {},
    onResolve() {},
    onReject() {}
  })), /Choose 2FA device/);
  assert.match(renderToString(h(DatePicker, {
    options: buildWeekDateOptions(weeklyLogwork()),
    selectedIndex: 0,
    onChange() {},
    onSelect() {}
  })), /Pick date/);
  assert.match(renderToString(h(ProjectPicker, {
    options: buildProjectOptions({
      projectsResult: projectList(),
      weekly: weeklyLogwork(),
      date: '2026-06-01'
    }),
    selectedIndex: 0,
    onChange() {},
    onSelect() {}
  })), /Pick project/);
  const projectOptions = buildProjectOptions({
    projectsResult: projectList(),
    weekly: weeklyLogwork(),
    date: '2026-06-01'
  });
  assert.equal(projectOptions[0].booked, true);
  assert.equal(projectOptions[1].booked, false);
  assert.match(projectOptions[1].label, /UNBOOKED/);
  assert.match(renderToString(h(ProjectChart, {
    lines: [
      'Course Builder',
      '[████████████████████] 100%'
    ]
  })), /Course Builder/);
  assert.match(renderToString(h(TaskRemovePicker, {
    tasks: [
      { hours: 2, taskName: 'check ui/ux' },
      { hours: 1, taskName: 'fix copy' }
    ],
    selectedIndex: 0,
    selectedIndexes: [1],
    onChange() {},
    onToggle() {},
    onSubmit() {},
    onCancel() {}
  })), /Remove tasks/);
  assert.match(renderToString(h(TaskEditPicker, {
    tasks: [
      { hours: 2, taskName: 'check ui/ux' }
    ],
    selectedIndex: 0,
    onChange() {},
    onSelect() {},
    onCancel() {}
  })), /Edit task/);
  assert.match(renderToString(h(DraftPicker, {
    drafts: [
      savedDraftFixture()
    ],
    selectedIndex: 0,
    includeStartNew: true,
    onChange() {},
    onResume() {},
    onDelete() {},
    onStartNew() {},
    onCancel() {}
  })), /Start new logwork session/);
});

test('Ink manual app re-exports maintain UI and auth module compatibility', () => {
  assert.equal(StatusBar, DirectStatusBar);
  assert.equal(AuthPrompt, DirectAuthPrompt);
  assert.equal(loadingMessageForCommand({ type: 'query' }), 'Fetching Resource Optimiser timesheet...');
  assert.equal(sameProjectIdentity({ projectMemberId: 5234 }, { projectMemberId: '5234' }), true);
  assert.ok(commandItems().some((item) => item.value === '/query'));
  assert.match(renderToString(h(DirectStatusBar, {
    preview: null,
    dryRun: false,
    wizard: null
  })), /mode: command · preview: none/);
});

test('Ink credential provider resolves auth steps without clack prompts', async () => {
  const prompts = [];
  const panels = [];
  const inputValues = [];
  const selectedIndexes = [];
  const resolverRef = { current: null };
  const rejecterRef = { current: null };
  const provider = createInkCredentialProvider({
    resolverRef,
    rejecterRef,
    setAuthPrompt(prompt) {
      prompts.push(prompt);
    },
    setActivePanel(panel) {
      panels.push(panel);
    },
    setInputValue(value) {
      inputValues.push(value);
    },
    setSelectedIndex(value) {
      selectedIndexes.push(value);
    }
  });

  const credentialsPromise = provider.requestCredentials();
  assert.equal(prompts.at(-1).step, 'credentials');
  assert.equal(prompts.at(-1).field, 'email');
  assert.match(panels.at(-1).text, /email and password/);
  resolverRef.current({
    email: 'malco',
    password: 'not-printed'
  });
  assert.deepEqual(await credentialsPromise, {
    email: 'malco',
    password: 'not-printed'
  });

  const singleDevice = { label: 'Only phone', credentialId: 'one' };
  assert.equal(await provider.requestDeviceSelection([singleDevice]), singleDevice);

  const devices = [
    { label: 'iPhone', credentialId: 'a' },
    { label: '14 PRM', credentialId: 'b' }
  ];
  const devicePromise = provider.requestDeviceSelection(devices);
  assert.equal(prompts.at(-1).step, 'device');
  assert.equal(prompts.at(-1).devices, devices);
  resolverRef.current(devices[1]);
  assert.equal(await devicePromise, devices[1]);

  const otpPromise = provider.requestOtp();
  assert.equal(prompts.at(-1).step, 'otp');
  resolverRef.current('123456');
  assert.equal(await otpPromise, '123456');

  assert.ok(inputValues.every((value) => value === ''));
  assert.ok(selectedIndexes.every((value) => value === 0));
  assert.doesNotMatch(JSON.stringify(panels), /not-printed|123456/);
});

test('parseManualCommand supports visible commands and rejects exit aliases', () => {
  assert.deepEqual(parseManualCommand('/query today'), {
    type: 'query',
    args: { period: 'today' }
  });
  assert.deepEqual(parseManualCommand('/query this-week'), {
    type: 'query',
    args: { period: 'this_week' }
  });
  assert.deepEqual(parseManualCommand('/query 2026-06-05'), {
    type: 'query',
    args: { date: '2026-06-05' }
  });
  assert.deepEqual(parseManualCommand('/query 2026-06-01..2026-06-08'), {
    type: 'query',
    args: {
      from: '2026-06-01',
      to: '2026-06-08'
    }
  });
  assert.deepEqual(parseManualCommand('/logwork'), {
    type: 'logwork',
    text: undefined
  });
  assert.deepEqual(parseManualCommand('/diagnostics'), { type: 'diagnostics' });
  assert.deepEqual(parseManualCommand('/apply'), { type: 'apply' });
  assert.deepEqual(parseManualCommand('/projects'), {
    type: 'projects',
    project: undefined
  });
  assert.deepEqual(parseManualCommand('/projects 5234'), {
    type: 'projects',
    project: '5234'
  });
  assert.deepEqual(parseManualCommand('/map SCB,OPS 5234'), {
    type: 'map',
    tickets: ['SCB', 'OPS'],
    projectMemberId: '5234'
  });
  assert.throws(() => parseManualCommand('/exit'), /Unknown command/);
  assert.throws(() => parseManualCommand('/quit'), /Unknown command/);
  assert.throws(() => parseManualCommand('/query sometime'), /Usage: \/query/);
  assert.throws(() => parseManualCommand('/preview'), /Unknown command/);
  assert.throws(() => parseManualCommand('/unknown'), /Unknown command/);
});

test('manual query prints grouped logwork summary', async () => {
  const printed = [];
  const session = createManualSession();
  const command = parseManualCommand('/query this-week');
  const workflows = {
    queryLogwork: async (args) => {
      assert.equal(args.period, 'this_week');
      assert.equal(args.includeEntries, true);
      return {
        summary: 'Logwork from 2026-06-01 to 2026-06-08: 8h logged / 8h booked.'
      };
    }
  };

  await executeManualCommand(command, session, context({ workflows, printed }));

  assert.deepEqual(printed, ['Logwork from 2026-06-01 to 2026-06-08: 8h logged / 8h booked.']);
});

test('manual diagnostics writes support report summary', async () => {
  const printed = [];
  await executeManualCommand(parseManualCommand('/diagnostics'), createManualSession(), context({
    printed,
    workflows: {
      generateDiagnosticsReport: async () => ({
        summary: 'Diagnostics report written to /tmp/logwork-diagnostics.txt'
      })
    }
  }));

  assert.match(printed.join('\n'), /Diagnostics report written to \/tmp\/logwork-diagnostics\.txt/);
  assert.match(printed.join('\n'), /Send this sanitized file/);
});

test('manual logwork fallback stores last preview from pasted text', async () => {
  const printed = [];
  const session = createManualSession();
  const workflows = {
    previewLogworkBatch: async ({ text }) => {
      assert.match(text, /Maintenance mode/);
      return readyPreview({
        summary: 'Logwork preview:\nReady to apply.'
      });
    }
  };

  await executeManualCommand(parseManualCommand('/logwork'), session, context({
    workflows,
    printed,
    lines: [
      'Monday, 01 Jun 2026',
      '+2 Maintenance mode (SCB-213)',
      '/end'
    ]
  }));

  assert.equal(session.lastPreview.status, 'ready');
  assert.match(printed.join('\n'), /Paste weekly logwork text/);
  assert.match(printed.join('\n'), /Ready to apply/);
});

test('manual logwork draft helpers build text, overrides, and live preview', async () => {
  const task = parseTaskLine('+2 check ui/ux');
  assert.deepEqual(task, {
    hours: 2,
    taskName: 'check ui/ux',
    line: '+2 check ui/ux'
  });

  const draft = addDraftTask({
    draft: {
      date: '2026-06-01',
      project: {
        projectMemberId: 5234,
        projectName: '2621A-SIT-HTML BUILDER-PRJ'
      },
      tasks: []
    },
    line: '+1.5 polish flow'
  });
  assert.equal(draft.tasks[0].hours, 1.5);
  assert.equal(buildLogworkText({
    date: '2026-06-01',
    tasks: [task]
  }), 'Monday, 01 Jun 2026\n+2 check ui/ux');
  assert.deepEqual(buildProjectOverrides({
    date: '2026-06-01',
    tasks: [task],
    projectMemberId: 5234
  }), {
    '2026-06-01-01': 5234
  });
  assert.deepEqual(toggleTaskSelection([], 1), [1]);
  assert.deepEqual(toggleTaskSelection([0, 1], 1), [0]);
  assert.deepEqual(removeDraftTasks([
    { taskName: 'one' },
    { taskName: 'two' },
    { taskName: 'three' }
  ], [0, 2]), [{ taskName: 'two' }]);
  assert.deepEqual(replaceDraftTask([
    { taskName: 'one' },
    { taskName: 'two' }
  ], 1, { taskName: 'replacement' }), [
    { taskName: 'one' },
    { taskName: 'replacement' }
  ]);
  assert.equal(canApplyPreview(readyPreview()).ok, true);
  assert.equal(canApplyPreview({
    errors: [],
    unresolvedEntries: [{ id: 'entry_1' }]
  }).ok, false);
  assert.match(formatDraftPreview({
    date: '2026-06-01',
    project: {
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      booked: true
    },
    tasks: [task],
    preview: readyPreview()
  }), /Tasks: 1 · Total: 2h/);

  let previewArgs;
  const preview = await previewManualLogworkDraft({
    date: '2026-06-01',
    project: {
      projectMemberId: 5234,
      projectName: '2621A-SIT-HTML BUILDER-PRJ'
    },
    tasks: [task],
    workflows: {
      previewLogworkBatch: async (args) => {
        previewArgs = args;
        return readyPreview();
      }
    },
    print() {}
  });
  assert.equal(preview.status, 'ready');
  assert.match(previewArgs.text, /Monday, 01 Jun 2026/);
  assert.deepEqual(previewArgs.projectOverrides, {
    '2026-06-01-01': 5234
  });
});

test('manual draft persistence saves, updates, lists newest first, deletes, and sanitizes secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-helper-drafts-'));
  const path = join(dir, 'manual-drafts.json');
  const first = await saveManualDraft({
    cwd: '/tmp/repo',
    date: '2026-06-01',
    project: {
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      secretToken: 'should-not-save'
    },
    tasks: [
      {
        hours: 2,
        taskName: 'check ui/ux',
        password: 'should-not-save'
      }
    ],
    accessToken: 'should-not-save',
    latestPreviewStatus: 'ready'
  }, { path, cwd: '/tmp/repo' });
  assert.match(first.id, /^draft_/);
  assert.match(formatManualDraftLabel(first), /2026-06-01 · 2621A-SIT-HTML BUILDER-PRJ · 1 task/);

  const second = await saveManualDraft({
    cwd: '/tmp/repo',
    date: '2026-06-02',
    project: {
      projectMemberId: 7777,
      projectName: '2513A-JURONG-VAL-PRJ'
    },
    tasks: [
      {
        hours: 1,
        taskName: 'support'
      }
    ]
  }, { path, cwd: '/tmp/repo' });
  let drafts = await loadManualDrafts({ path });
  assert.deepEqual(drafts.map((draft) => draft.id), [second.id, first.id]);

  const updated = await saveManualDraft({
    id: first.id,
    cwd: '/tmp/repo',
    date: '2026-06-01',
    project: first.project,
    tasks: [
      {
        hours: 3,
        taskName: 'updated task'
      }
    ]
  }, { path, cwd: '/tmp/repo' });
  drafts = await loadManualDrafts({ path });
  assert.equal(drafts[0].id, updated.id);
  assert.equal(drafts[0].tasks[0].taskName, 'updated task');

  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /should-not-save|accessToken|password|secretToken/i);

  assert.equal(await deleteManualDraft(second.id, { path }), true);
  drafts = await loadManualDrafts({ path });
  assert.deepEqual(drafts.map((draft) => draft.id), [first.id]);
});

test('manual draft loading can be scoped to the current workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-helper-drafts-'));
  const path = join(dir, 'manual-drafts.json');
  const current = await saveManualDraft({
    cwd: '/tmp/current-repo',
    date: '2026-06-01',
    project: {
      projectMemberId: 5234,
      projectName: '2621A-SIT-HTML BUILDER-PRJ'
    },
    tasks: [
      {
        hours: 2,
        taskName: 'current repo task'
      }
    ]
  }, { path, cwd: '/tmp/current-repo' });
  const other = await saveManualDraft({
    cwd: '/tmp/other-repo',
    date: '2026-06-02',
    project: {
      projectMemberId: 7777,
      projectName: '2513A-JURONG-VAL-PRJ'
    },
    tasks: [
      {
        hours: 1,
        taskName: 'other repo task'
      }
    ]
  }, { path, cwd: '/tmp/other-repo' });

  assert.deepEqual((await loadManualDrafts({ path, cwd: '/tmp/current-repo' })).map((draft) => draft.id), [current.id]);
  assert.deepEqual((await loadManualDrafts({ path, cwd: '/tmp/other-repo' })).map((draft) => draft.id), [other.id]);
  assert.deepEqual(new Set((await loadManualDrafts({ path })).map((draft) => draft.id)), new Set([current.id, other.id]));
});

test('manual projects prints weekly chart and calls project query', async () => {
  const printed = [];
  const session = createManualSession();
  let listCalls = 0;
  let queryArgs;
  const workflows = {
    listLogworkProjects: async () => {
      listCalls += 1;
      return projectList();
    },
    queryLogwork: async (args) => {
      queryArgs = args;
      return weeklyLogwork();
    }
  };

  await executeManualCommand(parseManualCommand('/projects'), session, context({
    workflows,
    printed
  }));

  assert.equal(listCalls, 1);
  assert.equal(queryArgs.period, 'this_week');
  assert.equal(queryArgs.includeEntries, false);
  assert.match(printed.join('\n'), /This week:/);
  assert.match(printed.join('\n'), /2621A-SIT-HTML BUILDER-PRJ/);
  assert.match(printed.join('\n'), /\[████████████████████\] 100%/);
  assert.match(printed.join('\n'), /Mon 8\/8/);
  assert.match(printed.join('\n'), /Other memberships:/);
});

test('manual projects supports filter and overbooked chart', async () => {
  const printed = [];
  const session = createManualSession();
  let queryArgs;
  const workflows = {
    listLogworkProjects: async () => projectList(),
    queryLogwork: async (args) => {
      queryArgs = args;
      return weeklyLogwork({
        projects: [
          {
            projectMemberId: 5234,
            projectId: 643,
            projectName: '2621A-SIT-HTML BUILDER-PRJ',
            bookedHours: 40,
            loggedHours: 43,
            dates: ['2026-06-01']
          }
        ],
        days: [
          {
            date: '2026-06-01',
            projects: [
              {
                projectMemberId: 5234,
                projectId: 643,
                projectName: '2621A-SIT-HTML BUILDER-PRJ',
                bookedHours: 8,
                loggedHours: 9
              }
            ]
          }
        ]
      });
    }
  };

  await executeManualCommand(parseManualCommand('/projects 5234'), session, context({
    workflows,
    printed
  }));

  assert.equal(queryArgs.project, '5234');
  assert.match(printed.join('\n'), /43h logged \/ 40h booked \(\+3h over\)/);
  assert.doesNotMatch(printed.join('\n'), /2513A-JURONG-VAL-PRJ/);
});

test('manual apply blocks when no preview or unresolved entries exist', async () => {
  const printed = [];
  const session = createManualSession();

  await executeManualCommand(parseManualCommand('/apply'), session, context({ printed }));
  assert.match(printed.at(-1), /No preview available/);

  session.lastPreview = {
    entries: [],
    errors: [],
    unresolvedEntries: [{ id: 'entry_1' }],
    unbookedEntries: []
  };
  await executeManualCommand(parseManualCommand('/apply'), session, context({ printed }));
  assert.match(printed.at(-1), /Cannot apply preview with 1 unresolved entries/);
});

test('formatProjects handles no weekly chart for focused project', () => {
  const output = formatProjects(projectList(), {
    projects: [],
    days: []
  }, '2513');

  assert.match(output, /No weekly booking\/logwork chart found for "2513"/);
  assert.match(output, /2513A-JURONG-VAL-PRJ/);
});

test('formatProjectChart handles unbooked logged work', () => {
  const output = formatProjectChart({
    project: {
      projectMemberId: 123,
      projectId: 456,
      projectName: 'Support Project',
      bookedHours: 0,
      loggedHours: 2
    },
    days: [
      {
        date: '2026-06-06',
        bookedHours: 0,
        loggedHours: 2
      }
    ]
  }).join('\n');

  assert.match(output, /2h logged \/ 0h booked/);
  assert.match(output, /\[████████████████████\] unbooked/);
  assert.match(output, /Sat 2\/0/);
});

test('manual apply requires extra confirmation for unbooked entries', async () => {
  const printed = [];
  const session = createManualSession();
  session.lastPreview = readyPreview({
    status: 'ready_with_unbooked',
    unbookedEntries: [{ id: 'entry_1' }]
  });
  let applyCalled = false;
  const prompts = confirmations([true, false]);
  const workflows = {
    applyLogworkBatch: async () => {
      applyCalled = true;
    }
  };

  await executeManualCommand(parseManualCommand('/apply'), session, context({
    workflows,
    prompts,
    printed
  }));

  assert.equal(applyCalled, false);
  assert.match(printed.at(-1), /unbooked entries were not approved/);
});

test('manual apply submits approved preview and clears last preview', async () => {
  const printed = [];
  const session = createManualSession();
  session.lastPreview = readyPreview({
    status: 'ready_with_unbooked',
    unbookedEntries: [{ id: 'entry_1' }]
  });
  const prompts = confirmations([true, true]);
  const workflows = {
    applyLogworkBatch: async ({ batch, confirm, allowUnbooked }) => {
      assert.equal(batch, session.lastPreview);
      assert.equal(confirm, true);
      assert.equal(allowUnbooked, true);
      return {
        summary: 'Logwork submitted.',
        verification: {
          summary: 'Verified totals.'
        }
      };
    }
  };

  await executeManualCommand(parseManualCommand('/apply'), session, context({
    workflows,
    prompts,
    printed
  }));

  assert.equal(session.lastPreview, null);
  assert.match(printed.join('\n'), /Logwork submitted/);
  assert.match(printed.join('\n'), /Verified totals/);
});

test('manual commands run API auth inline when workflow reports auth required', async () => {
  const printed = [];
  const session = createManualSession();
  let queryCalls = 0;
  let loginCalls = 0;
  const workflows = {
    queryLogwork: async () => {
      queryCalls += 1;
      if (queryCalls === 1) {
        throw createAuthRequiredError();
      }
      return {
        summary: 'Authenticated query result.'
      };
    },
    loginResourceOptimiser: async () => {
      loginCalls += 1;
      return {
        summary: 'Authenticated as user 115.'
      };
    }
  };

  await executeManualCommand(parseManualCommand('/query today'), session, context({
    workflows,
    printed
  }));

  assert.equal(queryCalls, 2);
  assert.equal(loginCalls, 1);
  assert.match(printed.join('\n'), /Resource Optimiser authentication required/);
  assert.match(printed.join('\n'), /Authenticated query result/);
  assert.doesNotMatch(printed.join('\n'), /password|otp/i);
});

test('manual map confirms and upserts project mapping', async () => {
  const printed = [];
  const session = createManualSession();
  const prompts = confirmations([true]);
  const workflows = {
    upsertProjectMapping: async (args) => {
      assert.deepEqual(args.tickets, ['SCB']);
      assert.equal(args.projectMemberId, '5234');
      assert.equal(args.confirm, true);
      return {
        summary: 'Created project mapping for 2621A-SIT-HTML BUILDER-PRJ.'
      };
    }
  };

  await executeManualCommand(parseManualCommand('/map SCB 5234'), session, context({
    workflows,
    prompts,
    printed
  }));

  assert.match(printed.at(-1), /Created project mapping/);
});

function context({
  workflows = {},
  prompts = confirmations([]),
  printed = [],
  lines = []
} = {}) {
  const queue = [...lines];
  return {
    cwd: '/tmp/repo',
    workflows: {
      queryLogwork: async () => ({ summary: 'query' }),
      previewLogworkBatch: async () => readyPreview(),
      applyLogworkBatch: async () => ({ summary: 'applied' }),
      listLogworkProjects: async () => ({ summary: 'projects', projects: [], mappings: [] }),
      upsertProjectMapping: async () => ({ summary: 'mapped' }),
      loginResourceOptimiser: async () => ({ summary: 'auth' }),
      getStoredAuthStatus: async () => ({ summary: 'status' }),
      ...workflows
    },
    prompts,
    print(message = '') {
      printed.push(message);
    },
    async readLine() {
      if (!queue.length) {
        throw new Error('No test input line available.');
      }
      return queue.shift();
    }
  };
}

function confirmations(values) {
  const queue = [...values];
  return {
    async confirm() {
      return queue.length ? queue.shift() : true;
    }
  };
}

function readyPreview(overrides = {}) {
  return {
    batchId: 'batch_1',
    status: 'ready',
    errors: [],
    entries: [
      {
        id: 'entry_1',
        date: '2026-06-01',
        hours: 2,
        taskName: 'Maintenance mode',
        matchedProject: {
          projectMemberId: 5234,
          projectName: '2621A-SIT-HTML BUILDER-PRJ'
        }
      }
    ],
    unresolvedEntries: [],
    unbookedEntries: [],
    summary: 'Logwork preview:\nReady to apply.',
    ...overrides
  };
}

function projectList() {
  return {
    summary: 'Found 2 Resource Optimiser project memberships.',
    projects: [
      {
        projectMemberId: 5234,
        projectId: 643,
        projectName: '2621A-SIT-HTML BUILDER-PRJ'
      },
      {
        projectMemberId: 7777,
        projectId: 2513,
        projectName: '2513A-JURONG-VAL-PRJ'
      }
    ],
    mappings: [
      {
        projectMemberId: 5234,
        projectName: '2621A-SIT-HTML BUILDER-PRJ',
        tickets: ['SCB'],
        keywords: []
      }
    ]
  };
}

function savedDraftFixture() {
  return {
    id: 'draft_1',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T01:00:00.000Z',
    cwd: '/tmp/repo',
    date: '2026-06-08',
    project: {
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ'
    },
    tasks: [
      {
        hours: 2,
        taskName: 'check ui/ux'
      }
    ],
    latestPreviewStatus: 'ready'
  };
}

function weeklyLogwork(overrides = {}) {
  return {
    projects: [
      {
        projectMemberId: 5234,
        projectId: 643,
        projectName: '2621A-SIT-HTML BUILDER-PRJ',
        bookedHours: 40,
        loggedHours: 40,
        dates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']
      }
    ],
    days: [
      {
        date: '2026-06-01',
        projects: [
          {
            projectMemberId: 5234,
            projectId: 643,
            projectName: '2621A-SIT-HTML BUILDER-PRJ',
            bookedHours: 8,
            loggedHours: 8
          }
        ]
      }
    ],
    ...overrides
  };
}
