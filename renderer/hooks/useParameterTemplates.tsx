/**
 * useParameterTemplates Hook
 *
 * Manages parameter templates including storage, CRUD operations,
 * and integration with the parameter configuration system.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { ParameterTemplate, CustomParameterConfig } from '../../types/provider';

interface UseParameterTemplatesConfig {
  providerId?: string;
  storageKey?: string;
  enableAutoSave?: boolean;
}

interface UseParameterTemplatesReturn {
  templates: ParameterTemplate[];
  loading: boolean;
  error: string | null;

  // Template operations
  createTemplate: (
    template: Omit<ParameterTemplate, 'id'>,
  ) => Promise<ParameterTemplate>;
  updateTemplate: (
    templateId: string,
    updates: Partial<ParameterTemplate>,
  ) => Promise<ParameterTemplate>;
  deleteTemplate: (templateId: string) => Promise<void>;
  duplicateTemplate: (
    templateId: string,
    newName?: string,
  ) => Promise<ParameterTemplate>;

  // Template application
  applyTemplate: (templateId: string) => Promise<CustomParameterConfig>;
  validateTemplate: (
    template: ParameterTemplate,
  ) => Promise<{ isValid: boolean; errors: string[] }>;

  // Template management
  getTemplate: (templateId: string) => ParameterTemplate | null;
  getTemplatesByProvider: (providerId: string) => ParameterTemplate[];
  getTemplatesByCategory: (category: string) => ParameterTemplate[];
  searchTemplates: (query: string) => ParameterTemplate[];

  // Favorites
  toggleFavorite: (templateId: string) => Promise<void>;
  getFavoriteTemplates: () => ParameterTemplate[];

  // Import/Export
  exportTemplate: (templateId: string) => Promise<string>;
  exportAllTemplates: () => Promise<string>;
  importTemplate: (templateData: string) => Promise<ParameterTemplate>;
  importTemplates: (templatesData: string) => Promise<ParameterTemplate[]>;

  // Statistics
  getUsageStats: (templateId: string) => {
    usageCount: number;
    lastUsed?: Date;
  };
  incrementUsage: (templateId: string) => Promise<void>;

  // Storage operations
  loadTemplates: () => Promise<void>;
  saveTemplates: () => Promise<void>;
  clearTemplates: () => Promise<void>;
}

const DEFAULT_STORAGE_KEY = 'smartsub_parameter_templates';

// Pre-built templates based on real-world API configurations
const DEFAULT_TEMPLATES: ParameterTemplate[] = [
  {
    id: 'qwen-optimized',
    name: 'Qwen Optimized',
    description:
      'Optimized settings for Qwen models with thinking disabled for translation',
    category: 'provider',
    headerParameters: {
      Authorization: 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      model: 'qwen-plus',
      temperature: 0.7,
      top_p: 0.8,
      top_k: 50,
      presence_penalty: 0.1,
      stream: false,
      max_tokens: 2048,
      enable_thinking: false,
      result_format: 'message',
    },
    modelCompatibility: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    useCase: 'translation',
    provider: 'qwen',
  },
  {
    id: 'doubao-optimized',
    name: 'Doubao (No Thinking)',
    description: 'Doubao configuration with thinking mode disabled for speed',
    category: 'performance',
    headerParameters: {
      Authorization: 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      model: 'doubao-seed-1-6-250615',
      thinking: {
        type: 'disabled',
        mode: 'silent',
        strip_tags: true,
      },
      temperature: 0.1,
      max_tokens: 1024,
      enable_thinking: false,
    },
    modelCompatibility: [
      'doubao-seed-1-6-250615',
      'doubao-pro-4k',
      'doubao-lite-4k',
    ],
    useCase: 'speed',
    provider: 'doubao',
  },
  {
    id: 'claude-professional',
    name: 'Claude Professional',
    description:
      'Claude with professional translation settings and custom headers',
    category: 'quality',
    headerParameters: {
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'X-Custom-Region': 'us-west-2',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      model: 'claude-3-sonnet',
      max_tokens: 4096,
      temperature: 0.3,
      system: 'You are a professional translator',
      stop_sequences: ['Human:', 'Assistant:'],
    },
    modelCompatibility: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
    useCase: 'translation',
    provider: 'claude',
  },
  {
    id: 'openai-standard',
    name: 'OpenAI Standard',
    description:
      'Standard OpenAI configuration optimized for translation tasks',
    category: 'provider',
    headerParameters: {
      Authorization: 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      model: 'gpt-4',
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1.0,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
    },
    modelCompatibility: ['gpt-4', 'gpt-3.5-turbo'],
    useCase: 'translation',
    provider: 'openai',
  },
  {
    id: 'performance-optimized',
    name: 'Speed Optimized',
    description: 'Settings optimized for fast translation with minimal tokens',
    category: 'performance',
    headerParameters: {
      'Accept-Encoding': 'gzip',
      Connection: 'keep-alive',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      temperature: 0.0,
      max_tokens: 500,
      stream: true,
      presence_penalty: 0.0,
      frequency_penalty: 0.0,
      n: 1,
      best_of: 1,
    },
    modelCompatibility: ['gpt-3.5-turbo', 'qwen-turbo', 'doubao-lite-4k'],
    useCase: 'speed',
    provider: 'performance',
  },
  {
    id: 'quality-enhanced',
    name: 'Quality Enhanced',
    description: 'High-quality translation settings with enhanced parameters',
    category: 'quality',
    headerParameters: {
      'X-Translation-Service': 'premium',
      'X-Quality-Level': 'high',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      temperature: 0.3,
      max_tokens: 2048,
      top_p: 0.9,
      presence_penalty: 0.1,
      frequency_penalty: 0.1,
      domain_adaptation: true,
      preserve_formatting: true,
      quality_settings: {
        accuracy: 'high',
        fluency: 'natural',
        consistency: 'strict',
      },
    },
    modelCompatibility: ['gpt-4', 'claude-3-opus', 'qwen-max'],
    useCase: 'translation',
    provider: 'quality',
  },
];

export const useParameterTemplates = (
  config: UseParameterTemplatesConfig = {},
): UseParameterTemplatesReturn => {
  const {
    providerId,
    storageKey = DEFAULT_STORAGE_KEY,
    enableAutoSave = true,
  } = config;

  // State
  const [templates, setTemplates] = useState<ParameterTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load templates from storage
  const loadTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Load from localStorage or IPC
      let storedTemplates: ParameterTemplate[] = [];

      if (typeof window !== 'undefined' && window.ipc) {
        // Electron environment - use IPC
        try {
          const result = await window.ipc.invoke(
            'parameter-templates:load',
            storageKey,
          );
          storedTemplates = result || [];
        } catch (ipcError) {
          console.warn(
            'Failed to load templates via IPC, falling back to localStorage:',
            ipcError,
          );
          const stored = localStorage.getItem(storageKey);
          storedTemplates = stored ? JSON.parse(stored) : [];
        }
      } else {
        // Web environment - use localStorage
        const stored = localStorage.getItem(storageKey);
        storedTemplates = stored ? JSON.parse(stored) : [];
      }

      // Parse dates (no metadata to process in ParameterTemplate interface)

      // Merge with default templates
      const defaultTemplateIds = new Set(DEFAULT_TEMPLATES.map((t) => t.id));
      const customTemplates = storedTemplates.filter(
        (t) => !defaultTemplateIds.has(t.id),
      );

      setTemplates([...DEFAULT_TEMPLATES, ...customTemplates]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
      setTemplates(DEFAULT_TEMPLATES);
    } finally {
      setLoading(false);
    }
  }, [storageKey]);

  // Save templates to storage
  const saveTemplates = useCallback(async () => {
    try {
      setError(null);

      // Filter out default templates (they don't need to be saved)
      const defaultTemplateIds = new Set(DEFAULT_TEMPLATES.map((t) => t.id));
      const customTemplates = templates.filter(
        (t) => !defaultTemplateIds.has(t.id),
      );

      if (typeof window !== 'undefined' && window.ipc) {
        // Electron environment - use IPC
        await window.ipc.invoke(
          'parameter-templates:save',
          storageKey,
          customTemplates,
        );
      } else {
        // Web environment - use localStorage
        localStorage.setItem(storageKey, JSON.stringify(customTemplates));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save templates');
    }
  }, [templates, storageKey]);

  // Auto-save when templates change
  useEffect(() => {
    if (enableAutoSave && templates.length > 0) {
      const timeoutId = setTimeout(() => {
        saveTemplates();
      }, 1000); // Debounce saves

      return () => clearTimeout(timeoutId);
    }
  }, [templates, enableAutoSave, saveTemplates]);

  // Load templates on mount
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // Create template
  const createTemplate = useCallback(
    async (
      templateData: Omit<ParameterTemplate, 'id'>,
    ): Promise<ParameterTemplate> => {
      const newTemplate: ParameterTemplate = {
        ...templateData,
        id: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      };

      setTemplates((prev) => [...prev, newTemplate]);
      return newTemplate;
    },
    [],
  );

  // Update template
  const updateTemplate = useCallback(
    async (
      templateId: string,
      updates: Partial<ParameterTemplate>,
    ): Promise<ParameterTemplate> => {
      let updatedTemplate: ParameterTemplate | null = null;

      setTemplates((prev) =>
        prev.map((template) => {
          if (template.id === templateId) {
            updatedTemplate = {
              ...template,
              ...updates,
            };
            return updatedTemplate;
          }
          return template;
        }),
      );

      if (!updatedTemplate) {
        throw new Error(`Template with ID ${templateId} not found`);
      }

      return updatedTemplate;
    },
    [],
  );

  // Delete template
  const deleteTemplate = useCallback(
    async (templateId: string): Promise<void> => {
      setTemplates((prev) =>
        prev.filter((template) => template.id !== templateId),
      );
    },
    [],
  );

  // Duplicate template
  const duplicateTemplate = useCallback(
    async (
      templateId: string,
      newName?: string,
    ): Promise<ParameterTemplate> => {
      const originalTemplate = templates.find((t) => t.id === templateId);
      if (!originalTemplate) {
        throw new Error(`Template with ID ${templateId} not found`);
      }

      const duplicatedTemplate = await createTemplate({
        ...originalTemplate,
        name: newName || `${originalTemplate.name} (Copy)`,
        category: 'provider',
      });

      return duplicatedTemplate;
    },
    [templates, createTemplate],
  );

  // Apply template
  const applyTemplate = useCallback(
    async (templateId: string): Promise<CustomParameterConfig> => {
      const template = templates.find((t) => t.id === templateId);
      if (!template) {
        throw new Error(`Template with ID ${templateId} not found`);
      }

      // Increment usage count
      await incrementUsage(templateId);

      return {
        headerParameters: template.headerParameters,
        bodyParameters: template.bodyParameters,
        configVersion: '1.0.0',
        lastModified: Date.now(),
      };
    },
    [templates],
  );

  // Validate template
  const validateTemplate = useCallback(
    async (
      template: ParameterTemplate,
    ): Promise<{ isValid: boolean; errors: string[] }> => {
      const errors: string[] = [];

      // Required fields
      if (!template.name?.trim()) {
        errors.push('Template name is required');
      }
      if (!template.description?.trim()) {
        errors.push('Template description is required');
      }
      if (!template.category) {
        errors.push('Template category is required');
      }

      // Validate configurations
      if (!template.headerParameters && !template.bodyParameters) {
        errors.push('Template must have at least one parameter configuration');
      }

      // Validate JSON structure
      try {
        JSON.stringify(template.headerParameters);
        JSON.stringify(template.bodyParameters);
      } catch {
        errors.push('Template configurations contain invalid JSON');
      }

      return {
        isValid: errors.length === 0,
        errors,
      };
    },
    [],
  );

  // Get template by ID
  const getTemplate = useCallback(
    (templateId: string): ParameterTemplate | null => {
      return templates.find((t) => t.id === templateId) || null;
    },
    [templates],
  );

  // Get templates by provider
  const getTemplatesByProvider = useCallback(
    (providerId: string): ParameterTemplate[] => {
      return templates.filter((t) => !t.provider || t.provider === providerId);
    },
    [templates],
  );

  // Get templates by category
  const getTemplatesByCategory = useCallback(
    (category: string): ParameterTemplate[] => {
      return templates.filter((t) => t.category === category);
    },
    [templates],
  );

  // Search templates
  const searchTemplates = useCallback(
    (query: string): ParameterTemplate[] => {
      if (!query.trim()) return templates;

      const searchTerm = query.toLowerCase();
      return templates.filter(
        (template) =>
          template.name.toLowerCase().includes(searchTerm) ||
          template.description.toLowerCase().includes(searchTerm) ||
          template.category.toLowerCase().includes(searchTerm) ||
          (template.provider &&
            template.provider.toLowerCase().includes(searchTerm)),
      );
    },
    [templates],
  );

  // Toggle favorite (simplified without isFavorite property)
  const toggleFavorite = useCallback(
    async (templateId: string): Promise<void> => {
      // Favorites would need to be implemented with external storage
      // since ParameterTemplate interface doesn't include isFavorite
    },
    [],
  );

  // Get favorite templates (simplified without isFavorite property)
  const getFavoriteTemplates = useCallback((): ParameterTemplate[] => {
    return []; // No favorites since interface doesn't support it
  }, []);

  // Export template
  const exportTemplate = useCallback(
    async (templateId: string): Promise<string> => {
      const template = templates.find((t) => t.id === templateId);
      if (!template) {
        throw new Error(`Template with ID ${templateId} not found`);
      }

      return JSON.stringify(template, null, 2);
    },
    [templates],
  );

  // Export all templates
  const exportAllTemplates = useCallback(async (): Promise<string> => {
    return JSON.stringify(templates, null, 2);
  }, [templates]);

  // Import template
  const importTemplate = useCallback(
    async (templateData: string): Promise<ParameterTemplate> => {
      try {
        const parsedTemplate = JSON.parse(templateData) as ParameterTemplate;

        // Validate template
        const validation = await validateTemplate(parsedTemplate);
        if (!validation.isValid) {
          throw new Error(`Invalid template: ${validation.errors.join(', ')}`);
        }

        // Create new template with updated metadata
        const importedTemplate = await createTemplate({
          ...parsedTemplate,
          category: 'experimental', // Imported templates are experimental
        });

        return importedTemplate;
      } catch (err) {
        throw new Error(
          `Failed to import template: ${err instanceof Error ? err.message : 'Invalid JSON'}`,
        );
      }
    },
    [createTemplate, validateTemplate],
  );

  // Import multiple templates
  const importTemplates = useCallback(
    async (templatesData: string): Promise<ParameterTemplate[]> => {
      try {
        const parsedTemplates = JSON.parse(
          templatesData,
        ) as ParameterTemplate[];
        if (!Array.isArray(parsedTemplates)) {
          throw new Error('Templates data must be an array');
        }

        const importedTemplates: ParameterTemplate[] = [];

        for (const templateData of parsedTemplates) {
          try {
            const imported = await importTemplate(JSON.stringify(templateData));
            importedTemplates.push(imported);
          } catch (err) {
            console.warn(
              `Failed to import template "${templateData.name}":`,
              err,
            );
          }
        }

        return importedTemplates;
      } catch (err) {
        throw new Error(
          `Failed to import templates: ${err instanceof Error ? err.message : 'Invalid JSON'}`,
        );
      }
    },
    [importTemplate],
  );

  // Get usage stats (simplified without metadata)
  const getUsageStats = useCallback((templateId: string) => {
    return {
      usageCount: 0,
      lastUsed: undefined,
    };
  }, []);

  // Increment usage (simplified without metadata)
  const incrementUsage = useCallback(
    async (templateId: string): Promise<void> => {
      // Usage tracking would need to be implemented with external storage
      // since ParameterTemplate interface doesn't include metadata
    },
    [],
  );

  // Clear all templates
  const clearTemplates = useCallback(async (): Promise<void> => {
    setTemplates(DEFAULT_TEMPLATES);
    if (typeof window !== 'undefined' && window.ipc) {
      await window.ipc.invoke('parameter-templates:clear', storageKey);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  // Filter templates by provider if specified
  const filteredTemplates = useMemo(() => {
    if (!providerId) return templates;
    return getTemplatesByProvider(providerId);
  }, [templates, providerId, getTemplatesByProvider]);

  return {
    templates: filteredTemplates,
    loading,
    error,

    // Template operations
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate,

    // Template application
    applyTemplate,
    validateTemplate,

    // Template management
    getTemplate,
    getTemplatesByProvider,
    getTemplatesByCategory,
    searchTemplates,

    // Favorites
    toggleFavorite,
    getFavoriteTemplates,

    // Import/Export
    exportTemplate,
    exportAllTemplates,
    importTemplate,
    importTemplates,

    // Statistics
    getUsageStats,
    incrementUsage,

    // Storage operations
    loadTemplates,
    saveTemplates,
    clearTemplates,
  };
};
