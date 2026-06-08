import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const HELPER_HOME_DIRNAME = '.logwork-helper';
export const CONFIG_FILE_NAME = '.logwork-helper.json';
export const MANUAL_DRAFTS_FILE_NAME = 'manual-drafts.json';

export function helperHome() {
  return resolve(process.env.LOGWORK_HELPER_HOME || resolve(homedir(), HELPER_HOME_DIRNAME));
}

export function userConfigPath() {
  return resolve(helperHome(), CONFIG_FILE_NAME);
}

export function manualDraftsPath() {
  return resolve(helperHome(), MANUAL_DRAFTS_FILE_NAME);
}

export function legacyUserConfigPath() {
  return resolve(homedir(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd = process.cwd()) {
  return resolve(cwd, CONFIG_FILE_NAME);
}
