import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJiraWorklogBatch,
  buildJiraWorklogPayload,
  createJiraWorklogComment,
  findDuplicateWorklog,
  formatJiraStarted,
  previewJiraWorklogBatch
} from '../lib/jira-workflow.mjs';

const weeklyText = `Monday, 01 Jun 2026
+2 Maintenance mode management (SCB-213)
Tuesday, 02 Jun 2026
+1 Fix regression (SCB-214)`;

test('Jira worklog payload formats started, seconds, and short marker comment', () => {
  const entry = {
    id: '2026-06-01-01',
    batchId: 'jira_batch',
    date: '2026-06-01',
    hours: 1.5,
    taskName: 'Maintenance mode'
  };

  assert.equal(formatJiraStarted('2026-06-01'), '2026-06-01T09:00:00.000+0700');
  assert.deepEqual(buildJiraWorklogPayload(entry), {
    started: '2026-06-01T09:00:00.000+0700',
    timeSpentSeconds: 5400,
    comment: createJiraWorklogComment(entry)
  });
  assert.match(createJiraWorklogComment(entry), /^Maintenance mode\n\n#lh:[a-f0-9]{8}$/);
});

test('Jira preview blocks missing and multiple issue keys without fetching Jira', async () => {
  let issueCalls = 0;
  const preview = await previewJiraWorklogBatch({
    text: `Monday, 01 Jun 2026
+1 No ticket task
+2 Multi ticket task (SCB-213, OPS-7)`,
    getSession: async () => fakeSession(),
    fetchIssue: async () => {
      issueCalls += 1;
      throw new Error('should not fetch');
    },
    fetchWorklogs: async () => []
  });

  assert.equal(preview.status, 'blocked');
  assert.deepEqual(preview.entries.map((entry) => entry.reason), ['missing_issue_key', 'multiple_issue_keys']);
  assert.equal(issueCalls, 0);
  assert.match(preview.summary, /Resolve blocked entries/);
});

test('Jira preview validates issue and blocks duplicate worklogs', async () => {
  const preview = await previewJiraWorklogBatch({
    text: weeklyText,
    getSession: async () => fakeSession(),
    fetchIssue: async (issueKey) => fakeIssue(issueKey),
    fetchWorklogs: async (issueKey) => issueKey === 'SCB-213'
      ? [{
        id: 'existing',
        started: '2026-06-01T10:00:00.000+0700',
        timeSpentSeconds: 7200,
        comment: 'Maintenance mode management (SCB-213)'
      }]
      : []
  });

  assert.equal(preview.status, 'blocked');
  assert.equal(preview.entries[0].status, 'duplicate');
  assert.equal(preview.entries[1].status, 'ready');
  assert.match(preview.summary, /duplicate_worklog/);
});

test('findDuplicateWorklog matches short marker, legacy marker, or same date seconds and task comment', () => {
  const entry = {
    id: 'entry-1',
    batchId: 'jira_batch',
    date: '2026-06-01',
    hours: 2,
    taskName: 'Maintenance mode'
  };

  assert.equal(Boolean(findDuplicateWorklog([{
    id: 'by-marker',
    started: '2026-06-02T09:00:00.000+0700',
    timeSpentSeconds: 60,
    comment: `${createJiraWorklogComment(entry)}`
  }], entry)), true);

  assert.equal(Boolean(findDuplicateWorklog([{
    id: 'by-legacy-marker',
    started: '2026-06-02T09:00:00.000+0700',
    timeSpentSeconds: 60,
    comment: 'Other\n\n[logwork-helper:jira_batch:entry-1]'
  }], entry)), true);

  assert.equal(Boolean(findDuplicateWorklog([{
    id: 'by-fields',
    started: '2026-06-01T12:00:00.000+0700',
    timeSpentSeconds: 7200,
    comment: ' maintenance   mode '
  }], entry)), true);
});

test('Jira apply rechecks duplicates before posting and blocks all writes', async () => {
  const batch = readyBatch();
  let submitCalls = 0;
  const result = await applyJiraWorklogBatch({
    batch,
    confirm: true,
    getSession: async () => fakeSession(),
    fetchWorklogs: async () => [{
      id: 'existing',
      started: '2026-06-01T09:00:00.000+0700',
      timeSpentSeconds: 7200,
      comment: 'Maintenance mode'
    }],
    submitWorklog: async () => {
      submitCalls += 1;
    }
  });

  assert.equal(result.status, 'blocked');
  assert.equal(submitCalls, 0);
  assert.match(result.summary, /apply blocked/);
});

test('Jira apply submits ready entries and stops on API failure', async () => {
  const batch = readyBatch();
  let submitCalls = 0;
  const result = await applyJiraWorklogBatch({
    batch,
    confirm: true,
    getSession: async () => fakeSession(),
    fetchWorklogs: async () => [],
    submitWorklog: async (issueKey, payload) => {
      submitCalls += 1;
      if (submitCalls === 2) {
        throw new Error('Jira rejected worklog');
      }
      assert.equal(issueKey, 'SCB-213');
      assert.equal(payload.timeSpentSeconds, 7200);
      return { id: 'worklog-1' };
    }
  });

  assert.equal(result.status, 'partial_failed');
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, 'submitted');
  assert.equal(result.results[1].status, 'failed');
  assert.match(result.summary, /failed 1/);
});

test('Jira apply requires explicit confirm true', async () => {
  await assert.rejects(() => applyJiraWorklogBatch({
    batch: readyBatch(),
    confirm: false
  }), /confirm: true/);
});

function readyBatch() {
  return {
    batchId: 'jira_batch',
    status: 'ready',
    entries: [
      {
        id: 'entry-1',
        batchId: 'jira_batch',
        date: '2026-06-01',
        hours: 2,
        taskName: 'Maintenance mode',
        tickets: ['SCB-213'],
        issueKey: 'SCB-213',
        status: 'ready',
        reason: 'single_issue_key'
      },
      {
        id: 'entry-2',
        batchId: 'jira_batch',
        date: '2026-06-02',
        hours: 1,
        taskName: 'Second task',
        tickets: ['SCB-214'],
        issueKey: 'SCB-214',
        status: 'ready',
        reason: 'single_issue_key'
      }
    ]
  };
}

function fakeSession() {
  return {
    baseUrl: 'https://jira.example.com',
    token: 'pat-secret'
  };
}

function fakeIssue(issueKey) {
  return {
    key: issueKey,
    summary: `Summary ${issueKey}`,
    status: 'In Progress',
    issueType: 'Task'
  };
}
