const RESOLVE_THRESHOLD = 0.75;
const AMBIGUOUS_MARGIN = 0.1;

export function resolveEntryProject({
  entry,
  projects,
  membershipProjects = [],
  projectOverrides = {},
  config = {}
}) {
  const bookedProjects = Array.isArray(projects) ? projects : [];
  const memberships = Array.isArray(membershipProjects) ? membershipProjects : [];
  const override = projectOverrides?.[entry.id];

  if (override !== undefined && override !== null && String(override).trim() !== '') {
    const project = findProjectByMemberId(bookedProjects, override);

    if (project) {
      return resolved(project, 1, 'override', [], true);
    }

    const membership = findProjectByMemberId(memberships, override);
    if (membership) {
      return resolved(membership, 1, 'override_unbooked', [], false);
    }

    return unresolved('override_not_found', combineCandidates(bookedProjects, memberships));
  }

  if (bookedProjects.length === 1) {
    return resolved(bookedProjects[0], 0.95, 'single_booked_project', [], true);
  }

  if (bookedProjects.length > 1) {
    const bookedResult = resolveScoredProjects(entry, bookedProjects, config, true);
    if (bookedResult.status === 'resolved') {
      return bookedResult;
    }
  }

  const membershipCandidates = memberships.filter((membership) => (
    !bookedProjects.some((booked) => String(booked.projectMemberId) === String(membership.projectMemberId))
  ));
  const unbookedResult = resolveScoredProjects(entry, membershipCandidates, config, false);
  if (unbookedResult.status === 'resolved_unbooked') {
    return unbookedResult;
  }

  if (bookedProjects.length === 0) {
    return unresolved('no_booked_projects', membershipCandidates);
  }

  const scored = bookedProjects
    .map((project) => scoreProject(entry, project, config))
    .sort((left, right) => right.confidence - left.confidence);
  const best = scored[0];

  return {
    status: 'unresolved',
    reason: best.confidence > 0 ? 'ambiguous_project_match' : 'no_project_match',
    confidence: best.confidence,
    candidates: scored.map(toCandidate)
  };
}

function resolveScoredProjects(entry, projects, config, booked) {
  if (!projects.length) {
    return unresolved(booked ? 'no_booked_projects' : 'no_membership_project_match', []);
  }

  const scored = projects
    .map((project) => scoreProject(entry, project, config, { allowProjectTextMatch: booked }))
    .sort((left, right) => right.confidence - left.confidence);
  const best = scored[0];
  const second = scored[1];

  if (
    best.confidence >= RESOLVE_THRESHOLD &&
    (!second || best.confidence - second.confidence >= AMBIGUOUS_MARGIN)
  ) {
    return resolved(best.project, best.confidence, booked ? best.source : `${best.source}_unbooked`, scored, booked);
  }

  return {
    status: 'unresolved',
    reason: best.confidence > 0 ? 'ambiguous_project_match' : 'no_project_match',
    confidence: best.confidence,
    candidates: scored.map((candidate) => toCandidate(candidate, booked))
  };
}

function scoreProject(entry, project, config, { allowProjectTextMatch = true } = {}) {
  const taskText = normalize(entry.taskName);
  const projectName = normalize(project.projectName);
  let confidence = 0;
  let source = 'none';

  if (allowProjectTextMatch && projectName && taskText.includes(projectName)) {
    confidence = 0.95;
    source = 'project_name';
  }

  if (allowProjectTextMatch) {
    for (const word of projectName.split(/\s+/).filter((part) => part.length >= 4)) {
      if (taskText.includes(word) && confidence < 0.65) {
        confidence = 0.65;
        source = 'project_name_token';
      }
    }
  }

  for (const mapping of config.projectMappings || []) {
    if (!mappingMatchesProject(mapping, project)) {
      continue;
    }

    const ticketMatch = (entry.tickets || []).some((ticket) => (
      (mapping.tickets || []).some((prefix) => ticket.startsWith(prefix.toUpperCase()))
    ));
    if (ticketMatch && confidence < 0.9) {
      confidence = 0.9;
      source = 'config_ticket';
    }

    const keywordMatch = (mapping.keywords || []).some((keyword) => (
      taskText.includes(normalize(keyword))
    ));
    if (keywordMatch && confidence < 0.85) {
      confidence = 0.85;
      source = 'config_keyword';
    }
  }

  return { project, confidence, source };
}

function mappingMatchesProject(mapping, project) {
  if (mapping.projectMemberId !== undefined && mapping.projectMemberId !== null) {
    return String(mapping.projectMemberId) === String(project.projectMemberId);
  }

  if (mapping.projectName) {
    return normalize(project.projectName).includes(normalize(mapping.projectName));
  }

  return false;
}

function resolved(project, confidence, source, candidates, booked) {
  return {
    status: booked ? 'resolved' : 'resolved_unbooked',
    reason: source,
    confidence,
    booked,
    requiresAllowUnbooked: !booked,
    project,
    candidates: candidates.map((candidate) => toCandidate(candidate, booked))
  };
}

function unresolved(reason, projects) {
  return {
    status: 'unresolved',
    reason,
    confidence: 0,
    candidates: projects.map((project) => ({
      projectMemberId: project.projectMemberId,
      projectId: project.projectId,
      projectName: project.projectName,
      booked: Boolean(project.booked),
      confidence: 0,
      source: 'none'
    }))
  };
}

function combineCandidates(bookedProjects, membershipProjects) {
  const candidates = new Map();

  for (const project of bookedProjects) {
    candidates.set(candidateKey(project), {
      ...project,
      booked: true
    });
  }

  for (const project of membershipProjects) {
    const key = candidateKey(project);
    if (candidates.has(key)) {
      continue;
    }

    candidates.set(key, {
      ...project,
      booked: false
    });
  }

  return [...candidates.values()];
}

function toCandidate(item, booked = item.booked) {
  const project = item.project || item;
  return {
    projectMemberId: project.projectMemberId,
    projectId: project.projectId,
    projectName: project.projectName,
    booked: Boolean(booked),
    confidence: item.confidence ?? 0,
    source: item.source || 'none'
  };
}

function findProjectByMemberId(projects, projectMemberId) {
  return projects.find((candidate) => (
    String(candidate.projectMemberId) === String(projectMemberId)
  ));
}

function candidateKey(project) {
  return String(project.projectMemberId ?? project.projectId ?? project.projectName);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
