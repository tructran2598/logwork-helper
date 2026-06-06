import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const HELPER_HOME_DIRNAME = '.logwork-helper';
export const CONFIG_FILE_NAME = '.logwork-helper.json';

export function helperHome() {
  return resolve(process.env.LOGWORK_HELPER_HOME || resolve(homedir(), HELPER_HOME_DIRNAME));
}

export function userConfigPath() {
  return resolve(helperHome(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd = process.cwd()) {
  return resolve(cwd, CONFIG_FILE_NAME);
}
