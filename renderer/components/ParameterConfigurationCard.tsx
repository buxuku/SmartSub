import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Settings2,
  ChevronRight,
  ChevronDown,
  Eye,
  FileText,
  Download,
  Upload,
  Info,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { CustomParameterEditor } from './CustomParameterEditor';
import { ParameterPreviewSystem } from './ParameterPreviewSystem';
import { useParameterConfig } from '../hooks/useParameterConfig';
import { toast } from 'sonner';

interface ParameterConfigurationCardProps {
  providerId: string;
  providerName?: string;
  compact?: boolean;
  className?: string;
}

export const ParameterConfigurationCard: React.FC<
  ParameterConfigurationCardProps
> = ({
  providerId,
  providerName = providerId,
  compact = false,
  className = '',
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const parameterConfig = useParameterConfig();

  React.useEffect(() => {
    if (providerId) {
      parameterConfig.loadConfig(providerId);
    }
  }, [providerId]);

  const getConfigSummary = () => {
    const { headerParameters, bodyParameters } = parameterConfig.state.config;
    const headerCount = Object.keys(headerParameters).length;
    const bodyCount = Object.keys(bodyParameters).length;
    const totalCount = headerCount + bodyCount;

    return {
      total: totalCount,
      headers: headerCount,
      body: bodyCount,
      hasConfig: totalCount > 0,
    };
  };

  const handleExportConfig = async () => {
    try {
      const config = await window.ipc.invoke('getCustomParameters', providerId);
      if (config) {
        const dataStr = JSON.stringify(config, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${providerId}-parameters.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast.success('Parameter configuration exported');
      }
    } catch (error) {
      console.error('Export failed:', error);
      toast.error('Failed to export configuration');
    }
  };

  const handleImportConfig = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          const text = await file.text();
          const config = JSON.parse(text);
          await parameterConfig.saveConfig(providerId, config);
          await parameterConfig.loadConfig(providerId);
          toast.success('Parameter configuration imported');
        } catch (error) {
          console.error('Import failed:', error);
          toast.error('Failed to import configuration');
        }
      }
    };
    input.click();
  };

  const summary = getConfigSummary();

  if (compact) {
    return (
      <div className={`space-y-2 ${className}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Custom Parameters</span>
            {summary.hasConfig && (
              <Badge variant="secondary" className="text-xs">
                {summary.total}
              </Badge>
            )}
          </div>

          <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                Configure
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
              <DialogHeader>
                <DialogTitle>Custom Parameters - {providerName}</DialogTitle>
              </DialogHeader>
              <CustomParameterEditor providerId={providerId} />
            </DialogContent>
          </Dialog>
        </div>

        {summary.hasConfig && (
          <div className="text-xs text-muted-foreground">
            {summary.headers} headers, {summary.body} body parameters
          </div>
        )}
      </div>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            <CardTitle className="text-lg">Custom Parameters</CardTitle>
            {summary.hasConfig && (
              <Badge variant="secondary">{summary.total} configured</Badge>
            )}
          </div>

          <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>
          </Collapsible>
        </div>
      </CardHeader>

      <CardContent>
        <div className="space-y-4">
          {/* Quick Summary */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Headers:</span>
              <Badge variant="outline">{summary.headers}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Body Params:</span>
              <Badge variant="outline">{summary.body}</Badge>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2">
            <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-1"
                >
                  <Settings2 className="h-4 w-4" />
                  Edit Parameters
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
                <DialogHeader>
                  <DialogTitle>Parameter Editor - {providerName}</DialogTitle>
                </DialogHeader>
                <CustomParameterEditor providerId={providerId} />
              </DialogContent>
            </Dialog>

            {/* Templates functionality removed as requested */}

            <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-1"
                >
                  <Eye className="h-4 w-4" />
                  Preview
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[80vh] overflow-auto">
                <DialogHeader>
                  <DialogTitle>Parameter Preview - {providerName}</DialogTitle>
                </DialogHeader>
                <ParameterPreviewSystem
                  config={
                    parameterConfig.state.config || {
                      headerParameters: {},
                      bodyParameters: {},
                      configVersion: '1.0.0',
                      lastModified: Date.now(),
                    }
                  }
                  providerId={providerId}
                />
              </DialogContent>
            </Dialog>
          </div>

          <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
            <CollapsibleContent className="space-y-4">
              <Separator />

              <div className="flex gap-2 text-sm">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleExportConfig}
                  className="flex items-center gap-1"
                >
                  <Download className="h-4 w-4" />
                  Export
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleImportConfig}
                  className="flex items-center gap-1"
                >
                  <Upload className="h-4 w-4" />
                  Import
                </Button>
              </div>

              <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
                <Info className="h-4 w-4 text-muted-foreground mt-0.5" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium mb-1">Custom Parameters</p>
                  <p>
                    Configure additional headers and body parameters that will
                    be included in API requests to this provider.
                  </p>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </CardContent>
    </Card>
  );
};

export default ParameterConfigurationCard;
