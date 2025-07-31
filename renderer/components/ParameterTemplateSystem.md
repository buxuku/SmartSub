# Parameter Template System

The Parameter Template System provides a comprehensive solution for managing, creating, and applying parameter configurations across different AI providers. It consists of three main components working together to deliver a seamless template management experience.

## Architecture Overview

```
ParameterTemplateManager (UI Component)
    ↓
useParameterTemplates (Hook)
    ↓
Storage Layer (localStorage/IPC)
    ↓
Template Data (JSON)
```

### Core Components

1. **ParameterTemplateManager**: Main UI component for template management
2. **useParameterTemplates**: Hook for template operations and storage
3. **Template Integration**: Seamless integration with parameter editor

## ParameterTemplateManager Component

### Features

- **Template Browsing**: Grid-based template display with filtering and search
- **Category Organization**: Official, Community, Custom, and Favorites categories
- **Template Operations**: Apply, preview, export, edit, and delete templates
- **Template Creation**: Create templates from current configurations
- **Import/Export**: Save and restore template configurations
- **Usage Tracking**: Monitor template usage and popularity

### Usage

```tsx
import { ParameterTemplateManager } from '@/components/parameter';

const MyProviderSettings = () => {
  const [currentConfig, setCurrentConfig] = useState<CustomParameterConfig>({
    headerConfigs: {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    },
    bodyConfigs: {
      temperature: 0.7,
      max_tokens: 1000,
    },
  });

  const handleTemplateApply = (template: ParameterTemplate) => {
    // Apply template to current configuration
    setCurrentConfig({
      headerConfigs: template.headerConfigs,
      bodyConfigs: template.bodyConfigs,
    });
  };

  return (
    <ParameterTemplateManager
      providerId="openai"
      currentConfig={currentConfig}
      onTemplateApply={handleTemplateApply}
      onTemplateCreate={(template) => console.log('Created:', template)}
    />
  );
};
```

### Props

| Prop               | Type                                    | Description                     |
| ------------------ | --------------------------------------- | ------------------------------- |
| `providerId`       | `string`                                | Filter templates by provider    |
| `currentConfig`    | `CustomParameterConfig`                 | Current parameter configuration |
| `onTemplateApply`  | `(template: ParameterTemplate) => void` | Template application callback   |
| `onTemplateCreate` | `(template: ParameterTemplate) => void` | Template creation callback      |
| `onTemplateUpdate` | `(template: ParameterTemplate) => void` | Template update callback        |
| `onTemplateDelete` | `(templateId: string) => void`          | Template deletion callback      |
| `disabled`         | `boolean`                               | Disable all interactions        |

## useParameterTemplates Hook

### Features

- **CRUD Operations**: Create, read, update, delete templates
- **Storage Management**: Persistent storage with auto-save
- **Template Validation**: Ensure template integrity
- **Usage Statistics**: Track application frequency and timing
- **Import/Export**: JSON-based template sharing
- **Provider Filtering**: Show relevant templates only

### Usage

```tsx
import { useParameterTemplates } from '@/hooks/useParameterTemplates';

const MyComponent = () => {
  const {
    templates,
    loading,
    createTemplate,
    applyTemplate,
    toggleFavorite,
    exportTemplate,
  } = useParameterTemplates({
    providerId: 'openai',
    enableAutoSave: true,
  });

  const handleCreateTemplate = async () => {
    const template = await createTemplate({
      name: 'My Custom Template',
      description: 'Custom configuration for specific use case',
      category: 'custom',
      tags: ['custom', 'optimized'],
      isPublic: false,
      isFavorite: false,
      headerConfigs: { Authorization: 'Bearer token' },
      bodyConfigs: { temperature: 0.8 },
    });

    console.log('Created template:', template);
  };

  return (
    <div>
      {templates.map((template) => (
        <div key={template.id}>
          <h3>{template.name}</h3>
          <button onClick={() => applyTemplate(template.id)}>Apply</button>
          <button onClick={() => toggleFavorite(template.id)}>
            {template.isFavorite ? 'Unfavorite' : 'Favorite'}
          </button>
        </div>
      ))}
    </div>
  );
};
```

