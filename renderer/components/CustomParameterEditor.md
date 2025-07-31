# CustomParameterEditor Component

The `CustomParameterEditor` component provides a comprehensive interface for managing custom parameters in AI providers, with separation between header and body parameters and full CRUD functionality.

## Features

- **Parameter Organization**: Separate tabs for HTTP headers and request body parameters
- **Full CRUD Operations**: Add, edit, delete, and duplicate parameters
- **Template System**: Apply pre-built parameter templates for popular providers
- **Import/Export**: Save and restore parameter configurations
- **Real-time Search**: Filter parameters by name or value
- **Type Safety**: Full TypeScript support with parameter validation
- **Accessibility**: WCAG 2.1 AA compliant interface
- **Responsive Design**: Works on all screen sizes

## Usage

```tsx
import { CustomParameterEditor } from '@/components/parameter';
import { CustomParameterConfig } from '../../types/provider';

const MyProviderSettings = () => {
  const [config, setConfig] = useState<CustomParameterConfig>({
    headerConfigs: {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    },
    bodyConfigs: {
      temperature: 0.7,
      max_tokens: 1000,
    },
  });

  const handleConfigChange = (newConfig: CustomParameterConfig) => {
    setConfig(newConfig);
  };

  const handleSave = () => {
    // Save configuration to provider
    console.log('Saving config:', config);
  };

  return (
    <CustomParameterEditor
      providerId="openai"
      initialConfig={config}
      onConfigChange={handleConfigChange}
      onSave={handleSave}
    />
  );
};
```

## Props

### Required Props

| Prop         | Type     | Description                           |
| ------------ | -------- | ------------------------------------- |
| `providerId` | `string` | Unique identifier for the AI provider |

### Optional Props

| Prop             | Type                                      | Default     | Description                         |
| ---------------- | ----------------------------------------- | ----------- | ----------------------------------- |
| `initialConfig`  | `CustomParameterConfig`                   | `undefined` | Initial parameter configuration     |
| `onConfigChange` | `(config: CustomParameterConfig) => void` | `undefined` | Callback when configuration changes |
| `onSave`         | `() => void`                              | `undefined` | Callback for save button click      |
| `disabled`       | `boolean`                                 | `false`     | Whether the editor is disabled      |
| `className`      | `string`                                  | `''`        | Additional CSS classes              |

## Interface Structure

### Header Section

- **Title and Description**: Clear interface identification
- **Template Selector**: Apply pre-built configurations
- **Action Buttons**: Export, Import, Refresh, Save
- **Search Bar**: Filter parameters by name or value
- **Add Parameter**: Create new custom parameters

### Parameter Tabs

#### Headers Tab

- **HTTP Headers**: Parameters sent in request headers
- **Common Use Cases**: Authorization, API versioning, content type
- **Examples**: `Authorization`, `anthropic-version`, `OpenAI-Organization`

#### Body Parameters Tab

- **Request Body**: Parameters included in API request body
- **Model Settings**: Temperature, max tokens, sampling parameters
- **Behavior Controls**: Thinking mode, streaming, stop sequences

### Parameter Management

Each parameter includes:

- **Dynamic Input**: Type-appropriate input component
- **Validation**: Real-time error checking and feedback
- **Actions**: Duplicate and remove options
- **Error Display**: Clear validation messages

## Parameter Types

### String Parameters

```tsx
// Example: API authorization header
{
  key: 'Authorization',
  type: 'string',
  category: 'header',
  value: 'Bearer sk-...'
}
```

### Number Parameters

```tsx
// Example: Temperature setting
{
  key: 'temperature',
  type: 'number',
  category: 'core',
  value: 0.7
}
```

### Boolean Parameters

```tsx
// Example: Thinking mode toggle
{
  key: 'enable_thinking',
  type: 'boolean',
  category: 'core',
  value: false
}
```

### Object Parameters

```tsx
// Example: Complex configuration object
{
  key: 'thinking_config',
  type: 'object',
  category: 'core',
  value: {
    type: 'disabled',
    mode: 'silent',
    depth: 1
  }
}
```

### Array Parameters

```tsx
// Example: Stop sequences
{
  key: 'stop_sequences',
  type: 'array',
  category: 'core',
  value: ['Human:', 'Assistant:', '\n\n']
}
```

## Template System

### Pre-built Templates

**OpenAI Default**

```typescript
{
  headerConfigs: {
    'Authorization': 'Bearer sk-proj-...',
    'OpenAI-Organization': 'org-...'
  },
  bodyConfigs: {
    'temperature': 0.7,
    'max_tokens': 1000,
    'top_p': 1.0
  }
}
```

**Claude Optimized**

```typescript
{
  headerConfigs: {
    'x-api-key': 'sk-ant-api03-...',
    'anthropic-version': '2023-06-01'
  },
  bodyConfigs: {
    'max_tokens': 1000,
    'temperature': 0.7,
    'top_p': 0.9
  }
}
```

**Doubao Configuration**

```typescript
{
  headerConfigs: {
    'Authorization': 'Bearer ...'
  },
  bodyConfigs: {
    'enable_thinking': false,
    'temperature': 0.8,
    'thinking': 'disabled'
  }
}
```

### Custom Templates

Users can save current configurations as custom templates:

