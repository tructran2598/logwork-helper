import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listLogworkProjects,
  upsertProjectMapping
} from '../lib/project-mapping-workflow.mjs';
import { previewLogworkBatch } from '../lib/batch-workflow.mjs';

const projects = [
  {
    projectMemberId: 5234,
    projectId: 643,
    projectName: '2621A-SIT-HTML BUILDER-PRJ'
  }
];

test('upsertProjectMapping creates .logwork-helper.json and preview can use it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-test-'));

  const result = await upsertProjectMapping({
    cwd,
    projectMemberId: 5234,
    tickets: ['scb'],
    keywords: ['question bank'],
    confirm: true,
    fetchProjects: async () => projects
  });

  assert.equal(result.status, 'created');
  assert.deepEqual(result.mapping, {
    projectName: '2621A-SIT-HTML BUILDER-PRJ',
    projectMemberId: 5234,
    tickets: ['SCB'],
    keywords: ['question bank']
  });

  const file = JSON.parse(await fs.readFile(join(cwd, '.logwork-helper.json'), 'utf8'));
  assert.equal(file.projectMappings[0].projectName, '2621A-SIT-HTML BUILDER-PRJ');

  const preview = await previewLogworkBatch({
    cwd,
    text: `Monday, 01 Jun 2026
+2 Maintenance mode management (SCB-213)`.replace('++', '+'),
    fetchProjects: async () => [],
    fetchMembershipProjects: async () => projects
  });

  assert.equal(preview.status, 'ready_with_unbooked');
  assert.equal(preview.entries[0].status, 'resolved_unbooked');
  assert.equal(preview.entries[0].matchedProject.projectMemberId, 5234);
});

test('upsertProjectMapping merges existing mapping and dedupes tickets and keywords', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-test-'));
  await fs.writeFile(join(cwd, '.logwork-helper.json'), JSON.stringify({
    projectMappings: [
      {
        projectName: '2621A-SIT-HTML BUILDER-PRJ',
        projectMemberId: 5234,
        tickets: ['SCB'],
        keywords: ['question bank']
      }
    ]
  }), 'utf8');

  const result = await upsertProjectMapping({
    cwd,
    projectName: 'HTML BUILDER',
    tickets: ['SCB', 'scb', 'NEW'],
    keywords: ['programme', 'question bank'],
    confirm: true,
    fetchProjects: async () => projects
  });

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.mapping.tickets, ['SCB', 'NEW']);
  assert.deepEqual(result.mapping.keywords, ['question bank', 'programme']);
});

test('upsertProjectMapping rejects invalid project without writing config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-test-'));

  await assert.rejects(
    () => upsertProjectMapping({
      cwd,
      projectMemberId: 9999,
      tickets: ['SCB'],
      confirm: true,
      fetchProjects: async () => projects
    }),
    /was not found/
  );

  await assert.rejects(
    () => fs.readFile(join(cwd, '.logwork-helper.json'), 'utf8'),
    /ENOENT/
  );
});

test('upsertProjectMapping requires explicit confirm true', async () => {
  await assert.rejects(
    () => upsertProjectMapping({
      projectMemberId: 5234,
      tickets: ['SCB'],
      confirm: false,
      fetchProjects: async () => projects
    }),
    /confirm: true/
  );
});

test('listLogworkProjects returns memberships and current mappings', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-test-'));
  await upsertProjectMapping({
    cwd,
    projectMemberId: 5234,
    tickets: ['SCB'],
    confirm: true,
    fetchProjects: async () => projects
  });

  const result = await listLogworkProjects({
    cwd,
    fetchProjects: async () => projects
  });

  assert.deepEqual(result.projects, projects);
  assert.equal(result.mappings.length, 1);
  assert.match(result.summary, /Found 1 Resource Optimiser project memberships/);
});
