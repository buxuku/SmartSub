# B18 参数编辑器简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 7-step Add-Dialog flow with Postman-style inline key-value tables in the existing Dialog, cutting common tasks (e.g. `temperature=0.3`) to ≤3 steps while keeping `useParameterConfig` + main `parameterProcessor` unchanged.

**Architecture:** Add `parameterValueUtils.ts` (coerce/validate) + `ParameterKvTable.tsx` (presentational table with draft row). Rewrite `CustomParameterEditor.tsx` to compose Tabs + two tables + a「更多」dropdown; stop using `DynamicParameterInput` in the editor (file kept, deprecated comment only).

**Tech Stack:** React 18, next-i18next (`parameters` namespace), shadcn/ui (Table, DropdownMenu, Tabs), existing `useParameterConfig` hook, Electron IPC unchanged.

**Spec:** `docs/superpowers/specs/2026-06-13-parameter-editor-simplify-design.md`

---

## File map

| File                                                           | Responsibility                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `renderer/lib/parameterValueUtils.ts`                          | **Create** — infer/coerce/validate values; registry-aware coerce via optional `ParameterDefinition` |
| `renderer/components/ParameterKvTable.tsx`                     | **Create** — reusable K/V table: existing rows + trailing draft row                                 |
| `renderer/components/CustomParameterEditor.tsx`                | **Rewrite** — shell: toolbar, tabs, two tables, import/export/refresh                               |
| `renderer/components/DynamicParameterInput.tsx`                | **Touch** — top comment `@deprecated`; no runtime usage from editor                                 |
| `renderer/public/locales/{zh,en}/parameters.json`              | **Modify** — table keys, more menu, remove unused addDialog references from UI                      |
| `renderer/components/__tests__/CustomParameterEditor.test.tsx` | **Rewrite** — focused tests for new table UX                                                        |
| `docs/UX_REFACTOR_PROGRESS.md`                                 | **Modify** — mark 6.5.12 done after batch                                                           |

**Do not modify:** `useParameterConfig.tsx`, `main/helpers/parameterProcessor.ts`, `ipcParameterHandlers.ts`, `ProviderForm.tsx` (Dialog wrapper stays).

---

### Task 1: Value utils + K/V table component

**Files:**

- Create: `renderer/lib/parameterValueUtils.ts`
- Create: `renderer/components/ParameterKvTable.tsx`
- Test: `renderer/lib/__tests__/parameterValueUtils.test.ts` (create)

- [ ] **Step 1: Write unit tests for coerce helpers**

Create `renderer/lib/__tests__/parameterValueUtils.test.ts`:

```typescript
import {
  inferTypeFromValue,
  coerceParameterValue,
  parseDraftValue,
} from '../parameterValueUtils';
import type { ParameterDefinition } from '../../../types/provider';

describe('parameterValueUtils', () => {
  it('coerces temperature string to number via registry definition', () => {
    const def: ParameterDefinition = {
      key: 'temperature',
      type: 'number',
      category: 'behavior',
      required: false,
      providerSupport: ['*'],
    };
    expect(coerceParameterValue('0.3', def)).toBe(0.3);
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
```

- [ ] **Step 2: Implement `parameterValueUtils.ts`**

Create `renderer/lib/parameterValueUtils.ts`:

```typescript
import type { ParameterDefinition, ParameterValue } from '../../types/provider';

export type ParameterType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'array';

export function inferTypeFromValue(value: ParameterValue): ParameterType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'float';
  if (Array.isArray(value)) return 'array';
  return 'string';
}

/** Map registry `number` to float coercion path */
function registryTypeToDraft(def?: ParameterDefinition | null): ParameterType {
  if (!def) return 'string';
  if (def.type === 'number') return 'float';
  if (def.type === 'boolean') return 'boolean';
  if (def.type === 'array') return 'array';
  if (def.type === 'integer') return 'integer';
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
  const type = registryTypeToDraft(definition);
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
  if (type === 'array') return JSON.stringify(value);
  if (type === 'boolean') return String(value);
  return String(value ?? '');
}
```

