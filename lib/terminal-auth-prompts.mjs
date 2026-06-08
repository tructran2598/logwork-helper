import { isCancel, password, select, text } from '@clack/prompts';
import { createAuthRequiredError } from './auth-errors.mjs';
import { createKeychainEmailStorage } from './keychain.mjs';

export function createTerminalCredentialProvider({
  emailStorage = createKeychainEmailStorage(),
  stdin = process.stdin,
  stdout = process.stdout
} = {}) {
  return {
    async requestCredentials() {
      ensureInteractive(stdin, stdout);
      const rememberedEmail = await emailStorage.get().catch(() => null);
      const email = handleCancel(await text({
        message: 'Resource Optimiser email:',
        placeholder: 'name@example.com',
        initialValue: rememberedEmail || '',
        validate(value) {
          if (!String(value || '').trim()) {
            return 'Email is required.';
          }
          return undefined;
        }
      })).trim();

      const secret = handleCancel(await password({
        message: 'Resource Optimiser password:',
        validate(value) {
          if (!String(value || '')) {
            return 'Password is required.';
          }
          return undefined;
        }
      }));

      await emailStorage.set(email).catch(() => {});
      return {
        email,
        password: secret
      };
    },

    async requestDeviceSelection(devices) {
      ensureInteractive(stdin, stdout);
      if (!Array.isArray(devices) || devices.length === 0) {
        return null;
      }
      if (devices.length === 1) {
        return devices[0];
      }

      const selected = handleCancel(await select({
        message: 'Choose 2FA device:',
        options: devices.map((device, index) => ({
          value: String(index),
          label: device.label || `Device ${index + 1}`
        }))
      }));

      return devices[Number(selected)];
    },

    async requestOtp() {
      ensureInteractive(stdin, stdout);
      return handleCancel(await password({
        message: '2FA code:',
        validate(value) {
          if (!String(value || '').trim()) {
            return '2FA code is required.';
          }
          return undefined;
        }
      })).trim();
    }
  };
}

function ensureInteractive(stdin, stdout) {
  if (!stdin?.isTTY || !stdout?.isTTY) {
    throw createAuthRequiredError();
  }
}

function handleCancel(value) {
  if (isCancel(value)) {
    throw new Error('User cancelled Resource Optimiser authentication.');
  }

  return value;
}
