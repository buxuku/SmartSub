import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ParameterManagementHub } from './ParameterManagementHub';
import { Settings2, Zap, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const ParameterManagementHubDemo: React.FC = () => {
  const demoProviders = [
    { id: 'openai-custom', name: 'Custom OpenAI', type: 'OpenAI Compatible' },
    { id: 'azure-openai', name: 'Azure OpenAI', type: 'Azure' },
    { id: 'anthropic-custom', name: 'Anthropic Claude', type: 'Anthropic' },
  ];

  const [selectedProvider, setSelectedProvider] = React.useState(
    demoProviders[0].id,
  );

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Demo Header */}
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">
          Parameter Management Hub Demo
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
          Comprehensive parameter management system for AI service providers.
          Configure custom headers, body parameters, templates, and preview
          configurations.
        </p>
      </div>

      {/* Feature Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="text-center">
            <Settings2 className="h-12 w-12 mx-auto text-primary" />
            <CardTitle>Parameter Editor</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              Configure custom headers and body parameters with real-time
              validation
            </p>
            <Badge variant="secondary">Type-safe</Badge>
            <Badge variant="secondary">Real-time validation</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-center">
            <Zap className="h-12 w-12 mx-auto text-primary" />
            <CardTitle>Template System</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              Save and reuse parameter configurations with template management
            </p>
            <Badge variant="secondary">Reusable</Badge>
            <Badge variant="secondary">Export/Import</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-center">
            <Info className="h-12 w-12 mx-auto text-primary" />
            <CardTitle>Live Preview</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              Preview how parameters will be applied to actual API requests
            </p>
            <Badge variant="secondary">Live preview</Badge>
            <Badge variant="secondary">Request simulation</Badge>
          </CardContent>
        </Card>
      </div>

      {/* Provider Selection */}
      <Card>
        <CardHeader>
          <CardTitle>Select Demo Provider</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {demoProviders.map((provider) => (
              <Button
                key={provider.id}
                variant={
                  selectedProvider === provider.id ? 'default' : 'outline'
                }
                onClick={() => setSelectedProvider(provider.id)}
                className="flex items-center gap-2"
              >
                <Settings2 className="h-4 w-4" />
                {provider.name}
                <Badge variant="secondary" className="text-xs">
                  {provider.type}
                </Badge>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Demo Alert */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          This is a demonstration of the Parameter Management Hub. In a real
          application, this would be integrated with your provider configuration
          system and would persist settings for actual API service providers.
        </AlertDescription>
      </Alert>

      {/* Main Demo Component */}
      <ParameterManagementHub
        providerId={selectedProvider}
        className="border rounded-lg p-6 bg-background"
      />

      {/* Demo Footer */}
      <div className="text-center space-y-4 pt-8 border-t">
        <h3 className="text-lg font-semibold">Implementation Features</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <div className="space-y-1">
            <p className="font-medium">Type Safety</p>
            <p className="text-muted-foreground">Full TypeScript support</p>
          </div>
          <div className="space-y-1">
            <p className="font-medium">Real-time Validation</p>
            <p className="text-muted-foreground">Instant feedback on input</p>
          </div>
          <div className="space-y-1">
            <p className="font-medium">Auto-save</p>
            <p className="text-muted-foreground">
              Automatic configuration persistence
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-medium">Template System</p>
            <p className="text-muted-foreground">Reusable configurations</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ParameterManagementHubDemo;
