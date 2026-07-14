import { createHash } from 'node:crypto';
import { parseWeeklyLogText } from './batch-parser.mjs';
import { ApiError } from './api.mjs';
import {
  addJiraIssueWorklog,
  getJiraIssue,
  getJiraIssueWorklogs
} from './jira-api.mjs';
import {
  createJiraAuthRequiredError,
  getStoredJiraSession,
  isJiraAuthRequiredError
} from './jira-auth.mjs';

const JIRA_WORKLOG_MARKER_PREFIX = 'lh';
const LEGACY_JIRA_WORKLOG_MARKER_PREFIX = 'logwork-helper';

export async function previewJiraWorklogBatch({
  text,
  getSession = getStoredJiraSession,
  fetchIssue,
  fetchWorklogs
} = {}) {
  const parsed = parseWeeklyLogText(text);
  const batchId = createJiraBatchId(parsed.entries);
  const session = await getSession();
  const issueFetcher = fetchIssue || ((issueKey) => getJiraIssue(session.token, issueKey, { baseUrl: session.baseUrl }));
  const worklogFetcher = fetchWorklogs || ((issueKey) => getJiraIssueWorklogs(session.token, issueKey, { baseUrl: session.baseUrl }));
  const entries = [];

  for (const entry of parsed.entries) {
    entries.push(await previewJiraEntry({
      entry,
      batchId,
      fetchIssue: issueFetcher,
      fetchWorklogs: worklogFetcher
    }));
  }

  const status = parsed.errors.length || !entries.length || entries.some((entry) => entry.status !== 'ready')
    ? 'blocked'
    : 'ready';

  return {
    batchId,
    status,
    errors: parsed.errors,
    entries,
    totals: buildJiraTotals(entries),
    summary: formatJiraPreviewSummary({ status, errors: parsed.errors, entries })
  };
}

export async function applyJiraWorklogBatch({
  batch,
  confirm,
  getSession = getStoredJiraSession,
  fetchWorklogs,
  submitWorklog
} = {}) {
  if (confirm !== true) {
    throw new Error('apply_jira_worklog_batch requires confirm: true.');
  }

  if (!batch?.batchId || !Array.isArray(batch.entries)) {
    throw new Error('apply_jira_worklog_batch requires a cached preview batch.');
  }

  const readyEntries = batch.entries.filter((entry) => entry.status === 'ready');
  const blockedEntries = batch.entries.filter((entry) => entry.status !== 'ready');
  if (blockedEntries.length || readyEntries.length !== batch.entries.length || !readyEntries.length) {
    return {
      batchId: batch.batchId,
      status: 'blocked',
      results: [],
      blockedEntries,
      summary: formatJiraApplyBlockedSummary(blockedEntries)
    };
  }

  const session = await getSession();
  const worklogFetcher = fetchWorklogs || ((issueKey) => getJiraIssueWorklogs(session.token, issueKey, { baseUrl: session.baseUrl }));
  const submitter = submitWorklog || ((issueKey, worklog) => addJiraIssueWorklog(session.token, issueKey, worklog, { baseUrl: session.baseUrl }));

  const duplicateEntries = [];
  for (const entry of readyEntries) {
    const duplicate = findDuplicateWorklog(await worklogFetcher(entry.issueKey), entry);
    if (duplicate) {
      duplicateEntries.push({
        ...entry,
        status: 'duplicate',
        reason: 'duplicate_worklog',
        duplicate
      });
    }
  }

  if (duplicateEntries.length) {
    return {
      batchId: batch.batchId,
      status: 'blocked',
      results: [],
      blockedEntries: duplicateEntries,
      summary: formatJiraApplyBlockedSummary(duplicateEntries)
    };
  }

  const results = [];
  for (const entry of readyEntries) {
    const payload = buildJiraWorklogPayload(entry);
    try {
      const worklog = await submitter(entry.issueKey, payload);
      results.push({
        entryId: entry.id,
        issueKey: entry.issueKey,
        date: entry.date,
        hours: entry.hours,
        status: 'submitted',
        worklogId: worklog?.id,
        worklog
      });
    } catch (error) {
      results.push({
        entryId: entry.id,
        issueKey: entry.issueKey,
        date: entry.date,
        hours: entry.hours,
        status: 'failed',
        error: error.message
      });
      break;
    }
  }

  const failed = results.some((result) => result.status === 'failed');
  return {
    batchId: batch.batchId,
    status: failed ? (results.some((result) => result.status === 'submitted') ? 'partial_failed' : 'failed') : 'submitted',
    results,
    summary: formatJiraApplySummary(results)
  };
}

export function buildJiraWorklogPayload(entry) {
  return {
    started: formatJiraStarted(entry.date),
    timeSpentSeconds: hoursToSeconds(entry.hours),
    comment: createJiraWorklogComment(entry)
  };
}

export function findDuplicateWorklog(worklogs = [], entry) {
  const markers = createJiraWorklogMarkers(entry);
  const expectedDate = String(entry.date || '');
  const expectedSeconds = hoursToSeconds(entry.hours);
  const expectedComment = normalizeDuplicateComment(entry.taskName);

  return (worklogs || []).find((worklog) => {
    const comment = String(worklog.comment || '');
    if (markers.some((marker) => comment.includes(marker))) {
      return true;
    }

    return normalizeDateOnly(worklog.started) === expectedDate &&
      Number(worklog.timeSpentSeconds || 0) === expectedSeconds &&
      normalizeDuplicateComment(stripJiraWorklogMarkers(comment)) === expectedComment;
  }) || null;
}

