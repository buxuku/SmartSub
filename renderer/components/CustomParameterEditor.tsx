/**
 * CustomParameterEditor Component
 *
 * Main interface for managing custom parameters in AI providers.
 * Provides parameter list with add/edit/delete functionality and
 * separation between header and body parameters.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import { DynamicParameterInput } from './DynamicParameterInput';
import { useParameterConfig } from '../hooks/useParameterConfig';
import {
  ParameterValue,
  ParameterDefinition,
  ValidationError,
  CustomParameterConfig,
} from '../../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Plus,
  Search,
  Settings,
  Trash2,
  Copy,
  Download,
  Upload,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';

export interface CustomParameterEditorProps {
  providerId: string;
  initialConfig?: CustomParameterConfig;
  onConfigChange?: (config: CustomParameterConfig) => void;
  onSave?: () => void;
  disabled?: boolean;
  className?: string;
}

type ParameterCategory = 'headers' | 'body';
type ParameterType = 'string' | 'integer' | 'float' | 'boolean' | 'array';

interface NewParameterForm {
  key: string;
  type: ParameterType;
  category: ParameterCategory;
  value: ParameterValue;
}

export const CustomParameterEditor: React.FC<CustomParameterEditorProps> = ({
  providerId,
  initialConfig,
  onConfigChange,
  onSave,
  disabled = false,
  className = '',
}) => {
  const { t } = useTranslation('parameters');
  const {
    state,
    loadConfig,
    saveConfig,
    addHeaderParameter,
    updateHeaderParameter,
    removeHeaderParameter,
    addBodyParameter,
    updateBodyParameter,
    removeBodyParameter,
    validateConfiguration,
    exportConfiguration,
    importConfiguration,
    getSupportedParameters,
    getParameterDefinition,
  } = useParameterConfig();

  // Load configuration on mount
  useEffect(() => {
    if (providerId) {
      loadConfig(providerId);
    }
  }, [providerId, loadConfig]);

  // Type-aware initial value generator
  const getInitialValueForType = useCallback(
    (type: ParameterType): ParameterValue => {
      switch (type) {
        case 'boolean':
          return false;
        case 'integer':
          return 0;
        case 'float':
          return 0.0;
        case 'array':
          return [];
        default:
          return '';
      }
    },
    [],
  );

  // Local state
  const [activeTab, setActiveTab] = useState<ParameterCategory>('headers');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showRefreshDialog, setShowRefreshDialog] = useState(false);
  const [newParameter, setNewParameter] = useState<NewParameterForm>({
    key: '',
    type: 'string',
    category: 'headers',
    value: '',
  });

  // Filter parameters by category and search
  const filteredParameters = useMemo(() => {
    const config = state.config;
    if (!config) return [];

    const categoryParams =
      activeTab === 'headers'
        ? Object.entries(config.headerParameters || {})
        : Object.entries(config.bodyParameters || {});

    if (!searchQuery.trim()) {
      return categoryParams;
    }

    return categoryParams.filter(
      ([key, value]) =>
        key.toLowerCase().includes(searchQuery.toLowerCase()) ||
        JSON.stringify(value).toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [state.config, activeTab, searchQuery]);

  // Get parameter count by category
  const getParameterCount = useCallback(
    (category: ParameterCategory) => {
      const config = state.config;
      if (!config) return 0;

      if (category === 'headers') {
        return Object.keys(config.headerParameters || {}).length;
      } else {
        return Object.keys(config.bodyParameters || {}).length;
      }
    },
    [state.config],
  );

  // Handle parameter changes
  const handleParameterChange = useCallback(
    (key: string, value: ParameterValue) => {
      if (activeTab === 'headers') {
        updateHeaderParameter(key, value);
      } else {
        updateBodyParameter(key, value);
      }

      // Notify parent component
      if (onConfigChange && state.config) {
        const updatedConfig: CustomParameterConfig = {
          ...state.config,
          [activeTab === 'headers' ? 'headerParameters' : 'bodyParameters']: {
            ...state.config[
              activeTab === 'headers' ? 'headerParameters' : 'bodyParameters'
            ],
            [key]: value,
          },
        };

        onConfigChange(updatedConfig);
      }
    },
    [
      activeTab,
      updateHeaderParameter,
      updateBodyParameter,
      onConfigChange,
      state.config,
    ],
  );

  // Handle parameter removal
  const handleParameterRemove = useCallback(
    (key: string) => {
      if (activeTab === 'headers') {
        removeHeaderParameter(key);
      } else {
        removeBodyParameter(key);
      }

      // Notify parent component
      if (onConfigChange && state.config) {
        const currentParams =
          activeTab === 'headers'
            ? { ...state.config.headerParameters }
            : { ...state.config.bodyParameters };
        delete currentParams[key];

        const updatedConfig: CustomParameterConfig = {
          ...state.config,
          [activeTab === 'headers' ? 'headerParameters' : 'bodyParameters']:
            currentParams,
        };

        onConfigChange(updatedConfig);
      }
    },
    [
      activeTab,
      removeHeaderParameter,
      removeBodyParameter,
      onConfigChange,
      state.config,
    ],
  );

  // Convert value based on parameter type
  const convertValueForType = useCallback(
    (value: ParameterValue, type: ParameterType): ParameterValue => {
      switch (type) {
        case 'boolean':
          if (typeof value === 'string') {
            return value.toLowerCase() === 'true' || value === '1';
          }
          return Boolean(value);
        case 'integer':
          return typeof value === 'number'
            ? Math.floor(value)
            : parseInt(String(value), 10) || 0;
        case 'float':
          return typeof value === 'number'
            ? value
            : parseFloat(String(value)) || 0.0;
        case 'array':
          return Array.isArray(value) ? value : [];
        default:
          return String(value);
      }
    },
    [],
  );

  // Handle parameter type change
  const handleTypeChange = useCallback(
    (newType: ParameterType) => {
      setNewParameter((prev) => ({
        ...prev,
        type: newType,
        value: getInitialValueForType(newType),
      }));
    },
    [getInitialValueForType],
  );

  // Handle adding new parameter
  const handleAddParameter = useCallback(() => {
    if (!newParameter.key.trim()) return;

    // Convert value to correct type before adding
    const convertedValue = convertValueForType(
      newParameter.value,
      newParameter.type,
    );

    // Add parameter based on category
    if (newParameter.category === 'headers') {
      addHeaderParameter(newParameter.key, convertedValue);
    } else {
      addBodyParameter(newParameter.key, convertedValue);
    }

    // Reset form with proper initial value for default type
    const defaultType = 'string';
    setNewParameter({
      key: '',
      type: defaultType,
      category: 'headers',
      value: getInitialValueForType(defaultType),
    });
    setShowAddDialog(false);
  }, [
    newParameter,
    addHeaderParameter,
    addBodyParameter,
    convertValueForType,
    getInitialValueForType,
  ]);

  // Handle parameter duplication
  const handleDuplicateParameter = useCallback(
    (key: string) => {
      const config = state.config;
      if (!config) return;

      const originalValue =
        activeTab === 'headers'
          ? config.headerParameters?.[key]
          : config.bodyParameters?.[key];

      if (!originalValue) return;

      const newKey = `${key}_copy`;

      if (activeTab === 'headers') {
        addHeaderParameter(newKey, originalValue);
      } else {
        addBodyParameter(newKey, originalValue);
      }
    },
    [state.config, activeTab, addHeaderParameter, addBodyParameter],
  );

  // Handle configuration export
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

  // Handle configuration import
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
          }
        } catch (error) {
          console.error('Failed to import configuration:', error);
        }
      };
      reader.readAsText(file);
    },
    [importConfiguration],
  );

  // Get validation errors for parameter
  const getParameterErrors = useCallback(
    (key: string): ValidationError[] => {
      return state.validationErrors.filter((error) => error.key === key);
    },
    [state.validationErrors],
  );

  // Infer parameter type from value for display purposes
  const inferTypeFromValue = useCallback(
    (value: ParameterValue): ParameterType => {
      if (typeof value === 'boolean') return 'boolean';
      if (typeof value === 'number') {
        return Number.isInteger(value) ? 'integer' : 'float';
      }
      if (Array.isArray(value)) return 'array';
      return 'string';
    },
    [],
  );

  // Get parameter definition for display (inferred from value)
  const getParameterDefinitionForDisplay = useCallback(
    (key: string, value: ParameterValue): ParameterDefinition => {
      // Infer type from the actual stored value for accurate display
      const inferredType = inferTypeFromValue(value);
      return {
        key,
        type: inferredType,
        category: 'core',
        required: false,
        description: `Custom ${inferredType} parameter`,
        providerSupport: [providerId],
      };
    },
    [providerId, inferTypeFromValue],
  );

  // Handle smart refresh
  const handleRefresh = useCallback(() => {
    if (state.hasUnsavedChanges) {
      setShowRefreshDialog(true);
    } else {
      loadConfig(providerId);
    }
  }, [state.hasUnsavedChanges, loadConfig, providerId]);

  // Confirm refresh with unsaved changes
  const confirmRefresh = useCallback(() => {
    setShowRefreshDialog(false);
    loadConfig(providerId);
  }, [loadConfig, providerId]);

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Actions */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          {/* Actions */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportConfig}
            disabled={disabled}
          >
            <Download className="w-4 h-4 mr-2" />
            {t('actions.export')}
          </Button>

          <label className="inline-flex">
            <Button variant="outline" size="sm" disabled={disabled} asChild>
              <span>
                <Upload className="w-4 h-4 mr-2" />
                {t('actions.import')}
              </span>
            </Button>
            <input
              type="file"
              accept=".json"
              onChange={handleImportConfig}
              className="hidden"
              disabled={disabled}
            />
          </label>

          {/* Save Status Indicator */}
          {state.saveStatus !== 'idle' && (
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
                  <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-white"></div>
                  </div>
                  <span className="text-green-600">{t('status.saved')}</span>
                </>
              )}
              {state.saveStatus === 'error' && (
                <>
                  <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-white"></div>
                  </div>
                  <span className="text-red-600">{t('status.error')}</span>
                </>
              )}
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={disabled}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            {t('actions.refresh')}
            {state.hasUnsavedChanges &&
              state.saveStatus !== 'error' &&
              state.saveStatus !== 'saving' && (
                <AlertTriangle className="w-3 h-3 ml-1 text-orange-500" />
              )}
          </Button>
        </div>
      </div>

      {/* Search and Add */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('search.placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
            disabled={disabled}
          />
        </div>

        <AlertDialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <AlertDialogTrigger asChild>
            <Button disabled={disabled}>
              <Plus className="w-4 h-4 mr-2" />
              {t('actions.addParameter')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('addDialog.title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('addDialog.description')}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="param-key">{t('addDialog.fields.key')}</Label>
                <Input
                  id="param-key"
                  value={newParameter.key}
                  onChange={(e) =>
                    setNewParameter((prev) => ({
                      ...prev,
                      key: e.target.value,
                    }))
                  }
                  placeholder={t('addDialog.placeholders.key')}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="param-category">
                  {t('addDialog.fields.category')}
                </Label>
                <Select
                  value={newParameter.category}
                  onValueChange={(value: ParameterCategory) =>
                    setNewParameter((prev) => ({ ...prev, category: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="headers">
                      {t('categories.headers')}
                    </SelectItem>
                    <SelectItem value="body">{t('categories.body')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="param-type">{t('addDialog.fields.type')}</Label>
                <Select
                  value={newParameter.type}
                  onValueChange={handleTypeChange}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">{t('types.string')}</SelectItem>
                    <SelectItem value="integer">
                      {t('types.integer')}
                    </SelectItem>
                    <SelectItem value="float">{t('types.float')}</SelectItem>
                    <SelectItem value="boolean">
                      {t('types.boolean')}
                    </SelectItem>
                    <SelectItem value="array">{t('types.array')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="param-value">
                  {t('addDialog.fields.initialValue')}
                </Label>
                <DynamicParameterInput
                  parameterKey="new-param-value"
                  value={newParameter.value}
                  definition={{
                    key: 'new-param-value',
                    type: newParameter.type,
                    category: 'core',
                    required: false,
                    description: t('addDialog.tooltips.initialValue'),
                    providerSupport: [providerId],
                  }}
                  onChange={(_, value) =>
                    setNewParameter((prev) => ({ ...prev, value }))
                  }
                  placeholder={t('addDialog.placeholders.initialValue')}
                />
              </div>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={handleAddParameter}>
                {t('actions.addParameter')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Parameter Tabs */}
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
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                {t('headers.title')}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {t('headers.description')}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {filteredParameters.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {searchQuery
                    ? t('emptyStates.noHeadersSearch')
                    : t('emptyStates.noHeadersConfigured')}
                </div>
              ) : (
                filteredParameters.map(([key, value]) => (
                  <div key={key}>
                    <DynamicParameterInput
                      parameterKey={key}
                      value={value}
                      definition={getParameterDefinitionForDisplay(key, value)}
                      errors={getParameterErrors(key)}
                      onChange={handleParameterChange}
                      onRemove={handleParameterRemove}
                      showRemove={true}
                      disabled={disabled}
                    />

                    {/* Parameter actions */}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDuplicateParameter(key)}
                        disabled={disabled}
                        className="h-7 px-2"
                      >
                        <Copy className="w-3 h-3 mr-1" />
                        {t('actions.duplicate')}
                      </Button>
                    </div>

                    <Separator className="mt-4" />
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="body" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                {t('bodyParameters.title')}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {t('bodyParameters.description')}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {filteredParameters.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {searchQuery
                    ? t('emptyStates.noBodyParamsSearch')
                    : t('emptyStates.noBodyParamsConfigured')}
                </div>
              ) : (
                filteredParameters.map(([key, value]) => (
                  <div key={key}>
                    <DynamicParameterInput
                      parameterKey={key}
                      value={value}
                      definition={getParameterDefinitionForDisplay(key, value)}
                      errors={getParameterErrors(key)}
                      onChange={handleParameterChange}
                      onRemove={handleParameterRemove}
                      showRemove={true}
                      disabled={disabled}
                    />

                    {/* Parameter actions */}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDuplicateParameter(key)}
                        disabled={disabled}
                        className="h-7 px-2"
                      >
                        <Copy className="w-3 h-3 mr-1" />
                        {t('actions.duplicate')}
                      </Button>
                    </div>

                    <Separator className="mt-4" />
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Summary */}
      {(state.validationErrors.length > 0 ||
        (state.config &&
          (Object.keys(state.config.headerParameters || {}).length > 0 ||
            Object.keys(state.config.bodyParameters || {}).length > 0))) && (
        <Card>
          <CardHeader>
            <CardTitle>{t('summary.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium">
                  {t('summary.totalParameters')}
                </span>{' '}
                {getParameterCount('headers') + getParameterCount('body')}
              </div>
              <div>
                <span className="font-medium">{t('summary.headers')}</span>{' '}
                {getParameterCount('headers')}
              </div>
              <div>
                <span className="font-medium">
                  {t('summary.bodyParameters')}
                </span>{' '}
                {getParameterCount('body')}
              </div>
              <div>
                <span className="font-medium">
                  {t('summary.validationErrors')}
                </span>{' '}
                <span
                  className={
                    state.validationErrors.length > 0
                      ? 'text-red-600'
                      : 'text-green-600'
                  }
                >
                  {state.validationErrors.length}
                </span>
              </div>
            </div>

            {/* Save Status Indicator */}
            <div className="mt-4 pt-4 border-t">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">
                  {t('summary.saveStatus')}
                </span>
                {state.saveStatus === 'idle' && !state.hasUnsavedChanges && (
                  <div className="flex items-center gap-1 text-gray-500">
                    <div className="w-2 h-2 rounded-full bg-gray-400"></div>
                    <span className="text-sm">{t('status.upToDate')}</span>
                  </div>
                )}
                {state.saveStatus === 'idle' && state.hasUnsavedChanges && (
                  <div className="flex items-center gap-1 text-yellow-600">
                    <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                    <span className="text-sm">
                      {t('status.unsavedChanges')}
                    </span>
                  </div>
                )}
                {state.saveStatus === 'saving' && (
                  <div className="flex items-center gap-1 text-blue-600">
                    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                    <span className="text-sm">{t('status.saving')}</span>
                  </div>
                )}
                {state.saveStatus === 'saved' && (
                  <div className="flex items-center gap-1 text-green-600">
                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                    <span className="text-sm">
                      {t('status.savedAutomatically')}
                    </span>
                  </div>
                )}
                {state.saveStatus === 'error' && (
                  <div className="flex items-center gap-1 text-red-600">
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    <span className="text-sm">{t('status.saveFailed')}</span>
                  </div>
                )}
              </div>
              {state.saveMessage && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {state.saveMessage}
                </div>
              )}
              {state.lastSaved && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('summary.lastSaved')}{' '}
                  {new Date(state.lastSaved).toLocaleTimeString()}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Refresh Confirmation Dialog */}
      <AlertDialog open={showRefreshDialog} onOpenChange={setShowRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
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
              className="bg-orange-600 hover:bg-orange-700"
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
