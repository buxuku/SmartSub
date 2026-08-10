'use strict';

// Native sherpa results are JSON strings. Some Qwen outputs may contain raw
// C0 control characters inside the transcript text, which JSON.parse rejects.
function sanitizeJsonControlCharacters(jsonStr) {
  let sanitized = '';
  let inString = false;
  let escaped = false;

  for (const char of String(jsonStr)) {
    const code = char.charCodeAt(0);

    if (inString) {
      if (escaped) {
        sanitized += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        sanitized += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        sanitized += char;
        inString = false;
        continue;
      }
      if (code <= 0x1f) {
        sanitized += escapeControlCharacter(char);
        continue;
      }
      sanitized += char;
      continue;
    }

    if (char === '"') {
      inString = true;
      sanitized += char;
    } else if (code > 0x1f || char === '\t' || char === '\n' || char === '\r') {
      // Tabs, line feeds, and carriage returns are valid JSON whitespace
      // outside strings. Other C0 controls are never valid JSON tokens.
      sanitized += char;
    }
  }

  return sanitized;
}

function escapeControlCharacter(char) {
  switch (char) {
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }
}

function parseJsonResult(jsonStr) {
  return JSON.parse(sanitizeJsonControlCharacters(jsonStr));
}

module.exports = {
  parseJsonResult,
  sanitizeJsonControlCharacters,
};
