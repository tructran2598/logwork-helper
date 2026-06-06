import { CONFIG } from '../config.mjs';
import { addLocalDays, mapLimit, safeJsonParse, toApiLogDate } from './util.mjs';

export class ApiError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export async function apiFetch(token, path, options = {}) {
  const response = await fetch(`${CONFIG.apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text, text) : null;

  if (response.status === 401) {
    throw new ApiError('API request returned 401 Unauthorized.', {
      status: response.status,
      path,
      body: excerpt(text)
    });
  }

  if (!response.ok) {
    throw new ApiError(`API request failed: ${response.status} ${response.statusText} for ${path}. Body: ${excerpt(text)}`, {
      status: response.status,
      path,
      body: excerpt(text)
    });
  }

  return data;
}

export async function getProjects(token, userId) {
  const qs = new URLSearchParams({
    f_user_id: String(userId),
    'f_project.stage_id': '!6'
  });

  const data = await apiFetch(token, `${CONFIG.projectMembersPath}?${qs}`);
  return unwrapRecords(data).map(normalizeProject).filter((project) => project.projectMemberId);
}

export async function getDayLogs(token, projectId, userId, localDateISO) {
  const qs = new URLSearchParams({
    f_project_id: String(projectId),
    f_user_id: String(userId),
    f_logdate: toApiLogDate(localDateISO)
  });

  try {
    const data = await apiFetch(token, `${CONFIG.memberLogtimePath}?${qs}`);
    const logs = unwrapRecords(data);
    const entries = normalizeLogtimeEntries(logs, {
      date: localDateISO,
      projectId
    });

    return {
      projectId,
      totalHours: entries.reduce((sum, log) => sum + Number(log.hours || 0), 0),
      entries,
      logs,
      ok: true
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw error;
    }

    return {
      projectId,
      totalHours: null,
      logs: [],
      ok: false,
      error: error.message
    };
  }
}

export function normalizeLogtimeEntries(logs, defaults = {}) {
  return unwrapRecords(logs)
    .filter((log) => log && typeof log === 'object')
    .map((log) => ({
      id: log.id ?? log.logtime_id ?? log.logtimeId,
      date: normalizeDateOnly(log.logdate ?? log.log_date ?? log.date) || defaults.date,
      projectMemberId: readExplicitProjectMemberId(log) ?? defaults.projectMemberId,
      projectId: readProjectId(log) ?? defaults.projectId,
      projectName: hasProjectName(log) ? readProjectName(log, readProjectId(log)) : defaults.projectName,
      hours: Number(log.logtimes ?? log.hours ?? log.time ?? 0),
      taskName: log.task_name ?? log.taskName ?? log.name ?? log.title ?? ''
    }))
    .filter((entry) => Number.isFinite(entry.hours) && entry.hours > 0);
}

export async function getAllDayLogSummaries(token, projects, userId, localDateISO) {
  return mapLimit(projects, CONFIG.dayLogConcurrency, (project) => (
    getDayLogs(token, project.projectId, userId, localDateISO)
  ));
}

export async function getTimesheetRange(token, userId, { from, to }) {
  const qs = new URLSearchParams({
    f_user_id: String(userId),
    f_from: toApiLogDate(from),
    f_to: toApiLogDate(to),
    f_timesheet_by_week: '0',
    f_time_off: '1'
  });

  const data = await apiFetch(token, `${CONFIG.timesheetPath}?${qs}`);
  return normalizeTimesheetRange(data, { from, to });
}

export function normalizeTimesheetRange(data, { from, to } = {}) {
  const explicitRows = expandProjectTimesheetRows(data, { from, to });
  const rows = explicitRows.length ? explicitRows : findTimesheetRowsInRange(data, { from, to });
  return normalizeTimesheetRecords(rows);
}

export async function getBookedProjectsForDate(token, userId, localDateISO) {
  const records = await getTimesheetRange(token, userId, {
    from: localDateISO,
    to: addLocalDays(localDateISO, 1)
  });
  return normalizeTimesheetProjects(records, localDateISO);
}

export async function getTodayTimesheetProjects(token, userId, localDateISO) {
  return getBookedProjectsForDate(token, userId, localDateISO);
}

export async function addLogtime(token, {
  projectMemberId,
  logtimes,
  taskName,
  localDateISO
}) {
  const path = memberLogtimeWritePath(projectMemberId);
  const body = {
    add_data: [
      {
        project_member_id: projectMemberId,
        logtimes,
        task_name: taskName,
        logdate: toApiLogDate(localDateISO)
      }
    ]
  };

  if (process.env.LOGWORK_DRY_RUN === '1') {
    return {
      dryRun: true,
      method: CONFIG.memberLogtimeMethod,
      path,
      body
    };
  }

  return apiFetch(token, path, {
    method: CONFIG.memberLogtimeMethod,
    body: JSON.stringify(body)
  });
}

export async function submitLogtimeEntry(token, entry) {
  return addLogtime(token, entry);
}

function memberLogtimeWritePath(projectMemberId) {
  return `${CONFIG.memberLogtimePath}/${encodeURIComponent(String(projectMemberId))}`;
}

function normalizeProject(rec) {
  const projectId = rec.project_id ?? rec.project?.id ?? rec.project?.project_id;

  return {
    projectMemberId: rec.id ?? rec.project_member_id,
    projectId,
    projectName: rec.project?.name ?? rec.project_name ?? rec.name ?? `Project ${projectId}`,
    workloadPercent: rec.workload ?? rec.workload_percent ?? rec.assigned_percent ?? 0,
    raw: rec
  };
}

function normalizeTimesheetProjects(rows, localDateISO) {
  const byMember = new Map();

  for (const row of rows) {
    const projectMemberId = readProjectMemberId(row);
    const projectId = readProjectId(row);

    if (!projectMemberId && !projectId) {
      continue;
    }

    const key = String(projectMemberId ?? projectId);
    const projectName = readProjectName(row, projectId ?? projectMemberId);
    const assignedHours = Number(row.bookedHours ?? readAssignedHours(row));
    const loggedHours = Number(row.loggedHours ?? readLoggedHours(row));
    const existing = byMember.get(key);

    if (existing) {
      existing.assignedHours += assignedHours;
      existing.loggedHours += loggedHours;
      existing.workloadPercent = hoursToAssignPercent(existing.assignedHours);
      existing.raw.push(row);
      continue;
    }

    byMember.set(key, {
      projectMemberId: projectMemberId ?? row.project_member_id ?? row.id,
      projectId,
      projectName,
      assignedHours,
      loggedHours,
      workloadPercent: hoursToAssignPercent(assignedHours),
      localDateISO,
      raw: [row]
    });
  }

  return [...byMember.values()].filter((project) => project.assignedHours > 0);
}

function normalizeTimesheetRecords(rows) {
  const byDayProject = new Map();

  for (const row of rows) {
    const date = readDateLike(row);
    const projectMemberId = readProjectMemberId(row);
    const projectId = readProjectId(row);

    if (!date || (!projectMemberId && !projectId)) {
      continue;
    }

    const key = `${date}:${projectMemberId ?? projectId}`;
    const existing = byDayProject.get(key);
    const bookedHours = Number(row.bookedHours ?? readAssignedHours(row));
    const loggedHours = Number(row.loggedHours ?? readLoggedHours(row));
    const entries = readLogEntries(row);

    if (existing) {
      existing.bookedHours += bookedHours;
      existing.loggedHours += loggedHours;
      existing.entries.push(...entries);
      existing.raw.push(row);
      continue;
    }

    byDayProject.set(key, {
      date,
      projectMemberId,
      projectId,
      projectName: readProjectName(row, projectId ?? projectMemberId),
      bookedHours,
      loggedHours,
      entries,
      raw: [row]
    });
  }

  return [...byDayProject.values()].map((record) => ({
    ...record,
    bookedHours: Number(record.bookedHours.toFixed(2)),
    loggedHours: Number(record.loggedHours.toFixed(2))
  }));
}

function findTimesheetRowsForDate(data, localDateISO) {
  const rows = [];
  collectTimesheetRows(data, localDateISO, rows, new Set());
  return rows;
}

function expandProjectTimesheetRows(data, range) {
  const assignments = [];
  collectProjectAssignments(data, assignments, new Set());
  const rows = [];

  for (const assignment of assignments) {
    for (const day of assignment.timesheet) {
      const date = normalizeDateOnly(day.logdate ?? day.log_date ?? day.date);
      if (!isDateInRange(date, range)) {
        continue;
      }

      rows.push({
        date,
        projectMemberId: assignment.id,
        project_member_id: assignment.id,
        projectId: assignment.project?.id,
        project_id: assignment.project?.id,
        projectName: assignment.project?.name,
        project_name: assignment.project?.name,
        bookedHours: Number(day.assign_percent ?? day.assigned_hours ?? day.booked_hours ?? 0),
        loggedHours: Number(day.logtimes ?? 0),
        overtime: Number(day.overtime ?? 0),
        source: 'timesheet'
      });
    }
  }

  return rows;
}

function collectProjectAssignments(value, assignments, seen) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectProjectAssignments(item, assignments, seen);
    }
    return;
  }

  if (
    value.project &&
    typeof value.project === 'object' &&
    Array.isArray(value.timesheet)
  ) {
    assignments.push(value);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'overall') {
      continue;
    }
    collectProjectAssignments(child, assignments, seen);
  }
}

function findTimesheetRowsInRange(data, { from, to } = {}) {
  const rows = [];
  collectTimesheetRowsInRange(data, { from, to }, rows, new Set());
  return rows;
}

function collectTimesheetRowsInRange(value, range, rows, seen) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTimesheetRowsInRange(item, range, rows, seen);
    }
    return;
  }

  const directDate = readDateLike(value);
  if (isDateInRange(directDate, range) && looksLikeTimesheetRow(value)) {
    rows.push(value);
  }

  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      const keyDate = normalizeDateOnly(key);
      if (isDateInRange(keyDate, range)) {
        for (const item of child) {
          if (item && typeof item === 'object') {
            rows.push({ ...item, date: readDateLike(item) || keyDate });
          }
        }
        continue;
      }

      for (const item of child) {
        if (item && typeof item === 'object') {
          const itemDate = readDateLike(item);
          if (isDateInRange(itemDate, range) && looksLikeTimesheetRow(item)) {
            rows.push(item);
            continue;
          }
        }

        collectTimesheetRowsInRange(item, range, rows, seen);
      }
      continue;
    }

    if (child && typeof child === 'object') {
      const keyDate = normalizeDateOnly(key);
      if (isDateInRange(keyDate, range)) {
        rows.push({ ...child, date: readDateLike(child) || keyDate });
        continue;
      }

      collectTimesheetRowsInRange(child, range, rows, seen);
    }
  }
}

function collectTimesheetRows(value, localDateISO, rows, seen) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTimesheetRows(item, localDateISO, rows, seen);
    }
    return;
  }

  const directDate = readDateLike(value);
  if (directDate === localDateISO && looksLikeTimesheetRow(value)) {
    rows.push(value);
  }

  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      if (isDateKey(key, localDateISO)) {
        for (const item of child) {
          if (item && typeof item === 'object') {
            rows.push({ ...value, ...item });
          }
        }
        continue;
      }

      for (const item of child) {
        if (item && typeof item === 'object' && readDateLike(item) === localDateISO && looksLikeTimesheetRow({ ...value, ...item })) {
          rows.push({ ...value, ...item });
          continue;
        }

        collectTimesheetRows(item, localDateISO, rows, seen);
      }
      continue;
    }

    if (child && typeof child === 'object') {
      if (isDateKey(key, localDateISO)) {
        rows.push({ ...value, ...child });
        continue;
      }

      collectTimesheetRows(child, localDateISO, rows, seen);
    }
  }
}

function looksLikeTimesheetRow(row) {
  return readAssignedHours(row) > 0 || readLoggedHours(row) > 0 || Boolean(pickFirst(row, [
    'project_member_id',
    'projectMemberId',
    'project_id',
    'projectId'
  ]));
}

function readProjectMemberId(row) {
  const explicit = readExplicitProjectMemberId(row);

  if (explicit !== undefined) {
    return explicit;
  }

  if (looksLikeProjectMemberRow(row)) {
    return row.id;
  }

  return undefined;
}

function readExplicitProjectMemberId(row) {
  return pickFirst(row, [
    'project_member_id',
    'projectMemberId',
    'project_member.id',
    'projectMember.id'
  ]);
}

function readProjectId(row) {
  return pickFirst(row, [
    'project_id',
    'projectId',
    'project.id',
    'project.project_id',
    'projectMember.project_id',
    'project_member.project_id'
  ]);
}

function readProjectName(row, fallbackId) {
  return pickFirst(row, [
    'project.name',
    'project_name',
    'projectName',
    'name',
    'projectMember.project.name',
    'project_member.project.name'
  ]) ?? `Project ${fallbackId}`;
}

function hasProjectName(row) {
  return pickFirst(row, [
    'project.name',
    'project_name',
    'projectName',
    'name',
    'projectMember.project.name',
    'project_member.project.name'
  ]) !== undefined;
}

function looksLikeProjectMemberRow(row) {
  return row && typeof row === 'object' && row.id !== undefined && (
    row.project_id !== undefined ||
    row.projectId !== undefined ||
    row.project !== undefined ||
    row.project_name !== undefined ||
    row.projectName !== undefined ||
    row.assign_hours !== undefined ||
    row.assigned_hours !== undefined ||
    row.booked_hours !== undefined
  );
}

function readAssignedHours(row) {
  return readNumber(row, [
    'assign_hours',
    'assigned_hours',
    'assignedHours',
    'booking_hours',
    'booked_hours',
    'bookedHours',
    'workload_hours',
    'workloadHours',
    'assign_percent',
    'assignPercent',
    'hours_per_day',
    'hoursPerDay',
    'timesheet',
    'logtime',
    'logtimes_plan',
    'planned_hours',
    'plannedHours',
    'effort',
    'man_day'
  ]);
}

function readLoggedHours(row) {
  return readNumber(row, [
    'logged_hours',
    'loggedHours',
    'actual_hours',
    'actualHours',
    'logtimes',
    'log_times',
    'logTimes',
    'logged',
    'total_logtimes',
    'totalLoggedHours',
    'total_logged_hours',
    'spent_hours',
    'spentHours'
  ]);
}

function readLogEntries(row) {
  const rawEntries = pickFirst(row, [
    'logs',
    'logtimes_data',
    'logtimesData',
    'log_times',
    'logTimes',
    'items',
    'children'
  ]);

  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: entry.id ?? entry.logtime_id ?? entry.logtimeId,
      date: normalizeDateOnly(entry.logdate ?? entry.log_date ?? entry.date ?? row.logdate ?? row.date),
      projectMemberId: readProjectMemberId(entry) ?? readProjectMemberId(row),
      projectId: readProjectId(entry) ?? readProjectId(row),
      projectName: hasProjectName(entry) ? readProjectName(entry, readProjectId(entry)) : readProjectName(row, readProjectId(row)),
      hours: Number(entry.logtimes ?? entry.hours ?? entry.time ?? 0),
      taskName: entry.task_name ?? entry.taskName ?? entry.name ?? entry.title ?? '',
      raw: entry
    }))
    .filter((entry) => Number.isFinite(entry.hours) && entry.hours > 0);
}

function readNumber(row, paths) {
  for (const path of paths) {
    const value = pickFirst(row, [path]);
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }

  return 0;
}

function hoursToAssignPercent(hours) {
  return Math.round((Number(hours || 0) / CONFIG.standardDayHours) * 100);
}

function readDateLike(row) {
  const value = pickFirst(row, [
    'logdate',
    'log_date',
    'date',
    'day',
    'workdate',
    'work_date',
    'timesheet_date'
  ]);

  return normalizeDateOnly(value);
}

function normalizeDateOnly(value) {
  if (!value) {
    return '';
  }

  const text = String(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function isDateKey(key, localDateISO) {
  return normalizeDateOnly(key) === localDateISO;
}

function isDateInRange(localDateISO, { from, to } = {}) {
  if (!localDateISO) {
    return false;
  }

  if (from && localDateISO < from) {
    return false;
  }

  if (to && localDateISO >= to) {
    return false;
  }

  return true;
}

function pickFirst(row, paths) {
  for (const path of paths) {
    const value = getPath(row, path);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return undefined;
}

function getPath(row, path) {
  return path.split('.').reduce((current, part) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    return current[part];
  }, row);
}

function unwrapRecords(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.data?.data)) {
    return data.data.data;
  }

  if (Array.isArray(data?.records)) {
    return data.records;
  }

  if (Array.isArray(data?.items)) {
    return data.items;
  }

  return [];
}

function excerpt(text) {
  return String(text || '').slice(0, 500);
}
