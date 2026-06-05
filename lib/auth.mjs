import { CONFIG } from '../config.mjs';
import {
  focusTerminalWindowByTitle,
  openSafariLogin,
  readSafariLocalStorageToken
} from './macos.mjs';
import { sleep } from './util.mjs';

export function decodeJwt(token) {
  if (typeof token !== 'string') {
    throw new Error('JWT token is not a string.');
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Malformed JWT token.');
  }

  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`Unable to decode JWT payload: ${error.message}`);
  }
}

export function isJwtExpired(token, skewSeconds = 60) {
  try {
    const payload = decodeJwt(token);
    if (typeof payload.exp !== 'number') {
      return true;
    }

    const expiresAtMs = payload.exp * 1000;
    return expiresAtMs <= Date.now() + skewSeconds * 1000;
  } catch {
    return true;
  }
}

export function getUserIdFromJwt(token) {
  const payload = decodeJwt(token);
  const userId = payload.id ?? payload.user_id ?? payload.sub;

  if (userId === undefined || userId === null || String(userId).trim() === '') {
    throw new Error('Unable to find user id in JWT payload.');
  }

  return userId;
}

export async function getFreshToken({ loginUrl, tokenKey, allowedHosts, terminalTitle, forceLogin = false }) {
  const existingToken = await readSafariLocalStorageToken({ tokenKey, allowedHosts });
  if (!forceLogin && existingToken && !isJwtExpired(existingToken)) {
    return existingToken;
  }

  await openSafariLogin(loginUrl);

  const deadline = Date.now() + CONFIG.loginTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(CONFIG.loginPollMs);
    const token = await readSafariLocalStorageToken({ tokenKey, allowedHosts });
    if (token && !isJwtExpired(token)) {
      await focusTerminalWindowByTitle(terminalTitle).catch(() => {});
      return token;
    }
  }

  const error = new Error('LOGIN_TIMEOUT: timed out waiting for a fresh Safari token.');
  error.code = 'LOGIN_TIMEOUT';
  throw error;
}
