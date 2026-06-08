import { authenticateWithApi } from './api-auth.mjs';
import { createAuthRequiredError } from './auth-errors.mjs';
import { createKeychainEmailStorage, createKeychainTokenStorage } from './keychain.mjs';

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

export function summarizeToken(token) {
  const payload = decodeJwt(token);
  return {
    userId: getUserIdFromJwt(token),
    email: payload.email || null,
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null
  };
}

export async function getStoredAuthStatus({ storage = createKeychainTokenStorage() } = {}) {
  const token = await storage.get();
  if (!token) {
    return {
      authenticated: false,
      expired: false,
      summary: 'Not authenticated. Run `logwork-helper auth login`.'
    };
  }

  if (isJwtExpired(token)) {
    return {
      authenticated: false,
      expired: true,
      summary: 'Stored Resource Optimiser token is expired. Run `logwork-helper auth login`.'
    };
  }

  const details = summarizeToken(token);
  return {
    authenticated: true,
    expired: false,
    ...details,
    summary: `Authenticated as user ${details.userId}${details.email ? ` (${details.email})` : ''}. Token expires at ${details.expiresAt}.`
  };
}

export async function loginResourceOptimiser({
  credentialProvider,
  storage = createKeychainTokenStorage()
} = {}) {
  const token = await authenticateWithApi({ credentialProvider });
  await validateAndStoreToken(token, storage);
  const details = summarizeToken(token);
  return {
    ...details,
    summary: `Authenticated as user ${details.userId}${details.email ? ` (${details.email})` : ''}. Token expires at ${details.expiresAt}.`
  };
}

export async function logoutResourceOptimiser({
  storage = createKeychainTokenStorage(),
  emailStorage = createKeychainEmailStorage()
} = {}) {
  const deleted = await storage.delete();
  await emailStorage.delete().catch(() => {});
  return {
    deleted,
    summary: deleted ? 'Deleted stored Resource Optimiser token.' : 'No stored Resource Optimiser token found.'
  };
}

export async function getFreshToken({
  credentialProvider,
  forceLogin = false,
  interactive = true,
  storage = createKeychainTokenStorage()
} = {}) {
  if (!forceLogin) {
    const storedToken = await storage.get();
    if (storedToken && !isJwtExpired(storedToken)) {
      return storedToken;
    }
  }

  if (!interactive) {
    throw createAuthRequiredError();
  }

  const token = await authenticateWithApi({ credentialProvider });
  await validateAndStoreToken(token, storage);
  return token;
}

async function validateAndStoreToken(token, storage) {
  if (!token || isJwtExpired(token)) {
    throw new Error('Resource Optimiser auth did not return a valid API token.');
  }

  getUserIdFromJwt(token);
  await storage.set(token);
}
