import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.mjs';
import { createTerminalCredentialProvider } from './terminal-auth-prompts.mjs';
import { redactText } from './auth-redaction.mjs';

export async function authenticateWithApi({
  apiBase = CONFIG.apiBase,
  keycloakAuthUrl = CONFIG.keycloakAuthUrl,
  keycloakTokenUrl = CONFIG.keycloakTokenUrl,
  keycloakClientId = CONFIG.keycloakClientId,
  keycloakRedirectUri = CONFIG.keycloakRedirectUri,
  keycloakScope = CONFIG.keycloakScope,
  keycloakResponseMode = CONFIG.keycloakResponseMode,
  keycloakResponseType = CONFIG.keycloakResponseType,
  signinKeycloakPath = CONFIG.signinKeycloakPath,
  maxApiAuthSteps = CONFIG.maxApiAuthSteps,
  credentialProvider = createTerminalCredentialProvider(),
  fetchImpl = fetch
} = {}) {
  const session = createHttpSession({ fetchImpl });
  const authUrl = buildKeycloakAuthorizeUrl({
    keycloakAuthUrl,
    clientId: keycloakClientId,
    redirectUri: keycloakRedirectUri,
    scope: keycloakScope,
    responseMode: keycloakResponseMode,
    responseType: keycloakResponseType
  });
  const loginPage = await session.request(authUrl);

  let current = loginPage;
  const authContext = readAuthContext(authUrl);
  let apiAuthSteps = 0;
  let deviceSelectionSubmitted = false;

  while (!current.redirectCode) {
    if (apiAuthSteps >= maxApiAuthSteps) {
      throw safeApiAuthError(formatStepLimitDiagnostics(current, maxApiAuthSteps));
    }
    apiAuthSteps += 1;

    const form = selectNextKeycloakForm(current.body, current.url, {
      preferDevice: !deviceSelectionSubmitted
    });
    if (!form) {
      throw safeApiAuthError(formatMissingFormDiagnostics(current));
    }

    if (form.kind === 'credentials') {
      const credentials = await credentialProvider.requestCredentials();
      current = await submitCredentialsForm(session, form, credentials);
      continue;
    }

    if (form.kind === 'device') {
      const selectedDevice = await credentialProvider.requestDeviceSelection(form.devices);
      if (!selectedDevice) {
        throw safeApiAuthError('Keycloak requires device selection, but no device option was found.');
      }
      current = await submitDeviceForm(session, form, selectedDevice);
      deviceSelectionSubmitted = true;
      continue;
    }

    if (form.kind === 'otp') {
      const otp = await credentialProvider.requestOtp();
      current = await submitOtpForm(session, form, otp);
      continue;
    }
  }

  const code = current.redirectCode;
  const redirectUri = authContext.redirectUri || current.redirectUri;
  if (!code || !redirectUri) {
    throw safeApiAuthError('Keycloak did not return an authorization code and redirect URI.');
  }

  const keycloakToken = await exchangeAuthorizationCode(session, {
    keycloakTokenUrl,
    code,
    clientId: authContext.clientId || 'localhost',
    redirectUri
  });
  const finalToken = await exchangeSigninKeycloak(session, {
    apiBase,
    signinKeycloakPath,
    accessToken: keycloakToken
  });

  return finalToken;
}

export function buildKeycloakAuthorizeUrl({
  keycloakAuthUrl = CONFIG.keycloakAuthUrl,
  clientId = CONFIG.keycloakClientId,
  redirectUri = CONFIG.keycloakRedirectUri,
  scope = CONFIG.keycloakScope,
  responseMode = CONFIG.keycloakResponseMode,
  responseType = CONFIG.keycloakResponseType,
  state = randomUUID(),
  nonce = randomUUID()
} = {}) {
  const url = new URL(keycloakAuthUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_mode', responseMode);
  url.searchParams.set('response_type', responseType);
  url.searchParams.set('scope', scope);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

export function createHttpSession({ fetchImpl = fetch } = {}) {
  const jar = new CookieJar();

  return {
    jar,
    async request(url, options = {}) {
      return requestWithRedirects({ fetchImpl, jar, url, options });
    }
  };
}

export async function requestWithRedirects({ fetchImpl, jar, url, options = {}, maxRedirects = 10 }) {
  let currentUrl = new URL(url).toString();
  let method = options.method || 'GET';
  let body = options.body;
  const headers = new Headers(options.headers || {});

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const cookie = jar.header(currentUrl);
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    const response = await fetchImpl(currentUrl, {
      ...options,
      method,
      body,
      headers,
      redirect: 'manual'
    });
    jar.store(currentUrl, response.headers);

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw safeApiAuthError('Redirect response did not include a location header.');
      }
      const nextUrl = new URL(location, currentUrl).toString();
      const redirectCode = readAuthorizationCode(nextUrl);
      if (redirectCode) {
        return {
          url: nextUrl,
          status: response.status,
          headers: response.headers,
          body: '',
          redirectCode,
          redirectUri: stripHash(nextUrl)
        };
      }
      currentUrl = nextUrl;
      method = 'GET';
      body = undefined;
      headers.delete('Content-Type');
      continue;
    }

    const text = await response.text();
    if (!response.ok) {
      throw safeApiAuthError(`API auth request failed with HTTP ${response.status}.`);
    }
    return {
      url: currentUrl,
      status: response.status,
      headers: response.headers,
      body: text
    };
  }

  throw safeApiAuthError('Too many redirects during API auth.');
}

