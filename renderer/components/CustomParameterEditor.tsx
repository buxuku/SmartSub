/**
 * CustomParameterEditor Component
 *
 * Main interface for managing custom parameters in AI providers.
 * Headers and body parameters use inline K/V table editing.
 */

import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from 'react';
import { useTranslation } from 'next-i18next';
import { ParameterKvTable } from './ParameterKvTable';
import { useParameterConfig } from '../hooks/useParameterConfig';
import { ParameterValue, CustomParameterConfig } from '../../types';
import {
  inferTypeFromValue,
  parseDraftValue,
  formatValueForInput,
  type ParameterType,
} from '../lib/parameterValueUtils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Search, RefreshCw, AlertTriangle } from 'lucide-react';

export interface CustomParameterEditorProps {
  providerId: string;
  initialConfig?: CustomParameterConfig;
  onConfigChange?: (config: CustomParameterConfig) => void;
  onSave?: () => void;
  disabled?: boolean;
  className?: string;
}

type ParameterCategory = 'headers' | 'body';

function buildTypesFromParams(
  params: Record<string, ParameterValue> | undefined,
): Record<string, ParameterType> {
  const types: Record<string, ParameterType> = {};
  for (const [key, value] of Object.entries(params || {})) {
    types[key] = inferTypeFromValue(value);
  }
  return types;
}