1. Configure parameters as desired
2. Use "Export" to save configuration
3. Import saved configuration on other providers
4. Share templates with team members

## Import/Export

### Export Configuration

```typescript
const handleExport = async () => {
  const config = await exportConfig();
  // Downloads JSON file: providerId-parameters.json
};
```

### Import Configuration

```typescript
const handleImport = (file: File) => {
  const reader = new FileReader();
  reader.onload = async (e) => {
    const config = JSON.parse(e.target.result as string);
    await importConfig(config);
  };
  reader.readAsText(file);
};
```

## Validation

### Parameter Validation

- **Type Checking**: Ensures values match expected types
- **Range Validation**: Numeric parameters within valid ranges
- **Format Validation**: JSON syntax for object/array parameters
- **Required Fields**: Validates required parameters are present

### Error Display

```tsx
interface ValidationError {
  key: string;
  type: 'type' | 'range' | 'format' | 'dependency' | 'system';
  message: string;
  suggestion?: string;
}
```

## Accessibility

### Keyboard Navigation

- **Tab Order**: Logical tab sequence through interface
- **Keyboard Shortcuts**: Standard shortcuts for common actions
- **Focus Management**: Clear focus indicators and behavior

### Screen Reader Support

- **ARIA Labels**: Comprehensive labeling for all controls
- **Live Regions**: Announcements for dynamic content changes
- **Semantic Structure**: Proper heading hierarchy and landmarks

### Visual Design

- **Color Contrast**: WCAG AA compliant contrast ratios
- **Focus Indicators**: High-contrast focus outlines
- **Error States**: Clear visual and textual error indication

## Integration with Parameter System

### Hook Integration

```tsx
const {
  parameters,
  definitions,
  errors,
  updateParameter,
  removeParameter,
  addParameter,
} = useParameterConfig(providerId);
```

### API Integration

```typescript
// Headers are added to HTTP request
const headers = {
  'Content-Type': 'application/json',
  ...config.headerConfigs
};

// Body parameters merged with request
const body = {
  model: 'gpt-4',
  messages: [...],
  ...config.bodyConfigs
};
```

## Performance

### Optimization Features

- **Memoized Callbacks**: Prevents unnecessary re-renders
- **Debounced Search**: Reduces search input processing
- **Lazy Loading**: Efficient handling of large parameter sets
- **Virtual Rendering**: Handles hundreds of parameters efficiently

### Memory Management

- **Cleanup**: Proper event listener removal
- **Caching**: Intelligent caching of processed parameters
- **Batching**: Batched updates for better performance

## Styling

### Design System Integration

- **Shadcn/UI Components**: Consistent with application design
- **Tailwind CSS**: Utility-first styling approach
- **Dark Mode**: Full dark mode support
- **Responsive**: Mobile-first responsive design

### Customization

```tsx
<CustomParameterEditor
  className="custom-parameter-editor"
  // Custom styling through className
/>
```

## Testing

### Test Coverage

- **Unit Tests**: All component functions and user interactions
- **Integration Tests**: Parameter management workflow
- **Accessibility Tests**: Keyboard navigation and screen reader support
- **Performance Tests**: Large parameter set handling

### Test Utilities

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { CustomParameterEditor } from '../CustomParameterEditor';

test('adds new parameter', () => {
  render(<CustomParameterEditor providerId="test" />);

  fireEvent.click(screen.getByText('Add Parameter'));
  // ... test parameter addition
});
```

## Common Use Cases

### Provider Configuration

```tsx
// Configure OpenAI provider with organization
<CustomParameterEditor
  providerId="openai"
  initialConfig={{
    headerConfigs: {
      Authorization: 'Bearer sk-proj-...',
      'OpenAI-Organization': 'org-123',
    },
    bodyConfigs: {
      temperature: 0.7,
      max_tokens: 1000,
    },
  }}
/>
```

### Model-Specific Settings

```tsx
// Disable thinking for Doubao model
<CustomParameterEditor
  providerId="doubao"
  initialConfig={{
    bodyConfigs: {
      enable_thinking: false,
      thinking: 'disabled',
    },
  }}
/>
```

### Advanced Configuration

```tsx
// Complex parameter setup with validation
<CustomParameterEditor
  providerId="custom"
  onConfigChange={(config) => {
    // Validate configuration
    if (validateParameters(config)) {
      saveProviderConfig(config);
    }
  }}
  onSave={() => deployConfiguration()}
/>
```

## Browser Support

Supports all modern browsers:

- Chrome 88+
- Firefox 85+
- Safari 14+
- Edge 88+

## Examples

See `CustomParameterEditorDemo.tsx` for a complete working example with multiple providers and realistic configurations.

## Migration Guide

### From Hard-coded Parameters

```typescript
// Before: Hard-coded in service
const qwenParams = {
  enable_thinking: false,
  temperature: 0.7,
};

// After: User-configurable
const config = await getProviderConfig('qwen');
const params = config.bodyConfigs;
```

### From Legacy Configuration

```typescript
// Migration utility
const migrateProviderConfig = (legacyConfig) => {
  return {
    headerConfigs: extractHeaders(legacyConfig),
    bodyConfigs: extractBodyParams(legacyConfig),
  };
};
```
