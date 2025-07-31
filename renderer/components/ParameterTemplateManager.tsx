/**
 * ParameterTemplateManager Component
 *
 * Template management interface for parameter configurations.
 * Provides browsing, searching, and applying pre-built templates.
 */

import React, { useState, useMemo } from 'react';
import {
  ParameterTemplate,
  ParameterCategory,
  CustomParameterConfig,
} from '../../types/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search, Star, Download, Upload, Plus, Settings } from 'lucide-react';

export interface ParameterTemplateManagerProps {
  providerId?: string;
  currentConfig?: CustomParameterConfig;
  onTemplateApply?: (template: ParameterTemplate) => void;
  onTemplateCreate?: (template: ParameterTemplate) => void;
  onTemplateUpdate?: (template: ParameterTemplate) => void;
  onTemplateDelete?: (templateId: string) => void;
  disabled?: boolean;
  className?: string;
}

const PRE_BUILT_TEMPLATES: ParameterTemplate[] = [
  {
    id: 'openai-default',
    name: 'OpenAI Default',
    description: 'Standard OpenAI configuration with common parameters',
    category: 'provider',
    headerParameters: {
      Authorization: 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    bodyParameters: {
      temperature: 0.7,
      max_tokens: 1000,
    },
    modelCompatibility: ['gpt-4', 'gpt-3.5-turbo'],
    useCase: 'translation',
    provider: 'openai',
  },
];

export const ParameterTemplateManager: React.FC<
  ParameterTemplateManagerProps
> = ({
  providerId,
  currentConfig,
  onTemplateApply,
  onTemplateCreate,
  onTemplateUpdate,
  onTemplateDelete,
  disabled = false,
  className = '',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [activeTab, setActiveTab] = useState('browse');

  // Filter templates based on search and category
  const filteredTemplates = useMemo(() => {
    return PRE_BUILT_TEMPLATES.filter((template) => {
      const matchesSearch =
        template.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        template.description.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesCategory =
        selectedCategory === 'all' || template.category === selectedCategory;

      return matchesSearch && matchesCategory;
    });
  }, [searchQuery, selectedCategory]);

  const handleApplyTemplate = (template: ParameterTemplate) => {
    if (onTemplateApply) {
      onTemplateApply(template);
    }
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="browse">Browse Templates</TabsTrigger>
          <TabsTrigger value="create">Create Template</TabsTrigger>
        </TabsList>

        <TabsContent value="browse" className="space-y-4">
          {/* Search and Filter Controls */}
          <div className="flex gap-4">
            <div className="flex-1">
              <Label htmlFor="search">Search Templates</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Search by name or description..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8"
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="w-48">
              <Label htmlFor="category">Category</Label>
              <Select
                value={selectedCategory}
                onValueChange={setSelectedCategory}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value="provider">Provider</SelectItem>
                  <SelectItem value="performance">Performance</SelectItem>
                  <SelectItem value="quality">Quality</SelectItem>
                  <SelectItem value="experimental">Experimental</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Template Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTemplates.map((template) => (
              <Card
                key={template.id}
                className="hover:shadow-md transition-shadow"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{template.name}</CardTitle>
                      <Badge variant="outline" className="mt-1">
                        {template.category}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-4">
                    {template.description}
                  </p>

                  <div className="space-y-2 text-xs">
                    <div>
                      <span className="font-medium">Headers:</span>{' '}
                      {Object.keys(template.headerParameters || {}).length}
                    </div>
                    <div>
                      <span className="font-medium">Body params:</span>{' '}
                      {Object.keys(template.bodyParameters || {}).length}
                    </div>
                    <div>
                      <span className="font-medium">Use case:</span>{' '}
                      {template.useCase}
                    </div>
                  </div>

                  <Button
                    className="w-full mt-4"
                    onClick={() => handleApplyTemplate(template)}
                    disabled={disabled}
                  >
                    Apply Template
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>

          {filteredTemplates.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Settings className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No templates found matching your criteria.</p>
              <p className="text-sm">
                Try adjusting your search or category filter.
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="create" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Create Custom Template</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Custom template creation is coming soon. You can export your
                current configuration and import it later.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};