- [ ] **Step 3: Create `ParameterKvTable.tsx`**

Create `renderer/components/ParameterKvTable.tsx` (~180 lines). Core props:

```typescript
export interface ParameterKvTableProps {
  entries: Array<[string, ParameterValue]>;
  disabled?: boolean;
  parameterTypes: Record<string, ParameterType>; // local override per key
  onCommitNew: (key: string, value: ParameterValue) => void;
  onUpdate: (key: string, value: ParameterValue) => void;
  onRemove: (key: string) => void;
  onTypeChange: (key: string, type: ParameterType) => void;
  resolveDefinition?: (key: string) => Promise<ParameterDefinition | null>;
  errorsByKey?: Record<string, string>;
}
```

Behavior:

- Render `<Table>` with columns: 键 | 值 | ⋯
- Map `entries` to editable rows (key read-only for existing rows; value input)
- **Draft row** at bottom: empty key + empty value inputs; on blur/Enter when both non-empty → call `onCommitNew` after `coerceParameterValue(value, await resolveDefinition?.(key))`
- Row ⋯ `DropdownMenu`: type select (5 options) + Delete (existing rows only)
- Boolean rows: render `<Switch>` instead of text input
- Array rows: `<Textarea>` with JSON validation message under cell
- Duplicate key on commit: set `errorsByKey[draftKey]='duplicateKey'` and do not call `onCommitNew`

- [ ] **Step 4: Run utils tests**

Run (if Jest available in project): `npx jest renderer/lib/__tests__/parameterValueUtils.test.ts --passWithNoTests`

Gate (always): `node scripts/check-i18n.mjs` && `cd renderer && npx tsc --noEmit 2>&1 | grep -v -E "__tests__|\.test\.|\.spec\." | grep -c "error TS"` → expect `0`

- [ ] **Step 5: Commit**

```bash
git add renderer/lib/parameterValueUtils.ts renderer/lib/__tests__/parameterValueUtils.test.ts renderer/components/ParameterKvTable.tsx
git commit -m "feat(parameters): add K/V table and value coerce utils for editor simplify"
```

---

### Task 2: Rewrite CustomParameterEditor shell (Body tab + 更多 menu)

**Files:**

- Modify: `renderer/components/CustomParameterEditor.tsx` (replace body; delete Add Dialog block ~L527-634 and Card/DynamicParameterInput list ~L658-780)
- Modify: `renderer/public/locales/zh/parameters.json`
- Modify: `renderer/public/locales/en/parameters.json`

- [ ] **Step 1: Add i18n keys**

In both `parameters.json`, add:

```json
"table": {
  "keyColumn": "参数名",
  "valueColumn": "值",
  "keyPlaceholder": "例如 temperature",
  "valuePlaceholder": "例如 0.3",
  "duplicateKey": "该参数名已存在",
  "emptyKey": "请填写参数名"
},
"more": {
  "label": "更多",
  "search": "搜索参数",
  "import": "导入 JSON",
  "export": "导出 JSON",
  "refresh": "从磁盘刷新"
}
```

(English equivalents in `en/parameters.json`.)

- [ ] **Step 2: Rewrite editor top bar**

Replace export/import/refresh button row with:

```tsx
<div className="flex items-center justify-between gap-2">
  {/* save status — keep existing saving/saved/error block */}
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm">
        {t('more.label')}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {/* Search toggle — only if param count > 5 in active tab */}
      {/* Import label+hidden file input — reuse handleImportConfig */}
      {/* Export — handleExportConfig */}
      {/* Refresh — handleRefresh + unsaved AlertDialog unchanged */}
    </DropdownMenuContent>
  </DropdownMenu>
</div>
```

Remove standalone Search input from main bar; move search into dropdown or show inline when >5 params.

