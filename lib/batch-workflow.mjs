import { addLogtime, ApiError, getBookedProjectsForDate, getProjects } from './api.mjs';
import { parseWeeklyLogText } from './batch-parser.mjs';
import { loadLocalConfig } from './logwork-config.mjs';
import { buildSetupSuggestions } from './project-mapping-workflow.mjs';
import { resolveEntryProject } from './project-resolver.mjs';
import { createResourceOptimiserSession, queryLogwork } from './query-workflow.mjs';

export async function previewLogworkBatch({
  text,
  projectOverrides = {},
  cwd = process.cwd(),
  fetchProjects,
  fetchMembershipProjects
}) {
  const config = await loadLocalConfig(cwd);
  const parsed = parseWeeklyLogText(text);
  const dates = [...new Set(parsed.entries.map((entry) => entry.date))];
  const projectsByDate = new Map();
  const projectFetcher = fetchProjects || createBookedProjectsFetcher();
  const membershipFetcher = fetchMembershipProjects || createMembershipProjectsFetcher();

  for (const date of dates) {
    projectsByDate.set(date, await projectFetcher(date));
  }

  const bookedPreview = buildLogworkBatchPreview({
    parsed,
    projectsByDate,
    projectOverrides,
    config
  });

  if (!bookedPreview.unresolvedEntries.length) {
    return bookedPreview;
  }

  const membershipProjects = await membershipFetcher();
  return buildLogworkBatchPreview({
    parsed,
    projectsByDate,
    membershipProjects,
    projectOverrides,
    config
  });
}

export function buildLogworkBatchPreview({
  parsed,
  projectsByDate,
  membershipProjects = [],
  projectOverrides = {},
  config = {}
}) {
  const batchId = createBatchId(parsed.entries, projectOverrides);
  const entries = parsed.entries.map((entry) => {
    const projects = projectsByDate instanceof Map
      ? projectsByDate.get(entry.date) || []
      : projectsByDate?.[entry.date] || [];
    const resolution = resolveEntryProject({
      entry,
      projects,
      membershipProjects,
      projectOverrides,
      config
    });

    const matchedProject = resolution.status === 'resolved' || resolution.status === 'resolved_unbooked' ? {
      projectMemberId: resolution.project.projectMemberId,
      projectId: resolution.project.projectId,
      projectName: resolution.project.projectName
    } : null;

    return {
      ...entry,
      status: resolution.status,
      reason: resolution.reason,
      confidence: resolution.confidence,
      matchedProject,
      booked: Boolean(resolution.booked),
      requiresAllowUnbooked: Boolean(resolution.requiresAllowUnbooked),
      candidates: resolution.candidates
    };
  });
  const unresolvedEntries = entries.filter((entry) => entry.status === 'unresolved');
  const unbookedEntries = entries.filter((entry) => entry.status === 'resolved_unbooked');
  const setupSuggestions = buildSetupSuggestions(unresolvedEntries, membershipProjects);

  return {
    batchId,
    status: getBatchStatus(parsed.errors, unresolvedEntries, unbookedEntries),
    errors: parsed.errors,
    entries,
    unresolvedEntries,
    unbookedEntries,
    setupSuggestions,
    totalsByDate: totalsBy(entries, (entry) => entry.date),
    totalsByProject: totalsBy(entries.filter((entry) => entry.matchedProject), (entry) => entry.matchedProject.projectName),
    summary: formatPreviewSummary(entries, parsed.errors, setupSuggestions)
  };
}

