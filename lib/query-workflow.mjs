import { CONFIG } from '../config.mjs';
import { getFreshToken, getUserIdFromJwt } from './auth.mjs';
import { ApiError, getDayLogs, getTimesheetRange } from './api.mjs';
import { loadLocalConfig } from './logwork-config.mjs';
import { addLocalDays, todayLocalDateISO } from './util.mjs';

export async function queryLogwork({
  date,
  from,
  to,
  period,
  project,
  includeEntries = true,
  cwd = process.cwd(),
  fetchRange,
  fetchDayLogs
} = {}) {
  const range = normalizeQueryRange({ date, from, to, period });
  const config = await loadLocalConfig(cwd);
  const rangeFetcher = fetchRange || createTimesheetRangeFetcher();
  const dayLogsFetcher = fetchDayLogs || createDayLogsFetcher();
  const records = await rangeFetcher(range);
  const filterResult = filterRecordsByProject(records, project, config);
  const filteredRecords = filterResult.records;
  const detail = includeEntries
    ? await collectEntries(filteredRecords, dayLogsFetcher)
    : { entries: [], missingDetailEntries: [] };

  const payload = {
    range,
    totals: buildTotals(filteredRecords),
    days: buildDays(filteredRecords, detail.entries),
    projects: buildProjects(filteredRecords),
    entries: detail.entries,
    missingDetailEntries: detail.missingDetailEntries,
    unmatchedProjectFilter: filterResult.unmatchedProjectFilter,
    summary: formatQuerySummary(filteredRecords, detail.entries, range, filterResult.unmatchedProjectFilter, detail.missingDetailEntries)
  };

  return payload;
}

export function normalizeQueryRange({ date, from, to, period } = {}) {
  if (date) {
    return {
      from: assertDateOnly(date, 'date'),
      to: addLocalDays(assertDateOnly(date, 'date'), 1)
    };
  }

  if (from || to) {
    const start = assertDateOnly(from || todayLocalDateISO(), 'from');
    const end = assertDateOnly(to || addLocalDays(start, 1), 'to');
    if (end <= start) {
      throw new Error('to must be after from.');
    }

    return { from: start, to: end };
  }

  if (period === 'this_week') {
    return currentWeekRange();
  }

  const today = todayLocalDateISO();
  return {
    from: today,
    to: addLocalDays(today, 1)
  };
}

export function filterRecordsByProject(records, projectFilter, config = {}) {
  if (projectFilter === undefined || projectFilter === null || String(projectFilter).trim() === '') {
    return {
      records,
      unmatchedProjectFilter: null
    };
  }

  const filter = String(projectFilter).trim();
  const normalizedFilter = normalize(filter);
  const matches = records.filter((record) => recordMatchesFilter(record, filter, normalizedFilter, config));
  const candidates = uniqueProjects(records);

  if (!matches.length) {
    return {
      records: [],
      unmatchedProjectFilter: {
        filter,
        candidates
      }
    };
  }

  return {
    records: matches,
    unmatchedProjectFilter: null
  };
}

export function buildTotals(records) {
  return records.reduce((totals, record) => ({
    bookedHours: roundHours(totals.bookedHours + Number(record.bookedHours || 0)),
    loggedHours: roundHours(totals.loggedHours + Number(record.loggedHours || 0)),
    projectCount: new Set([...totals.projectKeys, projectKey(record)]).size,
    dayCount: new Set([...totals.days, record.date]).size,
    projectKeys: [...new Set([...totals.projectKeys, projectKey(record)])],
    days: [...new Set([...totals.days, record.date])]
  }), {
    bookedHours: 0,
    loggedHours: 0,
    projectCount: 0,
    dayCount: 0,
    projectKeys: [],
    days: []
  });
}

export async function collectEntries(records, fetchDayLogs) {
  const entries = [];
  const missingDetailEntries = [];

  for (const record of records) {
    if (!record.loggedHours || !record.projectId) {
      continue;
    }

    const dayLogs = await fetchDayLogs({
      date: record.date,
      projectId: record.projectId,
      projectMemberId: record.projectMemberId,
      projectName: record.projectName
    });

    const detailEntries = dayLogs.entries?.length
      ? dayLogs.entries
      : (dayLogs.logs || []).map((log) => sanitizeEntry(log, record));

    if (!detailEntries.length) {
      missingDetailEntries.push({
        date: record.date,
        projectMemberId: record.projectMemberId,
        projectId: record.projectId,
        projectName: record.projectName,
        loggedHours: record.loggedHours
      });
      continue;
    }

    for (const entry of detailEntries) {
      entries.push(sanitizeEntry(entry, record));
    }
  }

  return { entries, missingDetailEntries };
}

export function createTimesheetRangeFetcher() {
  const session = createResourceOptimiserSession();
  return async (range) => {
    const { token, userId } = await session.get();
    try {
      return await getTimesheetRange(token, userId, range);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getTimesheetRange(refreshed.token, refreshed.userId, range);
    }
  };
}

export function createDayLogsFetcher() {
  const session = createResourceOptimiserSession();
  return async ({ date, projectId }) => {
    const { token, userId } = await session.get();
    try {
      return await getDayLogs(token, projectId, userId, date);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getDayLogs(refreshed.token, projectId, refreshed.userId, date);
    }
  };
}

export function createResourceOptimiserSession() {
  let cached = null;

  return {
    async get({ forceLogin = false } = {}) {
      if (cached && !forceLogin) {
        return cached;
      }

      const token = await getFreshToken({
        loginUrl: CONFIG.loginUrl,
        tokenKey: CONFIG.tokenKey,
        allowedHosts: CONFIG.allowedSafariHosts,
        terminalTitle: 'Logwork Helper MCP',
        forceLogin
      });
      cached = {
        token,
        userId: getUserIdFromJwt(token)
      };
      return cached;
    }
  };
}

