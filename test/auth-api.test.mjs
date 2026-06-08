import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticateWithApi,
  buildKeycloakAuthorizeUrl,
  exchangeSigninKeycloak,
  extractRoToken,
  parseHtmlForms,
  selectNextKeycloakForm
} from '../lib/api-auth.mjs';

test('buildKeycloakAuthorizeUrl creates Resource Optimiser OIDC authorize URL', () => {
  const url = new URL(buildKeycloakAuthorizeUrl({
    state: 'state-value',
    nonce: 'nonce-value'
  }));

  assert.equal(url.origin + url.pathname, 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/auth');
  assert.equal(url.searchParams.get('client_id'), 'localhost');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.resourceoptimiser.com/vinova/check-login');
  assert.equal(url.searchParams.get('response_mode'), 'fragment');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('nonce'), 'nonce-value');

  const randomUrl = new URL(buildKeycloakAuthorizeUrl());
  assert.match(randomUrl.searchParams.get('state'), /^[0-9a-f-]{36}$/);
  assert.match(randomUrl.searchParams.get('nonce'), /^[0-9a-f-]{36}$/);
});

test('parseHtmlForms finds Keycloak credential, device, and OTP forms', () => {
  const credentials = selectNextKeycloakForm(`
    <form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=secret" method="post">
      <input type="hidden" name="credentialId" value="">
      <input name="username">
      <input name="password" type="password">
    </form>
  `);
  assert.equal(credentials.kind, 'credentials');
  assert.equal(credentials.fields.some((field) => field.name === 'password'), true);

  const [device] = parseHtmlForms(`
    <form action="/device" method="post">
      <input type="hidden" name="code" value="session-code">
      <input type="radio" id="phone" name="credentialId" value="phone">
      <label for="phone">Mobile phone</label>
    </form>
  `, 'https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?execution=step');
  assert.equal(device.kind, 'device');
  assert.equal(device.action, 'https://keycloak.vinova.sg/device');
  assert.deepEqual(device.devices[0], {
    type: 'radio',
    name: 'credentialId',
    value: 'phone',
    label: 'Mobile phone'
  });

  const otp = selectNextKeycloakForm(`
    <form action="/otp" method="post">
      <input type="text" name="otp">
    </form>
  `);
  assert.equal(otp.kind, 'otp');

  const mixedOtpDevice = selectNextKeycloakForm(`
    <form action="/mixed" method="post">
      <input type="radio" id="phone-again" name="credentialId" value="phone">
      <label for="phone-again">Mobile phone</label>
      <input type="text" name="otp">
    </form>
  `);
  assert.equal(mixedOtpDevice.kind, 'otp');
  assert.equal(mixedOtpDevice.devices[0].label, 'Mobile phone');

  const mixedBeforeDeviceSubmit = selectNextKeycloakForm(`
    <form action="/mixed" method="post">
      <input type="radio" id="phone-again" name="credentialId" value="phone">
      <label for="phone-again">Mobile phone</label>
      <input type="text" name="otp">
    </form>
  `, undefined, { preferDevice: true });
  assert.equal(mixedBeforeDeviceSubmit.kind, 'device');

  const otpPreferredOverDevice = selectNextKeycloakForm(`
    <form action="/device" method="post">
      <input type="radio" id="phone" name="credentialId" value="phone">
      <label for="phone">Mobile phone</label>
    </form>
    <form action="/otp" method="post">
      <input type="text" name="totp">
    </form>
  `);
  assert.equal(otpPreferredOverDevice.kind, 'otp');

  const visibleCodeWithoutOtpHint = selectNextKeycloakForm(`
    <form action="/not-otp" method="post">
      <input type="text" name="code" id="country-code">
    </form>
  `);
  assert.equal(visibleCodeWithoutOtpHint, null);

  const visibleCodeWithOtpHint = selectNextKeycloakForm(`
    <form action="/otp-code" method="post">
      <input type="text" name="code" autocomplete="one-time-code">
    </form>
  `);
  assert.equal(visibleCodeWithOtpHint.kind, 'otp');
});