export async function applyLogworkBatch({
  batch,
  confirm,
  projectOverrides = {},
  allowUnbooked = false,
  cwd = process.cwd(),
  fetchProjects,
  fetchMembershipProjects,
  submitEntry,
  verifyLogwork
}) {
  if (confirm !== true) {
    throw new Error('apply_logwork_batch requires confirm: true.');
  }

  const preview = batch?.entries
    ? applyOverridesToBatch(batch, projectOverrides)
    : await previewLogworkBatch({
      text: batch?.text,
      projectOverrides,
      cwd,
      fetchProjects,
      fetchMembershipProjects
    });

  if (preview.errors?.length) {
    throw new Error(`Cannot apply batch with parse errors: ${preview.errors.map((error) => error.message).join('; ')}`);
  }

  if (preview.unresolvedEntries?.length) {
    throw new Error(`Cannot apply batch with ${preview.unresolvedEntries.length} unresolved entries.`);
  }

  const unbookedEntries = preview.entries.filter((entry) => entry.requiresAllowUnbooked);
  if (unbookedEntries.length && allowUnbooked !== true) {
    const blocked = unbookedEntries
      .map((entry) => `${entry.id}: +${entry.hours}h ${entry.taskName} -> ${entry.matchedProject?.projectName || 'unknown project'}`)
      .join('; ');
    throw new Error(`Cannot apply ${unbookedEntries.length} unbooked entries without allowUnbooked: true. ${blocked}`);
  }

  const results = [];
  const entrySubmitter = submitEntry || createLogtimeSubmitter();
  for (const entry of preview.entries) {
    const result = await entrySubmitter({
      projectMemberId: entry.matchedProject.projectMemberId,
      logtimes: entry.hours,
      taskName: entry.taskName,
      localDateISO: entry.date
    });

    results.push({
      entryId: entry.id,
      date: entry.date,
      hours: entry.hours,
      taskName: entry.taskName,
      projectName: entry.matchedProject.projectName,
      dryRun: Boolean(result?.dryRun),
      ok: true,
      result
    });
  }

  return {
    batchId: preview.batchId,
    status: 'submitted',
    dryRun: results.some((result) => result.dryRun),
    results,
    verification: await buildApplyVerification({
      preview,
      results,
      cwd,
      verifyLogwork
    }),
    summary: formatApplySummary(results)
  };
}

export function formatToolResponse(payload) {
  return {
    content: [
      {
        type: 'text',
        text: `${payload.summary}\n\n${JSON.stringify(payload, null, 2)}`
      }
    ],
    structuredContent: payload
  };
}

function createBookedProjectsFetcher() {
  const session = createResourceOptimiserSession();
  return async (localDateISO) => {
    const { token, userId } = await session.get();
    try {
      return await getBookedProjectsForDate(token, userId, localDateISO);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getBookedProjectsForDate(refreshed.token, refreshed.userId, localDateISO);
    }
  };
}

