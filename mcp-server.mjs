#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError } from './lib/api.mjs';
import {
  applyLogworkBatch,
  formatToolResponse,
  previewLogworkBatch
} from './lib/batch-workflow.mjs';
import { authRequiredPayload, isAuthRequiredError } from './lib/auth-errors.mjs';
import { startAuthLoginTerminal } from './lib/auth-terminal.mjs';
import { isMainModule } from './lib/entrypoint.mjs';
import {
  jiraAuthRequiredPayload,
  getStoredJiraSession,
  isJiraAuthRequiredError
} from './lib/jira-auth.mjs';
import { getJiraIssue } from './lib/jira-api.mjs';
import {
  applyJiraWorklogBatch,
  previewJiraWorklogBatch
} from './lib/jira-workflow.mjs';
import {
  listLogworkProjects,
  upsertProjectMapping
} from './lib/project-mapping-workflow.mjs';
import { readPackageVersion } from './lib/package-info.mjs';
import { queryLogwork } from './lib/query-workflow.mjs';

const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_PREVIEWS = 100;
const previews = new Map();
const jiraPreviews = new Map();

const server = new McpServer({
  name: 'logwork-helper',
  version: readPackageVersion()
});

server.registerTool('preview_logwork_batch', {
  description: 'Resource Optimiser only: parse a weekly logwork text block, resolve booked RO projects by date, and return an approval preview. Use Jira tools separately for Jira worklogs.',
  inputSchema: {
    text: z.string().min(1).describe('Weekly log block with headings like Monday, 01 Jun 2026 and entries like +2 Task.'),
    timezone: z.string().optional().describe('Reserved for future date parsing; current parser uses explicit dates in the text.'),
    projectOverrides: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Map preview entry id to projectMemberId.')
  }
}, withAuthRequiredHandling(async ({ text, projectOverrides = {} }) => {
  prunePreviewCache(previews);
  const preview = await previewLogworkBatch({ text, projectOverrides });
  setCachedPreview(previews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('apply_logwork_batch', {
  description: 'Resource Optimiser only: submit an approved RO logwork preview. Requires confirm: true and blocks unresolved entries. Does not write Jira worklogs.',
  inputSchema: {
    batchId: z.string().optional().describe('batchId returned by preview_logwork_batch. Required for apply.'),
    batch: z.any().optional().describe('Backward-compatible structured preview echo. When provided, it must match the cached preview for batchId.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.'),
    allowUnbooked: z.boolean().optional().describe('Allow submitting entries resolved to a valid project membership without a booking for that date.'),
    projectOverrides: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Deprecated for apply. Project overrides must be included during preview so approval covers the final project selection.')
  }
}, withAuthRequiredHandling(async ({ batchId, batch, confirm, allowUnbooked = false, projectOverrides = {} }) => {
  prunePreviewCache(previews);
  assertNoFinalProjectOverrides(projectOverrides);
  if (confirm !== true) {
    throw new Error('apply_logwork_batch requires confirm: true.');
  }
  const approvedBatch = consumeApprovedBatch({
    cache: previews,
    batchId,
    batch
  });

  const result = await applyLogworkBatch({
    batch: approvedBatch,
    confirm,
    allowUnbooked
  });
  return formatToolResponse(result);
}));

server.registerTool('query_logwork', {
  description: 'Read-only query for logged/booked Resource Optimiser work by preset period and optional project filter.',
  inputSchema: {
    period: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']).optional().describe('Preset query period. Defaults to today.'),
    project: z.union([z.string(), z.number()]).optional().describe('Project filter by projectMemberId, projectId, name, ticket prefix, or mapping keyword.'),
    includeEntries: z.boolean().optional().describe('Whether to include task-level log entries. Defaults to true.')
  }
}, withAuthRequiredHandling(async ({ period, project, includeEntries = true }) => {
  const result = await queryLogwork({
    period,
    project,
    includeEntries
  });
  return formatToolResponse(result);
}));

server.registerTool('list_logwork_projects', {
  description: 'List Resource Optimiser project memberships and current local logwork project mappings without changing data.',
  inputSchema: {}
}, withAuthRequiredHandling(async () => {
  const result = await listLogworkProjects();
  return formatToolResponse(result);
}));

server.registerTool('upsert_project_mapping', {
  description: 'Create or update a local ticket/keyword-to-project mapping after explicit user approval.',
  inputSchema: {
    projectMemberId: z.union([z.string(), z.number()]).optional().describe('Resource Optimiser project_member_id chosen from list_logwork_projects or preview setupSuggestions.'),
    projectName: z.string().optional().describe('Project name to match against user project memberships when projectMemberId is not provided.'),
    tickets: z.array(z.string()).min(1).describe('Ticket prefixes to map, for example ["SCB"].'),
    keywords: z.array(z.string()).optional().describe('Optional task keywords to map to the project.'),
    scope: z.enum(['user', 'project']).optional().describe('Where to write the mapping. Defaults to user: ~/.logwork-helper/.logwork-helper.json.'),
    confirm: z.boolean().describe('Must be true after explicit user approval because this writes .logwork-helper.json.')
  }
}, withAuthRequiredHandling(async ({ projectMemberId, projectName, tickets, keywords = [], scope = 'user', confirm }) => {
  const result = await upsertProjectMapping({
    projectMemberId,
    projectName,
    tickets,
    keywords,
    scope,
    confirm
  });
  return formatToolResponse(result);
}));

server.registerTool('start_auth_login', {
  description: 'Resource Optimiser auth only: start or explain a local RO auth login session. No credentials are accepted by this MCP tool.',
  inputSchema: {}
}, async () => {
  const result = await startAuthLoginTerminal();
  return formatToolResponse(result);
});

server.registerTool('start_jira_auth', {
  description: 'Explain how to start a local Jira PAT login session. No Jira token or password is accepted by this MCP tool.',
  inputSchema: {}
}, async () => formatToolResponse({
  status: 'jira_auth_required',
  authRequired: true,
  command: 'logwork-helper jira login',
  summary: 'Run `logwork-helper jira login` in a terminal and paste a Jira Personal Access Token there, then retry the MCP tool.'
}));

server.registerTool('get_jira_issue', {
  description: 'Read a Jira issue by key from the configured self-hosted Jira instance.',
  inputSchema: {
    issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).describe('Jira issue key, for example SCB-213.')
  }
}, withJiraAuthRequiredHandling(async ({ issueKey }) => {
  const session = await getStoredJiraSession();
  const issue = await getJiraIssue(session.token, issueKey, {
    baseUrl: session.baseUrl
  });
  return formatToolResponse({
    status: 'ok',
    issue,
    summary: `${issue.key}: ${issue.summary} (${issue.status || 'unknown status'})`
  });
}));

server.registerTool('preview_jira_worklog_batch', {
  description: 'Jira only: parse a weekly logwork text block, validate Jira issue keys, detect duplicate Jira worklogs, and return an approval preview. Use RO tools separately for Resource Optimiser.',
  inputSchema: {
    text: z.string().min(1).describe('Weekly log block with headings like Monday, 01 Jun 2026 and entries like +2 Task (SCB-213).')
  }
}, withJiraAuthRequiredHandling(async ({ text }) => {
  prunePreviewCache(jiraPreviews);
  const preview = await previewJiraWorklogBatch({ text });
  setCachedJiraPreview(jiraPreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('apply_jira_worklog_batch', {
  description: 'Jira only: submit an approved Jira worklog preview. Requires confirm: true and a cached batchId from preview_jira_worklog_batch. Does not write Resource Optimiser logwork.',
  inputSchema: {
    batchId: z.string().optional().describe('batchId returned by preview_jira_worklog_batch. Required for apply.'),
    batch: z.any().optional().describe('Backward-compatible structured preview echo. When provided, it must match the cached preview for batchId.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.')
  }
}, withJiraAuthRequiredHandling(async ({ batchId, batch, confirm }) => {
  prunePreviewCache(jiraPreviews);
  if (confirm !== true) {
    throw new Error('apply_jira_worklog_batch requires confirm: true.');
  }
  const approvedBatch = consumeApprovedJiraBatch({
    cache: jiraPreviews,
    batchId,
    batch
  });
  const result = await applyJiraWorklogBatch({
    batch: approvedBatch,
    confirm
  });
  return formatToolResponse(result);
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error('Logwork Helper MCP server error:', error);
    process.exit(1);
  });
}

export function setCachedPreview(cache, preview, now = Date.now()) {
  prunePreviewCache(cache, now);
  const cachedPreview = clonePreview(preview);
  cache.set(cachedPreview.batchId, {
    preview: cachedPreview,
    fingerprint: createPreviewFingerprint(cachedPreview),
    expiresAt: now + PREVIEW_TTL_MS
  });
  prunePreviewCache(cache, now);
}

export function getCachedPreview(cache, batchId, now = Date.now()) {
  const cached = getCachedPreviewRecord(cache, batchId, now);
  return cached ? clonePreview(cached.preview) : null;
}

export function setCachedJiraPreview(cache, preview, now = Date.now()) {
  prunePreviewCache(cache, now);
  const cachedPreview = clonePreview(preview);
  cache.set(cachedPreview.batchId, {
    preview: cachedPreview,
    fingerprint: createJiraPreviewFingerprint(cachedPreview),
    expiresAt: now + PREVIEW_TTL_MS
  });
  prunePreviewCache(cache, now);
}

export function getCachedJiraPreview(cache, batchId, now = Date.now()) {
  const cached = getCachedPreviewRecord(cache, batchId, now);
  return cached ? clonePreview(cached.preview) : null;
}

function getCachedPreviewRecord(cache, batchId, now = Date.now()) {
  const cached = cache.get(batchId);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    cache.delete(batchId);
    return null;
  }

  return cached;
}

export function prunePreviewCache(cache, now = Date.now()) {
  for (const [batchId, cached] of cache.entries()) {
    if (cached.expiresAt <= now) {
      cache.delete(batchId);
    }
  }

  while (cache.size > MAX_PREVIEWS) {
    const oldestBatchId = cache.keys().next().value;
    if (oldestBatchId === undefined) {
      break;
    }
    cache.delete(oldestBatchId);
  }
}

export function resolveApprovedBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  if (!batchId) {
    throw new Error('apply_logwork_batch requires batchId from preview_logwork_batch. Re-run preview_logwork_batch and apply using the returned batchId.');
  }

  if (batch?.batchId && batch.batchId !== batchId) {
    throw new Error(`Approved batch mismatch: batchId ${batchId} does not match batch.batchId ${batch.batchId}. Re-run preview_logwork_batch before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, batchId, now);
  if (!cached) {
    throw new Error('Missing cached preview for batchId. Re-run preview_logwork_batch and apply using the returned batchId.');
  }

  if (batch && createPreviewFingerprint(batch) !== cached.fingerprint) {
    throw new Error('Approved batch content changed after preview. Re-run preview_logwork_batch and apply using the returned batchId.');
  }

  return clonePreview(cached.preview);
}

export function consumeApprovedBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  const approvedBatch = resolveApprovedBatch({
    cache,
    batchId,
    batch,
    now
  });
  cache.delete(batchId);
  return approvedBatch;
}

export function resolveApprovedJiraBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  if (!batchId) {
    throw new Error('apply_jira_worklog_batch requires batchId from preview_jira_worklog_batch. Re-run preview_jira_worklog_batch and apply using the returned batchId.');
  }

  if (batch?.batchId && batch.batchId !== batchId) {
    throw new Error(`Approved Jira batch mismatch: batchId ${batchId} does not match batch.batchId ${batch.batchId}. Re-run preview_jira_worklog_batch before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, batchId, now);
  if (!cached) {
    throw new Error('Missing cached Jira preview for batchId. Re-run preview_jira_worklog_batch and apply using the returned batchId.');
  }

  if (batch && createJiraPreviewFingerprint(batch) !== cached.fingerprint) {
    throw new Error('Approved Jira batch content changed after preview. Re-run preview_jira_worklog_batch and apply using the returned batchId.');
  }

  return clonePreview(cached.preview);
}

export function consumeApprovedJiraBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  const approvedBatch = resolveApprovedJiraBatch({
    cache,
    batchId,
    batch,
    now
  });
  cache.delete(batchId);
  return approvedBatch;
}

export function assertNoFinalProjectOverrides(projectOverrides = {}) {
  if (!projectOverrides || typeof projectOverrides !== 'object' || !Object.keys(projectOverrides).length) {
    return;
  }

  throw new Error('apply_logwork_batch no longer accepts final projectOverrides. Re-run preview_logwork_batch with projectOverrides so the approved batchId covers the final project selection.');
}

export function createPreviewFingerprint(preview = {}) {
  return JSON.stringify({
    batchId: textOrNull(preview.batchId),
    status: textOrNull(preview.status),
    errors: arrayOrEmpty(preview.errors).map((error) => ({
      line: valueOrNull(error?.line),
      message: textOrNull(error?.message)
    })),
    entries: arrayOrEmpty(preview.entries).map((entry) => ({
      id: textOrNull(entry?.id),
      date: textOrNull(entry?.date),
      hours: numberOrNull(entry?.hours),
      taskName: textOrNull(entry?.taskName),
      tickets: arrayOrEmpty(entry?.tickets).map((ticket) => String(ticket)),
      status: textOrNull(entry?.status),
      reason: textOrNull(entry?.reason),
      confidence: numberOrNull(entry?.confidence),
      matchedProject: projectFingerprint(entry?.matchedProject),
      booked: booleanOrNull(entry?.booked),
      requiresAllowUnbooked: booleanOrNull(entry?.requiresAllowUnbooked)
    }))
  });
}

export function createJiraPreviewFingerprint(preview = {}) {
  return JSON.stringify({
    batchId: textOrNull(preview.batchId),
    status: textOrNull(preview.status),
    errors: arrayOrEmpty(preview.errors).map((error) => ({
      line: valueOrNull(error?.line),
      message: textOrNull(error?.message)
    })),
    entries: arrayOrEmpty(preview.entries).map((entry) => ({
      id: textOrNull(entry?.id),
      date: textOrNull(entry?.date),
      hours: numberOrNull(entry?.hours),
      taskName: textOrNull(entry?.taskName),
      tickets: arrayOrEmpty(entry?.tickets).map((ticket) => String(ticket)),
      issueKey: textOrNull(entry?.issueKey),
      status: textOrNull(entry?.status),
      reason: textOrNull(entry?.reason),
      issue: jiraIssueFingerprint(entry?.issue),
      duplicate: jiraDuplicateFingerprint(entry?.duplicate)
    }))
  });
}

function clonePreview(preview) {
  if (typeof structuredClone === 'function') {
    return structuredClone(preview);
  }
  return JSON.parse(JSON.stringify(preview));
}

function projectFingerprint(project) {
  if (!project || typeof project !== 'object') {
    return null;
  }

  return {
    projectMemberId: idOrNull(project.projectMemberId),
    projectId: idOrNull(project.projectId),
    projectName: textOrNull(project.projectName)
  };
}

function jiraIssueFingerprint(issue) {
  if (!issue || typeof issue !== 'object') {
    return null;
  }

  return {
    key: textOrNull(issue.key),
    summary: textOrNull(issue.summary),
    status: textOrNull(issue.status),
    issueType: textOrNull(issue.issueType)
  };
}

function jiraDuplicateFingerprint(worklog) {
  if (!worklog || typeof worklog !== 'object') {
    return null;
  }

  return {
    id: textOrNull(worklog.id),
    started: textOrNull(worklog.started),
    timeSpentSeconds: numberOrNull(worklog.timeSpentSeconds),
    comment: textOrNull(worklog.comment)
  };
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function textOrNull(value) {
  return value === undefined || value === null ? null : String(value);
}

function idOrNull(value) {
  return value === undefined || value === null || String(value).trim() === ''
    ? null
    : String(value);
}

function valueOrNull(value) {
  return value === undefined ? null : value;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return value === undefined || value === null ? null : Boolean(value);
}

function withAuthRequiredHandling(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        return formatToolResponse(authRequiredPayload(error));
      }
      throw error;
    }
  };
}

function withJiraAuthRequiredHandling(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (isJiraAuthRequiredError(error) || (error instanceof ApiError && error.status === 401)) {
        return formatToolResponse(jiraAuthRequiredPayload(error));
      }
      throw error;
    }
  };
}
