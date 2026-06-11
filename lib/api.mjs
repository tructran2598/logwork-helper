import { CONFIG } from '../config.mjs';
import { fetchWithPolicy, redactedExcerpt } from './http.mjs';
import { addLocalDays, mapLimit, safeJsonParse, toApiLogDate } from './util.mjs';

const NORMALIZATION_DIAGNOSTICS_KEY = 'normalization';
const MAX_DIAGNOSTIC_ITEMS = 25;

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
  const {
    fetchImpl,
    retries,
    retryDelayMs = CONFIG.httpRetryDelayMs,
    timeoutMs = CONFIG.httpTimeoutMs,
    ...requestOptions
  } = options;
  const method = requestOptions.method || 'GET';
  const response = await fetchWithPolicy(`${CONFIG.apiBase}${path}`, {
    ...requestOptions,
    fetchImpl,
    timeoutMs,
    retryDelayMs,
    retries: retries ?? CONFIG.httpReadRetries,
    idempotent: isIdempotentMethod(method),
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...requestOptions.headers
    }
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text, text) : null;
  const safeBody = redactedExcerpt(text);

  if (response.status === 401) {
    throw new ApiError('API request returned 401 Unauthorized.', {
      status: response.status,
      path,
      body: safeBody
    });
  }

  if (!response.ok) {
    throw new ApiError(`API request failed: ${response.status} ${response.statusText} for ${path}. Body: ${safeBody}`, {
      status: response.status,
      path,
      body: safeBody
    });
  }

  return data;
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

