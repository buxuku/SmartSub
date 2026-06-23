import {
  inferTypeFromValue,
  coerceParameterValue,
  parseDraftValue,
  resolveParameterType,
} from '../parameterValueUtils';
import type { ParameterDefinition } from '../../../types/provider';

describe('parameterValueUtils', () => {
  it('coerces temperature string to number via registry definition', () => {
    const def = {
      key: 'temperature',
      type: 'number',
      category: 'behavior',
      required: false,
      description: 'temperature',
      providerSupport: ['*'],
    } as ParameterDefinition;
    expect(coerceParameterValue('0.3', def)).toBe(0.3);
    expect(resolveParameterType(def, 0.3)).toBe('float');
  });

  it('keeps unknown keys as trimmed strings by default', () => {
    expect(coerceParameterValue('  hello ', undefined)).toBe('hello');
  });

  it('parses boolean draft values', () => {
    expect(parseDraftValue('true', 'boolean')).toBe(true);
    expect(parseDraftValue('false', 'boolean')).toBe(false);
  });

  it('parses array draft as JSON', () => {
    expect(parseDraftValue('[1,2]', 'array')).toEqual([1, 2]);
  });

  it('inferTypeFromValue matches stored shapes', () => {
    expect(inferTypeFromValue(1)).toBe('integer');
    expect(inferTypeFromValue(0.3)).toBe('float');
    expect(inferTypeFromValue(true)).toBe('boolean');
    expect(inferTypeFromValue([])).toBe('array');
    expect(inferTypeFromValue('x')).toBe('string');
  });
});
