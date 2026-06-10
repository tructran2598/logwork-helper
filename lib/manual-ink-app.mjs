import React, {
  useCallback,
  useMemo,
  useRef,
  useState
} from 'react';
import { Box, render, useApp } from 'ink';
import { isAuthRequiredError } from './auth-errors.mjs';
import {
  buildLogworkText,
  buildProjectOverrides,
  buildProjectOptions,
  buildWeekDateOptions,
  canApplyPreview,
  formatDraftPreview,
  parseTaskLine,
  removeDraftTasks,
  replaceDraftTask,
  toggleTaskSelection
} from './manual-logwork-wizard.mjs';
import {
  getCommandSuggestions,
  TASK_COMMANDS
} from './manual-commands.mjs';
import {
  deleteManualDraft,
  formatManualDraftLabel,
  loadManualDrafts,
  saveManualDraft
} from './manual-drafts.mjs';
import {
  CommandInput,
  ConfirmDialog,
  CurrentPanel,
  DatePicker,
  DraftPicker,
  formatTaskHours,
  HeaderBar,
  LoadingLine,
  loadingMessageForCommand,
  panelTitleForCommand,
  ProjectPicker,
  sameProjectIdentity,
  StatusBar,
  TaskEditPicker,
  TaskRemovePicker
} from './manual-ink-ui.mjs';
import {
  AuthPrompt,
  createInkCredentialProvider
} from './manual-ink-auth.mjs';

export {
  CommandInput,
  ConfirmDialog,
  CurrentPanel,
  DatePicker,
  DraftPicker,
  HeaderBar,
  LoadingLine,
  OutputPanel,
  ProjectChart,
  ProjectPicker,
  SelectionList,
  SlashMenu,
  StatusBar,
  TaskEditPicker,
  TaskRemovePicker,
  chartLineColor,
  commandItems,
  formatTaskHours,
  loadingMessageForCommand,
  panelColor,
  panelTitleForCommand,
  renderProjectChartText,
  sameProjectIdentity
} from './manual-ink-ui.mjs';
export {
  AuthCredentialsPrompt,
  AuthDevicePrompt,
  AuthOtpPrompt,
  AuthPrompt,
  createInkCredentialProvider
} from './manual-ink-auth.mjs';

const h = React.createElement;

export async function runManualInkApp({
  input,
  output,
  cwd = process.cwd(),
  workflows,
  controller,
  showIntro = true
} = {}) {
  const app = render(h(ManualApp, {
    cwd,
    workflows,
    controller,
    showIntro
  }), {
    stdin: input,
    stdout: output,
    stderr: output
  });
  await app.waitUntilExit();
}

