/**
 * Parameter Preview System Demo Component
 *
 * Demonstrates the preview system with realistic scenarios and
 * integration with parameter configuration tools.
 */

import React, { useState } from 'react';
import {
  ParameterPreviewSystem,
  PreviewRequest,
} from './ParameterPreviewSystem';
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
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Eye,
  Settings,
  Zap,
  Code,
  Send,
  Activity,
  FileText,
} from 'lucide-react';

export const ParameterPreviewSystemDemo: React.FC = () => {
  const [selectedProvider, setSelectedProvider] = useState('openai');
  const [selectedModel, setSelectedModel] = useState('gpt-4');
  const [currentConfig, setCurrentConfig] = useState<CustomParameterConfig>({
    headerParameters: {
      Authorization: 'Bearer sk-proj-example...',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1.0,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
    configVersion: '1.0.0',
    lastModified: Date.now(),
  });

  const [activeTab, setActiveTab] = useState('preview');
  const [requestHistory, setRequestHistory] = useState<
    Array<{
      request: PreviewRequest;
      timestamp: Date;
      provider: string;
      model: string;
    }>
  >([]);
  const [lastResponse, setLastResponse] = useState<any>(null);

  const providers = [
    {
      id: 'openai',
      name: 'OpenAI GPT',
      icon: '🤖',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    },
    {
      id: 'claude',
      name: 'Anthropic Claude',
      icon: '🧠',
      endpoint: 'https://api.anthropic.com/v1/messages',
      models: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
    },
    {
      id: 'doubao',
      name: 'Doubao (ByteDance)',
      icon: '🚀',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      models: ['doubao-pro-4k', 'doubao-pro-32k', 'doubao-lite-4k'],
    },
    {
      id: 'qwen',
      name: 'Qwen (Alibaba)',
      icon: '🌟',
      endpoint:
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    },
  ];

  const currentProvider = providers.find((p) => p.id === selectedProvider);

  // Handle provider change
  const handleProviderChange = (providerId: string) => {
    setSelectedProvider(providerId);
    const provider = providers.find((p) => p.id === providerId);
    if (provider) {
      setSelectedModel(provider.models[0]);

      // Update config with provider-specific defaults
      setCurrentConfig((prev) => ({
        ...prev,
        headerParameters: {
          ...prev.headerParameters,
          ...(providerId === 'claude'
            ? {
                'x-api-key': 'YOUR_API_KEY',
                'anthropic-version': '2023-06-01',
              }
            : {
                Authorization: 'Bearer YOUR_API_KEY',
              }),
        },
      }));
    }
  };

  // Handle configuration changes
  const handleConfigChange = (config: CustomParameterConfig) => {
    setCurrentConfig(config);
  };

  // Handle request sending
  const handleSendRequest = async (request: PreviewRequest) => {
    // Add to history
    setRequestHistory((prev) => [
      {
        request,
        timestamp: new Date(),
        provider: selectedProvider,
        model: selectedModel,
      },
      ...prev.slice(0, 9), // Keep last 10 requests
    ]);

    // Simulate API response
    const mockResponse = {
      id: `req-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: selectedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              'This is a simulated response from the API preview system. Your parameters have been applied successfully!',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: request.estimatedTokens || 50,
        completion_tokens: 25,
        total_tokens: (request.estimatedTokens || 50) + 25,
      },
    };

    setLastResponse(mockResponse);
    console.log('Request sent:', request);
    console.log('Mock response:', mockResponse);
  };

  // Get system stats
  const getSystemStats = () => {
    const totalRequests = requestHistory.length;
    const uniqueProviders = new Set(requestHistory.map((r) => r.provider)).size;
    const avgTokens =
      requestHistory.length > 0
        ? Math.round(
            requestHistory.reduce(
              (sum, r) => sum + (r.request.estimatedTokens || 0),
              0,
            ) / requestHistory.length,
          )
        : 0;
    const totalCost = requestHistory.reduce(
      (sum, r) => sum + (r.request.estimatedCost || 0),
      0,
    );

    return {
      totalRequests,
      uniqueProviders,
      avgTokens,
      totalCost: totalCost.toFixed(6),
    };
  };

  const stats = getSystemStats();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <Eye className="w-6 h-6" />
            Parameter Preview System Demo
          </CardTitle>
          <p className="text-muted-foreground">
            Real-time parameter configuration preview with API request
            simulation. Configure parameters, preview requests, and test API
            integrations.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Active Provider:</label>
                <Select
                  value={selectedProvider}
                  onValueChange={handleProviderChange}
                >
                  <SelectTrigger className="w-[250px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        <div className="flex items-center gap-2">
                          <span>{provider.icon}</span>
                          <span>{provider.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Model:</label>
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(currentProvider?.models || []).map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4 text-center text-sm">
              <div>
                <div className="text-2xl font-bold text-blue-600">
                  {stats.totalRequests}
                </div>
                <div className="text-muted-foreground">Requests</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-600">
                  {stats.uniqueProviders}
                </div>
                <div className="text-muted-foreground">Providers</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-purple-600">
                  {stats.avgTokens}
                </div>
                <div className="text-muted-foreground">Avg Tokens</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-orange-600">
                  ${stats.totalCost}
                </div>
                <div className="text-muted-foreground">Total Cost</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Interface */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="preview" className="flex items-center gap-2">
            <Eye className="w-4 h-4" />
            Preview System
          </TabsTrigger>
          <TabsTrigger value="editor" className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            Parameter Editor
          </TabsTrigger>
          <TabsTrigger value="history" className="flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Request History
          </TabsTrigger>
          <TabsTrigger value="integration" className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Integration
          </TabsTrigger>
        </TabsList>

        <TabsContent value="preview" className="space-y-6">
          <ParameterPreviewSystem
            config={currentConfig}
            providerId={selectedProvider}
            endpoint={currentProvider?.endpoint}
            model={selectedModel}
            onConfigChange={handleConfigChange}
            onSendRequest={handleSendRequest}
          />
        </TabsContent>

        <TabsContent value="editor" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Parameter Configuration Editor</CardTitle>
              <p className="text-muted-foreground">
                Configure parameters for {currentProvider?.name}. Changes will
                be reflected in the preview system.
              </p>
            </CardHeader>
            <CardContent>
              <CustomParameterEditor
                providerId={selectedProvider}
                initialConfig={currentConfig}
                onConfigChange={handleConfigChange}
                onSave={() =>
                  console.log('Configuration saved:', currentConfig)
                }
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Request History</CardTitle>
              <p className="text-muted-foreground">
                Track your API requests and preview system usage
              </p>
            </CardHeader>
            <CardContent>
              {requestHistory.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Activity className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p className="text-lg font-medium">No requests sent yet</p>
                  <p className="text-sm">
                    Use the preview system to send test requests
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {requestHistory.map((entry, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                          <span className="text-blue-600 font-medium">
                            {
                              providers.find((p) => p.id === entry.provider)
                                ?.icon
                            }
                          </span>
                        </div>
                        <div>
                          <div className="font-medium">{entry.model}</div>
                          <div className="text-sm text-muted-foreground">
                            {
                              providers.find((p) => p.id === entry.provider)
                                ?.name
                            }
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {entry.request.estimatedTokens} tokens • $
                            {entry.request.estimatedCost}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium">
                          {entry.timestamp.toLocaleTimeString()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {entry.timestamp.toLocaleDateString()}
                        </div>
                        <Badge variant="outline" className="mt-1">
                          {entry.request.method}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Last Response */}
          {lastResponse && (
            <Card>
              <CardHeader>
                <CardTitle>Last API Response (Simulated)</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
                  <code>{JSON.stringify(lastResponse, null, 2)}</code>
                </pre>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="integration" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>System Integration</CardTitle>
              <p className="text-muted-foreground">
                Demonstrates seamless integration between preview and editor
                systems
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Current Configuration Display */}
              <div>
                <h3 className="text-lg font-medium mb-4">
                  Current Configuration
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h4 className="font-medium mb-2">
                      Headers (
                      {Object.keys(currentConfig.headerParameters || {}).length}
                      )
                    </h4>
                    <div className="bg-muted p-3 rounded text-sm">
                      <pre>
                        {JSON.stringify(
                          currentConfig.headerParameters || {},
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </div>
                  <div>
                    <h4 className="font-medium mb-2">
                      Body Parameters (
                      {Object.keys(currentConfig.bodyParameters || {}).length})
                    </h4>
                    <div className="bg-muted p-3 rounded text-sm">
                      <pre>
                        {JSON.stringify(
                          currentConfig.bodyParameters || {},
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Integration Features */}
              <div>
                <h3 className="text-lg font-medium mb-4">
                  Integration Features
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 border rounded-lg">
                    <h4 className="font-medium mb-2">🔄 Real-time Preview</h4>
                    <p className="text-sm text-muted-foreground">
                      Parameter changes are immediately reflected in the preview
                      system. See exactly how your API requests will be
                      structured.
                    </p>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <h4 className="font-medium mb-2">📊 Request Validation</h4>
                    <p className="text-sm text-muted-foreground">
                      Built-in validation ensures your parameters are correct
                      before sending. Get immediate feedback on configuration
                      issues.
                    </p>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <h4 className="font-medium mb-2">📋 Request History</h4>
                    <p className="text-sm text-muted-foreground">
                      Track all your test requests with full request and
                      response details. Perfect for debugging and optimization.
                    </p>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Quick Actions */}
              <div>
                <h3 className="text-lg font-medium mb-4">Quick Actions</h3>
                <div className="flex items-center gap-4">
                  <Button
                    onClick={() => setActiveTab('preview')}
                    variant="outline"
                  >
                    <Eye className="w-4 h-4 mr-2" />
                    View Preview
                  </Button>
                  <Button
                    onClick={() => setActiveTab('editor')}
                    variant="outline"
                  >
                    <Settings className="w-4 h-4 mr-2" />
                    Edit Parameters
                  </Button>
                  <Button
                    onClick={() => setActiveTab('history')}
                    variant="outline"
                  >
                    <Activity className="w-4 h-4 mr-2" />
                    View History
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Status Footer */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <div>
              Preview System Status: Active with {providers.length} supported
              providers
            </div>
            <div className="flex items-center gap-4">
              <span>Provider: {currentProvider?.name}</span>
              <span>•</span>
              <span>Model: {selectedModel}</span>
              <span>•</span>
              <span>Last Updated: {new Date().toLocaleTimeString()}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default ParameterPreviewSystemDemo;
