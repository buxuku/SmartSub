# Parameter Preview System

The Parameter Preview System provides real-time preview capabilities for parameter configurations, showing how they will be applied in actual API requests with validation feedback, request simulation, and comprehensive debugging tools.

## Architecture Overview

```
ParameterPreviewSystem (Main Component)
    ↓
Request Generation Engine
    ↓
Validation System + Metrics Calculator
    ↓
Preview Renderer (Tabs: Preview, Headers, Body, cURL)
    ↓
Action Handlers (Copy, Download, Send)
```

### Core Components

1. **ParameterPreviewSystem**: Main UI component for request preview
2. **Request Generator**: Builds preview requests from configurations
3. **Validation Engine**: Validates parameters and provides feedback
4. **Preview Renderer**: Multi-tab interface for different view modes

## ParameterPreviewSystem Component

### Features

- **Real-time Preview**: Live updates as parameters change
- **Multi-format Display**: Preview, Headers, Body, and cURL views
- **Validation Feedback**: Real-time parameter validation with errors and warnings
- **Request Simulation**: Generate and send test requests
- **Metrics Calculation**: Estimate tokens, cost, and complexity
- **Copy/Download**: Export requests in various formats
- **Provider Support**: Multi-provider endpoint and model selection

### Usage

```tsx
import { ParameterPreviewSystem } from '@/components/parameter';

const MyAPITester = () => {
  const [config, setConfig] = useState<CustomParameterConfig>({
    headerConfigs: {
      Authorization: 'Bearer sk-proj-example...',
      'Content-Type': 'application/json',
    },
    bodyConfigs: {
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1.0,
    },
  });

  const handleSendRequest = (request: PreviewRequest) => {
    // Handle the API request
    console.log('Sending request:', request);
  };

  return (
    <ParameterPreviewSystem
      config={config}
      providerId="openai"
      model="gpt-4"
      onConfigChange={setConfig}
      onSendRequest={handleSendRequest}
    />
  );
};
```

### Props

| Prop             | Type                                      | Description                                   |
| ---------------- | ----------------------------------------- | --------------------------------------------- |
| `config`         | `CustomParameterConfig`                   | Current parameter configuration               |
| `providerId`     | `string`                                  | AI provider identifier (openai, claude, etc.) |
| `endpoint`       | `string`                                  | Custom API endpoint URL                       |
| `model`          | `string`                                  | Selected model name                           |
| `onConfigChange` | `(config: CustomParameterConfig) => void` | Config change callback                        |
| `onSendRequest`  | `(request: PreviewRequest) => void`       | Request send callback                         |
| `disabled`       | `boolean`                                 | Disable all interactions                      |
| `className`      | `string`                                  | Custom CSS classes                            |

## Preview Request Structure

### PreviewRequest Interface

```tsx
interface PreviewRequest {
  url: string; // API endpoint URL
  method: string; // HTTP method (POST)
  headers: Record<string, string>; // Request headers
  body: Record<string, any>; // Request body
  curlCommand: string; // Generated cURL command
  estimatedTokens?: number; // Token estimate
  estimatedCost?: number; // Cost estimate
}
```

### Request Generation

The system automatically generates complete API requests from parameter configurations:

```tsx
// Example generated request
{
  "url": "https://api.openai.com/v1/chat/completions",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
  },
  "body": {
    "model": "gpt-4",
    "temperature": 0.7,
    "max_tokens": 1000,
    "top_p": 1.0,
    "messages": [
      {
        "role": "user",
        "content": "This is a preview request to test your parameter configuration."
      }
    ]
  },
  "curlCommand": "curl -X POST \"https://api.openai.com/v1/chat/completions\" \\\n  -H \"Authorization: Bearer YOUR_API_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{...}'",
  "estimatedTokens": 125,
  "estimatedCost": 0.0025
}
```

## Validation System

### Validation Rules

The system performs comprehensive validation:

```tsx
interface ValidationResult {
  isValid: boolean;
  errors: string[]; // Blocking issues
  warnings: string[]; // Non-blocking concerns
}
```

#### Error Conditions

- Missing API endpoint
- Missing model selection
- Missing API key (Authorization or x-api-key header)
- Invalid JSON structure

#### Warning Conditions

- Temperature outside recommended range (0-2)
- Negative max_tokens value
- Large request size (>2000 chars)
- Too many parameters (>15)

### Real-time Validation

