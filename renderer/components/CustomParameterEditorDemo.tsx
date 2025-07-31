/**
 * CustomParameterEditor Demo Component
 *
 * Demonstrates the CustomParameterEditor component with realistic provider configurations.
 * This is for testing and development purposes.
 */

import React, { useState } from 'react';
import { CustomParameterEditor } from './CustomParameterEditor';
import { CustomParameterConfig } from '../../types/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const CustomParameterEditorDemo: React.FC = () => {
  const [selectedProvider, setSelectedProvider] = useState('openai');
  const [configurations, setConfigurations] = useState<
    Record<string, CustomParameterConfig>
  >({
    openai: {
      headerParameters: {
        Authorization: 'Bearer sk-proj-...',
        'OpenAI-Organization': 'org-...',
        'OpenAI-Project': 'proj_...',
      },
      bodyParameters: {
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 1.0,
        frequency_penalty: 0,
        presence_penalty: 0,
        stop: null,
      },
      configVersion: '1.0.0',
      lastModified: Date.now(),
    },
    claude: {
      headerParameters: {
        'x-api-key': 'sk-ant-api03-...',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      bodyParameters: {
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9,
        stop_sequences: [],
      },
      configVersion: '1.0.0',
      lastModified: Date.now(),
    },
    doubao: {
      headerParameters: {
        Authorization: 'Bearer ...',
        'Content-Type': 'application/json',
      },
      bodyParameters: {
        enable_thinking: false,
        temperature: 0.8,
        max_tokens: 2000,
        thinking: {
          type: 'disabled',
          mode: 'silent',
        },
      },
      configVersion: '1.0.0',
      lastModified: Date.now(),
    },
    qwen: {
      headerParameters: {
        Authorization: 'Bearer sk-...',
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'disable',
      },
      bodyParameters: {
        enable_thinking: false,
        temperature: 0.7,
        max_tokens: 1500,
        top_p: 0.8,
        repetition_penalty: 1.1,
        seed: 1234,
        stream: false,
      },
      configVersion: '1.0.0',
      lastModified: Date.now(),
    },
  });

  const [unsavedChanges, setUnsavedChanges] = useState<Record<string, boolean>>(
    {},
  );

  // Provider options for demo
  const providers = [
    {
      id: 'openai',
      name: 'OpenAI GPT',
      description: 'OpenAI GPT models with standard parameters',
    },
    {
      id: 'claude',
      name: 'Anthropic Claude',
      description: 'Claude models with Anthropic-specific headers',
    },
    {
      id: 'doubao',
      name: 'Doubao (ByteDance)',
      description: 'Doubao model with thinking mode disabled',
    },
    {
      id: 'qwen',
      name: 'Qwen (Alibaba)',
      description: 'Qwen models with DashScope API configuration',
    },
  ];

  const handleConfigChange = (
    providerId: string,
    config: CustomParameterConfig,
  ) => {
    setConfigurations((prev) => ({
      ...prev,
      [providerId]: config,
    }));

    setUnsavedChanges((prev) => ({
      ...prev,
      [providerId]: true,
    }));
  };

  const handleSave = (providerId: string) => {
    console.log(
      `Saving configuration for ${providerId}:`,
      configurations[providerId],
    );
    setUnsavedChanges((prev) => ({
      ...prev,
      [providerId]: false,
    }));
  };

  const resetConfiguration = (providerId: string) => {
    const defaultConfigs = {
      openai: {
        headerParameters: {
          Authorization: 'Bearer sk-proj-...',
          'OpenAI-Organization': 'org-...',
        },
        bodyParameters: {
          temperature: 0.7,
          max_tokens: 1000,
        },
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
      claude: {
        headerParameters: {
          'x-api-key': 'sk-ant-api03-...',
          'anthropic-version': '2023-06-01',
        },
        bodyParameters: {
          max_tokens: 1000,
          temperature: 0.7,
        },
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
      doubao: {
        headerParameters: {
          Authorization: 'Bearer ...',
        },
        bodyParameters: {
          enable_thinking: false,
          temperature: 0.8,
        },
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
      qwen: {
        headerParameters: {
          Authorization: 'Bearer sk-...',
        },
        bodyParameters: {
          enable_thinking: false,
          temperature: 0.7,
        },
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
    };

    setConfigurations((prev) => ({
      ...prev,
      [providerId]: defaultConfigs[
        providerId as keyof typeof defaultConfigs
      ] || {
        headerParameters: {},
        bodyParameters: {},
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
    }));

    setUnsavedChanges((prev) => ({
      ...prev,
      [providerId]: false,
    }));
  };

  const getConfigStats = (config: CustomParameterConfig) => {
    const headerCount = Object.keys(config.headerParameters || {}).length;
    const bodyCount = Object.keys(config.bodyParameters || {}).length;
    return { headerCount, bodyCount, total: headerCount + bodyCount };
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Custom Parameter Editor Demo</CardTitle>
          <p className="text-muted-foreground">
            Demonstrates the parameter management interface for different AI
            providers. Each provider showcases typical parameter configurations
            including headers and body parameters.
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Provider Selection */}
            <div className="flex items-center gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Select Provider:</label>
                <Select
                  value={selectedProvider}
                  onValueChange={setSelectedProvider}
                >
                  <SelectTrigger className="w-[300px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        <div className="flex items-center justify-between w-full">
                          <span>{provider.name}</span>
                          {unsavedChanges[provider.id] && (
                            <Badge variant="secondary" className="ml-2">
                              Unsaved
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2 ml-auto">
                <Button
                  variant="outline"
                  onClick={() => resetConfiguration(selectedProvider)}
                  size="sm"
                >
                  Reset to Default
                </Button>
              </div>
            </div>

            {/* Provider Info */}
            <div className="p-4 bg-muted rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">
                    {providers.find((p) => p.id === selectedProvider)?.name}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {
                      providers.find((p) => p.id === selectedProvider)
                        ?.description
                    }
                  </p>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  {(() => {
                    const stats = getConfigStats(
                      configurations[selectedProvider] || {
                        headerParameters: {},
                        bodyParameters: {},
                        configVersion: '1.0.0',
                        lastModified: Date.now(),
                      },
                    );
                    return (
                      <>
                        <div className="text-center">
                          <div className="font-medium">{stats.headerCount}</div>
                          <div className="text-muted-foreground">Headers</div>
                        </div>
                        <div className="text-center">
                          <div className="font-medium">{stats.bodyCount}</div>
                          <div className="text-muted-foreground">
                            Body Params
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="font-medium">{stats.total}</div>
                          <div className="text-muted-foreground">Total</div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Parameter Editor */}
      <CustomParameterEditor
        providerId={selectedProvider}
        initialConfig={configurations[selectedProvider]}
        onConfigChange={(config) =>
          handleConfigChange(selectedProvider, config)
        }
        onSave={() => handleSave(selectedProvider)}
        disabled={false}
      />

      {/* Live Configuration Preview */}
      <Card>
        <CardHeader>
          <CardTitle>Live Configuration Preview</CardTitle>
          <p className="text-muted-foreground">
            Real-time preview of the current parameter configuration as it would
            be sent to the API.
          </p>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="formatted" className="w-full">
            <TabsList>
              <TabsTrigger value="formatted">Formatted View</TabsTrigger>
              <TabsTrigger value="json">Raw JSON</TabsTrigger>
              <TabsTrigger value="api">API Request Preview</TabsTrigger>
            </TabsList>

            <TabsContent value="formatted" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium mb-2">HTTP Headers</h4>
                  <div className="bg-muted p-3 rounded text-sm font-mono">
                    {Object.entries(
                      configurations[selectedProvider]?.headerParameters || {},
                    ).length === 0 ? (
                      <div className="text-muted-foreground italic">
                        No headers configured
                      </div>
                    ) : (
                      Object.entries(
                        configurations[selectedProvider]?.headerParameters ||
                          {},
                      ).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex justify-between border-b border-border/50 pb-1 mb-1 last:border-b-0 last:mb-0 last:pb-0"
                        >
                          <span className="text-blue-600">{key}:</span>
                          <span className="text-green-600 truncate ml-2">
                            {String(value)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="font-medium mb-2">Request Body Parameters</h4>
                  <div className="bg-muted p-3 rounded text-sm font-mono">
                    {Object.entries(
                      configurations[selectedProvider]?.bodyParameters || {},
                    ).length === 0 ? (
                      <div className="text-muted-foreground italic">
                        No body parameters configured
                      </div>
                    ) : (
                      Object.entries(
                        configurations[selectedProvider]?.bodyParameters || {},
                      ).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex justify-between border-b border-border/50 pb-1 mb-1 last:border-b-0 last:mb-0 last:pb-0"
                        >
                          <span className="text-blue-600">{key}:</span>
                          <span className="text-green-600 truncate ml-2">
                            {typeof value === 'object'
                              ? JSON.stringify(value)
                              : String(value)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="json">
              <pre className="bg-muted p-4 rounded text-sm overflow-auto max-h-96">
                {JSON.stringify(
                  configurations[selectedProvider] || {
                    headerParameters: {},
                    bodyParameters: {},
                  },
                  null,
                  2,
                )}
              </pre>
            </TabsContent>

            <TabsContent value="api">
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-2">Sample API Request</h4>
                  <pre className="bg-muted p-4 rounded text-sm overflow-auto">
                    {`POST /v1/chat/completions
${Object.entries(configurations[selectedProvider]?.headerParameters || {})
  .map(([key, value]) => `${key}: ${value}`)
  .join('\n')}

{
  "model": "${selectedProvider}-model",
  "messages": [
    {"role": "user", "content": "Hello, world!"}
  ],${
    Object.entries(configurations[selectedProvider]?.bodyParameters || {})
      .length > 0
      ? '\n  ' +
        Object.entries(configurations[selectedProvider]?.bodyParameters || {})
          .map(([key, value]) => `"${key}": ${JSON.stringify(value)}`)
          .join(',\n  ')
      : ''
  }
}`}
                  </pre>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Usage Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>Demo Instructions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <strong>1. Provider Selection:</strong> Use the dropdown above to
            switch between different AI providers and see their typical
            configurations.
          </p>
          <p>
            <strong>2. Parameter Management:</strong> Add, edit, or remove
            parameters using the interface. Use the Headers and Body tabs to
            organize parameters by type.
          </p>
          <p>
            <strong>3. Templates:</strong> Try applying different templates to
            see how pre-built configurations work.
          </p>
          <p>
            <strong>4. Import/Export:</strong> Test the import/export
            functionality to save and restore configurations.
          </p>
          <p>
            <strong>5. Live Preview:</strong> Watch the configuration update in
            real-time in the preview section below.
          </p>
          <p>
            <strong>6. Search:</strong> Use the search box to quickly find
            specific parameters in large configurations.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default CustomParameterEditorDemo;
