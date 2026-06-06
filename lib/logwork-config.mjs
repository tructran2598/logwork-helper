import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { safeJsonParse } from './util.mjs';

export async function loadLocalConfig(cwd = process.cwd()) {
  const path = resolve(cwd, '.logwork-helper.json');

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

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}
