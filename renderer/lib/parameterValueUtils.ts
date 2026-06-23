import type { ParameterDefinition, ParameterValue } from '../../types/provider';

export type ParameterType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'array';

export function inferTypeFromValue(value: ParameterValue): ParameterType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'float';
  }
  if (Array.isArray(value)) return 'array';
  return 'string';
}

/** Map registry `number` to float coercion path */
export function resolveParameterType(
  definition?: ParameterDefinition | null,
  value?: ParameterValue,
): ParameterType {
  if (definition) {
    const registryType = definition.type as string;
    if (registryType === 'number') return 'float';
    if (definition.type === 'boolean') return 'boolean';
    if (definition.type === 'array') return 'array';
    if (definition.type === 'integer') return 'integer';
    if (definition.type === 'float') return 'float';
    return 'string';
  }

  if (value !== undefined) {
    return inferTypeFromValue(value);
  }

  return 'string';
}

export function parseDraftValue(
  raw: string,
  type: ParameterType,
): ParameterValue {
  switch (type) {
    case 'boolean':
      return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';
    case 'integer':
      return parseInt(raw, 10) || 0;
    case 'float':
      return parseFloat(raw) || 0;
    case 'array':
      return JSON.parse(raw) as ParameterValue;
    default:
      return raw;
  }
}

export function coerceParameterValue(
  raw: string,
  definition?: ParameterDefinition | null,
): ParameterValue {
  const trimmed = raw.trim();
  const type = resolveParameterType(definition);
  try {
    return parseDraftValue(trimmed, type);
  } catch {
    return trimmed;
  }
}

export function formatValueForInput(
  value: ParameterValue,
  type: ParameterType,
): string {
  if (type === 'array') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[]';
    }
  }
  if (type === 'boolean') return String(value);
  return String(value ?? '');
}
