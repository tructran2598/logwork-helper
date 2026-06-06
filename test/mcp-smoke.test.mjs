import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP server lists logwork tools over stdio', async () => {
  const client = new Client({
    name: 'logwork-helper-test-client',
    version: '0.1.0'
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp-server.mjs'],
    cwd: process.cwd(),
    stderr: 'pipe'
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['apply_logwork_batch', 'preview_logwork_batch', 'query_logwork']);
    const applyTool = result.tools.find((tool) => tool.name === 'apply_logwork_batch');
    assert.equal(applyTool.inputSchema.properties.allowUnbooked.type, 'boolean');
    const queryTool = result.tools.find((tool) => tool.name === 'query_logwork');
    assert.deepEqual(queryTool.inputSchema.properties.period.enum, ['today', 'this_week']);

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
