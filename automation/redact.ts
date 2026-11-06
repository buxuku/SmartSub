const secret =
  /api.?key|api.?secret|access.?key|secret|password|token|authorization|credential|private.?key|headerParameters|cookie(?:text|raw|value|header)?$/i;
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      secret.test(key)
        ? entry
          ? '[REDACTED]'
          : entry
        : /(?:url|endpoint|proxy)$/i.test(key) && typeof entry === 'string'
          ? redactUrlCredentials(entry)
          : /(?:^error$|Error$|^errorMessage$)/.test(key)
            ? redactDiagnostics(entry)
            : redact(entry),
    ]),
  );
}
/** Only use string heuristics for diagnostics, never subtitle text or paths. */
export function redactDiagnostics(value: any): any {
  if (typeof value === 'string') return safeMessage(value);
  if (Array.isArray(value)) return value.map(redactDiagnostics);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(redact(value)).map(([key, entry]) => [
      key,
      redactDiagnostics(entry),
    ]),
  );
}
export function redactUrlCredentials(value: string): string {
  // Work on the authority alone, preserving the original URL spelling and
  // percent encoding. Also handles proxy schemes and protocol-relative URLs.
  return value.replace(
    /((?:[a-z][a-z0-9+.-]*:)?\/\/)[^\s/\\?#]*@/gi,
    '$1[REDACTED]@',
  );
}
export function safeMessage(message: unknown): string {
  return redactUrlCredentials(String(message))
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?key|secret|token|password|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}