```tsx
const validateConfiguration = (): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required field validation
  if (!selectedEndpoint) {
    errors.push('API endpoint is required');
  }

  // Parameter validation
  if (body.temperature && (body.temperature < 0 || body.temperature > 2)) {
    warnings.push('Temperature should be between 0 and 2');
  }

  return { isValid: errors.length === 0, errors, warnings };
};
```

## Preview Modes

### 1. Request Preview Tab

Complete request overview with:

- HTTP method and endpoint
- Request structure display
- Validation status
- Action buttons (Copy, Download, Send)

### 2. Headers Tab

Focused view of request headers:

- Authentication headers
- Content-Type specifications
- Custom headers from configuration

### 3. Body Tab

Request body parameter display:

- Model and provider-specific parameters
- JSON-formatted with syntax highlighting
- Parameter value validation

### 4. cURL Tab

Ready-to-use cURL command:

- Complete command with headers and body
- Properly escaped for terminal usage
- Copy-to-clipboard functionality

## Metrics System

### Calculated Metrics

```tsx
interface PreviewMetrics {
  headerCount: number; // Number of headers
  bodyParamCount: number; // Number of body parameters
  estimatedSize: number; // Request size in bytes
  complexity: 'low' | 'medium' | 'high'; // Complexity level
}
```

### Complexity Calculation

```tsx
const calculateComplexity = (bodyParamCount: number, estimatedSize: number) => {
  if (bodyParamCount > 10 || estimatedSize > 1000) return 'high';
  if (bodyParamCount > 5 || estimatedSize > 500) return 'medium';
  return 'low';
};
```

### Cost Estimation

```tsx
// Simplified token and cost estimation
const estimatedTokens = Math.ceil(JSON.stringify(body).length / 4);
const estimatedCost = estimatedTokens * 0.00002; // Rough GPT-4 pricing
```

## Provider Configuration

### Supported Providers

```tsx
const PROVIDER_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  qwen: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
  custom: '',
};

const PROVIDER_MODELS = {
  openai: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  claude: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
  doubao: ['doubao-pro-4k', 'doubao-pro-32k', 'doubao-lite-4k'],
  qwen: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
};
```

### Provider-Specific Headers

```tsx
// OpenAI
{
  'Authorization': 'Bearer YOUR_API_KEY',
  'Content-Type': 'application/json'
}

// Claude
{
  'x-api-key': 'YOUR_API_KEY',
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json'
}
```

## Action Handlers

### Copy to Clipboard

```tsx
const copyToClipboard = async (content: string, type: string) => {
  try {
    await navigator.clipboard.writeText(content);
    showSuccessMessage(`${type} copied to clipboard`);
  } catch (err) {
    showErrorMessage('Failed to copy to clipboard');
  }
};

// Usage examples
copyToClipboard(JSON.stringify(previewRequest, null, 2), 'request');
copyToClipboard(previewRequest.curlCommand, 'curl');
```

### Download as File

```tsx
const downloadAsFile = (content: string, filename: string) => {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// Usage
downloadAsFile(JSON.stringify(previewRequest, null, 2), 'api-request.json');
```

### Send Request

```tsx
const handleSendRequest = () => {
  if (onSendRequest && validationResults.isValid) {
    onSendRequest(previewRequest);
  }
};
```

## Integration Patterns

### With Parameter Editor

```tsx
const IntegratedParameterSystem = () => {
  const [config, setConfig] = useState<CustomParameterConfig>({});

  return (
    <div className="grid grid-cols-2 gap-6">
      <CustomParameterEditor
        initialConfig={config}
        onConfigChange={setConfig}
      />
      <ParameterPreviewSystem config={config} onConfigChange={setConfig} />
    </div>
  );
};
```

### With Template System

```tsx
const TemplateIntegratedPreview = () => {
  const [config, setConfig] = useState<CustomParameterConfig>({});

  const handleTemplateApply = (template: ParameterTemplate) => {
    setConfig({
      headerConfigs: template.headerConfigs,
      bodyConfigs: template.bodyConfigs,
    });
  };

  return (
    <div>
      <ParameterTemplateManager onTemplateApply={handleTemplateApply} />
      <ParameterPreviewSystem config={config} />
    </div>
  );
};
```

## Advanced Features

### Request Simulation

```tsx
const simulateAPIRequest = async (request: PreviewRequest) => {
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });

    return await response.json();
  } catch (error) {
    console.error('Request failed:', error);
    throw error;
  }
};
```

### Custom Validation Rules

```tsx
const customValidationRules = {
  temperature: (value: number) => {
    if (value < 0 || value > 2) {
      return 'Temperature must be between 0 and 2';
    }
    return null;
  },

  max_tokens: (value: number) => {
    if (value < 1 || value > 32000) {
      return 'Max tokens must be between 1 and 32000';
    }
    return null;
  },
};
```

