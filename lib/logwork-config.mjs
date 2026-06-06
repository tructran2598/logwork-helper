import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { safeJsonParse } from './util.mjs';

const CONFIG_FILE_NAME = '.logwork-helper.json';

export async function loadLocalConfig(cwd = process.cwd()) {
  const path = configPath(cwd);

  try {
    const text = await fs.readFile(path, 'utf8');
    const data = safeJsonParse(text, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${path} must contain a JSON object.`);
    }

    return normalizeConfig(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return normalizeConfig({});
    }
    throw error;
  }
}

export async function upsertProjectMappingConfig({
  cwd = process.cwd(),
  project,
  tickets = [],
  keywords = []
}) {
  const rawConfig = await readRawConfig(cwd);
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
  const path = configPath(cwd);
  await fs.writeFile(path, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');

  return {
    path,
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

export function configPath(cwd = process.cwd()) {
  return resolve(cwd, CONFIG_FILE_NAME);
}

async function readRawConfig(cwd) {
  const path = configPath(cwd);
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
