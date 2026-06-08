export const CONFIG = {
  apiBase: 'https://api.resourceoptimiser.com/api/v1',
  loginUrl: 'https://app.resourceoptimiser.com/vinova',
  tokenKey: 'vinova_access_token',

  allowedSafariHosts: [
    'app.resourceoptimiser.com'
  ],

  projectMembersPath: '/project-members/by-user',
  memberLogtimePath: '/member-logtime',
  memberLogtimeMethod: 'PATCH',
  timesheetPath: '/member-logtime/timesheet',
  signinKeycloakPath: '/auth/signinKeyCloak',
  refreshTokenPath: '/auth/refresh-token',
  keycloakAuthUrl: 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/auth',
  keycloakTokenUrl: 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/token',
  keycloakClientId: 'localhost',
  keycloakRedirectUri: 'https://app.resourceoptimiser.com/vinova/check-login',
  keycloakScope: 'openid',
  keycloakResponseMode: 'fragment',
  keycloakResponseType: 'code',
  keycloakHost: 'keycloak.vinova.sg',

  pollMs: 500,
  hookTimeoutMs: 5 * 60 * 1000,
  loginPollMs: 2000,
  loginTimeoutMs: 5 * 60 * 1000,
  maxApiAuthSteps: 12,

  defaultHours: 1,
  standardDayHours: 8,
  hourStep: 0.5,
  dayLogConcurrency: 5,

  resultValues: {
    ok: 'ok',
    skip: 'skip',
    abort: 'abort'
  }
};
