import React, { useCallback, useId, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type { ParameterDefinition, ParameterValue } from '../../types/provider';
import {
  coerceParameterValue,
  formatValueForInput,
  inferTypeFromValue,
  parseDraftValue,
  resolveParameterType,
  validateJsonParameter,
  type ParameterType,
} from '../lib/parameterValueUtils';
import { cn } from 'lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

const PARAMETER_TYPES: ParameterType[] = [
  'string',
  'integer',
  'float',
  'boolean',
  'object',
  'array',
];

export interface ParameterKvTableProps {
  entries: Array<[string, ParameterValue]>;
  existingKeys?: string[];
  disabled?: boolean;
  parameterTypes: Record<string, ParameterType>;
  onCommitNew: (
    key: string,
    value: ParameterValue,
    type: ParameterType,
  ) => void;
  onUpdate: (key: string, value: ParameterValue) => void;
  onRemove: (key: string) => void;
  onTypeChange: (key: string, type: ParameterType) => void;
  resolveDefinition?: (key: string) => Promise<ParameterDefinition | null>;
  errorsByKey?: Record<string, string>;
  draftRef?: React.MutableRefObject<ParameterTableDraft | null>;
  onDirtyChange?: (dirty: boolean) => void;
}

export interface ParameterTableDraft {
  getIsDirty: () => boolean;
  flush: () => Promise<boolean>;
  discard: () => void;
}

function getRowType(
  key: string,
  value: ParameterValue,
  parameterTypes: Record<string, ParameterType>,
): ParameterType {
  return parameterTypes[key] ?? inferTypeFromValue(value);
}

function formatJsonError(
  error: string | null,
  t: (key: string, options?: Record<string, string>) => string,
): string | null {
  if (!error) return null;
  if (error === 'NOT_ARRAY') {
    return t('validation.notArray');
  }
  if (error === 'NOT_OBJECT') {
    return t('validation.notObject');
  }
  return t('validation.invalidJson', { message: error });
}

interface TypeSelectProps {
  value: ParameterType;
  disabled?: boolean;
  onChange: (type: ParameterType) => void;
}

const TypeSelect: React.FC<TypeSelectProps> = ({
  value,
  disabled,
  onChange,
}) => {
  const { t } = useTranslation('parameters');

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as ParameterType)}
    >
      <SelectTrigger className="h-9">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PARAMETER_TYPES.map((optionType) => (
          <SelectItem key={optionType} value={optionType}>
            {t(`types.${optionType}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

interface ValueEditorProps {
  type: ParameterType;
  value: ParameterValue | string;
  disabled: boolean;
  onChange: (raw: string) => void;
  onCommit: () => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  inputId?: string;
  inputDataField?: string;
}

const ValueEditor: React.FC<ValueEditorProps> = ({
  type,
  value,
  disabled,
  onChange,
  onCommit,
  onKeyDown,
  inputId,
  inputDataField,
}) => {
  const { t } = useTranslation('parameters');
  const raw =
    typeof value === 'string' ? value : formatValueForInput(value, type);

  if (type === 'boolean') {
    const checked =
      typeof value === 'boolean'
        ? value
        : parseDraftValue(String(value), 'boolean') === true;

    return (
      <div className="space-y-1" data-draft-field={inputDataField}>
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(String(next))}
        />
        <p className="text-xs text-muted-foreground">
          {t('table.booleanHint')}
        </p>
      </div>
    );
  }

  if (type === 'array' || type === 'object') {
    const jsonError = validateJsonParameter(raw, type);
    const jsonErrorMessage = formatJsonError(jsonError, t);

    return (
      <div className="space-y-1">
        <Textarea
          id={inputId}
          data-draft-field={inputDataField}
          value={raw}
          disabled={disabled}
          placeholder={t(`table.${type}Placeholder`)}
          className={cn(
            'min-h-[72px] font-mono text-xs',
            jsonErrorMessage && 'border-destructive',
          )}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={onKeyDown}
        />
        <p className="text-xs text-muted-foreground">
          {t(`table.${type}Hint`)}
        </p>
        {jsonErrorMessage ? (
          <p className="text-xs text-destructive">{jsonErrorMessage}</p>
        ) : null}
      </div>
    );
  }

  const placeholder =
    type === 'string'
      ? t('table.stringPlaceholder')
      : t('table.numberPlaceholder');

  return (
    <Input
      id={inputId}
      data-draft-field={inputDataField}
      value={raw}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={onKeyDown}
    />
  );
};

interface ExistingValueCellProps {
  parameterKey: string;
  value: ParameterValue;
  type: ParameterType;
  disabled: boolean;
  onUpdate: (key: string, value: ParameterValue) => void;
  onDirtyChange: (key: string, dirty: boolean) => void;
  registerCommit: (key: string, commit: (() => boolean) | null) => void;
}

const ExistingValueCell: React.FC<ExistingValueCellProps> = ({
  parameterKey,
  value,
  type,
  disabled,
  onUpdate,
  onDirtyChange,
  registerCommit,
}) => {
  const [raw, setRaw] = useState(() => formatValueForInput(value, type));

  React.useEffect(() => {
    setRaw(formatValueForInput(value, type));
    onDirtyChange(parameterKey, false);
    return () => onDirtyChange(parameterKey, false);
  }, [value, type, parameterKey, onDirtyChange]);

  const commit = useCallback(() => {
    if (raw === formatValueForInput(value, type)) return true;
    if (type === 'array' || type === 'object') {
      const error = validateJsonParameter(raw, type);
      if (error) return false;
    }
    onUpdate(parameterKey, parseDraftValue(raw, type));
    onDirtyChange(parameterKey, false);
    return true;
  }, [onUpdate, parameterKey, raw, type, value, onDirtyChange]);
  useIsomorphicLayoutEffect(() => {
    registerCommit(parameterKey, commit);
    return () => registerCommit(parameterKey, null);
  }, [registerCommit, parameterKey, commit]);

  return (
    <ValueEditor
      type={type}
      value={raw}
      disabled={disabled}
      onChange={(next) => {
        setRaw(next);
        if (type === 'boolean') {
          onUpdate(parameterKey, parseDraftValue(next, type));
        } else {
          onDirtyChange(
            parameterKey,
            next !== formatValueForInput(value, type),
          );
        }
      }}
      onCommit={commit}
    />
  );
};

export const ParameterKvTable: React.FC<ParameterKvTableProps> = ({
  entries,
  existingKeys,
  disabled = false,
  parameterTypes,
  onCommitNew,
  onUpdate,
  onRemove,
  onTypeChange,
  resolveDefinition,
  errorsByKey = {},
  draftRef,
  onDirtyChange,
}) => {
  const { t } = useTranslation('parameters');
  const draftRowId = useId();
  const draftKeyInputId = `${draftRowId}-key`;
  const draftValueInputId = `${draftRowId}-value`;
  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [draftType, setDraftType] = useState<ParameterType>('string');
  const [draftError, setDraftError] = useState('');
  const committingRef = useRef<Promise<boolean> | null>(null);
  const invalidRows = useRef(new Set<string>());
  const rowCommits = useRef(new Map<string, () => boolean>());
  const registerCommit = useCallback(
    (key: string, commit: (() => boolean) | null) => {
      if (commit) rowCommits.current.set(key, commit);
      else rowCommits.current.delete(key);
    },
    [],
  );
  const draftKeyRef = useRef('');
  const draftValueRef = useRef('');
  const draftTypeRef = useRef<ParameterType>('string');
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const getIsDirty = useCallback(
    () =>
      !!(
        draftKeyRef.current ||
        draftValueRef.current ||
        invalidRows.current.size
      ),
    [],
  );
  const notifyDirty = useCallback(
    () => dirtyCallback.current?.(getIsDirty()),
    [getIsDirty],
  );
  const setRowDirty = useCallback(
    (key: string, dirty: boolean) => {
      if (dirty) invalidRows.current.add(key);
      else invalidRows.current.delete(key);
      notifyDirty();
    },
    [notifyDirty],
  );

  const syncDraftKey = useCallback(
    (next: string) => {
      draftKeyRef.current = next;
      setDraftKey(next);
      notifyDirty();
    },
    [notifyDirty],
  );

  const syncDraftValue = useCallback(
    (next: string) => {
      draftValueRef.current = next;
      setDraftValue(next);
      notifyDirty();
    },
    [notifyDirty],
  );

  const syncDraftType = useCallback((next: ParameterType) => {
    draftTypeRef.current = next;
    setDraftType(next);
  }, []);

  const knownKeys = existingKeys ?? entries.map(([key]) => key);

  const commitDraft = useCallback(async (): Promise<boolean> => {
    if (committingRef.current) return committingRef.current;
    const run = async () => {
      const key = draftKeyRef.current.trim();
      const raw = draftValueRef.current;
      const selectedType = draftTypeRef.current;

      if (!key) {
        if (raw.trim()) {
          setDraftError(t('table.emptyKey'));
        }
        return !raw.trim();
      }

      if (!raw.trim() && selectedType !== 'boolean') {
        setDraftError(t('table.emptyValue'));
        return false;
      }

      if (knownKeys.some((existingKey) => existingKey === key)) {
        setDraftError(t('table.duplicateKey'));
        return false;
      }

      if (selectedType === 'array' || selectedType === 'object') {
        const jsonError = validateJsonParameter(raw, selectedType);
        if (jsonError) {
          setDraftError(
            formatJsonError(jsonError, t) || t('validation.invalidJson'),
          );
          return false;
        }
      }

      try {
        const definition = resolveDefinition
          ? await resolveDefinition(key)
          : null;
        if (
          key !== draftKeyRef.current.trim() ||
          raw !== draftValueRef.current ||
          selectedType !== draftTypeRef.current
        )
          return false;

        let value: ParameterValue;
        let type: ParameterType;

        // An explicitly selected JSON object must not be coerced through a
        // legacy string definition (e.g. the thinking convenience parameter).
        if (selectedType === 'object') {
          value = parseDraftValue(raw, selectedType);
          type = selectedType;
        } else if (definition) {
          value = coerceParameterValue(raw, definition);
          type = resolveParameterType(definition, value);
        } else if (selectedType === 'boolean') {
          value = parseDraftValue(raw || 'false', 'boolean');
          type = 'boolean';
        } else {
          value = parseDraftValue(raw, selectedType);
          type = selectedType;
        }

        onCommitNew(key, value, type);
        syncDraftKey('');
        syncDraftValue('');
        syncDraftType('string');
        setDraftError('');
        return true;
      } catch (error) {
        setDraftError(error instanceof Error ? error.message : String(error));
        return false;
      }
    };
    const pending = run();
    committingRef.current = pending;
    try {
      return await pending;
    } finally {
      committingRef.current = null;
    }
  }, [
    knownKeys,
    onCommitNew,
    resolveDefinition,
    syncDraftKey,
    syncDraftType,
    syncDraftValue,
    t,
  ]);

  useIsomorphicLayoutEffect(() => {
    if (!draftRef) return;
    draftRef.current = {
      getIsDirty,
      flush: async () => {
        for (const commit of Array.from(rowCommits.current.values()))
          if (!commit()) return false;
        return await commitDraft();
      },
      discard: () => {
        syncDraftKey('');
        syncDraftValue('');
        invalidRows.current.clear();
        notifyDirty();
      },
    };
    return () => {
      draftRef.current = null;
    };
  }, [
    draftRef,
    getIsDirty,
    commitDraft,
    syncDraftKey,
    syncDraftValue,
    notifyDirty,
  ]);

  const handleDraftKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (
        event.key === 'Enter' &&
        !(
          event.target instanceof HTMLTextAreaElement &&
          !event.ctrlKey &&
          !event.metaKey
        )
      ) {
        event.preventDefault();
        void commitDraft();
      }
    },
    [commitDraft],
  );

  const handleDraftKeyBlur = useCallback(async () => {
    const key = draftKeyRef.current.trim();
    if (!key || !resolveDefinition) return;

    const definition = await resolveDefinition(key);
    if (definition && draftTypeRef.current !== 'object') {
      syncDraftType(resolveParameterType(definition));
    }
  }, [resolveDefinition, syncDraftType]);

  const handleDraftValueBlur = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      const relatedTarget = event.relatedTarget as HTMLElement | null;
      if (
        relatedTarget?.dataset.draftField === 'key' ||
        relatedTarget?.dataset.draftField === 'type' ||
        relatedTarget?.dataset.draftField === 'value' ||
        relatedTarget?.dataset.draftAddButton === 'true' ||
        relatedTarget?.closest('[data-draft-field]') ||
        relatedTarget?.closest('[data-draft-add-button="true"]')
      ) {
        return;
      }
      void commitDraft();
    },
    [commitDraft],
  );

  const canAddDraft =
    draftKey.trim().length > 0 &&
    (draftType === 'boolean' || draftValue.trim().length > 0);

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[28%]">{t('table.keyColumn')}</TableHead>
            <TableHead className="w-[18%]">{t('table.typeColumn')}</TableHead>
            <TableHead>{t('table.valueColumn')}</TableHead>
            <TableHead className="w-[88px] text-right">
              {t('table.actionColumn')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([key, value]) => {
            const type = getRowType(key, value, parameterTypes);
            const rowError = errorsByKey[key];

            return (
              <TableRow key={key}>
                <TableCell className="align-top font-mono text-sm">
                  {key}
                </TableCell>
                <TableCell className="align-top">
                  <TypeSelect
                    value={type}
                    disabled={disabled}
                    onChange={(nextType) => onTypeChange(key, nextType)}
                  />
                </TableCell>
                <TableCell className="align-top">
                  <ExistingValueCell
                    parameterKey={key}
                    value={value}
                    type={type}
                    disabled={disabled}
                    onUpdate={onUpdate}
                    onDirtyChange={setRowDirty}
                    registerCommit={registerCommit}
                  />
                  {rowError ? (
                    <p className="mt-1 text-xs text-destructive">{rowError}</p>
                  ) : null}
                </TableCell>
                <TableCell className="align-top text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    disabled={disabled}
                    aria-label={t('table.delete')}
                    onClick={() => onRemove(key)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          <TableRow className="border-t border-dashed bg-muted/20">
            <TableCell className="align-top">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {t('table.addRowLabel')}
              </div>
              <Input
                id={draftKeyInputId}
                data-draft-field="key"
                value={draftKey}
                disabled={disabled}
                placeholder={t('table.keyPlaceholder')}
                className={cn(draftError && 'border-destructive')}
                onChange={(event) => {
                  syncDraftKey(event.target.value);
                  setDraftError('');
                }}
                onBlur={() => {
                  void handleDraftKeyBlur();
                }}
                onKeyDown={handleDraftKeyDown}
              />
              {draftError ? (
                <p className="mt-1 text-xs text-destructive">{draftError}</p>
              ) : null}
            </TableCell>
            <TableCell className="align-top">
              <div className="mb-1 text-xs font-medium text-transparent select-none">
                {t('table.addRowLabel')}
              </div>
              <div data-draft-field="type">
                <TypeSelect
                  value={draftType}
                  disabled={disabled}
                  onChange={(nextType) => {
                    syncDraftType(nextType);
                    if (
                      nextType === 'boolean' &&
                      !draftValueRef.current.trim()
                    ) {
                      syncDraftValue('false');
                    }
                  }}
                />
              </div>
            </TableCell>
            <TableCell className="align-top">
              <div className="mb-1 text-xs font-medium text-transparent select-none">
                {t('table.addRowLabel')}
              </div>
              <div data-draft-field="value" onBlur={handleDraftValueBlur}>
                <ValueEditor
                  type={draftType}
                  value={draftValue}
                  disabled={disabled}
                  inputId={draftValueInputId}
                  inputDataField="value"
                  onChange={syncDraftValue}
                  onCommit={() => {
                    void commitDraft();
                  }}
                  onKeyDown={handleDraftKeyDown}
                />
              </div>
            </TableCell>
            <TableCell className="align-top text-right">
              <div className="mb-1 text-xs font-medium text-transparent select-none">
                {t('table.addRowLabel')}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-1"
                disabled={disabled || !canAddDraft}
                data-draft-add-button="true"
                onClick={() => {
                  void commitDraft();
                }}
              >
                <Plus className="h-4 w-4" />
                {t('table.addButton')}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">{t('table.addHint')}</p>
    </div>
  );
};
