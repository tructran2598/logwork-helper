#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  applyLogworkBatch,
  formatToolResponse,
  previewLogworkBatch
} from './lib/batch-workflow.mjs';
import { queryLogwork } from './lib/query-workflow.mjs';

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
  const preview = await previewLogworkBatch({ text, projectOverrides });
  previews.set(preview.batchId, preview);
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
  const approvedBatch = batch || previews.get(batchId);
  if (!approvedBatch) {
    throw new Error('Missing approved batch. Pass batchId from preview_logwork_batch or the full structured batch.');
  }

  const result = await applyLogworkBatch({
    batch: approvedBatch,
    confirm,
    allowUnbooked,
    projectOverrides
  });
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

main().catch((error) => {
  console.error('Logwork Helper MCP server error:', error);
  process.exit(1);
});
