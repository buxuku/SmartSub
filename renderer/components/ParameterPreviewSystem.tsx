/**
 * Parameter Preview System
 *
 * Provides real-time preview capabilities for parameter configurations,
 * showing how they will be applied in actual API requests with syntax highlighting,
 * validation feedback, and request simulation.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { CustomParameterConfig, ParameterValue } from '../../types/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Eye,
  Code,
  Send,
  CheckCircle,
  AlertCircle,
  Copy,
  Download,
  RefreshCw,
  Settings,
  Zap,
} from 'lucide-react';

export interface ParameterPreviewSystemProps {
  config: CustomParameterConfig;
  providerId?: string;
  endpoint?: string;
  model?: string;
  onConfigChange?: (config: CustomParameterConfig) => void;
  onSendRequest?: (request: PreviewRequest) => void;
  disabled?: boolean;
  className?: string;
}

export interface PreviewRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any>;
  curlCommand: string;
  estimatedTokens?: number;
  estimatedCost?: number;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

interface PreviewMetrics {
  headerCount: number;
  bodyParamCount: number;
  estimatedSize: number;
  complexity: 'low' | 'medium' | 'high';
}

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
  custom: [],
};

export const ParameterPreviewSystem: React.FC<ParameterPreviewSystemProps> = ({
  config,
  providerId = 'openai',
  endpoint,
  model,
  onConfigChange,
  onSendRequest,
  disabled = false,
  className = '',
}) => {
  const [activeTab, setActiveTab] = useState('preview');
  const [selectedModel, setSelectedModel] = useState(
    model ||
      PROVIDER_MODELS[providerId as keyof typeof PROVIDER_MODELS]?.[0] ||
      '',
  );
  const [selectedEndpoint, setSelectedEndpoint] = useState(
    endpoint ||
      PROVIDER_ENDPOINTS[providerId as keyof typeof PROVIDER_ENDPOINTS] ||
      '',
  );
  const [validationResults, setValidationResults] = useState<ValidationResult>({
    isValid: true,
    errors: [],
    warnings: [],
  });
  const [copied, setCopied] = useState<string | null>(null);

  // Generate preview request
  const previewRequest = useMemo((): PreviewRequest => {
    const headers = {
      'Content-Type': 'application/json',
      ...config.headerParameters,
    };

    const body = {
      model: selectedModel,
      ...config.bodyParameters,
      messages: [
        {
          role: 'user',
          content:
            'This is a preview request to test your parameter configuration.',
        },
      ],
    };

    // Generate cURL command
    const curlHeaders = Object.entries(headers)
      .map(([key, value]) => `-H "${key}: ${value}"`)
      .join(' ');

    const curlCommand = `curl -X POST "${selectedEndpoint}" \\\n  ${curlHeaders} \\\n  -d '${JSON.stringify(body, null, 2)}'`;

    // Estimate tokens and cost (simplified calculation)
    const estimatedTokens = JSON.stringify(body).length / 4; // Rough approximation
    const estimatedCost = estimatedTokens * 0.00002; // Rough cost estimate

    return {
      url: selectedEndpoint,
      method: 'POST',
      headers,
      body,
      curlCommand,
      estimatedTokens: Math.ceil(estimatedTokens),
      estimatedCost: parseFloat(estimatedCost.toFixed(6)),
    };
  }, [config, selectedModel, selectedEndpoint]);

  // Calculate preview metrics
  const previewMetrics = useMemo((): PreviewMetrics => {
    const headerCount = Object.keys(config.headerParameters || {}).length;
    const bodyParamCount = Object.keys(config.bodyParameters || {}).length;
    const estimatedSize = JSON.stringify(previewRequest.body).length;

    let complexity: 'low' | 'medium' | 'high' = 'low';
    if (bodyParamCount > 10 || estimatedSize > 1000) complexity = 'high';
    else if (bodyParamCount > 5 || estimatedSize > 500) complexity = 'medium';

    return {
      headerCount,
      bodyParamCount,
      estimatedSize,
      complexity,
    };
  }, [config, previewRequest]);

  // Validate configuration
  const validateConfiguration = useCallback((): ValidationResult => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (!selectedEndpoint) {
      errors.push('API endpoint is required');
    }
    if (!selectedModel) {
      errors.push('Model selection is required');
    }

    // Validate headers
    const headers = config.headerParameters || {};
    if (!headers['Authorization'] && !headers['x-api-key']) {
      errors.push('API key is required (Authorization or x-api-key header)');
    }

    // Validate body parameters
    const body = config.bodyParameters || {};
    if (
      body.temperature &&
      (typeof body.temperature !== 'number' ||
        body.temperature < 0 ||
        body.temperature > 2)
    ) {
      warnings.push('Temperature should be a number between 0 and 2');
    }
    if (
      body.max_tokens &&
      (typeof body.max_tokens !== 'number' || body.max_tokens < 1)
    ) {
      warnings.push('Max tokens should be a positive number');
    }

    // Check for potential issues
    if (previewMetrics.estimatedSize > 2000) {
      warnings.push('Large request size may impact performance');
    }
    if (Object.keys(body).length > 15) {
      warnings.push('Many parameters may complicate debugging');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }, [config, selectedEndpoint, selectedModel, previewMetrics]);

  // Update validation results
  useEffect(() => {
    const results = validateConfiguration();
    setValidationResults(results);
  }, [validateConfiguration]);

  // Copy to clipboard
  const copyToClipboard = useCallback(async (content: string, type: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, []);

  // Download as file
  const downloadAsFile = useCallback((content: string, filename: string) => {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  // Handle send request
  const handleSendRequest = useCallback(() => {
    if (onSendRequest && validationResults.isValid) {
      onSendRequest(previewRequest);
    }
  }, [onSendRequest, previewRequest, validationResults.isValid]);

  // Format JSON with syntax highlighting
  const formatJson = (obj: any) => {
    return JSON.stringify(obj, null, 2);
  };

  // Get complexity color
  const getComplexityColor = (complexity: string) => {
    switch (complexity) {
      case 'low':
        return 'text-green-600';
      case 'medium':
        return 'text-yellow-600';
      case 'high':
        return 'text-red-600';
      default:
        return 'text-gray-600';
    }
  };

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <Eye className="w-5 h-5" />
            Parameter Preview System
          </CardTitle>
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground">
              Real-time preview of your parameter configuration and API request
              structure
            </p>
            <div className="flex items-center gap-4">
              {/* Validation Status */}
              <div className="flex items-center gap-2">
                {validationResults.isValid ? (
                  <CheckCircle className="w-4 h-4 text-green-600" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-600" />
                )}
                <span
                  className={`text-sm ${validationResults.isValid ? 'text-green-600' : 'text-red-600'}`}
                >
                  {validationResults.isValid ? 'Valid' : 'Invalid'}
                </span>
              </div>

              {/* Complexity Indicator */}
              <Badge
                variant="outline"
                className={getComplexityColor(previewMetrics.complexity)}
              >
                {previewMetrics.complexity} complexity
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Configuration Controls */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">API Endpoint</label>
              <Select
                value={selectedEndpoint}
                onValueChange={setSelectedEndpoint}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select endpoint" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PROVIDER_ENDPOINTS).map(([provider, url]) => (
                    <SelectItem key={provider} value={url}>
                      {provider.charAt(0).toUpperCase() + provider.slice(1)} -{' '}
                      {url}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Model</label>
              <Select
                value={selectedModel}
                onValueChange={setSelectedModel}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    PROVIDER_MODELS[
                      providerId as keyof typeof PROVIDER_MODELS
                    ] || []
                  ).map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Metrics Summary */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {previewMetrics.headerCount}
              </div>
              <div className="text-sm text-muted-foreground">Headers</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {previewMetrics.bodyParamCount}
              </div>
              <div className="text-sm text-muted-foreground">Parameters</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">
                {previewRequest.estimatedTokens}
              </div>
              <div className="text-sm text-muted-foreground">Est. Tokens</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-600">
                ${previewRequest.estimatedCost}
              </div>
              <div className="text-sm text-muted-foreground">Est. Cost</div>
            </div>
          </div>

          {/* Validation Messages */}
          {(validationResults.errors.length > 0 ||
            validationResults.warnings.length > 0) && (
            <div className="space-y-2 mb-6">
              {validationResults.errors.map((error, index) => (
                <Alert key={`error-${index}`} variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ))}
              {validationResults.warnings.map((warning, index) => (
                <Alert key={`warning-${index}`}>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{warning}</AlertDescription>
                </Alert>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preview Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="preview" className="flex items-center gap-2">
            <Eye className="w-4 h-4" />
            Request Preview
          </TabsTrigger>
          <TabsTrigger value="headers" className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            Headers
          </TabsTrigger>
          <TabsTrigger value="body" className="flex items-center gap-2">
            <Code className="w-4 h-4" />
            Body
          </TabsTrigger>
          <TabsTrigger value="curl" className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            cURL
          </TabsTrigger>
        </TabsList>

        <TabsContent value="preview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Complete Request Preview</CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() =>
                    copyToClipboard(
                      JSON.stringify(previewRequest, null, 2),
                      'request',
                    )
                  }
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  {copied === 'request' ? 'Copied!' : 'Copy Request'}
                </Button>
                <Button
                  onClick={() =>
                    downloadAsFile(
                      JSON.stringify(previewRequest, null, 2),
                      'api-request.json',
                    )
                  }
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
                {onSendRequest && (
                  <Button
                    onClick={handleSendRequest}
                    disabled={disabled || !validationResults.isValid}
                    className="ml-auto"
                  >
                    <Send className="w-4 h-4 mr-2" />
                    Send Request
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline">POST</Badge>
                    <code className="text-sm bg-muted px-2 py-1 rounded">
                      {previewRequest.url}
                    </code>
                  </div>
                </div>

                <Separator />

                <div>
                  <h4 className="font-medium mb-2">Request Structure</h4>
                  <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
                    <code>{formatJson(previewRequest)}</code>
                  </pre>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="headers" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Request Headers</CardTitle>
              <Button
                onClick={() =>
                  copyToClipboard(
                    JSON.stringify(previewRequest.headers, null, 2),
                    'headers',
                  )
                }
                variant="outline"
                size="sm"
                disabled={disabled}
              >
                <Copy className="w-4 h-4 mr-2" />
                {copied === 'headers' ? 'Copied!' : 'Copy Headers'}
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
                <code>{formatJson(previewRequest.headers)}</code>
              </pre>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="body" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Request Body</CardTitle>
              <Button
                onClick={() =>
                  copyToClipboard(
                    JSON.stringify(previewRequest.body, null, 2),
                    'body',
                  )
                }
                variant="outline"
                size="sm"
                disabled={disabled}
              >
                <Copy className="w-4 h-4 mr-2" />
                {copied === 'body' ? 'Copied!' : 'Copy Body'}
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
                <code>{formatJson(previewRequest.body)}</code>
              </pre>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="curl" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>cURL Command</CardTitle>
              <Button
                onClick={() =>
                  copyToClipboard(previewRequest.curlCommand, 'curl')
                }
                variant="outline"
                size="sm"
                disabled={disabled}
              >
                <Copy className="w-4 h-4 mr-2" />
                {copied === 'curl' ? 'Copied!' : 'Copy cURL'}
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
                <code>{previewRequest.curlCommand}</code>
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ParameterPreviewSystem;