### Hook API

#### Template Operations

```tsx
// Create new template
const template = await createTemplate({
  name: 'Template Name',
  description: 'Template description',
  category: 'custom',
  tags: ['tag1', 'tag2'],
  headerConfigs: {},
  bodyConfigs: {},
});

// Update existing template
await updateTemplate('template-id', {
  name: 'Updated Name',
  description: 'Updated description',
});

// Delete template
await deleteTemplate('template-id');

// Duplicate template
const duplicated = await duplicateTemplate('template-id', 'New Name');
```

#### Template Application

```tsx
// Apply template and get configuration
const config = await applyTemplate('template-id');

// Validate template
const { isValid, errors } = await validateTemplate(template);
```

#### Template Management

```tsx
// Get specific template
const template = getTemplate('template-id');

// Get templates by provider
const openaiTemplates = getTemplatesByProvider('openai');

// Get templates by category
const customTemplates = getTemplatesByCategory('custom');

// Search templates
const searchResults = searchTemplates('openai creative');
```

#### Favorites

```tsx
// Toggle favorite status
await toggleFavorite('template-id');

// Get all favorites
const favorites = getFavoriteTemplates();
```

#### Import/Export

```tsx
// Export single template
const templateJson = await exportTemplate('template-id');

// Export all templates
const allTemplatesJson = await exportAllTemplates();

// Import template
const imported = await importTemplate(templateJsonString);

// Import multiple templates
const importedList = await importTemplates(templatesJsonString);
```

#### Statistics

```tsx
// Get usage statistics
const { usageCount, lastUsed } = getUsageStats('template-id');

// Increment usage (called automatically on apply)
await incrementUsage('template-id');
```

## Template Data Structure

### ParameterTemplate Interface

```tsx
interface ParameterTemplate {
  id: string; // Unique identifier
  name: string; // Display name
  description: string; // Template description
  category: 'official' | 'community' | 'custom' | 'favorites';
  providerId?: string; // Associated provider
  tags: string[]; // Searchable tags
  isPublic: boolean; // Public visibility
  isFavorite: boolean; // User favorite status
  headerConfigs: Record<string, ParameterValue>; // HTTP headers
  bodyConfigs: Record<string, ParameterValue>; // Request body parameters
  metadata?: {
    author: string; // Template author
    version: string; // Template version
    createdAt: Date; // Creation timestamp
    updatedAt: Date; // Last update timestamp
    usageCount: number; // Application count
    lastUsed?: Date; // Last application time
  };
}
```

### Pre-Built Templates

#### OpenAI Templates

**OpenAI Default**

```json
{
  "id": "openai-default",
  "name": "OpenAI Default",
  "description": "Standard OpenAI configuration",
  "category": "official",
  "providerId": "openai",
  "headerConfigs": {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
  },
  "bodyConfigs": {
    "temperature": 0.7,
    "max_tokens": 1000,
    "top_p": 1.0,
    "frequency_penalty": 0,
    "presence_penalty": 0
  }
}
```

**OpenAI Creative**

```json
{
  "id": "openai-creative",
  "name": "OpenAI Creative",
  "description": "High creativity settings for creative writing",
  "category": "official",
  "providerId": "openai",
  "bodyConfigs": {
    "temperature": 1.2,
    "max_tokens": 2000,
    "top_p": 0.9,
    "frequency_penalty": 0.3,
    "presence_penalty": 0.3
  }
}
```

#### Claude Templates

**Claude Standard**

```json
{
  "id": "claude-default",
  "name": "Claude Standard",
  "description": "Anthropic Claude standard configuration",
  "category": "official",
  "providerId": "claude",
  "headerConfigs": {
    "x-api-key": "YOUR_API_KEY",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  "bodyConfigs": {
    "max_tokens": 1000,
    "temperature": 0.7,
    "top_p": 0.9
  }
}
```

