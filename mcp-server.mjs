#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  applyLogworkBatch,
  formatToolResponse,
  previewLogworkBatch
} from './lib/batch-workflow.mjs';
import { queryLogwork } from './lib/query-workflow.mjs';

const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_PREVIEWS = 100;
const previews = new Map();

const server = new McpServer({
  name: 'logwork-helper',
  version: '0.1.0'
});

server.registerTool('preview_logwork_batch', {
  description: 'Parse a weekly logwork text block, resolve booked Resource Optimiser projects by date, and return an approval preview.',
  inputSchema: {
    text: z.string().min(1).describe('Weekly log block with headings like Monday, 01 Jun 2026 and entries like +2 Task.'),
    timezone: z.string().optional().describe('Reserved for future date parsing; current parser uses explicit dates in the text.'),
    projectOverrides: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Map preview entry id to projectMemberId.')
  }
}, async ({ text, projectOverrides = {} }) => {
  prunePreviewCache(previews);
  const preview = await previewLogworkBatch({ text, projectOverrides });
  setCachedPreview(previews, preview);
  return formatToolResponse(preview);
});

server.registerTool('apply_logwork_batch', {
  description: 'Submit an approved logwork preview. Requires confirm: true and blocks unresolved entries.',
  inputSchema: {
    batchId: z.string().optional().describe('batchId returned by preview_logwork_batch.'),
    batch: z.any().optional().describe('Full structured preview returned by preview_logwork_batch.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.'),
    allowUnbooked: z.boolean().optional().describe('Allow submitting entries resolved to a valid project membership without a booking for that date.'),
    projectOverrides: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Final map from preview entry id to projectMemberId.')
  }
}, async ({ batchId, batch, confirm, allowUnbooked = false, projectOverrides = {} }) => {
  prunePreviewCache(previews);
  const approvedBatch = batch || getCachedPreview(previews, batchId);
  if (!approvedBatch) {
    throw new Error('Missing approved batch. Pass batchId from preview_logwork_batch or the full structured batch.');
  }

  const result = await applyLogworkBatch({
    batch: approvedBatch,
    confirm,
    allowUnbooked,
    projectOverrides
  });
  if (batchId) {
    previews.delete(batchId);
  }
  return formatToolResponse(result);
});

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
}, async ({ date, from, to, period, project, includeEntries = true }) => {
  const result = await queryLogwork({
    date,
    from,
    to,
    period,
    project,
    includeEntries
  });
  return formatToolResponse(result);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('Logwork Helper MCP server error:', error);
    process.exit(1);
  });
}

export function setCachedPreview(cache, preview, now = Date.now()) {
  prunePreviewCache(cache, now);
  cache.set(preview.batchId, {
    preview,
    expiresAt: now + PREVIEW_TTL_MS
  });
  prunePreviewCache(cache, now);
}

export function getCachedPreview(cache, batchId, now = Date.now()) {
  const cached = cache.get(batchId);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    cache.delete(batchId);
    return null;
  }

  return cached.preview;
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

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