- [ ] **Step 3: Wire Body tab to ParameterKvTable**

```tsx
<TabsContent value="body">
  <ParameterKvTable
    entries={filteredBodyEntries}
    disabled={disabled}
    parameterTypes={bodyTypes}
    onCommitNew={(key, value) => addBodyParameter(key, value)}
    onUpdate={(key, value) => updateBodyParameter(key, value)}
    onRemove={(key) => removeBodyParameter(key)}
    onTypeChange={(key, type) => {
      /* update bodyTypes state; re-coerce stored value */
    }}
    resolveDefinition={(key) => getParameterDefinition(key)}
    errorsByKey={errorsByKey}
  />
</TabsContent>
```

- `filteredBodyEntries`: `Object.entries(config.bodyParameters || {})` filtered by `searchQuery`
- Local state `bodyTypes: Record<string, ParameterType>` initialized from `inferTypeFromValue` on load
- `onConfigChange` parent callback: keep existing pattern after each hook mutation

- [ ] **Step 4: Remove dead UI**

Delete from `CustomParameterEditor.tsx`:

- `showAddDialog`, `newParameter`, `handleAddParameter`, entire `AlertDialog` add flow
- Per-row `DynamicParameterInput` + duplicate button + `Separator` stacks
- Summary Card at bottom (if present)

- [ ] **Step 5: Gate**

```bash
node scripts/check-i18n.mjs
cd renderer && npx tsc --noEmit 2>&1 | grep -v -E "__tests__|\.test\.|\.spec\." | grep -c "error TS"
```

- [ ] **Step 6: Commit**

```bash
git add renderer/components/CustomParameterEditor.tsx renderer/public/locales/zh/parameters.json renderer/public/locales/en/parameters.json
git commit -m "feat(parameters): inline K/V table for body params, collapse advanced actions"
```

---

### Task 3: Header tab + type overrides + deprecate old input

**Files:**

- Modify: `renderer/components/CustomParameterEditor.tsx`
- Modify: `renderer/components/DynamicParameterInput.tsx` (comment only)

- [ ] **Step 1: Mirror Header tab**

Duplicate Body wiring for `headerParameters` using `addHeaderParameter` / `updateHeaderParameter` / `removeHeaderParameter` and `headerTypes` state.

- [ ] **Step 2: Default tab**

Set `useState<ParameterCategory>('body')` so Dialog opens on **请求体** (spec §2.1).

- [ ] **Step 3: Search threshold**

Show search field when active tab entry count `> 5`; otherwise hide (spec §2.4).

- [ ] **Step 4: Mark DynamicParameterInput deprecated**

Add at top of `DynamicParameterInput.tsx`:

```typescript
/** @deprecated Used only by legacy tests; CustomParameterEditor uses ParameterKvTable. */
```

- [ ] **Step 5: Manual smoke**

1. `yarn dev` → 资源中心 → 编辑 OpenAI 类 provider → 配置自定义参数
2. Body 空行输入 `temperature` / `0.3` → 等待「已保存」
3. 关闭 Dialog → 重新打开 → 行仍在
4. Header tab 添加 `X-Custom: test` → 保存成功

- [ ] **Step 6: Commit**

```bash
git add renderer/components/CustomParameterEditor.tsx renderer/components/DynamicParameterInput.tsx
git commit -m "feat(parameters): header K/V table and default body tab"
```

---

### Task 4: Tests, progress doc, batch closeout

**Files:**

- Modify: `renderer/components/__tests__/CustomParameterEditor.test.tsx`
- Modify: `docs/UX_REFACTOR_PROGRESS.md`
- Modify: `docs/superpowers/specs/2026-06-12-remaining-roadmap-design.md` (strike 6.5.12 backlog line)

- [ ] **Step 1: Rewrite component tests (focused set)**

Replace outdated mock shape with hook return matching `useParameterConfig`:

