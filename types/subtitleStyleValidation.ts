import { z } from 'zod';
import type { SubtitleStyle } from './subtitleMerge';
import { parseSubtitleColor } from './subtitleColor';

const color = z
  .string()
  .refine(
    (value) => !!parseSubtitleColor(value),
    'Enter a complete #RRGGBB or rgb/rgba color',
  );
const nonnegative = z.number().finite().nonnegative();

// Draft recovery is intentionally more permissive; only rendering/export uses this schema.
const schema = z.object({
  fontName: z
    .string()
    .trim()
    .min(1)
    .refine((name) => !/[{}\\,\r\n]/.test(name), 'Invalid ASS font name'),
  fontSize: z.number().finite().positive(),
  primaryColor: color,
  outlineColor: color,
  backColor: color,
  backOpacity: z.number().finite().min(0).max(100).optional(),
  bold: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
  borderStyle: z.union([z.literal(1), z.literal(3)]),
  outline: nonnegative,
  shadow: nonnegative,
  alignment: z.number().int().min(1).max(9),
  marginL: nonnegative,
  marginR: nonnegative,
  marginV: nonnegative,
  positionY: z.number().finite().min(0).max(100).optional(),
  positionReferenceY: z.number().finite().optional(),
  secondLineColor: color.optional(),
  highlightColor: color.optional(),
  glowColor: color.optional(),
  highlightTerms: z.array(z.string()).optional(),
  glow: z.number().finite().min(0).max(10).optional(),
});

export function invalidSubtitleStyleFields(
  style: unknown,
): (keyof SubtitleStyle)[] {
  const result = schema.safeParse(style);
  return result.success
    ? []
    : Array.from(
        new Set(
          result.error.issues.map(
            (issue) =>
              String(issue.path[0] || 'fontName') as keyof SubtitleStyle,
          ),
        ),
      );
}

export function assertValidSubtitleStyle(
  style: unknown,
): asserts style is SubtitleStyle {
  const fields = invalidSubtitleStyleFields(style);
  if (fields.length)
    throw new Error(`Invalid subtitle style: ${fields.join(', ')}`);
}