test('authenticateWithApi submits credentials, device, OTP, token exchange, and signinKeyCloak', async () => {
  const finalToken = makeJwt({ id: 115, exp: futureExp() });
  const requests = [];
  let devicePromptCount = 0;
  let otpPromptCount = 0;
  const responses = [
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1" method="post"><input name="username"><input name="password" type="password"><input name="credentialId" value=""></form>`),
    htmlResponse(`<form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s2&execution=e2&tab_id=t2" method="post"><input type="hidden" name="code" value="session-code"><input type="radio" id="phone" name="credentialId" value="phone"><label for="phone">Phone</label></form>`),
    htmlResponse(`<form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s3&execution=e3&tab_id=t3" method="post"><input type="radio" id="phone-again" name="credentialId" value="phone"><label for="phone-again">Phone</label><input name="otp"></form>`),
    redirectResponse('https://app.resourceoptimiser.com/vinova/check-login#code=auth-code&state=state-value'),
    jsonResponse({ access_token: makeJwt({ sub: 'keycloak-user', exp: futureExp() }) }),
    jsonResponse({ accessToken: finalToken })
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({
      url: String(url),
      method: options.method || 'GET',
      body: String(options.body || '')
    });
    return responses.shift();
  };

  const token = await authenticateWithApi({
    fetchImpl,
    credentialProvider: {
      async requestCredentials() {
        return {
          email: 'user@example.com',
          password: 'secret-password'
        };
      },
      async requestDeviceSelection(devices) {
        devicePromptCount += 1;
        assert.equal(devices[0].label, 'Phone');
        return devices[0];
      },
      async requestOtp() {
        otpPromptCount += 1;
        return '654321';
      }
    }
  });

  assert.equal(token, finalToken);
  assert.equal(devicePromptCount, 1);
  assert.equal(otpPromptCount, 1);
  assert.match(requests[0].url, /^https:\/\/keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth\?/);
  assert.equal(new URL(requests[0].url).searchParams.get('client_id'), 'localhost');
  assert.equal(new URL(requests[0].url).searchParams.get('redirect_uri'), 'https://app.resourceoptimiser.com/vinova/check-login');
  assert.equal(requests[1].url, 'https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1');
  assert.equal(requests[1].body.includes('username=user%40example.com'), true);
  assert.equal(requests[1].body.includes('password=secret-password'), true);
  assert.equal(requests[2].body.includes('credentialId=phone'), true);
  assert.equal(requests[3].body.includes('otp=654321'), true);
  assert.equal(requests[4].url, 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/token');
  assert.equal(requests[4].body.includes('code=auth-code'), true);
  assert.match(requests[5].url, /\/api\/v1\/auth\/signinKeyCloak$/);
});

test('authenticateWithApi stops repeated Keycloak device form loops safely', async () => {
  let devicePromptCount = 0;
  const repeatedDeviceForm = `
    <html>
      <body>
        <form action="/auth/realms/resource/login-actions/authenticate?session_code=secret&execution=execution-id&tab_id=tab-id" method="post">
          <input type="radio" id="phone" name="credentialId" value="phone">
          <label for="phone">Phone</label>
        </form>
        <script>const password = "secret-password"; const otp = "123456";</script>
      </body>
    </html>
  `;

  await assert.rejects(
    authenticateWithApi({
      maxApiAuthSteps: 3,
      fetchImpl: async () => htmlResponse(repeatedDeviceForm),
      credentialProvider: {
        async requestCredentials() {
          throw new Error('credentials should not be requested');
        },
        async requestDeviceSelection(devices) {
          devicePromptCount += 1;
          return devices[0];
        },
        async requestOtp() {
          throw new Error('otp should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /stopped after 3 Keycloak form steps/);
      assert.match(error.message, /Forms: 1 \(device\)/);
      assert.equal(error.message.includes('secret-password'), false);
      assert.equal(error.message.includes('123456'), false);
      assert.equal(error.message.includes('session_code=secret'), false);
      return true;
    }
  );
  assert.equal(devicePromptCount, 3);
});

test('authenticateWithApi reports safe diagnostics when Keycloak returns no supported form', async () => {
  await assert.rejects(
    authenticateWithApi({
      fetchImpl: async () => htmlResponse(`
        <html>
          <head><title>Login unavailable</title></head>
          <body><h1>Unexpected page</h1><p>No form rendered.</p><script>const token = "raw-token";</script></body>
        </html>
      `),
      credentialProvider: {
        async requestCredentials() {
          throw new Error('credentials should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /Current page: keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth/);
      assert.match(error.message, /Status: 200/);
      assert.match(error.message, /Forms: 0/);
      assert.match(error.message, /Title: Login unavailable/);
      assert.equal(error.message.includes('<script>'), false);
      assert.equal(error.message.includes('raw-token'), false);
      assert.equal(error.message.includes('password='), false);
      assert.equal(error.message.includes('Cookie'), false);
      return true;
    }
  );
});

test('extractRoToken ignores Keycloak-shaped objects unless final token field is present', () => {
  const token = makeRoJwt({ id: 115, exp: futureExp() });
  assert.equal(extractRoToken({ data: { user: { token } } }), token);
  assert.equal(extractRoToken({ data: { auth: { accessToken: token } } }), token);
  assert.equal(extractRoToken({ result: { session: { jwt: token } } }), token);
  assert.equal(extractRoToken({ accessToken: makeKeycloakJwt() }), null);
  assert.equal(extractRoToken({ nope: 'missing' }), null);
});

test('exchangeSigninKeycloak accepts Resource Optimiser token from authorization header', async () => {
  const token = makeRoJwt({ id: 115, email: 'user@example.com', exp: futureExp() });
  const session = {
    async request(url, options) {
      assert.match(url, /\/auth\/signinKeyCloak$/);
      assert.equal(JSON.parse(options.body).accessToken, 'keycloak-token');
      return {
        status: 200,
        headers: new Headers({
          Authorization: `Bearer ${token}`
        }),
        body: JSON.stringify({ ok: true })
      };
    }
  };

  assert.equal(await exchangeSigninKeycloak(session, {
    apiBase: 'https://api.resourceoptimiser.com/api/v1',
    signinKeycloakPath: '/auth/signinKeyCloak',
    accessToken: 'keycloak-token'
  }), token);
});

test('exchangeSigninKeycloak reports sanitized diagnostics without leaking tokens', async () => {
  const keycloakToken = makeKeycloakJwt();
  const session = {
    async request() {
      return {
        status: 200,
        headers: new Headers(),
        body: JSON.stringify({
          accessToken: keycloakToken,
          data: {
            user: {
              name: 'Example User'
            }
          }
        })
      };
    }
  };

  await assert.rejects(
    exchangeSigninKeycloak(session, {
      apiBase: 'https://api.resourceoptimiser.com/api/v1',
      signinKeycloakPath: '/auth/signinKeyCloak',
      accessToken: 'keycloak-token'
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /signinKeyCloak did not return a usable API token/);
      assert.match(error.message, /Status: 200/);
      assert.match(error.message, /JSON keys: accessToken, data, data.user, data.user.name/);
      assert.equal(error.message.includes(keycloakToken), false);
      assert.equal(error.message.includes('keycloak-token'), false);
      assert.equal(error.message.includes('Cookie'), false);
      return true;
    }
  );
});

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html'
    }
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function redirectResponse(location) {
  return new Response('', {
    status: 302,
    headers: {
      Location: location
    }
  });
}

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

function makeRoJwt(payload = {}) {
  return makeJwt({
    id: 115,
    email: 'user@example.com',
    db_url: 'rp_vinova_prod',
    ...payload
  });
}

function makeKeycloakJwt(payload = {}) {
  return makeJwt({
    iss: 'https://keycloak.vinova.sg/auth/realms/resource',
    azp: 'localhost',
    realm_access: {
      roles: ['offline_access']
    },
    ...payload
  });
}

function futureExp() {
  return Math.floor(Date.now() / 1000) + 60 * 60;
}
