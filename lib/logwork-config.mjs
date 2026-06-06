import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  projectConfigPath,
  userConfigPath
} from './paths.mjs';
import { safeJsonParse } from './util.mjs';

export async function loadLocalConfig(cwd = process.cwd()) {
  const userConfig = normalizeConfig(await readRawConfigPath(userConfigPath()));
  const projectPath = projectConfigPath(cwd);
  const projectConfig = projectPath === userConfigPath()
    ? normalizeConfig({})
    : normalizeConfig(await readRawConfigPath(projectPath));

  return mergeConfigs(userConfig, projectConfig);
}

export async function upsertProjectMappingConfig({
  cwd = process.cwd(),
  scope = 'user',
  project,
  tickets = [],
  keywords = []
}) {
  const path = scope === 'project' ? projectConfigPath(cwd) : userConfigPath();
  const rawConfig = await readRawConfigPath(path);
  const config = normalizeConfig(rawConfig);
  const mapping = {
    projectName: project.projectName,
    projectMemberId: project.projectMemberId,
    tickets: normalizeTickets(tickets),
    keywords: normalizeKeywords(keywords)
  };
  const existingIndex = config.projectMappings.findIndex((candidate) => (
    mapping.projectMemberId !== undefined &&
      mapping.projectMemberId !== null &&
      candidate.projectMemberId !== undefined &&
      candidate.projectMemberId !== null
      ? String(candidate.projectMemberId) === String(mapping.projectMemberId)
      : normalize(candidate.projectName) === normalize(mapping.projectName)
  ));

  const projectMappings = [...config.projectMappings];
  if (existingIndex >= 0) {
    const existing = projectMappings[existingIndex];
    projectMappings[existingIndex] = {
      projectName: mapping.projectName || existing.projectName,
      projectMemberId: mapping.projectMemberId ?? existing.projectMemberId,
      tickets: uniqueStrings([...existing.tickets, ...mapping.tickets], { uppercase: true }),
      keywords: uniqueStrings([...existing.keywords, ...mapping.keywords])
    };
  } else {
    projectMappings.push(mapping);
  }

  const nextConfig = { projectMappings };
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');

  return {
    path,
    scope,
    config: normalizeConfig(nextConfig),
    mapping: normalizeConfig({ projectMappings: [existingIndex >= 0 ? projectMappings[existingIndex] : mapping] }).projectMappings[0],
    created: existingIndex < 0
  };
}

export function normalizeConfig(config) {
  const rawMappings = Array.isArray(config.projectMappings)
    ? config.projectMappings
    : Array.isArray(config.mappings)
      ? config.mappings
      : [];

  return {
    projectMappings: rawMappings
      .filter((mapping) => mapping && typeof mapping === 'object')
      .map((mapping) => ({
        projectName: stringOrEmpty(mapping.projectName),
        projectMemberId: mapping.projectMemberId,
        tickets: stringArray(mapping.tickets),
        keywords: stringArray(mapping.keywords)
      }))
  };
}

export function configPath(cwd = process.cwd(), scope = 'user') {
  return scope === 'project' ? projectConfigPath(cwd) : userConfigPath();
}

async function readRawConfigPath(path) {
  try {
    const text = await fs.readFile(path, 'utf8');
    const data = safeJsonParse(text, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${path} must contain a JSON object.`);
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function mergeConfigs(userConfig, projectConfig) {
  const mappings = new Map();

  for (const mapping of userConfig.projectMappings) {
    mappings.set(mappingKey(mapping), mapping);
  }

  for (const mapping of projectConfig.projectMappings) {
    mappings.set(mappingKey(mapping), mapping);
  }

  return {
    projectMappings: [...mappings.values()]
  };
}

function mappingKey(mapping) {
  return mapping.projectMemberId !== undefined && mapping.projectMemberId !== null
    ? `member:${mapping.projectMemberId}`
    : `name:${normalize(mapping.projectName)}`;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeTickets(value) {
  return uniqueStrings(stringArray(value), { uppercase: true });
}

function normalizeKeywords(value) {
  return uniqueStrings(stringArray(value));
}

function uniqueStrings(values, { uppercase = false } = {}) {
  const seen = new Set();
  const results = [];

  for (const value of values) {
    const normalized = uppercase ? value.toUpperCase() : value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
