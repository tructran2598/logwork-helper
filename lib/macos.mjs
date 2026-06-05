import { spawn } from 'node:child_process';

export async function runOsascript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const error = new Error(`osascript failed with exit code ${code}: ${stderr.trim() || 'no stderr'}`);
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export async function readSafariLocalStorageToken({ tokenKey, allowedHosts }) {
  const hosts = allowedHosts.join('\n');
  const script = String.raw`
function hostFromUrl(rawUrl) {
  const text = String(rawUrl || '');
  const schemeSplit = text.split('://');
  if (schemeSplit.length < 2) return '';

  return schemeSplit[1].split('/')[0].split(':')[0];
}

function run(argv) {
  const tokenKey = argv[0];
  const allowedHosts = String(argv[1] || '').split('\n').filter(Boolean);
  const Safari = Application('Safari');
  const js = 'String(localStorage.getItem(' + JSON.stringify(tokenKey) + ') || "")';

  for (const safariWindow of Safari.windows()) {
    for (const safariTab of safariWindow.tabs()) {
      const tabHost = hostFromUrl(safariTab.url());
      if (!allowedHosts.includes(tabHost)) continue;

      try {
        const tokenValue = Safari.doJavaScript(js, { in: safariTab });
        if (tokenValue) return String(tokenValue);
      } catch (error) {
        const number = error.errorNumber || error.number || '';
        const message = error.message || String(error);
        return '__LOGWORK_SAFARI_JS_ERROR__' + number + ': ' + message;
      }
    }
  }

  return '';
}`;

  const token = await runOsaJavaScript(script, [tokenKey, hosts]);
  if (token.startsWith('__LOGWORK_SAFARI_JS_ERROR__')) {
    const detail = token
      .replace('__LOGWORK_SAFARI_JS_ERROR__', '')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error([
      'Safari could not read Resource Optimiser localStorage.',
      'Make sure Develop -> Allow JavaScript from Apple Events is enabled, then quit and reopen Safari if needed.',
      detail ? `Safari error: ${detail}` : ''
    ].join(' '));
  }

  return token || null;
}

function runOsaJavaScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const error = new Error(`osascript JavaScript failed with exit code ${code}: ${stderr.trim() || 'no stderr'}`);
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export async function openSafariLogin(loginUrl) {
  const script = String.raw`
on run argv
  tell application "Safari"
    activate
    open location (item 1 of argv)
  end tell
end run`;

  await runOsascript(script, [loginUrl]);
}

export async function focusTerminalWindowByTitle(title) {
  const script = String.raw`
on run argv
  set targetTitle to item 1 of argv
  tell application "Terminal"
    activate
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        if (custom title of terminalTab contains targetTitle) or (name of terminalTab contains targetTitle) then
          set selected tab of terminalWindow to terminalTab
          set index of terminalWindow to 1
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

  return runOsascript(script, [title]);
}

export async function closeTerminalWindowByTitle(title) {
  const script = String.raw`
on run argv
  set targetTitle to item 1 of argv
  tell application "Terminal"
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        if (custom title of terminalTab contains targetTitle) or (name of terminalTab contains targetTitle) then
          close terminalWindow
          return "closed"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

  return runOsascript(script, [title]);
}

export async function setTerminalTitle(title) {
  process.stdout.write(`\u001b]0;${title}\u0007`);
}