export function getNormalizationDiagnostics(value) {
  return value?.[NORMALIZATION_DIAGNOSTICS_KEY] || emptyNormalizationDiagnostics();
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
    const normalization = getNormalizationDiagnostics(entries);

    return {
      projectId,
      totalHours: entries.reduce((sum, log) => sum + Number(log.hours || 0), 0),
      entries,
      logs,
      normalization,
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
  const rows = unwrapRecords(logs);
  const diagnostics = createNormalizationDiagnostics('logtime_entries');
  diagnostics.rowsRead = rows.length;
  const entries = [];

  rows.forEach((log, index) => {
    if (!log || typeof log !== 'object') {
      addDroppedRow(diagnostics, 'invalid_log_entry', { index });
      return;
    }

    const context = { index, kind: 'logtime_entry' };
    const date = normalizeDateOnly(log.logdate ?? log.log_date ?? log.date) || defaults.date;
    const projectMemberId = readExplicitProjectMemberId(log) ?? defaults.projectMemberId;
    const projectId = readProjectId(log) ?? defaults.projectId;
    const hours = readNumber(log, ['logtimes', 'hours', 'time'], diagnostics, context);

    if (!date) {
      addDroppedRow(diagnostics, 'missing_date', { ...context, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    if (projectMemberId === undefined && projectId === undefined) {
      addDroppedRow(diagnostics, 'missing_project_identity', { ...context, date });
      return;
    }

    if (hours <= 0) {
      addDroppedRow(diagnostics, 'non_positive_hours', { ...context, date, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    diagnostics.rowsAccepted += 1;
    entries.push({
      id: log.id ?? log.logtime_id ?? log.logtimeId,
      date,
      projectMemberId,
      projectId,
      projectName: hasProjectName(log) ? readProjectName(log, readProjectId(log), diagnostics, context) : defaults.projectName,
      hours,
      taskName: log.task_name ?? log.taskName ?? log.name ?? log.title ?? ''
    });
  });

  return attachNormalizationDiagnostics(entries, diagnostics);
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
  const diagnostics = createNormalizationDiagnostics('unknown');
  const explicitRows = expandProjectTimesheetRows(data, { from, to }, diagnostics);
  const rows = explicitRows.length ? explicitRows : findTimesheetRowsInRange(data, { from, to });
  diagnostics.sourceShape = explicitRows.length ? 'project_timesheet' : 'range_scan';
  if (!rows.length && hasObjectPayload(data)) {
    addWarning(diagnostics, 'unknown_timesheet_shape');
  }
  return normalizeTimesheetRecords(rows, diagnostics);
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
  const projectMemberId = rec.id ?? rec.project_member_id;

  return {
    projectMemberId,
    projectId,
    projectName: rec.project?.name ?? rec.project_name ?? rec.name ?? projectFallbackName(projectId ?? projectMemberId),
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

function normalizeTimesheetRecords(rows, diagnostics = createNormalizationDiagnostics('range_scan')) {
  const byDayProject = new Map();
  diagnostics.rowsRead = rows.length;

  rows.forEach((row, index) => {
    const date = readDateLike(row);
    const projectMemberId = readProjectMemberId(row);
    const projectId = readProjectId(row);
    const context = {
      index,
      kind: 'timesheet_row',
      ...diagnosticProjectFields({ projectMemberId, projectId, projectName: hasProjectName(row) ? readProjectName(row, projectId ?? projectMemberId) : undefined })
    };

    if (!date) {
      addDroppedRow(diagnostics, 'missing_date', context);
      return;
    }

    if (projectMemberId === undefined && projectId === undefined) {
      addDroppedRow(diagnostics, 'missing_project_identity', { ...context, date });
      return;
    }

    const key = `${date}:${projectMemberId ?? projectId}`;
    const existing = byDayProject.get(key);
    const bookedHours = readTimesheetHours(row, ['bookedHours'], readAssignedHours, diagnostics, { ...context, date, metric: 'bookedHours' });
    const loggedHours = readTimesheetHours(row, ['loggedHours'], readLoggedHours, diagnostics, { ...context, date, metric: 'loggedHours' });
    const entries = readLogEntries(row, diagnostics, { ...context, date });
    diagnostics.rowsAccepted += 1;

    if (existing) {
      existing.bookedHours += bookedHours;
      existing.loggedHours += loggedHours;
      existing.entries.push(...entries);
      existing.raw.push(row);
      return;
    }

    byDayProject.set(key, {
      date,
      projectMemberId,
      projectId,
      projectName: readProjectName(row, projectId ?? projectMemberId, diagnostics, { ...context, date }),
      bookedHours,
      loggedHours,
      entries,
      raw: [row]
    });
  });

  return attachNormalizationDiagnostics([...byDayProject.values()].map((record) => ({
    ...record,
    bookedHours: Number(record.bookedHours.toFixed(2)),
    loggedHours: Number(record.loggedHours.toFixed(2))
  })), diagnostics);
}

function findTimesheetRowsForDate(data, localDateISO) {
  const rows = [];
  collectTimesheetRows(data, localDateISO, rows, new Set());
  return rows;
}

function expandProjectTimesheetRows(data, range, diagnostics = null) {
  const assignments = [];
  collectProjectAssignments(data, assignments, new Set());
  const rows = [];

  assignments.forEach((assignment, assignmentIndex) => {
    assignment.timesheet.forEach((day, dayIndex) => {
      const date = normalizeDateOnly(day.logdate ?? day.log_date ?? day.date);
      if (!isDateInRange(date, range)) {
        return;
      }

      const context = {
        index: rows.length,
        assignmentIndex,
        dayIndex,
        kind: 'project_timesheet_row',
        date,
        ...diagnosticProjectFields({
          projectMemberId: assignment.id,
          projectId: assignment.project?.id,
          projectName: assignment.project?.name
        })
      };

      rows.push({
        date,
        projectMemberId: assignment.id,
        project_member_id: assignment.id,
        projectId: assignment.project?.id,
        project_id: assignment.project?.id,
        projectName: assignment.project?.name,
        project_name: assignment.project?.name,
        bookedHours: readNumber(day, ['assign_percent', 'assigned_hours', 'booked_hours'], diagnostics, { ...context, metric: 'bookedHours' }),
        loggedHours: readNumber(day, ['logtimes'], diagnostics, { ...context, metric: 'loggedHours' }),
        overtime: readNumber(day, ['overtime'], diagnostics, { ...context, metric: 'overtime' }),
        source: 'timesheet'
      });
    });
  });

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
  } else if (!directDate && looksLikeTimesheetRow(value)) {
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

function readProjectName(row, fallbackId, diagnostics = null, context = {}) {
  const projectName = pickFirst(row, [
    'project.name',
    'project_name',
    'projectName',
    'name',
    'projectMember.project.name',
    'project_member.project.name'
  ]);

  if (projectName !== undefined) {
    return projectName;
  }

  if (fallbackId !== undefined && fallbackId !== null && String(fallbackId).trim() !== '') {
    addWarning(diagnostics, 'fallback_project_name', {
      ...context,
      ...diagnosticProjectFields({ projectMemberId: readProjectMemberId(row), projectId: readProjectId(row) })
    });
    return projectFallbackName(fallbackId);
  }

  addWarning(diagnostics, 'fallback_project_name', context);
  return 'Unknown project';
}

function projectFallbackName(fallbackId) {
  return fallbackId !== undefined && fallbackId !== null && String(fallbackId).trim() !== ''
    ? `Project ${fallbackId}`
    : 'Unknown project';
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

function readAssignedHours(row, diagnostics = null, context = {}) {
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
  ], diagnostics, context);
}

function readLoggedHours(row, diagnostics = null, context = {}) {
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
  ], diagnostics, context);
}

function readLogEntries(row, diagnostics = null, context = {}) {
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

  const entries = [];
  rawEntries.forEach((entry, entryIndex) => {
    if (!entry || typeof entry !== 'object') {
      addDroppedRow(diagnostics, 'invalid_log_entry', {
        ...context,
        entryIndex
      });
      return;
    }

    const entryContext = {
      ...context,
      entryIndex,
      kind: 'embedded_log_entry'
    };
    const date = normalizeDateOnly(entry.logdate ?? entry.log_date ?? entry.date ?? row.logdate ?? row.date);
    const projectMemberId = readProjectMemberId(entry) ?? readProjectMemberId(row);
    const projectId = readProjectId(entry) ?? readProjectId(row);
    const hours = readNumber(entry, ['logtimes', 'hours', 'time'], diagnostics, { ...entryContext, metric: 'hours' });

    if (!date) {
      addDroppedRow(diagnostics, 'missing_date', { ...entryContext, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    if (projectMemberId === undefined && projectId === undefined) {
      addDroppedRow(diagnostics, 'missing_project_identity', { ...entryContext, date });
      return;
    }

    if (hours <= 0) {
      addDroppedRow(diagnostics, 'non_positive_hours', { ...entryContext, date, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    entries.push({
      id: entry.id ?? entry.logtime_id ?? entry.logtimeId,
      date,
      projectMemberId,
      projectId,
      projectName: hasProjectName(entry) ? readProjectName(entry, readProjectId(entry), diagnostics, entryContext) : readProjectName(row, readProjectId(row) ?? readProjectMemberId(row), diagnostics, entryContext),
      hours,
      taskName: entry.task_name ?? entry.taskName ?? entry.name ?? entry.title ?? '',
      raw: entry
    });
  });

  return entries;
}

function readTimesheetHours(row, directPaths, fallbackReader, diagnostics, context) {
  const directValue = pickFirst(row, directPaths);
  if (directValue !== undefined) {
    return coerceHours(directValue, diagnostics, {
      ...context,
      field: directPaths[0]
    });
  }

  return fallbackReader(row, diagnostics, context);
}

function readNumber(row, paths, diagnostics = null, context = {}) {
  for (const path of paths) {
    const value = pickFirst(row, [path]);
    if (value !== undefined) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        return number;
      }
      if (Number.isFinite(number) && number === 0) {
        continue;
      }
      addWarning(diagnostics, 'invalid_hours', {
        ...context,
        field: path
      });
    }
  }

  return 0;
}

function coerceHours(value, diagnostics = null, context = {}) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) {
    return number;
  }

  addWarning(diagnostics, 'invalid_hours', context);
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

function createNormalizationDiagnostics(sourceShape = 'unknown') {
  return {
    status: 'ok',
    sourceShape,
    rowsRead: 0,
    rowsAccepted: 0,
    droppedRowCount: 0,
    warningCount: 0,
    warnings: [],
    droppedRows: []
  };
}

function emptyNormalizationDiagnostics() {
  return createNormalizationDiagnostics('unknown');
}

function attachNormalizationDiagnostics(value, diagnostics) {
  Object.defineProperty(value, NORMALIZATION_DIAGNOSTICS_KEY, {
    value: finalizeNormalizationDiagnostics(diagnostics),
    enumerable: false,
    configurable: true
  });
  return value;
}

function finalizeNormalizationDiagnostics(diagnostics) {
  const warningCount = diagnostics.warnings.length;
  const droppedRowCount = diagnostics.droppedRows.length;
  return {
    ...diagnostics,
    status: warningCount || droppedRowCount ? 'warning' : 'ok',
    warningCount,
    droppedRowCount
  };
}

export function combineNormalizationDiagnostics(...items) {
  const diagnostics = createNormalizationDiagnostics('combined');
  for (const item of items) {
    const current = item?.warnings || item?.droppedRows
      ? item
      : getNormalizationDiagnostics(item);
    if (!current) {
      continue;
    }
    diagnostics.rowsRead += Number(current.rowsRead || 0);
    diagnostics.rowsAccepted += Number(current.rowsAccepted || 0);
    for (const warning of current.warnings || []) {
      pushDiagnostic(diagnostics.warnings, warning);
    }
    for (const dropped of current.droppedRows || []) {
      pushDiagnostic(diagnostics.droppedRows, dropped);
    }
  }
  return finalizeNormalizationDiagnostics(diagnostics);
}

function addWarning(diagnostics, reason, details = {}) {
  if (!diagnostics) {
    return;
  }
  pushDiagnostic(diagnostics.warnings, compactDiagnostic({
    reason,
    ...details
  }));
}

function addDroppedRow(diagnostics, reason, details = {}) {
  if (!diagnostics) {
    return;
  }
  pushDiagnostic(diagnostics.droppedRows, compactDiagnostic({
    reason,
    ...details
  }));
}

function pushDiagnostic(items, item) {
  if (items.length < MAX_DIAGNOSTIC_ITEMS) {
    items.push(item);
  }
}

function compactDiagnostic(details) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => (
    value !== undefined &&
    value !== null &&
    value !== ''
  )));
}

function diagnosticProjectFields({ projectMemberId, projectId, projectName } = {}) {
  return compactDiagnostic({
    projectMemberId,
    projectId,
    projectName
  });
}

function hasObjectPayload(data) {
  return Boolean(data && typeof data === 'object' && Object.keys(data).length > 0);
}
