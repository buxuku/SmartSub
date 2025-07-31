/**
 * ParameterTemplateManager Demo Component
 *
 * Demonstrates the template management system with realistic scenarios
 * and integration with the parameter editor.
 */

import React, { useState } from 'react';
import { ParameterTemplateManager } from './ParameterTemplateManager';
import { CustomParameterEditor } from './CustomParameterEditor';
import { useParameterTemplates } from '../hooks/useParameterTemplates';
import { ParameterTemplate, CustomParameterConfig } from '../../types/provider';
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
import { ArrowLeftRight, Settings, Zap, History, Star } from 'lucide-react';

export const ParameterTemplateManagerDemo: React.FC = () => {
  const [selectedProvider, setSelectedProvider] = useState('openai');
  const [currentConfig, setCurrentConfig] = useState<CustomParameterConfig>({
    headerParameters: {
      Authorization: 'Bearer sk-proj-example...',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1.0,
    },
    configVersion: '1.0.0',
    lastModified: Date.now(),
  });

  const [activeTab, setActiveTab] = useState('templates');
  const [templateHistory, setTemplateHistory] = useState<
    Array<{
      template: ParameterTemplate;
      appliedAt: Date;
      providerId: string;
    }>
  >([]);

  // Use the templates hook
  const {
    templates,
    loading,
    createTemplate,
    applyTemplate,
    toggleFavorite,
    getUsageStats,
    getFavoriteTemplates,
  } = useParameterTemplates({ providerId: selectedProvider });

  const providers = [
    { id: 'openai', name: 'OpenAI GPT', icon: '🤖' },
    { id: 'claude', name: 'Anthropic Claude', icon: '🧠' },
    { id: 'doubao', name: 'Doubao (ByteDance)', icon: '🚀' },
    { id: 'qwen', name: 'Qwen (Alibaba)', icon: '🌟' },
    { id: 'custom', name: 'Custom Provider', icon: '⚙️' },
  ];

  // Handle template application
  const handleTemplateApply = async (template: ParameterTemplate) => {
    try {
      const config = await applyTemplate(template.id);
      setCurrentConfig(config);

      // Add to history
      setTemplateHistory((prev) => [
        {
          template,
          appliedAt: new Date(),
          providerId: selectedProvider,
        },
        ...prev.slice(0, 9), // Keep last 10 applications
      ]);

      // Show success feedback
      console.log('Template applied successfully:', template.name);
    } catch (error) {
      console.error('Failed to apply template:', error);
    }
  };

  // Handle template creation
  const handleTemplateCreate = async (template: ParameterTemplate) => {
    try {
      await createTemplate(template);
      console.log('Template created successfully:', template.name);
    } catch (error) {
      console.error('Failed to create template:', error);
    }
  };

  // Handle configuration changes
  const handleConfigChange = (config: CustomParameterConfig) => {
    setCurrentConfig(config);
  };

  // Get quick stats
  const getQuickStats = () => {
    const favorites = getFavoriteTemplates();
    const totalTemplates = templates.length;
    const recentlyUsed = templateHistory.slice(0, 5);

    return {
      totalTemplates,
      favoriteCount: favorites.length,
      recentApplications: recentlyUsed.length,
      mostUsedTemplate: templates.reduce((most, current) => {
        const currentUsage = getUsageStats(current.id).usageCount;
        const mostUsage = getUsageStats(most?.id || '').usageCount;
        return currentUsage > mostUsage ? current : most;
      }, templates[0]),
    };
  };

  const stats = getQuickStats();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <Settings className="w-6 h-6" />
            Parameter Template System Demo
          </CardTitle>
          <p className="text-muted-foreground">
            Comprehensive template management system for AI provider parameters.
            Create, manage, and apply parameter configurations across different
            providers.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Active Provider:</label>
                <Select
                  value={selectedProvider}
                  onValueChange={setSelectedProvider}
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
            </div>

            <div className="grid grid-cols-4 gap-4 text-center text-sm">
              <div>
                <div className="text-2xl font-bold text-blue-600">
                  {stats.totalTemplates}
                </div>
                <div className="text-muted-foreground">Templates</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-yellow-600">
                  {stats.favoriteCount}
                </div>
                <div className="text-muted-foreground">Favorites</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-600">
                  {stats.recentApplications}
                </div>
                <div className="text-muted-foreground">Recent Uses</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-purple-600">
                  {getUsageStats(stats.mostUsedTemplate?.id || '').usageCount}
                </div>
                <div className="text-muted-foreground">Most Used</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Interface */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="templates" className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Template Manager
          </TabsTrigger>
          <TabsTrigger value="editor" className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            Parameter Editor
          </TabsTrigger>
          <TabsTrigger value="history" className="flex items-center gap-2">
            <History className="w-4 h-4" />
            Usage History
          </TabsTrigger>
          <TabsTrigger value="integration" className="flex items-center gap-2">
            <ArrowLeftRight className="w-4 h-4" />
            Integration
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Template Manager</CardTitle>
              <p className="text-muted-foreground">
                Browse, manage, and apply parameter templates for{' '}
                {providers.find((p) => p.id === selectedProvider)?.name}
              </p>
            </CardHeader>
            <CardContent>
              <ParameterTemplateManager
                providerId={selectedProvider}
                currentConfig={currentConfig}
                onTemplateApply={handleTemplateApply}
                onTemplateCreate={handleTemplateCreate}
                disabled={loading}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="editor" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Parameter Editor</CardTitle>
              <p className="text-muted-foreground">
                Configure custom parameters for{' '}
                {providers.find((p) => p.id === selectedProvider)?.name}.
                Changes here can be saved as templates.
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
              <CardTitle>Template Usage History</CardTitle>
              <p className="text-muted-foreground">
                Track your template applications and usage patterns
              </p>
            </CardHeader>
            <CardContent>
              {templateHistory.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <History className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p className="text-lg font-medium">No usage history yet</p>
                  <p className="text-sm">
                    Apply some templates to see your usage history
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {templateHistory.map((entry, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                          <span className="text-blue-600 font-medium">
                            {
                              providers.find((p) => p.id === entry.providerId)
                                ?.icon
                            }
                          </span>
                        </div>
                        <div>
                          <div className="font-medium">
                            {entry.template.name}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            Applied to{' '}
                            {
                              providers.find((p) => p.id === entry.providerId)
                                ?.name
                            }
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium">
                          {entry.appliedAt.toLocaleTimeString()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {entry.appliedAt.toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Usage Statistics */}
          <Card>
            <CardHeader>
              <CardTitle>Template Statistics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {templates.slice(0, 6).map((template) => {
                  const stats = getUsageStats(template.id);
                  return (
                    <div key={template.id} className="p-4 border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium truncate">
                          {template.name}
                        </div>
                        <Star className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div className="text-sm text-muted-foreground mb-2">
                        {template.description}
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <Badge variant="outline">{template.category}</Badge>
                        <span className="text-muted-foreground">
                          {stats.usageCount} uses
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="integration" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Template-Editor Integration</CardTitle>
              <p className="text-muted-foreground">
                Demonstrates seamless integration between template management
                and parameter editing
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

              {/* Quick Actions */}
              <div>
                <h3 className="text-lg font-medium mb-4">Quick Actions</h3>
                <div className="flex items-center gap-4">
                  <Button
                    onClick={() => setActiveTab('templates')}
                    variant="outline"
                  >
                    Browse Templates
                  </Button>
                  <Button
                    onClick={() => setActiveTab('editor')}
                    variant="outline"
                  >
                    Edit Parameters
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline">
                        Create Template from Current
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Create Template</AlertDialogTitle>
                        <AlertDialogDescription>
                          Create a new template from the current parameter
                          configuration? This will save your current headers and
                          body parameters as a reusable template.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            handleTemplateCreate({
                              id: '',
                              name: `${selectedProvider} Custom Template`,
                              description:
                                'Template created from current configuration',
                              category: 'provider',
                              headerParameters:
                                currentConfig.headerParameters || {},
                              bodyParameters:
                                currentConfig.bodyParameters || {},
                              modelCompatibility: ['gpt-4', 'gpt-3.5-turbo'],
                              useCase: 'translation',
                              provider: selectedProvider,
                            });
                          }}
                        >
                          Create Template
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
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
                    <h4 className="font-medium mb-2">🔄 Real-time Sync</h4>
                    <p className="text-sm text-muted-foreground">
                      Changes in the parameter editor are immediately available
                      for template creation. Applied templates instantly update
                      the editor configuration.
                    </p>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <h4 className="font-medium mb-2">📊 Usage Tracking</h4>
                    <p className="text-sm text-muted-foreground">
                      Template applications are tracked with timestamps and
                      usage counts. Popular templates are automatically
                      prioritized in listings.
                    </p>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <h4 className="font-medium mb-2">🎯 Provider Filtering</h4>
                    <p className="text-sm text-muted-foreground">
                      Templates are automatically filtered by provider
                      compatibility. Only relevant templates are shown for each
                      AI provider.
                    </p>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <h4 className="font-medium mb-2">💾 Auto-save</h4>
                    <p className="text-sm text-muted-foreground">
                      Template configurations are automatically saved to
                      persistent storage. No data loss when switching between
                      providers or sessions.
                    </p>
                  </div>
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
              Demo Status: Template system fully operational with{' '}
              {templates.length} available templates
            </div>
            <div className="flex items-center gap-4">
              <span>
                Provider:{' '}
                {providers.find((p) => p.id === selectedProvider)?.name}
              </span>
              <span>•</span>
              <span>Last Updated: {new Date().toLocaleTimeString()}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default ParameterTemplateManagerDemo;
