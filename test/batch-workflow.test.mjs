import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLogworkBatch,
  buildLogworkBatchPreview
} from '../lib/batch-workflow.mjs';
import { parseWeeklyLogText } from '../lib/batch-parser.mjs';

const weeklyText = `Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
+1 System page updates`;

const parsed = parseWeeklyLogText(weeklyText);
const projectsByDate = new Map([
  ['2026-06-01', [{ projectMemberId: 5352, projectId: 1, projectName: 'Course Builder' }]]
]);

test('buildLogworkBatchPreview returns ready batch with totals', () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });

  assert.equal(preview.status, 'ready');
  assert.equal(preview.entries.length, 2);
  assert.deepEqual(preview.entries[0].resolution, {
    status: 'resolved',
    reason: 'single_booked_project',
    confidence: 0.95,
    booked: true,
    autoResolved: true,
    requiresUserChoice: false,
    requiresAllowUnbooked: false,
    candidates: []
  });
  assert.deepEqual(preview.totalsByDate, { '2026-06-01': 3 });
  assert.deepEqual(preview.totalsByProject, { 'Course Builder': 3 });
  assert.match(preview.summary, /via single_booked_project, confidence 0.95/);
});

test('buildLogworkBatchPreview marks mapped membership without booking as ready_with_unbooked', () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(preview.status, 'ready_with_unbooked');
  assert.equal(preview.entries[0].status, 'resolved_unbooked');
  assert.equal(preview.entries[0].booked, false);
  assert.equal(preview.entries[0].requiresAllowUnbooked, true);
  assert.equal(preview.entries[0].resolution.requiresAllowUnbooked, true);
  assert.equal(preview.entries[0].resolution.autoResolved, true);
  assert.equal(preview.entries[0].matchedProject.projectMemberId, 5234);
  assert.match(preview.summary, /UNBOOKED: \+2h/);
});

test('buildLogworkBatchPreview keeps ticket mapping conflicts unresolved', async () => {
  const conflictParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`);
  const preview = buildLogworkBatchPreview({
    parsed: conflictParsed,
    projectsByDate: new Map([[
      '2026-06-01',
      [{ projectMemberId: 1, projectId: 10, projectName: 'Internal' }]
    ]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectMemberId: 5234, projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(preview.status, 'unresolved');
  assert.equal(preview.entries[0].matchedProject, null);
  assert.equal(preview.entries[0].reason, 'single_booked_project_conflicts_with_mapping');
  assert.equal(preview.entries[0].resolution.requiresUserChoice, true);
  assert.equal(preview.entries[0].resolution.autoResolved, false);
  assert.deepEqual(preview.entries[0].candidates.map((candidate) => candidate.source), [
    'config_ticket',
    'single_booked_project'
  ]);
  assert.match(preview.summary, /needs user choice single_booked_project_conflicts_with_mapping, confidence 0.99/);

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: true,
      submitEntry: async () => ({ dryRun: true })
    }),
    /unresolved/
  );
});

test('buildLogworkBatchPreview suggests mapping setup for unresolved ticket entries', () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ]
  });

  assert.equal(preview.status, 'unresolved');
  assert.equal(preview.setupSuggestions.length, 1);
  assert.equal(preview.setupSuggestions[0].ticketPrefixes[0], 'SCB');
  assert.deepEqual(preview.setupSuggestions[0].candidateProjects[0].toolArguments, {
    projectMemberId: 5234,
    tickets: ['SCB'],
    keywords: [],
    confirm: true
  });
  assert.match(preview.summary, /upsert_project_mapping/);
});

test('applyLogworkBatch requires confirm true', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: false,
      submitEntry: async () => ({ dryRun: true })
    }),
    /confirm: true/
  );
});

test('applyLogworkBatch blocks unresolved entries', async () => {
  const preview = buildLogworkBatchPreview({
    parsed,
    projectsByDate: new Map([['2026-06-01', []]])
  });

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: true,
      submitEntry: async () => ({ dryRun: true })
    }),
    /unresolved/
  );
});

test('applyLogworkBatch submits one payload per line', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  const payloads = [];

  const result = await applyLogworkBatch({
    batch: preview,
    confirm: true,
    submitEntry: async (payload) => {
      payloads.push(payload);
      return { dryRun: true, body: payload };
    },
    verifyLogwork: async () => {
      throw new Error('dry run should not verify');
    }
  });

  assert.equal(result.status, 'submitted');
  assert.equal(result.dryRun, true);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], {
    projectMemberId: 5352,
    logtimes: 2,
    taskName: 'Maintenance mode management and status UI (SCB-213)',
    localDateISO: '2026-06-01'
  });
  assert.equal(result.verification, null);
});

test('applyLogworkBatch blocks unbooked entries without allowUnbooked true', async () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });
  const payloads = [];

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: true,
      submitEntry: async (payload) => {
        payloads.push(payload);
        return { dryRun: true };
      }
    }),
    /allowUnbooked: true/
  );
  assert.equal(payloads.length, 0);
});

test('applyLogworkBatch submits unbooked entries with allowUnbooked true', async () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });
  const payloads = [];

  const result = await applyLogworkBatch({
    batch: preview,
    confirm: true,
    allowUnbooked: true,
    submitEntry: async (payload) => {
      payloads.push(payload);
      return { dryRun: true, body: payload };
    }
  });

  assert.equal(result.status, 'submitted');
  assert.deepEqual(payloads, [
    {
      projectMemberId: 5234,
      logtimes: 2,
      taskName: 'Maintenance mode management and status UI (SCB-213)',
      localDateISO: '2026-06-01'
    }
  ]);
});

test('applyLogworkBatch verifies submitted date range after real submit', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  const verificationCalls = [];

  const result = await applyLogworkBatch({
    batch: preview,
    confirm: true,
    submitEntry: async () => ({ ok: true }),
    verifyLogwork: async (args) => {
      verificationCalls.push(args);
      return {
        range: { from: args.from, to: args.to },
        totals: { loggedHours: 3, bookedHours: 8 }
      };
    }
  });

  assert.equal(result.verification.totals.loggedHours, 3);
  assert.deepEqual(verificationCalls, [
    { from: '2026-06-01', to: '2026-06-02', includeEntries: false }
  ]);
});
