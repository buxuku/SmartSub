export const XIAOMI_MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';

/** Normalize pay-as-you-go and Token Plan URLs to the API base. */
export function normalizeXiaomiMimoBaseURL(apiUrl?: string): string {
  const value = apiUrl?.trim() || XIAOMI_MIMO_DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'Xiaomi MiMo: API base URL must start with http:// or https://',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      'Xiaomi MiMo: API base URL must start with http:// or https://',
    );
  }
  let pathname = parsed.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/i, '');
  parsed.pathname = pathname || '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function xiaomiMimoChatURL(apiUrl?: string): string {
  return `${normalizeXiaomiMimoBaseURL(apiUrl)}/chat/completions`;
}

export function buildXiaomiMimoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function readXiaomiMimoError(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return '';
  }
  try {
    const json = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (json.error?.message) return String(json.error.message);
    if (json.message) return String(json.message);
  } catch {
    // Non-JSON responses are still useful when truncated.
  }
  return text.slice(0, 300);
}