function createMembershipProjectsFetcher() {
  const session = createResourceOptimiserSession();
  return async () => {
    const { token, userId } = await session.get();
    try {
      return await getProjects(token, userId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getProjects(refreshed.token, refreshed.userId);
    }
  };
}

function createLogtimeSubmitter() {
  const session = createResourceOptimiserSession();
  return async (entry) => {
    const { token } = await session.get();
    try {
      return await addLogtime(token, entry);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return addLogtime(refreshed.token, entry);
    }
  };
}

function applyOverridesToBatch(batch, projectOverrides) {
  if (!projectOverrides || !Object.keys(projectOverrides).length) {
    return batch;
  }

  const entries = (batch.entries || []).map((entry) => {
    if (!Object.hasOwn(projectOverrides, entry.id)) {
      return entry;
    }

    const candidates = (entry.candidates || []).map((candidate) => ({
      projectMemberId: candidate.projectMemberId,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      booked: candidate.booked
    }));
    if (entry.matchedProject) {
      candidates.push({
        ...entry.matchedProject,
        booked: Boolean(entry.booked)
      });
    }

    const preview = buildLogworkBatchPreview({
      parsed: {
        entries: [entry],
        errors: []
      },
      projectsByDate: new Map([[entry.date, candidates.filter((candidate) => candidate.booked)]]),
      membershipProjects: candidates,
      projectOverrides,
      config: { projectMappings: [] }
    });
    return preview.entries[0];
  });

  const unresolvedEntries = entries.filter((entry) => entry.status === 'unresolved');
  const unbookedEntries = entries.filter((entry) => entry.status === 'resolved_unbooked');
  const setupSuggestions = buildSetupSuggestions(unresolvedEntries, entries.flatMap((entry) => entry.candidates || []));
  return {
    ...batch,
    status: getBatchStatus(batch.errors || [], unresolvedEntries, unbookedEntries),
    entries,
    unresolvedEntries,
    unbookedEntries,
    setupSuggestions,
    totalsByDate: totalsBy(entries, (entry) => entry.date),
    totalsByProject: totalsBy(entries.filter((entry) => entry.matchedProject), (entry) => entry.matchedProject.projectName),
    summary: formatPreviewSummary(entries, batch.errors || [], setupSuggestions)
  };
}

async function buildApplyVerification({ preview, results, cwd, verifyLogwork }) {
  if (results.some((result) => result.dryRun)) {
    return null;
  }

  const dates = [...new Set(preview.entries.map((entry) => entry.date))].sort();
  if (!dates.length) {
    return null;
  }

  const from = dates[0];
  const to = addOneDay(dates[dates.length - 1]);
  const verifier = verifyLogwork || ((args) => queryLogwork({
    ...args,
    cwd,
    includeEntries: false
  }));

  return verifier({ from, to, includeEntries: false });
}

function addOneDay(localDateISO) {
  const [year, month, day] = localDateISO.split('-').map(Number);
  const date = new Date(year, month - 1, day + 1);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function createBatchId(entries, projectOverrides) {
  const source = JSON.stringify({
    entries: entries.map((entry) => [entry.id, entry.date, entry.hours, entry.taskName]),
    projectOverrides
  });
  return `batch_${hash(source)}`;
}

function getBatchStatus(errors, unresolvedEntries, unbookedEntries) {
  if (errors.length) {
    return 'invalid';
  }

  if (unresolvedEntries.length) {
    return 'unresolved';
  }

  if (unbookedEntries.length) {
    return 'ready_with_unbooked';
  }

  return 'ready';
}

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16);
}

function totalsBy(entries, keyFn) {
  return entries.reduce((totals, entry) => {
    const key = keyFn(entry);
    totals[key] = Number((Number(totals[key] || 0) + Number(entry.hours || 0)).toFixed(2));
    return totals;
  }, {});
}

function formatPreviewSummary(entries, errors, setupSuggestions = []) {
  if (errors.length) {
    return [
      'Logwork preview has parse errors:',
      ...errors.map((error) => `- line ${error.line}: ${error.message}`)
    ].join('\n');
  }

  const lines = ['Logwork preview:'];
  for (const entry of entries) {
    const project = entry.matchedProject?.projectName || 'UNRESOLVED';
    const prefix = entry.status === 'resolved_unbooked' ? 'UNBOOKED: ' : '';
    lines.push(`- ${entry.date}: ${prefix}+${entry.hours}h ${project} - ${entry.taskName}`);
  }
  const unresolved = entries.filter((entry) => entry.status === 'unresolved').length;
  const unbooked = entries.filter((entry) => entry.status === 'resolved_unbooked').length;
  if (unresolved) {
    lines.push(`Unresolved entries: ${unresolved}`);
    if (setupSuggestions.length) {
      lines.push('Choose a project and call upsert_project_mapping, then preview again.');
    }
  } else if (unbooked) {
    lines.push(`Unbooked entries: ${unbooked}. Apply requires allowUnbooked: true.`);
  } else {
    lines.push('Ready to apply.');
  }
  return lines.join('\n');
}

function formatApplySummary(results) {
  return [
    results.some((result) => result.dryRun) ? 'DRY RUN: logwork payloads generated.' : 'Logwork submitted:',
    ...results.map((result) => `- ${result.date}: +${result.hours}h ${result.projectName} - ${result.taskName}`)
  ].join('\n');
}