export const CustomParameterEditor: React.FC<CustomParameterEditorProps> = ({
  providerId,
  onConfigChange,
  disabled = false,
  className = '',
}) => {
  const { t } = useTranslation('parameters');
  const {
    state,
    loadConfig,
    addHeaderParameter,
    updateHeaderParameter,
    removeHeaderParameter,
    addBodyParameter,
    updateBodyParameter,
    removeBodyParameter,
    exportConfiguration,
    importConfiguration,
    getParameterDefinition,
  } = useParameterConfig();

  const [activeTab, setActiveTab] = useState<ParameterCategory>('headers');
  const [searchQuery, setSearchQuery] = useState('');
  const [showRefreshDialog, setShowRefreshDialog] = useState(false);
  const [headerTypes, setHeaderTypes] = useState<Record<string, ParameterType>>(
    {},
  );
  const [bodyTypes, setBodyTypes] = useState<Record<string, ParameterType>>({});
  const importInputRef = useRef<HTMLInputElement>(null);
  const prevLoadingRef = useRef(false);

  useEffect(() => {
    if (providerId) {
      loadConfig(providerId);
    }
  }, [providerId, loadConfig]);

  useEffect(() => {
    if (prevLoadingRef.current && !state.isLoading && state.config) {
      setHeaderTypes(buildTypesFromParams(state.config.headerParameters));
      setBodyTypes(buildTypesFromParams(state.config.bodyParameters));
    }
    prevLoadingRef.current = state.isLoading;
  }, [state.isLoading, state.config]);

  useEffect(() => {
    if (!state.config || state.isLoading) return;

    setHeaderTypes((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(
        state.config?.headerParameters || {},
      )) {
        if (!(key in next)) {
          next[key] = inferTypeFromValue(value);
        }
      }
      for (const key of Object.keys(next)) {
        if (!(key in (state.config?.headerParameters || {}))) {
          delete next[key];
        }
      }
      return next;
    });

    setBodyTypes((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(
        state.config?.bodyParameters || {},
      )) {
        if (!(key in next)) {
          next[key] = inferTypeFromValue(value);
        }
      }
      for (const key of Object.keys(next)) {
        if (!(key in (state.config?.bodyParameters || {}))) {
          delete next[key];
        }
      }
      return next;
    });
  }, [
    state.config?.headerParameters,
    state.config?.bodyParameters,
    state.isLoading,
  ]);

  const notifyBodyConfigChange = useCallback(
    (bodyParameters: Record<string, ParameterValue>) => {
      if (onConfigChange && state.config) {
        onConfigChange({ ...state.config, bodyParameters });
      }
    },
    [onConfigChange, state.config],
  );

  const notifyHeaderConfigChange = useCallback(
    (headerParameters: Record<string, ParameterValue>) => {
      if (onConfigChange && state.config) {
        onConfigChange({ ...state.config, headerParameters });
      }
    },
    [onConfigChange, state.config],
  );

  const filterEntries = useCallback(
    (entries: Array<[string, ParameterValue]>) => {
      if (!searchQuery.trim()) return entries;
      const query = searchQuery.toLowerCase();
      return entries.filter(
        ([key, value]) =>
          key.toLowerCase().includes(query) ||
          JSON.stringify(value).toLowerCase().includes(query),
      );
    },
    [searchQuery],
  );

  const filteredHeaderEntries = useMemo(() => {
    const entries = Object.entries(state.config?.headerParameters || {});
    return filterEntries(entries);
  }, [state.config?.headerParameters, filterEntries]);

  const filteredBodyEntries = useMemo(() => {
    const entries = Object.entries(state.config?.bodyParameters || {});
    return filterEntries(entries);
  }, [state.config?.bodyParameters, filterEntries]);

  const headerKeys = useMemo(
    () => Object.keys(state.config?.headerParameters || {}),
    [state.config?.headerParameters],
  );

  const bodyKeys = useMemo(
    () => Object.keys(state.config?.bodyParameters || {}),
    [state.config?.bodyParameters],
  );

  const getParameterCount = useCallback(
    (category: ParameterCategory) => {
      const config = state.config;
      if (!config) return 0;
      return category === 'headers'
        ? Object.keys(config.headerParameters || {}).length
        : Object.keys(config.bodyParameters || {}).length;
    },
    [state.config],
  );

  const activeTabParamCount = getParameterCount(activeTab);
  const showSearch = activeTabParamCount > 5;

  const errorsByKey = useMemo(() => {
    const map: Record<string, string> = {};
    for (const error of state.validationErrors) {
      map[error.key] = error.message;
    }
    return map;
  }, [state.validationErrors]);

  const handleHeaderCommitNew = useCallback(
    (key: string, value: ParameterValue, type: ParameterType) => {
      addHeaderParameter(key, value);
      setHeaderTypes((prev) => ({ ...prev, [key]: type }));
      if (onConfigChange && state.config) {
        notifyHeaderConfigChange({
          ...state.config.headerParameters,
          [key]: value,
        });
      }
    },
    [
      addHeaderParameter,
      onConfigChange,
      state.config,
      notifyHeaderConfigChange,
    ],
  );

  const handleHeaderUpdate = useCallback(
    (key: string, value: ParameterValue) => {
      updateHeaderParameter(key, value);
      if (onConfigChange && state.config) {
        notifyHeaderConfigChange({
          ...state.config.headerParameters,
          [key]: value,
        });
      }
    },
    [
      updateHeaderParameter,
      onConfigChange,
      state.config,
      notifyHeaderConfigChange,
    ],
  );

  const handleHeaderRemove = useCallback(
    (key: string) => {
      removeHeaderParameter(key);
      setHeaderTypes((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (onConfigChange && state.config) {
        const currentParams = { ...state.config.headerParameters };
        delete currentParams[key];
        notifyHeaderConfigChange(currentParams);
      }
    },
    [
      removeHeaderParameter,
      onConfigChange,
      state.config,
      notifyHeaderConfigChange,
    ],
  );

  const handleHeaderTypeChange = useCallback(
    (key: string, type: ParameterType) => {
      setHeaderTypes((prev) => ({ ...prev, [key]: type }));
      const currentValue = state.config?.headerParameters?.[key];
      if (currentValue === undefined) return;

      const currentType = headerTypes[key] ?? inferTypeFromValue(currentValue);
      const raw = formatValueForInput(currentValue, currentType);
      let newValue: ParameterValue;
      try {
        newValue = parseDraftValue(raw, type);
      } catch {
        newValue = currentValue;
      }
      handleHeaderUpdate(key, newValue);
    },
    [state.config?.headerParameters, headerTypes, handleHeaderUpdate],
  );

  const handleBodyCommitNew = useCallback(
    (key: string, value: ParameterValue, type: ParameterType) => {
      addBodyParameter(key, value);
      setBodyTypes((prev) => ({ ...prev, [key]: type }));
      if (onConfigChange && state.config) {
        notifyBodyConfigChange({
          ...state.config.bodyParameters,
          [key]: value,
        });
      }
    },
    [addBodyParameter, onConfigChange, state.config, notifyBodyConfigChange],
  );

  const handleBodyUpdate = useCallback(
    (key: string, value: ParameterValue) => {
      updateBodyParameter(key, value);
      if (onConfigChange && state.config) {
        notifyBodyConfigChange({
          ...state.config.bodyParameters,
          [key]: value,
        });
      }
    },
    [updateBodyParameter, onConfigChange, state.config, notifyBodyConfigChange],
  );

  const handleBodyRemove = useCallback(
    (key: string) => {
      removeBodyParameter(key);
      setBodyTypes((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (onConfigChange && state.config) {
        const currentParams = { ...state.config.bodyParameters };
        delete currentParams[key];
        notifyBodyConfigChange(currentParams);
      }
    },
    [removeBodyParameter, onConfigChange, state.config, notifyBodyConfigChange],
  );

  const handleBodyTypeChange = useCallback(
    (key: string, type: ParameterType) => {
      setBodyTypes((prev) => ({ ...prev, [key]: type }));
      const currentValue = state.config?.bodyParameters?.[key];
      if (currentValue === undefined) return;

      const currentType = bodyTypes[key] ?? inferTypeFromValue(currentValue);
      const raw = formatValueForInput(currentValue, currentType);
      let newValue: ParameterValue;
      try {
        newValue = parseDraftValue(raw, type);
      } catch {
        newValue = currentValue;
      }
      handleBodyUpdate(key, newValue);
    },
    [state.config?.bodyParameters, bodyTypes, handleBodyUpdate],
  );

  const handleExportConfig = useCallback(async () => {
    try {
      const config = exportConfiguration();
      if (!config) return;

      const blob = new Blob([config], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${providerId}-parameters.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export configuration:', error);
    }
  }, [providerId, exportConfiguration]);

  const handleImportConfig = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const configStr = e.target?.result as string;
          const success = importConfiguration(configStr);
          if (!success) {
            console.error('Failed to import configuration: Invalid format');
            return;
          }
          const importData = JSON.parse(configStr) as {
            configuration?: {
              headerParameters?: Record<string, ParameterValue>;
              bodyParameters?: Record<string, ParameterValue>;
            };
          };
          setHeaderTypes(
            buildTypesFromParams(importData.configuration?.headerParameters),
          );
          setBodyTypes(
            buildTypesFromParams(importData.configuration?.bodyParameters),
          );
        } catch (error) {
          console.error('Failed to import configuration:', error);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    },
    [importConfiguration],
  );

  const handleRefresh = useCallback(() => {
    if (state.hasUnsavedChanges) {
      setShowRefreshDialog(true);
    } else {
      loadConfig(providerId);
    }
  }, [state.hasUnsavedChanges, loadConfig, providerId]);

  const confirmRefresh = useCallback(() => {
    setShowRefreshDialog(false);
    loadConfig(providerId);
  }, [loadConfig, providerId]);

  return (
    <div className={`space-y-6 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        {state.saveStatus !== 'idle' ? (
          <div className="flex items-center gap-2 text-sm">
            {state.saveStatus === 'saving' && (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span className="text-muted-foreground">
                  {t('status.saving')}
                </span>
              </>
            )}
            {state.saveStatus === 'saved' && (
              <>
                <div className="w-4 h-4 rounded-full bg-success flex items-center justify-center">
                  <div className="w-2 h-2 rounded-full bg-white" />
                </div>
                <span className="text-success">{t('status.saved')}</span>
              </>
            )}
            {state.saveStatus === 'error' && (
              <>
                <div className="w-4 h-4 rounded-full bg-destructive flex items-center justify-center">
                  <div className="w-2 h-2 rounded-full bg-white" />
                </div>
                <span className="text-destructive">{t('status.error')}</span>
              </>
            )}
          </div>
        ) : (
          <div />
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={disabled}>
              {t('more.label')}
              {state.hasUnsavedChanges &&
                state.saveStatus !== 'error' &&
                state.saveStatus !== 'saving' && (
                  <AlertTriangle className="w-3 h-3 ml-1 text-warning" />
                )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={disabled}
              onSelect={() => importInputRef.current?.click()}
            >
              {t('more.import')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled} onSelect={handleExportConfig}>
              {t('more.export')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled} onSelect={handleRefresh}>
              {t('more.refresh')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <input
          ref={importInputRef}
          type="file"
          accept=".json"
          onChange={handleImportConfig}
          className="hidden"
          disabled={disabled}
        />
      </div>

      {showSearch && (
        <div className="relative max-w-sm">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('more.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
            disabled={disabled}
          />
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(value: string) =>
          setActiveTab(value as ParameterCategory)
        }
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="headers" className="flex items-center gap-2">
            {t('tabs.headers')}
            <Badge variant="secondary" className="ml-1">
              {getParameterCount('headers')}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="body" className="flex items-center gap-2">
            {t('tabs.bodyParameters')}
            <Badge variant="secondary" className="ml-1">
              {getParameterCount('body')}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="headers" className="space-y-4">
          <ParameterKvTable
            entries={filteredHeaderEntries}
            existingKeys={headerKeys}
            disabled={disabled}
            parameterTypes={headerTypes}
            onCommitNew={handleHeaderCommitNew}
            onUpdate={handleHeaderUpdate}
            onRemove={handleHeaderRemove}
            onTypeChange={handleHeaderTypeChange}
            resolveDefinition={getParameterDefinition}
            errorsByKey={errorsByKey}
          />
        </TabsContent>

        <TabsContent value="body" className="space-y-4">
          <ParameterKvTable
            entries={filteredBodyEntries}
            existingKeys={bodyKeys}
            disabled={disabled}
            parameterTypes={bodyTypes}
            onCommitNew={handleBodyCommitNew}
            onUpdate={handleBodyUpdate}
            onRemove={handleBodyRemove}
            onTypeChange={handleBodyTypeChange}
            resolveDefinition={getParameterDefinition}
            errorsByKey={errorsByKey}
          />
        </TabsContent>
      </Tabs>

      <AlertDialog open={showRefreshDialog} onOpenChange={setShowRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-warning" />
              {t('unsavedChangesDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('unsavedChangesDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRefresh}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {t('unsavedChangesDialog.refreshAnyway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CustomParameterEditor;
