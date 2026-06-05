export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return value;
}

export function todayLocalDateISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toApiLogDate(localDateISO) {
  return `${localDateISO}T00:00:00.000Z`;
}

export function addLocalDays(localDateISO, days) {
  const [year, month, day] = localDateISO.split('-').map(Number);
  const date = new Date(year, month - 1, day + days);
  return todayLocalDateISO(date);
}

export async function mapLimit(items, limit, mapper) {
  if (!Array.isArray(items)) {
    throw new Error('items must be an array.');
  }

  const concurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function isAbortSignal(value) {
  return Boolean(value && typeof value === 'object' && value.aborted === true);
}