function buildDays(records, entries) {
  const byDate = new Map();
  for (const record of records) {
    const existing = byDate.get(record.date) || {
      date: record.date,
      bookedHours: 0,
      loggedHours: 0,
      projects: []
    };
    existing.bookedHours = roundHours(existing.bookedHours + Number(record.bookedHours || 0));
    existing.loggedHours = roundHours(existing.loggedHours + Number(record.loggedHours || 0));
    existing.projects.push({
      ...projectSummary(record),
      entries: entries.filter((entry) => (
        entry.date === record.date &&
        sameProject(entry, record)
      ))
    });
    byDate.set(record.date, existing);
  }

  for (const day of byDate.values()) {
    day.entries = entries.filter((entry) => entry.date === day.date);
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function buildProjects(records) {
  const byProject = new Map();
  for (const record of records) {
    const key = projectKey(record);
    const existing = byProject.get(key) || {
      projectMemberId: record.projectMemberId,
      projectId: record.projectId,
      projectName: record.projectName,
      bookedHours: 0,
      loggedHours: 0,
      dates: []
    };
    existing.bookedHours = roundHours(existing.bookedHours + Number(record.bookedHours || 0));
    existing.loggedHours = roundHours(existing.loggedHours + Number(record.loggedHours || 0));
    existing.dates = [...new Set([...existing.dates, record.date])].sort();
    byProject.set(key, existing);
  }

  return [...byProject.values()].sort((left, right) => left.projectName.localeCompare(right.projectName));
}

function recordMatchesFilter(record, filter, normalizedFilter, config) {
  if (String(record.projectMemberId) === filter || String(record.projectId) === filter) {
    return true;
  }

  if (normalize(record.projectName).includes(normalizedFilter)) {
    return true;
  }

  return (config.projectMappings || []).some((mapping) => {
    const mappingMatchesProject = (
      (mapping.projectMemberId !== undefined && String(mapping.projectMemberId) === String(record.projectMemberId)) ||
      (mapping.projectName && normalize(record.projectName).includes(normalize(mapping.projectName)))
    );

    if (!mappingMatchesProject) {
      return false;
    }

    return (mapping.tickets || []).some((ticket) => normalize(ticket) === normalizedFilter) ||
      (mapping.keywords || []).some((keyword) => normalize(keyword).includes(normalizedFilter) || normalizedFilter.includes(normalize(keyword)));
  });
}

function uniqueProjects(records) {
  return buildProjects(records).map((project) => ({
    projectMemberId: project.projectMemberId,
    projectId: project.projectId,
    projectName: project.projectName
  }));
}

function sanitizeEntry(entry, record) {
  return {
    id: entry.id ?? entry.logtime_id ?? entry.logtimeId,
    date: entry.date || normalizeDateOnly(entry.logdate ?? entry.log_date) || record.date,
    projectMemberId: entry.projectMemberId ?? entry.project_member_id ?? record.projectMemberId,
    projectId: entry.projectId ?? entry.project_id ?? record.projectId,
    projectName: entry.projectName ?? entry.project_name ?? record.projectName,
    hours: Number(entry.hours ?? entry.logtimes ?? entry.time ?? 0),
    taskName: entry.taskName ?? entry.task_name ?? entry.name ?? entry.title ?? ''
  };
}

function sameProject(entry, record) {
  if (entry.projectMemberId !== undefined && record.projectMemberId !== undefined) {
    return String(entry.projectMemberId) === String(record.projectMemberId);
  }

  if (entry.projectId !== undefined && record.projectId !== undefined) {
    return String(entry.projectId) === String(record.projectId);
  }

  return entry.projectName === record.projectName;
}

function projectSummary(record) {
  return {
    projectMemberId: record.projectMemberId,
    projectId: record.projectId,
    projectName: record.projectName,
    bookedHours: record.bookedHours,
    loggedHours: record.loggedHours
  };
}

function projectKey(record) {
  return String(record.projectMemberId ?? record.projectId ?? record.projectName);
}

function assertDateOnly(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD format.`);
  }

  return value;
}

function currentWeekRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  return {
    from: formatLocalDate(start),
    to: formatLocalDate(end)
  };
}

function formatLocalDate(date) {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function normalizeDateOnly(value) {
  if (!value) {
    return '';
  }

  return String(value).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function roundHours(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatQuerySummary(records, entries, range, unmatchedProjectFilter, missingDetailEntries = []) {
  if (unmatchedProjectFilter) {
    return `No logwork projects matched "${unmatchedProjectFilter.filter}" from ${range.from} to ${range.to}.`;
  }

  const totals = buildTotals(records);
  const lines = [
    `Logwork from ${range.from} to ${range.to}: ${totals.loggedHours}h logged / ${totals.bookedHours}h booked.`
  ];

  for (const day of buildDays(records, entries)) {
    lines.push(day.date);
    for (const project of day.projects) {
      lines.push(`- ${project.projectName}: ${project.loggedHours}h logged / ${project.bookedHours}h booked`);
      for (const entry of project.entries) {
        lines.push(`  - +${entry.hours}h ${entry.taskName || '(no task name)'}`);
      }
    }
  }

  if (missingDetailEntries.length) {
    lines.push('Missing detail entries:');
    for (const missing of missingDetailEntries) {
      lines.push(`- ${missing.date}: ${missing.projectName} has ${missing.loggedHours}h logged but no task detail returned.`);
    }
  }

  return lines.join('\n');
}
