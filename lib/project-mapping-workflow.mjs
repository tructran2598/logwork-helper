import { ApiError, getProjects } from './api.mjs';
import {
  configPath,
  loadLocalConfig,
  upsertProjectMappingConfig
} from './logwork-config.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';

export async function listLogworkProjects({
  cwd = process.cwd(),
  fetchProjects
} = {}) {
  const projects = sanitizeProjects(await (fetchProjects || createMembershipProjectsFetcher())());
  const config = await loadLocalConfig(cwd);

  return {
    projects,
    mappings: config.projectMappings,
    configSources: {
      user: configPath(cwd, 'user'),
      project: configPath(cwd, 'project')
    },
    summary: [
      `Found ${projects.length} Resource Optimiser project memberships.`,
      config.projectMappings.length
        ? `Current mappings: ${config.projectMappings.length}.`
        : 'No project mappings configured yet.'
    ].join('\n')
  };
}

export async function upsertProjectMapping({
  projectMemberId,
  projectName,
  tickets = [],
  keywords = [],
  scope = 'user',
  confirm,
  cwd = process.cwd(),
  fetchProjects
} = {}) {
  if (confirm !== true) {
    throw new Error('upsert_project_mapping requires confirm: true.');
  }

  if (!Array.isArray(tickets) || !tickets.length) {
    throw new Error('upsert_project_mapping requires at least one ticket prefix.');
  }

  const projects = sanitizeProjects(await (fetchProjects || createMembershipProjectsFetcher())());
  const resolution = resolveProjectSelection(projects, { projectMemberId, projectName });
  if (!resolution.project) {
    const suffix = resolution.candidates?.length
      ? ` Candidates: ${resolution.candidates.map((project) => `${project.projectMemberId}:${project.projectName}`).join(', ')}`
      : '';
    throw new Error(`${resolution.reason}.${suffix}`);
  }

  const result = await upsertProjectMappingConfig({
    cwd,
    scope,
    project: resolution.project,
    tickets,
    keywords
  });

  return {
    status: result.created ? 'created' : 'updated',
    scope: result.scope,
    configPath: result.path,
    mapping: result.mapping,
    projects,
    summary: [
      `${result.created ? 'Created' : 'Updated'} project mapping for ${result.mapping.projectName}.`,
      `Tickets: ${result.mapping.tickets.join(', ')}.`,
      result.mapping.keywords.length ? `Keywords: ${result.mapping.keywords.join(', ')}.` : 'Keywords: none.'
    ].join('\n')
  };
}

export function buildSetupSuggestions(entries, membershipProjects = []) {
  const candidates = sanitizeProjects(membershipProjects);

  return entries
    .filter((entry) => entry.status === 'unresolved')
    .map((entry) => {
      const ticketPrefixes = ticketPrefixesFromEntry(entry);
      if (!ticketPrefixes.length) {
        return null;
      }

      const candidateProjects = sanitizeProjects(entry.candidates?.length ? entry.candidates : candidates);
      if (!candidateProjects.length) {
        return null;
      }

      return {
        entryId: entry.id,
        date: entry.date,
        hours: entry.hours,
        taskName: entry.taskName,
        tickets: entry.tickets || [],
        ticketPrefixes,
        candidateProjects: candidateProjects.map((project) => ({
          ...project,
          toolArguments: {
            projectMemberId: project.projectMemberId,
            tickets: ticketPrefixes,
            keywords: [],
            confirm: true
          }
        }))
      };
    })
    .filter(Boolean);
}

function createMembershipProjectsFetcher() {
  const session = createResourceOptimiserSession();
  return async () => {
    const { token, userId } = await session.get();
    try {
      return await getProjects(token, userId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getProjects(refreshed.token, refreshed.userId);
    }
  };
}

function resolveProjectSelection(projects, { projectMemberId, projectName }) {
  if (projectMemberId !== undefined && projectMemberId !== null && String(projectMemberId).trim() !== '') {
    const project = projects.find((candidate) => String(candidate.projectMemberId) === String(projectMemberId));
    return project
      ? { project }
      : { project: null, reason: `Project member ${projectMemberId} was not found in your memberships`, candidates: projects };
  }

  if (!projectName || !String(projectName).trim()) {
    return {
      project: null,
      reason: 'Pass projectMemberId or projectName to choose a mapping project',
      candidates: projects
    };
  }

  const normalizedName = normalize(projectName);
  const exactMatches = projects.filter((project) => normalize(project.projectName) === normalizedName);
  if (exactMatches.length === 1) {
    return { project: exactMatches[0] };
  }

  const fuzzyMatches = projects.filter((project) => normalize(project.projectName).includes(normalizedName));
  if (fuzzyMatches.length === 1) {
    return { project: fuzzyMatches[0] };
  }

  if (exactMatches.length > 1 || fuzzyMatches.length > 1) {
    return {
      project: null,
      reason: `Project name "${projectName}" is ambiguous`,
      candidates: exactMatches.length > 1 ? exactMatches : fuzzyMatches
    };
  }

  return {
    project: null,
    reason: `Project name "${projectName}" was not found in your memberships`,
    candidates: projects
  };
}

function ticketPrefixesFromEntry(entry) {
  return [...new Set((entry.tickets || [])
    .map((ticket) => String(ticket).toUpperCase().match(/^([A-Z][A-Z0-9]+)-\d+/)?.[1])
    .filter(Boolean))];
}

function sanitizeProjects(projects) {
  return (Array.isArray(projects) ? projects : [])
    .filter((project) => project && project.projectMemberId !== undefined && project.projectMemberId !== null)
    .map((project) => ({
      projectMemberId: project.projectMemberId,
      projectId: project.projectId,
      projectName: project.projectName
    }));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