#### Doubao Templates

**Doubao (No Thinking)**

```json
{
  "id": "doubao-no-thinking",
  "name": "Doubao (Thinking Disabled)",
  "description": "Doubao with thinking mode disabled",
  "category": "official",
  "providerId": "doubao",
  "bodyConfigs": {
    "enable_thinking": false,
    "temperature": 0.8,
    "max_tokens": 2000,
    "thinking": {
      "type": "disabled",
      "mode": "silent"
    }
  }
}
```

## Template Categories

### Official Templates

- Pre-built by provider companies
- Verified configurations
- Cannot be edited or deleted
- Regular updates with new versions

### Community Templates

- Shared by community members
- Peer-reviewed configurations
- Can be imported and modified
- Voting and rating system

### Custom Templates

- User-created templates
- Full edit and delete permissions
- Private by default
- Can be shared or exported

### Favorites

- User-starred templates
- Quick access collection
- Cross-category favorites
- Personal organization

## Template Operations

### Creating Templates

#### From Current Configuration

```tsx
const createFromCurrent = async (currentConfig: CustomParameterConfig) => {
  const template = await createTemplate({
    name: 'My Custom Template',
    description: 'Created from current settings',
    category: 'custom',
    tags: ['custom', 'optimized'],
    isPublic: false,
    isFavorite: false,
    headerConfigs: currentConfig.headerConfigs,
    bodyConfigs: currentConfig.bodyConfigs,
  });

  return template;
};
```

#### Manual Creation

```tsx
const createManual = async () => {
  const template = await createTemplate({
    name: 'High Performance',
    description: 'Optimized for fast responses',
    category: 'custom',
    tags: ['performance', 'speed'],
    isPublic: false,
    isFavorite: false,
    headerConfigs: {
      Authorization: 'Bearer token',
    },
    bodyConfigs: {
      temperature: 0.3,
      max_tokens: 500,
      top_p: 0.8,
    },
  });

  return template;
};
```

### Template Application

#### Basic Application

```tsx
const applyBasic = async (templateId: string) => {
  const config = await applyTemplate(templateId);

  // Apply to your parameter system
  setCurrentConfig(config);
};
```

#### Application with Validation

```tsx
const applyWithValidation = async (templateId: string) => {
  const template = getTemplate(templateId);
  if (!template) throw new Error('Template not found');

  const { isValid, errors } = await validateTemplate(template);
  if (!isValid) {
    console.error('Template validation failed:', errors);
    return;
  }

  const config = await applyTemplate(templateId);
  setCurrentConfig(config);
};
```

### Template Modification

#### Update Template

```tsx
const updateTemplate = async (templateId: string) => {
  await updateTemplate(templateId, {
    name: 'Updated Name',
    description: 'Updated description',
    tags: [...existingTags, 'new-tag'],
    bodyConfigs: {
      ...existingBodyConfigs,
      new_parameter: 'new_value',
    },
  });
};
```

#### Duplicate and Modify

```tsx
const duplicateAndModify = async (templateId: string) => {
  const duplicated = await duplicateTemplate(templateId, 'Modified Version');

  await updateTemplate(duplicated.id, {
    description: 'Modified version with custom settings',
    bodyConfigs: {
      ...duplicated.bodyConfigs,
      temperature: 0.9,
    },
  });

  return duplicated;
};
```

## Storage and Persistence

### Storage Architecture

The template system uses a multi-layer storage approach:

1. **Memory Layer**: Active templates in component state
2. **Local Storage**: Browser localStorage for web environments
3. **IPC Storage**: Electron main process for desktop apps
4. **File System**: JSON files for backup and sharing

### Storage Configuration