export function createJiraWorklogComment(entry) {
  return `${entry.taskName}\n\n${createJiraWorklogMarker(entry)}`;
}

export function createJiraWorklogMarker(entry) {
  const fingerprint = `${entry.batchId || ''}:${entry.id || ''}`;
  const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 8);
  return `#${JIRA_WORKLOG_MARKER_PREFIX}:${hash}`;
}

export function formatJiraStarted(localDateISO) {
  return `${localDateISO}T09:00:00.000+0700`;
}

export function createJiraBatchId(entries = []) {
  const fingerprint = JSON.stringify(entries.map((entry) => ({
    id: entry.id,
    date: entry.date,
    hours: entry.hours,
    taskName: entry.taskName,
    tickets: entry.tickets || []
  })));
  return `jira_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}

async function previewJiraEntry({
  entry,
  batchId,
  fetchIssue,
  fetchWorklogs
}) {
  const baseEntry = {
    ...entry,
    batchId,
    issueKey: entry.tickets?.length === 1 ? entry.tickets[0] : null
  };

  if (!entry.tickets?.length) {
    return {
      ...baseEntry,
      status: 'unresolved',
      reason: 'missing_issue_key'
    };
  }

  if (entry.tickets.length > 1) {
    return {
      ...baseEntry,
      status: 'unresolved',
      reason: 'multiple_issue_keys'
    };
  }

  try {
    const issue = await fetchIssue(baseEntry.issueKey);
    const duplicate = findDuplicateWorklog(await fetchWorklogs(baseEntry.issueKey), baseEntry);
    if (duplicate) {
      return {
        ...baseEntry,
        issue,
        status: 'duplicate',
        reason: 'duplicate_worklog',
        duplicate
      };
    }

    return {
      ...baseEntry,
      issue,
      status: 'ready',
      reason: 'single_issue_key'
    };
  } catch (error) {
    if (isJiraAuthRequiredError(error)) {
      throw error;
    }
    if (error instanceof ApiError && error.status === 401) {
      throw createJiraAuthRequiredError();
    }
    return {
      ...baseEntry,
      status: 'unresolved',
      reason: 'jira_lookup_failed',
      error: error.message
    };
  }
}

function buildJiraTotals(entries) {
  return {
    entryCount: entries.length,
    readyCount: entries.filter((entry) => entry.status === 'ready').length,
    blockedCount: entries.filter((entry) => entry.status !== 'ready').length,
    hours: roundHours(entries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0)),
    readyHours: roundHours(entries.filter((entry) => entry.status === 'ready').reduce((sum, entry) => sum + Number(entry.hours || 0), 0))
  };
}

function formatJiraPreviewSummary({ status, errors, entries }) {
  const lines = [
    `Jira worklog preview: ${status}. ${entries.length} entries, ${formatHours(entries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0))}h total.`
  ];

  if (errors.length) {
    lines.push('Parse errors:');
    for (const error of errors) {
      lines.push(`- line ${error.line}: ${error.message}`);
    }
  }

  for (const entry of entries) {
    const issue = entry.issueKey || 'UNRESOLVED';
    const suffix = entry.status === 'ready'
      ? ''
      : ` (${entry.reason}${entry.error ? `: ${entry.error}` : ''})`;
    lines.push(`- ${entry.date}: +${formatHours(entry.hours)}h ${issue} - ${entry.taskName} -> ${entry.status}${suffix}`);
  }

  if (status !== 'ready') {
    lines.push('Resolve blocked entries and preview again before applying Jira worklogs.');
  }

  return lines.join('\n');
}

function formatJiraApplyBlockedSummary(blockedEntries) {
  const lines = [
    `Jira worklog apply blocked: ${blockedEntries.length || 0} entries are not ready.`
  ];
  for (const entry of blockedEntries) {
    lines.push(`- ${entry.date}: ${entry.issueKey || 'UNRESOLVED'} ${entry.taskName} (${entry.reason || entry.status})`);
  }
  return lines.join('\n');
}

function formatJiraApplySummary(results) {
  const submitted = results.filter((result) => result.status === 'submitted');
  const failed = results.filter((result) => result.status === 'failed');
  const lines = [
    `Jira worklog apply: submitted ${submitted.length}, failed ${failed.length}.`
  ];
  for (const result of results) {
    lines.push(`- ${result.date}: ${result.issueKey} +${formatHours(result.hours)}h -> ${result.status}${result.error ? ` (${result.error})` : ''}`);
  }
  return lines.join('\n');
}

function hoursToSeconds(hours) {
  return Math.round(Number(hours || 0) * 3600);
}

function normalizeDuplicateComment(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripJiraWorklogMarkers(value) {
  return String(value || '')
    .replace(/\s*#lh:[a-f0-9]{6,16}\s*/gi, ' ')
    .replace(/\s*\[logwork-helper:[^\]]+\]\s*/g, ' ');
}

function createJiraWorklogMarkers(entry) {
  return [
    createJiraWorklogMarker(entry),
    `${LEGACY_JIRA_WORKLOG_MARKER_PREFIX}:${entry.batchId}:${entry.id}`
  ];
}

function normalizeDateOnly(value) {
  return String(value || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

function formatHours(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2))).replace(/\.0$/, '');
}

function roundHours(value) {
  return Number(Number(value || 0).toFixed(2));
}
