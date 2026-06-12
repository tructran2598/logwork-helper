#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  applyLogworkBatch,
  formatToolResponse,
  previewLogworkBatch
} from './lib/batch-workflow.mjs';
import { authRequiredPayload, isAuthRequiredError } from './lib/auth-errors.mjs';
import { startAuthLoginTerminal } from './lib/auth-terminal.mjs';
import { isMainModule } from './lib/entrypoint.mjs';
import {
  listLogworkProjects,
  upsertProjectMapping
} from './lib/project-mapping-workflow.mjs';
import { readPackageVersion } from './lib/package-info.mjs';
import { queryLogwork } from './lib/query-workflow.mjs';

const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_PREVIEWS = 100;
const previews = new Map();

const server = new McpServer({
  name: 'logwork-helper',
  version: readPackageVersion()
});

server.registerTool('preview_logwork_batch', {
  description: 'Parse a weekly logwork text block, resolve booked Resource Optimiser projects by date, and return an approval preview.',
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
  description: 'Submit an approved logwork preview. Requires confirm: true and blocks unresolved entries.',
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
  description: 'Read-only query for logged/booked Resource Optimiser work by date, range, and optional project filter.',
  inputSchema: {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Single date to query in YYYY-MM-DD format.'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive start date in YYYY-MM-DD format. Defaults to today.'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Exclusive end date in YYYY-MM-DD format.'),
    period: z.enum(['today', 'this_week']).optional().describe('Convenience range. Explicit date/from/to take precedence.'),
    project: z.union([z.string(), z.number()]).optional().describe('Project filter by projectMemberId, projectId, name, ticket prefix, or mapping keyword.'),
    includeEntries: z.boolean().optional().describe('Whether to include task-level log entries. Defaults to true.')
  }
}, withAuthRequiredHandling(async ({ date, from, to, period, project, includeEntries = true }) => {
  const result = await queryLogwork({
    date,
    from,
    to,
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
  description: 'Start or explain a local Resource Optimiser auth login session. No credentials are accepted by this MCP tool.',
  inputSchema: {}
}, async () => {
  const result = await startAuthLoginTerminal();
  return formatToolResponse(result);
});

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