export function ManualApp({
  cwd = process.cwd(),
  workflows,
  controller,
  showIntro = true
}) {
  const { exit } = useApp();
  const sessionRef = useRef(controller.createManualSession());
  const confirmResolverRef = useRef(null);
  const authResolverRef = useRef(null);
  const authRejecterRef = useRef(null);
  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activePanel, setActivePanel] = useState(() => ({
    kind: 'idle',
    title: 'Ready',
    text: showIntro ? 'Type / for commands.' : 'Ready.'
  }));
  const [loading, setLoading] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [authPrompt, setAuthPrompt] = useState(null);
  const [authActive, setAuthActive] = useState(false);
  const [wizard, setWizard] = useState(null);

  const prompts = useMemo(() => ({
    confirm(message, initialValue = true) {
      return new Promise((resolveValue) => {
        confirmResolverRef.current = resolveValue;
        setPendingConfirm({
          message,
          initialValue
        });
      });
    }
  }), []);

  const resolveConfirm = useCallback((value) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setPendingConfirm(null);
    if (resolver) {
      resolver(Boolean(value));
    }
  }, []);

  const credentialProvider = useMemo(() => createInkCredentialProvider({
    resolverRef: authResolverRef,
    rejecterRef: authRejecterRef,
    setAuthPrompt,
    setActivePanel,
    setInputValue,
    setSelectedIndex
  }), []);

  const inkWorkflows = useMemo(() => ({
    ...workflows,
    async loginResourceOptimiser(options = {}) {
      setAuthActive(true);
      try {
        return await workflows.loginResourceOptimiser({
          ...options,
          credentialProvider: options.credentialProvider || credentialProvider
        });
      } finally {
        setAuthActive(false);
        setAuthPrompt(null);
        setInputValue('');
        setSelectedIndex(0);
      }
    }
  }), [credentialProvider, workflows]);

  const resolveAuthPrompt = useCallback((value) => {
    const resolver = authResolverRef.current;
    authResolverRef.current = null;
    authRejecterRef.current = null;
    setAuthPrompt(null);
    setInputValue('');
    setSelectedIndex(0);
    if (resolver) {
      resolver(value);
    }
  }, []);

  const rejectAuthPrompt = useCallback((error = new Error('Resource Optimiser authentication cancelled.')) => {
    const rejecter = authRejecterRef.current;
    authResolverRef.current = null;
    authRejecterRef.current = null;
    setAuthPrompt(null);
    setInputValue('');
    setSelectedIndex(0);
    if (rejecter) {
      rejecter(error);
    }
  }, []);

  const runWithInlineAuth = useCallback(async (action) => {
    try {
      return await action();
    } catch (error) {
      if (!isAuthRequiredError(error)) {
        throw error;
      }
      setActivePanel({
        kind: 'auth',
        title: 'Authentication',
        text: 'Resource Optimiser authentication required. Enter credentials in this CLI panel.'
      });
      setLoading('Authenticating Resource Optimiser...');
      await inkWorkflows.loginResourceOptimiser();
      return action();
    }
  }, [inkWorkflows]);

  const setCommandPanel = useCallback((title, kind = 'output') => {
    const lines = [];
    setActivePanel({
      kind,
      title,
      text: ''
    });
    return (message = '') => {
      lines.push(String(message ?? ''));
      setActivePanel({
        kind,
        title,
        text: lines.join('\n')
      });
    };
  }, []);

  const executeCommand = useCallback(async (command) => {
    if (command.type !== 'apply' && command.type !== 'diagnostics') {
      setWizard(null);
    }
    setLoading(loadingMessageForCommand(command));
    const print = setCommandPanel(panelTitleForCommand(command), command.type === 'apply' ? 'success' : 'output');
    try {
      const result = await controller.executeManualCommand(command, sessionRef.current, {
        cwd,
        workflows: inkWorkflows,
        prompts,
        print,
        readLine: null
      });
      if (result.exit) {
        exit();
      }
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Error',
        text: error.message
      });
    } finally {
      if (command.type === 'apply' && sessionRef.current.lastPreview === null) {
        sessionRef.current.logworkDraft = null;
      }
      setLoading('');
    }
  }, [controller, cwd, exit, inkWorkflows, prompts, setCommandPanel]);

  const startNewLogworkWizard = useCallback(async () => {
    setInputValue('');
    setSelectedIndex(0);
    setLoading('Fetching current week...');
    setActivePanel({
      kind: 'logwork',
      title: 'Logwork',
      text: 'Loading this week booking/logwork data...'
    });
    try {
      const weekly = await runWithInlineAuth(() => inkWorkflows.queryLogwork({
        period: 'this_week',
        cwd,
        includeEntries: false
      }));
      const dateOptions = buildWeekDateOptions(weekly);
      if (!dateOptions.length) {
        throw new Error('Unable to build week date options.');
      }
      const todayIndex = dateOptions.findIndex((option) => option.isToday);
      setWizard({
        step: 'select_date',
        weekly,
        dateOptions,
        dateIndex: todayIndex >= 0 ? todayIndex : 0,
        projectsResult: null,
        projectOptions: [],
        projectIndex: 0,
        selectedDate: null,
        selectedProject: null,
        tasks: [],
        preview: null,
        activeDraftId: null
      });
      setActivePanel({
        kind: 'logwork',
        title: 'Select Date',
        text: 'Choose a day for this logwork session.'
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Logwork Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, runWithInlineAuth]);

  const startLogworkWizard = useCallback(async () => {
    setInputValue('');
    setSelectedIndex(0);
    setLoading('Loading saved drafts...');
    try {
      const drafts = await loadManualDrafts();
      if (drafts.length) {
        setWizard({
          step: 'select_draft',
          drafts,
          draftIndex: 0,
          draftSource: 'start',
          weekly: null,
          dateOptions: [],
          dateIndex: 0,
          projectsResult: null,
          projectOptions: [],
          projectIndex: 0,
          selectedDate: null,
          selectedProject: null,
          tasks: [],
          preview: null,
          activeDraftId: null
        });
        setActivePanel({
          kind: 'logwork',
          title: 'Saved Drafts',
          text: 'Resume a saved draft, delete one, or start a new logwork session.'
        });
        return;
      }
      await startNewLogworkWizard();
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Draft Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [startNewLogworkWizard]);

  const selectWizardDate = useCallback(async (dateOption) => {
    setLoading('Fetching project memberships...');
    setActivePanel({
      kind: 'logwork',
      title: 'Select Project',
      text: `Loading projects for ${dateOption.date}...`
    });
    try {
      const projectsResult = await runWithInlineAuth(() => inkWorkflows.listLogworkProjects({ cwd }));
      const projectOptions = buildProjectOptions({
        projectsResult,
        weekly: wizard.weekly,
        date: dateOption.date
      });
      if (!projectOptions.length) {
        throw new Error('No Resource Optimiser project memberships found.');
      }
      setWizard((current) => ({
        ...current,
        step: 'select_project',
        selectedDate: dateOption.date,
        projectsResult,
        projectOptions,
        projectIndex: 0,
        selectedProject: null,
        tasks: [],
        preview: null
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Select Project',
        text: `Choose a project for ${dateOption.date}.`
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Project Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, runWithInlineAuth, wizard]);

  const selectWizardProject = useCallback((project) => {
    const draft = {
      date: wizard.selectedDate,
      project,
      tasks: [],
      preview: null
    };
    sessionRef.current.logworkDraft = draft;
    sessionRef.current.lastPreview = null;
    setWizard((current) => ({
      ...current,
      step: 'edit_tasks',
      selectedProject: project,
      tasks: [],
      preview: null
    }));
    setActivePanel({
      kind: 'logwork',
      title: 'Logwork Draft',
      text: [
        formatDraftPreview(draft),
        '',
        'Enter tasks one per line: +2 check ui/ux',
        'Empty Enter applies after preview is ready.',
        'Type / for task commands. Esc cancels.'
      ].join('\n')
    });
  }, [wizard]);

  const previewDraft = useCallback(async (nextWizard) => {
    const draft = {
      date: nextWizard.selectedDate,
      project: nextWizard.selectedProject,
      tasks: nextWizard.tasks
    };

    if (!draft.tasks.length) {
      sessionRef.current.logworkDraft = draft;
      sessionRef.current.lastPreview = null;
      setWizard(nextWizard);
      setActivePanel({
        kind: 'logwork',
        title: 'Logwork Draft',
        text: [
          formatDraftPreview(draft),
          '',
          'Enter tasks one per line: +2 check ui/ux',
          'Empty Enter applies after preview is ready.'
        ].join('\n')
      });
      return;
    }

    setLoading('Building live preview...');
    try {
      const text = buildLogworkText({
        date: draft.date,
        tasks: draft.tasks
      });
      const projectOverrides = buildProjectOverrides({
        date: draft.date,
        tasks: draft.tasks,
        projectMemberId: draft.project.projectMemberId
      });
      const preview = await runWithInlineAuth(() => inkWorkflows.previewLogworkBatch({
        text,
        projectOverrides,
        cwd
      }));
      const withPreview = {
        ...draft,
        preview
      };
      sessionRef.current.logworkDraft = withPreview;
      sessionRef.current.lastPreview = preview;
      setWizard({
        ...nextWizard,
        preview
      });
      setActivePanel({
        kind: preview.unresolvedEntries?.length || preview.errors?.length ? 'error' : 'logwork',
        title: 'Logwork Preview',
        text: [
          formatDraftPreview(withPreview),
          '',
          'Empty Enter applies this preview.',
          'Type another +hours task to add more.',
          '/remove selects tasks to delete.'
        ].join('\n')
      });
      return preview;
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Preview Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, runWithInlineAuth]);

  const saveCurrentDraft = useCallback(async () => {
    if (!wizard?.selectedDate || !wizard?.selectedProject || !wizard?.tasks?.length) {
      setActivePanel({
        kind: 'logwork',
        title: 'Save Draft',
        text: 'Add at least one task before saving a draft.'
      });
      return null;
    }

    try {
      const saved = await saveManualDraft({
        id: wizard.activeDraftId,
        cwd,
        date: wizard.selectedDate,
        project: wizard.selectedProject,
        tasks: wizard.tasks,
        latestPreviewStatus: wizard.preview?.status
      }, { cwd });
      setWizard((current) => ({
        ...current,
        activeDraftId: saved.id
      }));
      setActivePanel({
        kind: 'success',
        title: 'Draft Saved',
        text: [
          `Saved ${saved.tasks.length} task${saved.tasks.length === 1 ? '' : 's'} locally.`,
          formatManualDraftLabel(saved),
          '',
          'Continue editing, press empty Enter to apply, or type /drafts.'
        ].join('\n')
      });
      return saved;
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Save Draft Error',
        text: error.message
      });
      return null;
    }
  }, [cwd, wizard]);

  const openDraftPicker = useCallback(async (source = 'editor') => {
    setLoading('Loading saved drafts...');
    try {
      const drafts = await loadManualDrafts();
      if (!drafts.length) {
        setActivePanel({
          kind: 'logwork',
          title: 'Saved Drafts',
          text: 'No saved drafts found.'
        });
        return;
      }
      setWizard((current) => ({
        ...current,
        step: 'select_draft',
        drafts,
        draftIndex: 0,
        draftSource: source
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Saved Drafts',
        text: 'Enter resumes · d deletes · Esc returns.'
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Draft Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, []);

  const resumeManualDraft = useCallback(async (draft) => {
    setLoading('Resuming saved draft...');
    try {
      const weekly = await runWithInlineAuth(() => inkWorkflows.queryLogwork({
        period: 'this_week',
        cwd,
        includeEntries: false
      }));
      const dateOptions = buildWeekDateOptions(weekly);
      const projectsResult = await runWithInlineAuth(() => inkWorkflows.listLogworkProjects({ cwd }));
      const projectOptions = buildProjectOptions({
        projectsResult,
        weekly,
        date: draft.date
      });
      const selectedProject = projectOptions.find((project) => sameProjectIdentity(project, draft.project)) || draft.project;
      const nextWizard = {
        step: 'edit_tasks',
        weekly,
        dateOptions,
        dateIndex: Math.max(0, dateOptions.findIndex((option) => option.date === draft.date)),
        projectsResult,
        projectOptions,
        projectIndex: Math.max(0, projectOptions.findIndex((project) => sameProjectIdentity(project, selectedProject))),
        selectedDate: draft.date,
        selectedProject,
        tasks: draft.tasks,
        preview: null,
        activeDraftId: draft.id
      };
      sessionRef.current.logworkDraft = {
        date: draft.date,
        project: selectedProject,
        tasks: draft.tasks,
        preview: null
      };
      sessionRef.current.lastPreview = null;
      await previewDraft(nextWizard);
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Resume Draft Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, previewDraft, runWithInlineAuth]);

  const deleteSavedDraft = useCallback(async (draft) => {
    const ok = await prompts.confirm(`Delete saved draft "${formatManualDraftLabel(draft)}"?`, false);
    if (!ok) {
      return;
    }
    await deleteManualDraft(draft.id);
    const drafts = await loadManualDrafts();
    setWizard((current) => ({
      ...current,
      drafts,
      draftIndex: 0
    }));
    setActivePanel({
      kind: 'success',
      title: 'Draft Deleted',
      text: drafts.length ? 'Draft deleted. Choose another saved draft or start new.' : 'Draft deleted. No saved drafts remain.'
    });
  }, [prompts]);

  const returnFromDraftPicker = useCallback(() => {
    if (wizard?.draftSource === 'start') {
      startNewLogworkWizard();
      return;
    }
    setWizard((current) => ({
      ...current,
      step: 'edit_tasks',
      draftSource: undefined
    }));
    const draft = {
      date: wizard?.selectedDate,
      project: wizard?.selectedProject,
      tasks: wizard?.tasks || [],
      preview: wizard?.preview
    };
    setActivePanel({
      kind: 'logwork',
      title: wizard?.preview ? 'Logwork Preview' : 'Logwork Draft',
      text: [
        formatDraftPreview(draft),
        '',
        'Type / for task commands. Empty Enter applies when ready.'
      ].join('\n')
    });
  }, [startNewLogworkWizard, wizard]);

  const cancelCurrentLogwork = useCallback(async () => {
    if (wizard?.tasks?.length) {
      const ok = await prompts.confirm('Discard this unsaved logwork session?', false);
      if (!ok) {
        return;
      }
    }
    sessionRef.current.logworkDraft = null;
    sessionRef.current.lastPreview = null;
    setWizard(null);
    setActivePanel({
      kind: 'idle',
      title: 'Ready',
      text: 'Logwork session discarded. Type / for commands.'
    });
  }, [prompts, wizard]);

  const applyWizardPreview = useCallback(async () => {
    if (!wizard.tasks.length) {
      setActivePanel({
        kind: 'logwork',
        title: 'Logwork Draft',
        text: 'Enter a task like +2 check ui/ux.'
      });
      return;
    }

    const preview = wizard.preview || sessionRef.current.lastPreview;
    if (!preview) {
      await previewDraft(wizard);
      return;
    }

    const applyState = canApplyPreview(preview);
    if (!applyState.ok) {
      setActivePanel({
        kind: 'error',
        title: 'Apply Blocked',
        text: applyState.reason
      });
      return;
    }

    await executeCommand({ type: 'apply' });
    if (!sessionRef.current.lastPreview) {
      setWizard(null);
    }
  }, [executeCommand, previewDraft, wizard]);

  const restoreTaskEditorPanel = useCallback((nextWizard = wizard) => {
    const draft = {
      date: nextWizard.selectedDate,
      project: nextWizard.selectedProject,
      tasks: nextWizard.tasks,
      preview: nextWizard.preview
    };
    setActivePanel({
      kind: 'logwork',
      title: nextWizard.preview ? 'Logwork Preview' : 'Logwork Draft',
      text: [
        formatDraftPreview(draft),
        '',
        nextWizard.preview ? 'Empty Enter applies this preview.' : 'Enter tasks one per line: +2 check ui/ux',
        nextWizard.preview ? 'Type another +hours task to add more.' : 'Empty Enter applies after preview is ready.',
        'Type / for task commands. Esc cancels.'
      ].join('\n')
    });
  }, [wizard]);

  const cancelRemoveTasks = useCallback(() => {
    setWizard((current) => ({
      ...current,
      step: 'edit_tasks',
      removeIndex: 0,
      removeSelectedIndexes: []
    }));
    restoreTaskEditorPanel();
  }, [restoreTaskEditorPanel]);

  const confirmRemoveTasks = useCallback(async (selectedIndexes) => {
    if (!selectedIndexes.length) {
      setActivePanel({
        kind: 'logwork',
        title: 'Remove Tasks',
        text: 'No tasks selected. Use Space to select tasks, Enter to remove, Esc to cancel.'
      });
      return;
    }

    const ok = await prompts.confirm(`Remove ${selectedIndexes.length} selected task${selectedIndexes.length === 1 ? '' : 's'}?`);
    if (!ok) {
      cancelRemoveTasks();
      return;
    }

    await previewDraft({
      ...wizard,
      step: 'edit_tasks',
      tasks: removeDraftTasks(wizard.tasks, selectedIndexes),
      preview: null,
      removeIndex: 0,
      removeSelectedIndexes: []
    });
  }, [cancelRemoveTasks, previewDraft, prompts, wizard]);

  const submitWizardTaskInput = useCallback(async (value) => {
    const text = String(value || '').trim();
    setInputValue('');

    if (!text) {
      await applyWizardPreview();
      return;
    }

    if (text === '/diagnostics') {
      await executeCommand({ type: 'diagnostics' });
      return;
    }

    if (text === '/cancel' || text === '/discard') {
      await cancelCurrentLogwork();
      return;
    }

    if (text === '/back') {
      sessionRef.current.logworkDraft = null;
      sessionRef.current.lastPreview = null;
      setWizard((current) => ({
        ...current,
        step: 'select_project',
        selectedProject: null,
        tasks: [],
        preview: null
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Select Project',
        text: `Choose a project for ${wizard.selectedDate}.`
      });
      return;
    }

    if (text === '/clear') {
      const ok = !wizard.tasks.length || await prompts.confirm('Clear all current tasks?', false);
      if (!ok) {
        restoreTaskEditorPanel();
        return;
      }
      await previewDraft({
        ...wizard,
        tasks: [],
        preview: null
      });
      return;
    }

    if (text === '/save') {
      await saveCurrentDraft();
      return;
    }

    if (text === '/drafts') {
      await openDraftPicker('editor');
      return;
    }

    if (text === '/edit') {
      if (!wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Edit Task',
          text: 'No tasks to edit.'
        });
        return;
      }
      setWizard((current) => ({
        ...current,
        step: 'edit_task_select',
        editIndex: 0,
        replacementError: ''
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Edit Task',
        text: 'Select a task to replace. Esc returns to the editor.'
      });
      return;
    }

    if (text === '/remove') {
      if (!wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Remove Task',
          text: 'No tasks to remove.'
        });
        return;
      }
      setWizard((current) => ({
        ...current,
        step: 'remove_tasks',
        removeIndex: 0,
        removeSelectedIndexes: []
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Remove Tasks',
        text: 'Select tasks to remove. Space toggles, Enter confirms, Esc cancels.'
      });
      return;
    }

    if (text.startsWith('/remove ')) {
      const index = Number(text.slice('/remove '.length).trim());
      if (!Number.isInteger(index)) {
        setActivePanel({
          kind: 'error',
          title: 'Remove Task',
          text: 'Usage: /remove <task number>'
        });
        return;
      }
      if (index < 1 || index > wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Remove Task',
          text: `No task found at index ${index}.`
        });
        return;
      }
      await previewDraft({
        ...wizard,
        tasks: wizard.tasks.filter((_, currentIndex) => currentIndex !== index - 1),
        preview: null
      });
      return;
    }

    if (text === '/done') {
      if (!wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Logwork Draft',
          text: 'Add at least one task before /done.'
        });
        return;
      }
      await previewDraft(wizard);
      return;
    }

    if (text === '/apply') {
      await applyWizardPreview();
      return;
    }

    if (text.startsWith('/')) {
      setActivePanel({
        kind: 'error',
        title: 'Logwork Draft',
        text: `Unknown logwork command: ${text}`
      });
      return;
    }

    try {
      const task = parseTaskLine(text);
      await previewDraft({
        ...wizard,
        tasks: [...wizard.tasks, task],
        preview: null
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Task Error',
        text: error.message
      });
    }
  }, [
    applyWizardPreview,
    cancelCurrentLogwork,
    executeCommand,
    openDraftPicker,
    previewDraft,
    prompts,
    restoreTaskEditorPanel,
    saveCurrentDraft,
    wizard
  ]);

  const selectTaskForEdit = useCallback((index) => {
    const task = wizard.tasks[index];
    setInputValue('');
    setWizard((current) => ({
      ...current,
      step: 'edit_task_replace',
      editIndex: index,
      replacementError: ''
    }));
    setActivePanel({
      kind: 'logwork',
      title: 'Replace Task',
      text: [
        `Replacing ${index + 1}. +${formatTaskHours(task.hours)} ${task.taskName}`,
        'Enter replacement line using format: +2 check ui/ux',
        'Esc returns without changing the task.'
      ].join('\n')
    });
  }, [wizard]);

  const submitTaskReplacement = useCallback(async (value) => {
    const text = String(value || '').trim();
    setInputValue('');
    if (!text) {
      setActivePanel({
        kind: 'error',
        title: 'Replace Task',
        text: 'Replacement task is empty. Use format: +2 check ui/ux'
      });
      return;
    }
    if (text === '/cancel') {
      setWizard((current) => ({
        ...current,
        step: 'edit_tasks',
        replacementError: ''
      }));
      restoreTaskEditorPanel();
      return;
    }
    try {
      const task = parseTaskLine(text);
      await previewDraft({
        ...wizard,
        step: 'edit_tasks',
        tasks: replaceDraftTask(wizard.tasks, wizard.editIndex, task),
        preview: null,
        replacementError: ''
      });
    } catch (error) {
      setWizard((current) => ({
        ...current,
        replacementError: error.message
      }));
      setActivePanel({
        kind: 'error',
        title: 'Replace Task',
        text: error.message
      });
    }
  }, [previewDraft, restoreTaskEditorPanel, wizard]);

  const submitInput = useCallback((value) => {
    const text = String(value || '');
    const trimmed = text.trim();

    if (pendingConfirm) {
      return;
    }

    if (authActive || authPrompt) {
      return;
    }

    if (wizard?.step === 'edit_tasks') {
      const taskSuggestions = getCommandSuggestions(inputValue, TASK_COMMANDS);
      const selected = taskSuggestions[selectedIndex];
      if (selected && !inputValue.includes(' ') && trimmed !== selected.name && trimmed !== '') {
        setInputValue(`${selected.name} `);
        setSelectedIndex(0);
        return;
      }
      submitWizardTaskInput(text);
      return;
    }

    if (wizard?.step === 'edit_task_replace') {
      submitTaskReplacement(text);
      return;
    }

    const suggestions = getCommandSuggestions(inputValue);
    const selected = suggestions[selectedIndex];
    if (selected && !inputValue.includes(' ') && trimmed !== selected.name && trimmed !== '') {
      setInputValue(`${selected.name} `);
      setSelectedIndex(0);
      return;
    }

    setInputValue('');
    setSelectedIndex(0);

    if (!trimmed) {
      return;
    }

    let command;
    try {
      command = controller.parseManualCommand(trimmed);
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Command Error',
        text: error.message
      });
      return;
    }

    if (command.type === 'logwork' && !command.text) {
      startLogworkWizard();
      return;
    }

    executeCommand(command);
  }, [
    controller,
    executeCommand,
    inputValue,
    pendingConfirm,
    authActive,
    authPrompt,
    selectedIndex,
    startLogworkWizard,
    submitTaskReplacement,
    submitWizardTaskInput,
    wizard
  ]);

  return h(Box, {
    flexDirection: 'column',
    gap: 1
  },
  h(HeaderBar, { cwd }),
  h(CurrentPanel, { panel: activePanel }),
  loading ? h(LoadingLine, { message: loading }) : null,
  h(StatusBar, {
    preview: sessionRef.current.lastPreview,
    dryRun: process.env.LOGWORK_DRY_RUN === '1',
    wizard,
    authPrompt: authPrompt || (authActive ? { step: 'working' } : null)
  }),
  authPrompt
    ? h(AuthPrompt, {
      prompt: authPrompt,
      inputValue,
      onInputChange(value) {
        setInputValue(value);
      },
      onPromptChange(nextPrompt) {
        setAuthPrompt(nextPrompt);
      },
      onResolve: resolveAuthPrompt,
      onReject: rejectAuthPrompt
    })
    : authActive
      ? h(AuthPrompt, {
        prompt: { step: 'working' },
        inputValue,
        onInputChange(value) {
          setInputValue(value);
        },
        onPromptChange(nextPrompt) {
          setAuthPrompt(nextPrompt);
        },
        onResolve: resolveAuthPrompt,
        onReject: rejectAuthPrompt
      })
    : pendingConfirm
    ? h(ConfirmDialog, {
      message: pendingConfirm.message,
      initialValue: pendingConfirm.initialValue,
      onResolve: resolveConfirm
    })
    : wizard?.step === 'select_draft'
      ? h(DraftPicker, {
        drafts: wizard.drafts || [],
        selectedIndex: wizard.draftIndex || 0,
        includeStartNew: wizard.draftSource === 'start',
        onChange(index) {
          setWizard((current) => ({
            ...current,
            draftIndex: index
          }));
        },
        onResume(draft) {
          resumeManualDraft(draft);
        },
        onDelete(draft) {
          deleteSavedDraft(draft);
        },
        onStartNew() {
          startNewLogworkWizard();
        },
        onCancel() {
          returnFromDraftPicker();
        }
      })
      : wizard?.step === 'select_date'
      ? h(DatePicker, {
        options: wizard.dateOptions,
        selectedIndex: wizard.dateIndex,
        onChange(index) {
          setWizard((current) => ({
            ...current,
            dateIndex: index
          }));
        },
        onSelect(option) {
          selectWizardDate(option);
        }
      })
      : wizard?.step === 'select_project'
        ? h(ProjectPicker, {
          options: wizard.projectOptions,
          selectedIndex: wizard.projectIndex,
          onChange(index) {
            setWizard((current) => ({
              ...current,
              projectIndex: index
            }));
          },
          onSelect(project) {
            selectWizardProject(project);
          }
        })
        : wizard?.step === 'remove_tasks'
          ? h(TaskRemovePicker, {
            tasks: wizard.tasks,
            selectedIndex: wizard.removeIndex || 0,
            selectedIndexes: wizard.removeSelectedIndexes || [],
            onChange(index) {
              setWizard((current) => ({
                ...current,
                removeIndex: index
              }));
            },
            onToggle(index) {
              setWizard((current) => ({
                ...current,
                removeSelectedIndexes: toggleTaskSelection(current.removeSelectedIndexes || [], index)
              }));
            },
            onSubmit(indexes) {
              confirmRemoveTasks(indexes);
            },
            onCancel() {
              cancelRemoveTasks();
            }
          })
        : wizard?.step === 'edit_task_select'
          ? h(TaskEditPicker, {
            tasks: wizard.tasks,
            selectedIndex: wizard.editIndex || 0,
            onChange(index) {
              setWizard((current) => ({
                ...current,
                editIndex: index
              }));
            },
            onSelect(index) {
              selectTaskForEdit(index);
            },
            onCancel() {
              setWizard((current) => ({
                ...current,
                step: 'edit_tasks'
              }));
              restoreTaskEditorPanel();
            }
          })
        : h(CommandInput, {
          value: inputValue,
          onChange(value) {
            setInputValue(value);
            setSelectedIndex(0);
          },
          onSubmit: submitInput,
          selectedIndex,
          setSelectedIndex,
          mode: wizard?.step === 'edit_tasks' ? 'task' : wizard?.step === 'edit_task_replace' ? 'task-edit' : 'command',
          onEscape() {
            if (!wizard) {
              exit();
              return;
            }
            if (wizard?.step === 'edit_tasks') {
              cancelCurrentLogwork();
              return;
            }
            if (wizard?.step === 'edit_task_replace') {
              setWizard((current) => ({
                ...current,
                step: 'edit_tasks'
              }));
              restoreTaskEditorPanel();
            }
          }
        }));
}
