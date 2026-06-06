import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDayLogs,
  getTimesheetRange,
  normalizeLogtimeEntries,
  normalizeTimesheetRange
} from '../lib/api.mjs';

test('getTimesheetRange builds expected query params', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await getTimesheetRange('token', 115, {
      from: '2026-05-18',
      to: '2026-06-29'
    });

    assert.equal(requestedUrl.pathname, '/api/v1/member-logtime/timesheet');
    assert.equal(requestedUrl.searchParams.get('f_user_id'), '115');
    assert.equal(requestedUrl.searchParams.get('f_from'), '2026-05-18T00:00:00.000Z');
    assert.equal(requestedUrl.searchParams.get('f_to'), '2026-06-29T00:00:00.000Z');
    assert.equal(requestedUrl.searchParams.get('f_timesheet_by_week'), '0');
    assert.equal(requestedUrl.searchParams.get('f_time_off'), '1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeTimesheetRange returns day/project records and totals duplicate rows', () => {
  const records = normalizeTimesheetRange({
    data: [
      {
        date: '2026-06-05',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 4,
        logged_hours: 2,
        logs: [{ id: 1, logtimes: 2, task_name: 'A' }]
      },
      {
        logdate: '2026-06-05T00:00:00.000Z',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 2,
        logged_hours: 1
      },
      {
        date: '2026-06-06',
        project_member_id: 9999,
        project_id: 200,
        project_name: 'Internal',
        booked_hours: 1,
        logged_hours: 0
      }
    ]
  }, {
    from: '2026-06-05',
    to: '2026-06-07'
  });

  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    date: '2026-06-05',
    projectMemberId: 5352,
    projectId: 100,
    projectName: 'Course Builder',
    bookedHours: 6,
    loggedHours: 3,
    entries: [
      {
        id: 1,
        date: '2026-06-05',
        projectMemberId: 5352,
        projectId: 100,
        projectName: 'Course Builder',
        hours: 2,
        taskName: 'A',
        raw: { id: 1, logtimes: 2, task_name: 'A' }
      }
    ],
    raw: [
      {
        date: '2026-06-05',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 4,
        logged_hours: 2,
        logs: [{ id: 1, logtimes: 2, task_name: 'A' }]
      },
      {
        logdate: '2026-06-05T00:00:00.000Z',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 2,
        logged_hours: 1
      }
    ]
  });
});

test('normalizeTimesheetRange expands real project timesheet shape and ignores overall', () => {
  const records = normalizeTimesheetRange({
    data: [
      {
        id: 5234,
        user_id: 115,
        project: {
          id: 643,
          name: '2621A-SIT-HTML BUILDER-PRJ',
          is_internal: false
        },
        timesheet: [
          {
            logdate: '2026-06-01T00:00:00.000Z',
            logtimes: 8,
            assign_percent: 8,
            overtime: 0
          },
          {
            logdate: '2026-06-02T00:00:00.000Z',
            logtimes: 0,
            assign_percent: 8,
            overtime: 0
          }
        ]
      }
    ],
    overall: [
      {
        logdate: '2026-06-01T00:00:00.000Z',
        logtimes: 99,
        assign_percent: 99,
        overtime: 0
      }
    ]
  }, {
    from: '2026-06-01',
    to: '2026-06-03'
  });

  assert.deepEqual(records, [
    {
      date: '2026-06-01',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 8,
      entries: [],
      raw: [
        {
          date: '2026-06-01',
          projectMemberId: 5234,
          project_member_id: 5234,
          projectId: 643,
          project_id: 643,
          projectName: '2621A-SIT-HTML BUILDER-PRJ',
          project_name: '2621A-SIT-HTML BUILDER-PRJ',
          bookedHours: 8,
          loggedHours: 8,
          overtime: 0,
          source: 'timesheet'
        }
      ]
    },
    {
      date: '2026-06-02',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 0,
      entries: [],
      raw: [
        {
          date: '2026-06-02',
          projectMemberId: 5234,
          project_member_id: 5234,
          projectId: 643,
          project_id: 643,
          projectName: '2621A-SIT-HTML BUILDER-PRJ',
          project_name: '2621A-SIT-HTML BUILDER-PRJ',
          bookedHours: 8,
          loggedHours: 0,
          overtime: 0,
          source: 'timesheet'
        }
      ]
    }
  ]);
});

test('getDayLogs builds expected detail query params', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      data: [{ id: 1, logtimes: 2, task_name: 'Task A' }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await getDayLogs('token', 643, 115, '2026-06-01');

    assert.equal(requestedUrl.pathname, '/api/v1/member-logtime');
    assert.equal(requestedUrl.searchParams.get('f_user_id'), '115');
    assert.equal(requestedUrl.searchParams.get('f_project_id'), '643');
    assert.equal(requestedUrl.searchParams.get('f_logdate'), '2026-06-01T00:00:00.000Z');
    assert.equal(result.entries[0].taskName, 'Task A');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeLogtimeEntries returns sanitized task entries', () => {
  const entries = normalizeLogtimeEntries([
    {
      id: 99,
      logdate: '2026-06-01T00:00:00.000Z',
      project_id: 643,
      project_name: 'Course Builder',
      logtimes: 1.5,
      task_name: 'Question bank cleanup',
      token: 'must-not-appear'
    }
  ], {
    date: '2026-06-01'
  });

  assert.deepEqual(entries, [
    {
      id: 99,
      date: '2026-06-01',
      projectMemberId: undefined,
      projectId: 643,
      projectName: 'Course Builder',
      hours: 1.5,
      taskName: 'Question bank cleanup'
    }
  ]);
});