```tsx
const { templates, loadTemplates, saveTemplates, clearTemplates } =
  useParameterTemplates({
    storageKey: 'custom_templates_key',
    enableAutoSave: true,
  });

// Manual storage operations
await saveTemplates(); // Save current state
await loadTemplates(); // Reload from storage
await clearTemplates(); // Clear all templates
```

### Data Migration

```tsx
// Migrate from old storage format
const migrateTemplates = async () => {
  const oldTemplates = localStorage.getItem('old_templates_key');
  if (oldTemplates) {
    const parsed = JSON.parse(oldTemplates);
    const migrated = parsed.map(convertOldTemplate);
    await importTemplates(JSON.stringify(migrated));
  }
};
```

## Integration with Parameter Editor

### Bidirectional Integration

The template system integrates seamlessly with the parameter editor:

```tsx
const IntegratedParameterManagement = () => {
  const [currentConfig, setCurrentConfig] = useState<CustomParameterConfig>({});
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);

  // Template applied to editor
  const handleTemplateApply = async (template: ParameterTemplate) => {
    const config = await applyTemplate(template.id);
    setCurrentConfig(config);
    setActiveTemplate(template.id);
  };

  // Editor changes create new template
  const handleCreateFromEditor = async () => {
    const template = await createTemplate({
      name: 'From Editor',
      description: 'Created from current editor state',
      category: 'custom',
      tags: ['editor-created'],
      headerConfigs: currentConfig.headerConfigs || {},
      bodyConfigs: currentConfig.bodyConfigs || {},
    });

    setActiveTemplate(template.id);
  };

  return (
    <div>
      <ParameterTemplateManager
        currentConfig={currentConfig}
        onTemplateApply={handleTemplateApply}
      />

      <CustomParameterEditor
        initialConfig={currentConfig}
        onConfigChange={setCurrentConfig}
      />
    </div>
  );
};
```

### Real-time Synchronization

```tsx
// Sync template changes with editor
useEffect(() => {
  if (activeTemplate) {
    const template = getTemplate(activeTemplate);
    if (template) {
      setCurrentConfig({
        headerConfigs: template.headerConfigs,
        bodyConfigs: template.bodyConfigs,
      });
    }
  }
}, [activeTemplate, templates]);

// Detect editor changes and suggest template creation
useEffect(() => {
  const hasChanges =
    JSON.stringify(currentConfig) !== JSON.stringify(originalConfig);
  if (hasChanges) {
    setSuggestTemplateCreation(true);
  }
}, [currentConfig, originalConfig]);
```

## Advanced Features

### Template Validation

```tsx
const validateTemplate = async (template: ParameterTemplate) => {
  const errors: string[] = [];

  // Required fields
  if (!template.name) errors.push('Name is required');
  if (!template.description) errors.push('Description is required');

  // Configuration validation
  if (!template.headerConfigs && !template.bodyConfigs) {
    errors.push('At least one configuration type required');
  }

  // JSON validation
  try {
    JSON.stringify(template.headerConfigs);
    JSON.stringify(template.bodyConfigs);
  } catch {
    errors.push('Invalid JSON in configurations');
  }

  // Provider compatibility
  if (template.providerId) {
    const isCompatible = await checkProviderCompatibility(
      template.providerId,
      template.bodyConfigs,
    );
    if (!isCompatible) {
      errors.push('Incompatible with specified provider');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};
```

### Template Versioning

```tsx
const versionTemplate = async (templateId: string) => {
  const template = getTemplate(templateId);
  if (!template) return;

  const newVersion = await createTemplate({
    ...template,
    name: `${template.name} v2.0`,
    metadata: {
      ...template.metadata,
      version: '2.0.0',
      parentId: templateId,
    },
  });

  return newVersion;
};
```

### Template Sharing

```tsx
const shareTemplate = async (templateId: string) => {
  const template = getTemplate(templateId);
  if (!template) return;

  // Create shareable link
  const shareableTemplate = {
    ...template,
    id: undefined, // Remove ID for import
    metadata: {
      ...template.metadata,
      sharedAt: new Date(),
      sharedBy: 'current-user',
    },
  };

  const shareUrl = await createShareUrl(shareableTemplate);
  return shareUrl;
};
```