```typescript
const mockConfig: CustomParameterConfig = {
  headerParameters: { Authorization: 'Bearer x' },
  bodyParameters: { temperature: 0.7 },
};

mockUseParameterConfig.mockReturnValue({
  state: {
    config: mockConfig,
    isLoading: false,
    hasUnsavedChanges: false,
    validationErrors: [],
    lastSaved: Date.now(),
    saveStatus: 'idle',
  },
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  addBodyParameter: jest.fn(),
  updateBodyParameter: jest.fn(),
  removeBodyParameter: jest.fn(),
  addHeaderParameter: jest.fn(),
  updateHeaderParameter: jest.fn(),
  removeHeaderParameter: jest.fn(),
  validateConfiguration: jest.fn(),
  exportConfiguration: jest.fn(() => '{}'),
  importConfiguration: jest.fn(),
  getSupportedParameters: jest.fn(),
  getParameterDefinition: jest.fn(async (key: string) =>
    key === 'temperature'
      ? {
          key,
          type: 'number',
          category: 'behavior',
          required: false,
          providerSupport: ['*'],
        }
      : null,
  ),
  resetConfig: jest.fn(),
  enableAutoSave: jest.fn(),
  disableAutoSave: jest.fn(),
  getMigrationStatus: jest.fn(),
  getAppliedMigrations: jest.fn(),
  getAvailableMigrations: jest.fn(),
});
```

Tests to keep (rewrite assertions):

1. Renders tabs with badge counts
2. Draft row commit calls `addBodyParameter('temperature', 0.3)` on blur
3. Remove button calls `removeBodyParameter` 4.「更多」menu contains export/import labels
4. No「添加参数」button in document (`queryByText` addDialog title absent)

Mock `ParameterKvTable` only if test file becomes flaky; prefer testing through editor.

- [ ] **Step 2: Update progress docs**

In `docs/UX_REFACTOR_PROGRESS.md`:

- Add §3 batch **B18 参数编辑器简化**
- Strike `参数编辑器简化（6.5.12）` from §4 remaining
- Set next batch to B16

- [ ] **Step 3: Final gates**

```bash
node scripts/check-i18n.mjs
cd renderer && npx tsc --noEmit 2>&1 | grep -v -E "__tests__|\.test\.|\.spec\." | grep -c "error TS"
cd .. && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "^main/"
```

Expect: i18n OK, renderer non-test 0, main ≤95.

- [ ] **Step 4: Commit**

```bash
git add renderer/components/__tests__/CustomParameterEditor.test.tsx docs/UX_REFACTOR_PROGRESS.md docs/superpowers/specs/2026-06-12-remaining-roadmap-design.md
git commit -m "test(docs): parameter editor simplify tests and B18 progress handover"
```

---

## Spec coverage checklist

| Spec requirement                | Task                                    |
| ------------------------------- | --------------------------------------- |
| ≤3 steps add temperature        | Task 2 draft row                        |
| Header/Body tabs                | Task 2–3                                |
| Default body tab                | Task 3                                  |
| Type via row ⋯                  | Task 1 table                            |
| Registry coerce                 | Task 1 utils + resolveDefinition        |
| More menu import/export/refresh | Task 2                                  |
| Remove Add Dialog               | Task 2                                  |
| Auto-save unchanged             | No hook changes                         |
| array/boolean support           | Task 1 parseDraftValue + table branches |
| i18n zh/en                      | Task 2                                  |
| Gates green                     | Each task                               |

## Manual acceptance (user)

1. Body: `temperature` = `0.3` in ≤3 interactions; saved; re-open persists
2. Run provider test translation; request body contains numeric temperature (network tab or log)
3. Import/export JSON still works from 更多
4. Delete row → auto-save → row gone

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-13-parameter-editor-simplify-b18.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, spec compliance + quality review between tasks
2. **Inline Execution** — implement all 4 tasks in this session with checkpoints after Task 2 and Task 4

Which approach do you want?