export function findKeycloakAuthUrl(html, baseUrl) {
  const matches = String(html || '').match(/https:\/\/keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth[^"' <]+/i);
  if (matches?.[0]) {
    return decodeHtml(matches[0]);
  }

  const href = findAttributeValue(html, 'href', /keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth/i);
  if (href) {
    return new URL(decodeHtml(href), baseUrl).toString();
  }

  return null;
}

export function selectNextKeycloakForm(html, baseUrl, { preferDevice = false } = {}) {
  const forms = parseHtmlForms(html, baseUrl);
  const credentials = forms.find((form) => form.kind === 'credentials');
  const otp = forms.find((form) => form.kind === 'otp');
  const device = forms.find((form) => form.kind === 'device' || form.devices.length > 0);

  if (credentials) {
    return credentials;
  }
  if (preferDevice && device) {
    return {
      ...device,
      kind: 'device'
    };
  }
  if (otp) {
    return otp;
  }
  if (device) {
    return device;
  }

  return forms.find((form) => form.kind === 'credentials')
    || null;
}

export function parseHtmlForms(html, baseUrl) {
  const forms = [];
  const source = String(html || '');
  const regex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = regex.exec(source))) {
    const attrs = match[1];
    const inner = match[2];
    const action = resolveActionUrl(decodeHtml(readAttr(attrs, 'action') || ''), baseUrl);
    const method = (readAttr(attrs, 'method') || 'GET').toUpperCase();
    const fields = readInputFields(inner);
    const devices = readDeviceOptions(inner);
    const kind = classifyForm(fields, devices);
    forms.push({ action, method, fields, devices, kind });
  }
  return forms;
}

export async function submitCredentialsForm(session, form, { email, password }) {
  const body = bodyFromForm(form);
  body.set(fieldName(form, ['username', 'email']) || 'username', email);
  body.set(fieldName(form, ['password']) || 'password', password);
  return postForm(session, form.action, body);
}

export async function submitDeviceForm(session, form, device) {
  const body = bodyFromForm(form);
  body.set(device.name, device.value);
  return postForm(session, form.action, body);
}

export async function submitOtpForm(session, form, otp) {
  const body = bodyFromForm(form);
  body.set(otpFieldName(form) || 'otp', otp);
  return postForm(session, form.action, body);
}

export async function exchangeAuthorizationCode(session, {
  keycloakTokenUrl,
  code,
  clientId,
  redirectUri
}) {
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri
  });
  const response = await session.request(keycloakTokenUrl, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://app.resourceoptimiser.com',
      Referer: 'https://app.resourceoptimiser.com/'
    },
    body
  });
  const data = safeJson(response.body);
  const token = data.access_token || data.accessToken;
  if (!token) {
    throw safeApiAuthError('Keycloak token endpoint did not return an access token.');
  }
  return token;
}

export async function exchangeSigninKeycloak(session, {
  apiBase,
  signinKeycloakPath,
  accessToken
}) {
  const response = await session.request(`${apiBase}${signinKeycloakPath}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: 'https://app.resourceoptimiser.com',
      Referer: 'https://app.resourceoptimiser.com/'
    },
    body: JSON.stringify({ accessToken })
  });
  const data = safeJson(response.body);
  const token = extractRoToken(data, response.headers);
  if (!token) {
    throw safeApiAuthError(formatSigninKeycloakDiagnostics(response, data));
  }
  return token;
}

export function extractRoToken(data, headers) {
  const candidates = [
    readBearerHeader(headers),
    ...collectJwtCandidates(data)
  ].filter(Boolean);
  return candidates.find(isResourceOptimiserJwt) || null;
}

export function readAuthContext(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return {};
  }
  return {
    clientId: url.searchParams.get('client_id'),
    redirectUri: url.searchParams.get('redirect_uri')
  };
}

function postForm(session, action, body) {
  return session.request(action, {
    method: 'POST',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
}

function formatMissingFormDiagnostics(response) {
  const url = safeUrlParts(response.url);
  const forms = parseHtmlForms(response.body, response.url);
  const kinds = forms.map((form) => form.kind).filter(Boolean);
  const title = readTitle(response.body);
  const bodyHint = readBodyHint(response.body);
  return [
    'Unable to find a supported Keycloak login, device, or 2FA form.',
    `Current page: ${url.host}${url.path}`,
    `Status: ${response.status || 'unknown'}`,
    `Forms: ${forms.length}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
    title ? `Title: ${title}` : null,
    bodyHint ? `Hint: ${bodyHint}` : null,
    'Retry with `logwork-helper auth login`. If this keeps failing, inspect sanitized JSON key diagnostics and Keycloak form shape.'
  ].filter(Boolean).join(' ');
}

