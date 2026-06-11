import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  assertNoFinalProjectOverrides,
  consumeApprovedBatch,
  getCachedPreview,
  resolveApprovedBatch,
  setCachedPreview
} from '../mcp-server.mjs';

test('MCP server lists logwork tools over stdio', async () => {
  const helperHome = await mkdtemp(join(tmpdir(), 'logwork-helper-home-'));
  const client = new Client({
    name: 'logwork-helper-test-client',
    version: '0.1.0'
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp-server.mjs'],
    cwd: process.cwd(),
    env: {
      LOGWORK_HELPER_HOME: helperHome
    },
    stderr: 'pipe'
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'apply_logwork_batch',
      'list_logwork_projects',
      'preview_logwork_batch',
      'query_logwork',
      'start_auth_login',
      'upsert_project_mapping'
    ]);
    const applyTool = result.tools.find((tool) => tool.name === 'apply_logwork_batch');
    assert.equal(applyTool.inputSchema.properties.allowUnbooked.type, 'boolean');
    assert.equal(applyTool.inputSchema.properties.projectOverrides.type, 'object');
    const setupTool = result.tools.find((tool) => tool.name === 'upsert_project_mapping');
    assert.equal(setupTool.inputSchema.properties.confirm.type, 'boolean');
    assert.deepEqual(setupTool.inputSchema.properties.scope.enum, ['user', 'project']);
    const queryTool = result.tools.find((tool) => tool.name === 'query_logwork');
    assert.deepEqual(queryTool.inputSchema.properties.period.enum, ['today', 'this_week']);
    const authTool = result.tools.find((tool) => tool.name === 'start_auth_login');
    assert.deepEqual(authTool.inputSchema.properties, {});
    assert.equal(authTool.inputSchema.properties.password, undefined);
    assert.equal(authTool.inputSchema.properties.otp, undefined);

    const preview = await client.callTool({
      name: 'preview_logwork_batch',
      arguments: {
        text: 'not a valid weekly log'
      }
    });
    assert.notEqual(preview.isError, true);
    assert.match(preview.content[0].text, /parse errors/);
  } finally {
    await client.close();
  }
});

test('MCP apply rejects final project overrides at boundary', () => {
  assert.throws(() => assertNoFinalProjectOverrides({
    entry_1: 5352
  }), /no longer accepts final projectOverrides/);
});

test('MCP preview cache expires old previews and caps stored batches', () => {
  const cache = new Map();
  const now = 1_000;

  setCachedPreview(cache, { batchId: 'expired' }, now);
  assert.equal(getCachedPreview(cache, 'expired', now + 60 * 60 * 1000), null);
  assert.equal(cache.has('expired'), false);

  for (let index = 0; index < 101; index += 1) {
    setCachedPreview(cache, { batchId: `batch-${index}` }, now);
  }

  assert.equal(cache.size, 100);
  assert.equal(getCachedPreview(cache, 'batch-0', now), null);
  assert.deepEqual(getCachedPreview(cache, 'batch-100', now), { batchId: 'batch-100' });
});

test('MCP preview cache clones previews and rejects mismatched approved batches', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();

  setCachedPreview(cache, preview, now);
  preview.entries[0].taskName = 'mutated before apply';

  const cached = getCachedPreview(cache, 'batch-safe', now);
  assert.equal(cached.entries[0].taskName, 'original task');
  cached.entries[0].taskName = 'mutated cached copy';
  assert.equal(getCachedPreview(cache, 'batch-safe', now).entries[0].taskName, 'original task');
  assert.equal(resolveApprovedBatch({ cache, batchId: 'batch-safe', now }).entries[0].taskName, 'original task');

  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: 'batch-safe',
    batch: {
      batchId: 'batch-other',
      entries: []
    },
    now
  }), /Approved batch mismatch/);
});

test('MCP apply requires cached preview provenance', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();

  assert.throws(() => resolveApprovedBatch({
    cache,
    batch: preview,
    now
  }), /requires batchId/);

  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    batch: preview,
    now
  }), /Missing cached preview/);

  setCachedPreview(cache, preview, now);
  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    now: now + 60 * 60 * 1000
  }), /Missing cached preview/);
});

test('MCP apply rejects mutated approved batch content', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();
  setCachedPreview(cache, preview, now);

  for (const mutate of [
    (batch) => { batch.entries[0].hours = 3; },
    (batch) => { batch.entries[0].taskName = 'forged task'; },
    (batch) => { batch.entries[0].status = 'resolved_unbooked'; },
    (batch) => { batch.entries[0].matchedProject.projectMemberId = 9999; }
  ]) {
    const mutated = structuredClone(preview);
    mutate(mutated);

    assert.throws(() => resolveApprovedBatch({
      cache,
      batchId: preview.batchId,
      batch: mutated,
      now
    }), /content changed/);
  }
});

test('MCP apply accepts matching batch echo but uses cached preview', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();
  setCachedPreview(cache, preview, now);

  const matchingEcho = structuredClone(preview);
  matchingEcho.summary = 'client display text changed';

  const approved = resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    batch: matchingEcho,
    now
  });

  assert.equal(approved.summary, preview.summary);
  matchingEcho.entries[0].taskName = 'mutated after approval';
  assert.equal(getCachedPreview(cache, preview.batchId, now).entries[0].taskName, preview.entries[0].taskName);
});

test('MCP apply consumes cached approval before submit work can await', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();
  setCachedPreview(cache, preview, now);

  const approved = consumeApprovedBatch({
    cache,
    batchId: preview.batchId,
    now
  });

  assert.equal(approved.entries[0].taskName, 'original task');
  assert.equal(getCachedPreview(cache, preview.batchId, now), null);
  assert.throws(() => consumeApprovedBatch({
    cache,
    batchId: preview.batchId,
    now
  }), /Missing cached preview/);
});

function createApprovedPreview() {
  return {
    batchId: 'batch-safe',
    status: 'ready',
    errors: [],
    entries: [
      {
        id: 'entry_1',
        date: '2026-06-01',
        hours: 2,
        taskName: 'original task',
        tickets: ['SCB-213'],
        status: 'resolved',
        reason: 'single_booked_project',
        confidence: 0.95,
        matchedProject: {
          projectMemberId: 5352,
          projectId: 1,
          projectName: 'Course Builder'
        },
        booked: true,
        requiresAllowUnbooked: false
      }
    ],
    summary: 'Logwork preview:\n- 2026-06-01: +2h Course Builder - original task'
  };
}
