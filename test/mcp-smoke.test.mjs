import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
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
  const preview = {
    batchId: 'batch-safe',
    entries: [
      {
        id: 'entry_1',
        taskName: 'original task'
      }
    ]
  };

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
