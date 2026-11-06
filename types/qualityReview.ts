/** Local review metadata. Numeric subtitle IDs are deliberately not identities. */
export type QualityKind =
  | 'translation'
  | 'speech'
  | 'speed'
  | 'timing'
  | 'glossary';
export type QualityDecision = 'confirmed' | 'skipped' | 'fixed';
export interface QualityInsertionDraft {
  start: string;
  end: string;
  source: string;
  target: string;
}
export interface QualityIssue {
  key: string;
  kind: QualityKind;
  start: number;
  end: number;
  field?: 'sourceContent' | 'targetContent';
  more: boolean;
  priority: number;
  evidence: string;
  /** Current indices are navigation hints only, never persisted decision identities. */
  indices: number[];
  detail: {
    reason: string;
    cps?: number;
    threshold?: number;
    term?: string;
    expected?: string;
    glossary?: string;
    suggested?: string;
  };
}
export interface QualityReviewState {
  version: 1;
  catalog: QualityIssue[];
  decisions: Record<string, { evidence: string; status: QualityDecision }>;
  insertionDrafts?: Record<string, QualityInsertionDraft>;
  view: {
    mode: 'all' | 'issues';
    status: 'pending' | 'skipped' | 'processed';
    kind: 'all' | QualityKind;
    more: boolean;
    sort: 'time' | 'priority';
    active?: string;
  };
}
export const emptyQualityReview = (): QualityReviewState => ({
  version: 1,
  catalog: [],
  decisions: {},
  view: {
    mode: 'all',
    status: 'pending',
    kind: 'all',
    more: false,
    sort: 'time',
  },
});
const kinds = new Set(['translation', 'speech', 'speed', 'timing', 'glossary']);

// Findings can be regenerated; decisions and unfinished text cannot. Bound only
// the derived cache, leaving user-authored state intact at every storage boundary.
export const QUALITY_CATALOG_LIMIT = 50000;
const QUALITY_CATALOG_CHAR_LIMIT = 8 * 1024 * 1024;
export function compactQualityCatalog(
  catalog: QualityIssue[],
  limit = QUALITY_CATALOG_LIMIT,
  preferred: (issue: QualityIssue) => boolean = () => false,
): QualityIssue[] {
  const selected = new Set<QualityIssue>();
  let size = 0;
  const add = (issue: QualityIssue) => {
    if (selected.size >= limit) return;
    const length = JSON.stringify(issue).length + 1;
    if (size + length > QUALITY_CATALOG_CHAR_LIMIT) return;
    selected.add(issue);
    size += length;
  };
  // Prefer user-linked findings, then recent findings. Keep their display order.
  for (let i = catalog.length - 1; i >= 0; i--)
    if (preferred(catalog[i])) add(catalog[i]);
  for (let i = catalog.length - 1; i >= 0; i--)
    if (!selected.has(catalog[i])) add(catalog[i]);
  return selected.size === catalog.length
    ? catalog
    : catalog.filter((i) => selected.has(i));
}

export function compactQualityReview(
  state: QualityReviewState,
): QualityReviewState {
  const catalog = compactQualityCatalog(
    state.catalog,
    QUALITY_CATALOG_LIMIT,
    (issue) =>
      issue.key === state.view.active ||
      !!state.decisions[issue.key] ||
      !!state.insertionDrafts?.[issue.key],
  );
  return catalog === state.catalog ? state : { ...state, catalog };
}

export function parseQualityReview(input: unknown): QualityReviewState {
  if (input == null) return emptyQualityReview();
  const s = input as QualityReviewState;
  if (
    s.version !== 1 ||
    !Array.isArray(s.catalog) ||
    !s.decisions ||
    typeof s.decisions !== 'object' ||
    Array.isArray(s.decisions) ||
    !s.view ||
    typeof s.view !== 'object'
  )
    throw new Error('INVALID_QUALITY_REVIEW');
  for (const i of s.catalog) {
    if (
      !i ||
      typeof i.key !== 'string' ||
      typeof i.evidence !== 'string' ||
      !kinds.has(i.kind) ||
      !Number.isFinite(i.start) ||
      !Number.isFinite(i.end) ||
      i.start < 0 ||
      i.end <= i.start ||
      !Array.isArray(i.indices) ||
      !i.indices.every(Number.isInteger) ||
      typeof i.more !== 'boolean' ||
      !Number.isFinite(i.priority) ||
      (i.field !== undefined &&
        !['sourceContent', 'targetContent'].includes(i.field)) ||
      !i.detail ||
      typeof i.detail.reason !== 'string' ||
      ![
        'translation',
        'speed',
        'outside',
        'overlap',
        'speech',
        'speechTiming',
        'speechText',
        'glossary',
      ].includes(i.detail.reason) ||
      ['term', 'expected', 'glossary', 'suggested'].some(
        (k) => i.detail[k] !== undefined && typeof i.detail[k] !== 'string',
      )
    )
      throw new Error('INVALID_QUALITY_ISSUE');
  }
  for (const d of Object.values(s.decisions))
    if (
      !d ||
      typeof d.evidence !== 'string' ||
      !['confirmed', 'skipped', 'fixed'].includes(d.status)
    )
      throw new Error('INVALID_QUALITY_DECISION');
  if (s.insertionDrafts !== undefined) {
    if (
      !s.insertionDrafts ||
      typeof s.insertionDrafts !== 'object' ||
      Array.isArray(s.insertionDrafts)
    )
      throw new Error('INVALID_QUALITY_INSERTION');
    for (const draft of Object.values(s.insertionDrafts))
      if (
        !draft ||
        ['start', 'end', 'source', 'target'].some(
          (key) => typeof draft[key] !== 'string',
        )
      )
        throw new Error('INVALID_QUALITY_INSERTION');
  }
  if (
    !['all', 'issues'].includes(s.view.mode) ||
    !['pending', 'skipped', 'processed'].includes(s.view.status) ||
    !(s.view.kind === 'all' || kinds.has(s.view.kind)) ||
    !['time', 'priority'].includes(s.view.sort) ||
    typeof s.view.more !== 'boolean' ||
    (s.view.active !== undefined && typeof s.view.active !== 'string')
  )
    throw new Error('INVALID_QUALITY_VIEW');
  return compactQualityReview(s);
}
export function qualityStatus(
  issue: QualityIssue,
  current: Map<string, QualityIssue>,
  state: QualityReviewState,
): 'pending' | 'skipped' | 'confirmed' | 'fixed' {
  const live = current.get(issue.key);
  if (!live) return 'fixed';
  const decision = state.decisions[issue.key];
  return decision?.evidence === live.evidence ? decision.status : 'pending';
}