### Preview History

```tsx
interface PreviewHistory {
  requests: Array<{
    request: PreviewRequest;
    timestamp: Date;
    provider: string;
    model: string;
  }>;
}

const usePreviewHistory = () => {
  const [history, setHistory] = useState<PreviewHistory>({ requests: [] });

  const addRequest = (
    request: PreviewRequest,
    provider: string,
    model: string,
  ) => {
    setHistory((prev) => ({
      requests: [
        { request, timestamp: new Date(), provider, model },
        ...prev.requests.slice(0, 99), // Keep last 100
      ],
    }));
  };

  return { history, addRequest };
};
```

## Testing

### Component Testing

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ParameterPreviewSystem } from './ParameterPreviewSystem';

test('renders preview system with basic configuration', () => {
  const config = {
    headerConfigs: { Authorization: 'Bearer test' },
    bodyConfigs: { temperature: 0.7 },
  };

  render(<ParameterPreviewSystem config={config} />);

  expect(screen.getByText('Parameter Preview System')).toBeInTheDocument();
  expect(screen.getByText('Valid')).toBeInTheDocument();
});

test('validates configuration correctly', () => {
  const invalidConfig = {
    headerConfigs: {},
    bodyConfigs: { temperature: 3.0 },
  };

  render(<ParameterPreviewSystem config={invalidConfig} />);

  expect(screen.getByText('Invalid')).toBeInTheDocument();
  expect(screen.getByText('API key is required')).toBeInTheDocument();
});
```

### Integration Testing

```tsx
test('integrates with parameter editor', () => {
  const TestIntegration = () => {
    const [config, setConfig] = useState({});

    return (
      <div>
        <CustomParameterEditor onConfigChange={setConfig} />
        <ParameterPreviewSystem config={config} />
      </div>
    );
  };

  render(<TestIntegration />);

  // Test that changes in editor reflect in preview
  // ... test implementation
});
```

## Performance Optimization

### Memoization

```tsx
const previewRequest = useMemo((): PreviewRequest => {
  // Expensive request generation
  return generatePreviewRequest(config, selectedModel, selectedEndpoint);
}, [config, selectedModel, selectedEndpoint]);

const validationResults = useMemo(() => {
  return validateConfiguration(config, selectedEndpoint, selectedModel);
}, [config, selectedEndpoint, selectedModel]);
```

### Debounced Updates

```tsx
const debouncedConfigChange = useMemo(
  () =>
    debounce((config: CustomParameterConfig) => {
      onConfigChange?.(config);
    }, 500),
  [onConfigChange],
);
```

## Error Handling

### Graceful Degradation

```tsx
const handleCopyError = (error: Error) => {
  console.error('Copy failed:', error);
  // Fall back to manual selection
  showFallbackCopyMessage();
};

const handleRequestError = (error: Error) => {
  console.error('Request failed:', error);
  setLastResponse({
    error: true,
    message: error.message,
    timestamp: new Date(),
  });
};
```

## Best Practices

### Configuration Management

1. **Validation First**: Always validate before allowing request sending
2. **Real-time Feedback**: Provide immediate validation feedback
3. **Clear Error Messages**: Use descriptive, actionable error messages
4. **Progressive Enhancement**: Work with basic features, enhance with advanced ones

### User Experience

1. **Visual Feedback**: Show loading states and operation results
2. **Keyboard Navigation**: Support keyboard shortcuts for common actions
3. **Accessibility**: Ensure screen reader compatibility
4. **Mobile Responsive**: Adapt to different screen sizes

### Performance

1. **Lazy Computation**: Calculate expensive operations only when needed
2. **Memoization**: Cache computed values to avoid recalculation
3. **Debouncing**: Debounce rapid changes to prevent excessive updates
4. **Efficient Rendering**: Use React.memo and useMemo appropriately

## Security Considerations

### API Key Protection

- Never log or expose API keys in preview displays
- Mask sensitive headers in copy operations
- Validate input to prevent injection attacks

### Safe Defaults

- Use secure default configurations
- Validate all user inputs
- Sanitize display content to prevent XSS

## Conclusion

The Parameter Preview System provides a comprehensive, real-time preview capability for API request configurations. With its robust validation, multi-format display, and seamless integration capabilities, it enables users to confidently configure and test API parameters before making actual requests.

The system's modular architecture allows for easy extension and customization, making it suitable for various AI provider integrations and deployment scenarios.
