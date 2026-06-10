import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithPolicy } from '../lib/http.mjs';

test('fetchWithPolicy aborts requests after timeout', async () => {
  await assert.rejects(
    fetchWithPolicy('https://example.test/slow', {
      timeoutMs: 1,
      fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    }),
    (error) => {
      assert.equal(error.code, 'HTTP_TIMEOUT');
      assert.match(error.message, /timed out/);
      return true;
    }
  );
});
