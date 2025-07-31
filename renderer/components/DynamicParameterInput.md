# DynamicParameterInput Component

The `DynamicParameterInput` component provides a flexible input interface for different parameter types with real-time validation and error display.

## Features

- **Multi-type Support**: Handles string, number, boolean, object, and array parameter types
- **Real-time Validation**: Provides immediate feedback on input validation
- **JSON Editor**: Built-in JSON editing for object and array types with syntax highlighting
- **Array Management**: Dynamic add/remove functionality for array items
- **Error Display**: Clear error messages with suggestions for resolution
- **Accessibility**: Full keyboard navigation and screen reader support
- **Customizable**: Flexible styling and configuration options

## Usage

```tsx
import { DynamicParameterInput } from '@/components/DynamicParameterInput';
import { ParameterDefinition, ValidationError } from '../../types/provider';

const MyComponent = () => {
  const [value, setValue] = useState<ParameterValue>('');
  const [errors, setErrors] = useState<ValidationError[]>([]);

  const definition: ParameterDefinition = {
    key: 'myParam',
    type: 'string',
    category: 'core',
    required: true,
    description: 'A sample parameter',
    providerSupport: ['openai'],
  };

  const handleChange = (key: string, newValue: ParameterValue) => {
    setValue(newValue);
  };

  return (
    <DynamicParameterInput
      parameterKey="myParam"
      value={value}
      definition={definition}
      errors={errors}
      onChange={handleChange}
    />
  );
};
```

## Props

### Required Props

| Prop           | Type                                           | Description                         |
| -------------- | ---------------------------------------------- | ----------------------------------- |
| `parameterKey` | `string`                                       | Unique identifier for the parameter |
| `value`        | `ParameterValue`                               | Current parameter value             |
| `onChange`     | `(key: string, value: ParameterValue) => void` | Callback when value changes         |

### Optional Props

| Prop          | Type                    | Default     | Description                                   |
| ------------- | ----------------------- | ----------- | --------------------------------------------- |
| `definition`  | `ParameterDefinition`   | `undefined` | Parameter definition with type and validation |
| `errors`      | `ValidationError[]`     | `[]`        | Array of validation errors                    |
| `disabled`    | `boolean`               | `false`     | Whether the input is disabled                 |
| `placeholder` | `string`                | `undefined` | Placeholder text                              |
| `onRemove`    | `(key: string) => void` | `undefined` | Callback for parameter removal                |
| `showRemove`  | `boolean`               | `false`     | Whether to show remove button                 |
| `className`   | `string`                | `undefined` | Additional CSS classes                        |

## Parameter Types

### String Parameters

- Rendered as text input
- Supports placeholder text
- Basic string validation

```tsx
const stringDefinition: ParameterDefinition = {
  key: 'textParam',
  type: 'string',
  category: 'core',
  required: true,
  description: 'Enter text here',
};
```

### Number Parameters

- Rendered as number input with spinners
- Supports min/max validation
- Automatic numeric parsing

```tsx
const numberDefinition: ParameterDefinition = {
  key: 'numParam',
  type: 'number',
  category: 'performance',
  validation: { min: 0, max: 100 },
  description: 'Enter a number between 0 and 100',
};
```

### Boolean Parameters

- Rendered as toggle switch
- Shows "Enabled"/"Disabled" labels
- Accessible keyboard navigation

```tsx
const boolDefinition: ParameterDefinition = {
  key: 'toggleParam',
  type: 'boolean',
  category: 'behavior',
  description: 'Toggle this feature on/off',
};
```

### Array Parameters

- Dynamic item management
- Add/remove individual items
- Fallback to JSON editor for complex arrays
- Visual item list with controls

```tsx
const arrayDefinition: ParameterDefinition = {
  key: 'listParam',
  type: 'array',
  category: 'core',
  description: 'Manage list items',
};
```

### Object Parameters

- JSON editor with syntax highlighting
- Real-time JSON validation
- Formatted display with proper indentation
- Error handling for invalid JSON

```tsx
const objectDefinition: ParameterDefinition = {
  key: 'configParam',
  type: 'object',
  category: 'core',
  description: 'JSON configuration object',
};
```

## Validation

The component supports various validation types:

- **Type Validation**: Ensures value matches expected type
- **Range Validation**: For numeric parameters with min/max
- **Format Validation**: JSON syntax validation for objects/arrays
- **Dependency Validation**: Cross-parameter validation rules
- **System Validation**: Application-level validation errors

### Error Display

Validation errors are displayed with:

- Clear error messages
- Helpful suggestions for resolution
- Visual indicators (icons and colors)
- Accessibility support for screen readers

## Accessibility

The component follows WCAG 2.1 AA guidelines:

- **Keyboard Navigation**: Full keyboard support for all interactions
- **Screen Reader Support**: Proper ARIA labels and descriptions
- **Focus Management**: Clear focus indicators and logical tab order
- **Error Announcements**: Screen reader announcements for validation errors
- **Semantic HTML**: Proper form controls and labels

## Styling

The component uses Tailwind CSS classes and follows the design system:

- **Consistent Spacing**: Uses standard spacing tokens
- **Color Scheme**: Follows light/dark theme patterns
- **Typography**: Consistent font sizes and weights
- **Interactive States**: Hover, focus, and disabled states

### Customization

You can customize the appearance using the `className` prop or by overriding the default styles:

```tsx
<DynamicParameterInput
  className="my-custom-parameter"
  // ... other props
/>
```

## Integration with Parameter System

The component integrates seamlessly with the parameter management system:

- Uses the `useParameterConfig` hook for state management
- Follows the parameter processing pipeline
- Supports template application and validation
- Works with export/import functionality

## Testing

The component includes comprehensive tests covering:

- **Unit Tests**: All parameter types and interactions
- **Validation Tests**: Error handling and edge cases
- **Accessibility Tests**: Keyboard navigation and screen reader support
- **Integration Tests**: Works with the parameter management system

Run tests with:

```bash
npm test DynamicParameterInput.test.tsx
```

## Performance

The component is optimized for performance:

- **Memoized Callbacks**: Prevents unnecessary re-renders
- **Debounced Validation**: Reduces validation calls during typing
- **Lazy Loading**: JSON parsing only when needed
- **Minimal Re-renders**: Efficient state updates

## Browser Support

Supports all modern browsers:

- Chrome 88+
- Firefox 85+
- Safari 14+
- Edge 88+

## Examples

See `DynamicParameterInputDemo.tsx` for a complete working example with all parameter types and validation scenarios.