### Bulk Operations

```tsx
const bulkOperations = {
  // Export multiple templates
  exportSelected: async (templateIds: string[]) => {
    const templates = templateIds.map((id) => getTemplate(id)).filter(Boolean);
    return JSON.stringify(templates, null, 2);
  },

  // Import multiple templates
  importBatch: async (templatesJson: string) => {
    const templates = JSON.parse(templatesJson);
    const results = [];

    for (const template of templates) {
      try {
        const imported = await importTemplate(JSON.stringify(template));
        results.push({ success: true, template: imported });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }

    return results;
  },

  // Delete multiple templates
  deleteMultiple: async (templateIds: string[]) => {
    const results = [];

    for (const id of templateIds) {
      try {
        await deleteTemplate(id);
        results.push({ success: true, id });
      } catch (error) {
        results.push({ success: false, id, error: error.message });
      }
    }

    return results;
  },
};
```

## Performance Optimization

### Template Caching

```tsx
// Implement template caching
const templateCache = new Map<string, ParameterTemplate>();

const getCachedTemplate = (templateId: string) => {
  if (templateCache.has(templateId)) {
    return templateCache.get(templateId);
  }

  const template = getTemplate(templateId);
  if (template) {
    templateCache.set(templateId, template);
  }

  return template;
};
```

### Lazy Loading

```tsx
// Implement lazy loading for large template sets
const useLazyTemplates = (pageSize: number = 20) => {
  const [loadedTemplates, setLoadedTemplates] = useState<ParameterTemplate[]>(
    [],
  );
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const loadMore = useCallback(async () => {
    const start = page * pageSize;
    const end = start + pageSize;
    const nextTemplates = templates.slice(start, end);

    if (nextTemplates.length === 0) {
      setHasMore(false);
      return;
    }

    setLoadedTemplates((prev) => [...prev, ...nextTemplates]);
    setPage((prev) => prev + 1);
  }, [page, pageSize, templates]);

  return { loadedTemplates, loadMore, hasMore };
};
```

### Search Optimization

```tsx
// Implement optimized search with indexing
const useTemplateSearch = () => {
  const [searchIndex, setSearchIndex] = useState<Map<string, string[]>>();

  // Build search index
  useEffect(() => {
    const index = new Map<string, string[]>();

    templates.forEach((template) => {
      const searchableText = [
        template.name,
        template.description,
        ...template.tags,
        template.category,
      ]
        .join(' ')
        .toLowerCase();

      const words = searchableText.split(/\s+/);
      words.forEach((word) => {
        if (!index.has(word)) {
          index.set(word, []);
        }
        index.get(word)!.push(template.id);
      });
    });

    setSearchIndex(index);
  }, [templates]);

  const search = useCallback(
    (query: string) => {
      if (!searchIndex || !query.trim()) return templates;

      const queryWords = query.toLowerCase().split(/\s+/);
      const matchingIds = new Set<string>();

      queryWords.forEach((word) => {
        const ids = searchIndex.get(word) || [];
        ids.forEach((id) => matchingIds.add(id));
      });

      return templates.filter((template) => matchingIds.has(template.id));
    },
    [searchIndex, templates],
  );

  return { search };
};
```

## Testing

### Component Testing

```tsx
// Test template application
test('applies template correctly', async () => {
  const mockOnApply = jest.fn();

  render(<ParameterTemplateManager onTemplateApply={mockOnApply} />);

  const applyButton = screen.getByText('Apply');
  fireEvent.click(applyButton);

  expect(mockOnApply).toHaveBeenCalledWith(
    expect.objectContaining({
      headerConfigs: expect.any(Object),
      bodyConfigs: expect.any(Object),
    }),
  );
});
```

### Hook Testing