function formatStepLimitDiagnostics(response, maxApiAuthSteps) {
  const url = safeUrlParts(response.url);
  const forms = parseHtmlForms(response.body, response.url);
  const kinds = forms.map((form) => form.kind).filter(Boolean);
  return [
    `API-only auth stopped after ${maxApiAuthSteps} Keycloak form steps to avoid an infinite loop.`,
    `Current page: ${url.host}${url.path}`,
    `Status: ${response.status || 'unknown'}`,
    `Forms: ${forms.length}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
    'Retry with `logwork-helper auth login`. If this keeps failing, inspect sanitized diagnostics and Keycloak form shape.'
  ].join(' ');
}

function formatSigninKeycloakDiagnostics(response, data) {
  const keys = collectJsonKeyPaths(data);
  return [
    'Resource Optimiser signinKeyCloak did not return a usable API token.',
    `Status: ${response.status || 'unknown'}`,
    `JSON keys: ${keys.length ? keys.join(', ') : '(none)'}`,
    'Retry with `logwork-helper auth login`. If this keeps failing, inspect sanitized JSON key diagnostics from the error.'
  ].join(' ');
}

function safeUrlParts(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      host: url.host,
      path: url.pathname
    };
  } catch {
    return {
      host: 'unknown-host',
      path: '/unknown-path'
    };
  }
}

function readTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(decodeHtml(match[1])).slice(0, 120) : null;
}

function readBodyHint(html) {
  const bodyMatch = String(html || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = String(bodyMatch ? bodyMatch[1] : html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const hint = stripTags(decodeHtml(body)).slice(0, 160);
  return hint || null;
}

function resolveActionUrl(action, baseUrl) {
  if (!action) {
    return baseUrl ? new URL(baseUrl).toString() : '';
  }
  if (!baseUrl) {
    return action;
  }
  return new URL(action, baseUrl).toString();
}

function bodyFromForm(form) {
  const body = new URLSearchParams();
  for (const field of form.fields) {
    if (field.name && field.value !== undefined) {
      body.set(field.name, field.value);
    }
  }
  return body;
}

function readBearerHeader(headers) {
  const value = headers?.get?.('authorization') || headers?.get?.('Authorization') || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function collectJwtCandidates(value, seen = new Set()) {
  if (typeof value === 'string') {
    return value.split('.').length >= 3 ? [value] : [];
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return [];
  }
  seen.add(value);

  const candidates = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      candidates.push(...collectJwtCandidates(item, seen));
    }
    return candidates;
  }

  for (const item of Object.values(value)) {
    candidates.push(...collectJwtCandidates(item, seen));
  }
  return candidates;
}

function collectJsonKeyPaths(value, path = '', seen = new Set(), output = []) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return output;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => {
      collectJsonKeyPaths(item, `${path}[${index}]`, seen, output);
    });
    return output;
  }

  for (const key of Object.keys(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    output.push(nextPath);
    if (output.length >= 40) {
      return output;
    }
    collectJsonKeyPaths(value[key], nextPath, seen, output);
  }
  return output;
}

function isResourceOptimiserJwt(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return false;
  }
  if (isKeycloakJwtPayload(payload)) {
    return false;
  }
  return Boolean(
    payload.id !== undefined
      || typeof payload.email === 'string'
      || typeof payload.db_url === 'string'
      || typeof payload.dbUrl === 'string'
      || typeof payload.user_id === 'number'
      || typeof payload.userId === 'number'
  );
}

function isKeycloakJwtPayload(payload) {
  const issuer = String(payload.iss || '').toLowerCase();
  return issuer.includes('keycloak')
    || payload.azp === 'localhost'
    || payload.realm_access !== undefined
    || payload.resource_access !== undefined;
}

function decodeJwtPayload(token) {
  const [, payload] = String(token || '').split('.');
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function fieldName(form, candidates) {
  const lower = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return form.fields.find((field) => lower.has(String(field.name || '').toLowerCase()))?.name;
}

function classifyForm(fields, devices) {
  const names = fields.map((field) => String(field.name || '').toLowerCase());
  const types = fields.map((field) => String(field.type || '').toLowerCase());
  if (names.includes('password') || types.includes('password')) {
    return 'credentials';
  }
  if (otpFieldName({ fields })) {
    return 'otp';
  }
  if (devices.length > 0) {
    return 'device';
  }
  return 'unknown';
}

function readInputFields(html) {
  const fields = [];
  const regex = /<input\b([^>]*)>/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const attrs = match[1];
    fields.push({
      name: decodeHtml(readAttr(attrs, 'name') || ''),
      id: decodeHtml(readAttr(attrs, 'id') || ''),
      type: decodeHtml(readAttr(attrs, 'type') || 'text'),
      value: decodeHtml(readAttr(attrs, 'value') || ''),
      autocomplete: decodeHtml(readAttr(attrs, 'autocomplete') || ''),
      inputmode: decodeHtml(readAttr(attrs, 'inputmode') || ''),
      placeholder: decodeHtml(readAttr(attrs, 'placeholder') || ''),
      ariaLabel: decodeHtml(readAttr(attrs, 'aria-label') || '')
    });
  }
  return fields.filter((field) => field.name);
}

function otpFieldName(form) {
  return form.fields.find(isOtpInputField)?.name;
}

function isOtpInputField(field) {
  const name = String(field.name || '').toLowerCase();
  const type = String(field.type || 'text').toLowerCase();
  if (['hidden', 'radio', 'checkbox', 'submit', 'button'].includes(type)) {
    return false;
  }

  if (['otp', 'totp'].includes(name)) {
    return true;
  }

  if (name !== 'code') {
    return false;
  }

  const hint = [
    field.id,
    field.autocomplete,
    field.inputmode,
    field.placeholder,
    field.ariaLabel
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  return /otp|totp|one-time|one time|verification|authenticator|2fa|mfa|sms|pin|numeric|number/.test(hint);
}

function readDeviceOptions(html) {
  const devices = [];
  const radioRegex = /<input\b([^>]*type=["']?radio["']?[^>]*)>/gi;
  let radioMatch;
  while ((radioMatch = radioRegex.exec(String(html || '')))) {
    const attrs = radioMatch[1];
    const name = decodeHtml(readAttr(attrs, 'name') || '');
    const value = decodeHtml(readAttr(attrs, 'value') || '');
    const id = decodeHtml(readAttr(attrs, 'id') || '');
    if (!name || !value) {
      continue;
    }
    devices.push({
      type: 'radio',
      name,
      value,
      label: readLabelFor(html, id) || value
    });
  }

  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch;
  while ((selectMatch = selectRegex.exec(String(html || '')))) {
    const name = decodeHtml(readAttr(selectMatch[1], 'name') || '');
    if (!name) {
      continue;
    }
    const optionRegex = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionRegex.exec(selectMatch[2]))) {
      const value = decodeHtml(readAttr(optionMatch[1], 'value') || '');
      const label = stripTags(decodeHtml(optionMatch[2]));
      if (value) {
        devices.push({ type: 'select', name, value, label: label || value });
      }
    }
  }

  return devices;
}

function readLabelFor(html, id) {
  if (!id) {
    return null;
  }
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html || '').match(new RegExp(`<label\\b[^>]*for=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/label>`, 'i'));
  return match ? stripTags(decodeHtml(match[1])) : null;
}

function readAttr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function findAttributeValue(html, attr, pattern) {
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (pattern.test(value)) {
      return value;
    }
  }
  return null;
}

function readAuthorizationCode(rawUrl) {
  const url = new URL(rawUrl);
  return url.searchParams.get('code') || new URLSearchParams(url.hash.replace(/^#/, '')).get('code');
}

function stripHash(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  return url.toString();
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw safeApiAuthError('Auth endpoint returned non-JSON response.');
  }
}

function safeApiAuthError(message) {
  const error = new Error(redactText(message));
  error.code = 'API_AUTH_FAILED';
  return error;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(rawUrl, headers) {
    const url = new URL(rawUrl);
    const values = getSetCookieValues(headers);
    for (const value of values) {
      const [pair] = value.split(';');
      const [name, cookieValue] = pair.split('=');
      if (name && cookieValue !== undefined) {
        this.cookies.set(`${url.hostname}:${name.trim()}`, `${name.trim()}=${cookieValue.trim()}`);
      }
    }
  }

  header(rawUrl) {
    const url = new URL(rawUrl);
    return [...this.cookies.entries()]
      .filter(([key]) => key.startsWith(`${url.hostname}:`))
      .map(([, value]) => value)
      .join('; ');
  }
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const value = headers.get?.('set-cookie');
  return value ? splitSetCookie(value) : [];
}

function splitSetCookie(value) {
  return String(value)
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((item) => item.trim())
    .filter(Boolean);
}