```tsx
// Test template hook operations
test('creates template successfully', async () => {
  const { result } = renderHook(() => useParameterTemplates());

  const template = await result.current.createTemplate({
    name: 'Test Template',
    description: 'Test description',
    category: 'custom',
    tags: ['test'],
    headerConfigs: {},
    bodyConfigs: {},
  });

  expect(template.id).toBeDefined();
  expect(template.name).toBe('Test Template');
});
```

### Integration Testing

```tsx
// Test template-editor integration
test('integrates with parameter editor', async () => {
  const TestIntegration = () => {
    const [config, setConfig] = useState<CustomParameterConfig>({});
    const { applyTemplate } = useParameterTemplates();

    const handleApply = async (template: ParameterTemplate) => {
      const newConfig = await applyTemplate(template.id);
      setConfig(newConfig);
    };

    return (
      <div>
        <ParameterTemplateManager onTemplateApply={handleApply} />
        <CustomParameterEditor initialConfig={config} />
      </div>
    );
  };

  render(<TestIntegration />);

  // Test template application affects editor
  const applyButton = screen.getByText('Apply');
  fireEvent.click(applyButton);

  await waitFor(() => {
    expect(screen.getByDisplayValue('0.7')).toBeInTheDocument(); // temperature
  });
});
```

## Migration Guide

### From Legacy Parameter System

```tsx
// Migrate existing parameter configurations
const migrateLegacyConfig = (legacyConfig: any) => {
  const template: ParameterTemplate = {
    id: `migrated-${Date.now()}`,
    name: legacyConfig.name || 'Migrated Configuration',
    description: 'Migrated from legacy system',
    category: 'custom',
    tags: ['migrated', 'legacy'],
    isPublic: false,
    isFavorite: false,
    headerConfigs: extractHeaders(legacyConfig),
    bodyConfigs: extractBodyParams(legacyConfig),
    metadata: {
      author: 'Migration Script',
      version: '1.0.0',
      createdAt: new Date(),
      updatedAt: new Date(),
      usageCount: 0,
    },
  };

  return template;
};
```

### Version Compatibility

```tsx
// Handle template format versions
const upgradeTemplate = (
  template: any,
  fromVersion: string,
): ParameterTemplate => {
  switch (fromVersion) {
    case '1.0':
      return upgradeFromV1(template);
    case '1.1':
      return upgradeFromV1_1(template);
    default:
      return template;
  }
};
```

## Best Practices

### Template Design

1. **Clear Naming**: Use descriptive names that indicate purpose
2. **Comprehensive Descriptions**: Explain when and why to use the template
3. **Appropriate Tags**: Use relevant, searchable tags
4. **Version Control**: Track template versions and changes
5. **Documentation**: Include usage examples and expected outcomes

### Performance

1. **Lazy Loading**: Load templates on demand for large sets
2. **Caching**: Cache frequently used templates
3. **Indexing**: Build search indexes for fast filtering
4. **Debouncing**: Debounce search and filter operations
5. **Pagination**: Paginate large template lists

### User Experience

1. **Quick Access**: Provide shortcuts to popular templates
2. **Smart Defaults**: Use intelligent defaults for template creation
3. **Visual Feedback**: Show loading states and operation results
4. **Error Handling**: Provide clear error messages and recovery options
5. **Keyboard Navigation**: Support keyboard shortcuts and navigation

### Security

1. **Input Validation**: Validate all template data on creation/import
2. **Sanitization**: Sanitize template content to prevent XSS
3. **Access Control**: Implement proper permissions for template operations
4. **Audit Trail**: Log template operations for security monitoring
5. **Safe Defaults**: Use secure defaults for sensitive parameters

## Conclusion

The Parameter Template System provides a comprehensive, scalable solution for managing AI provider configurations. With its rich feature set, seamless integration capabilities, and robust architecture, it enables users to efficiently manage complex parameter sets while maintaining flexibility and ease of use.

The system's modular design allows for easy extension and customization, making it suitable for various deployment scenarios from simple web applications to complex enterprise environments.
