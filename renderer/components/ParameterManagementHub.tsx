import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Settings2, FileText, Eye, Download, Upload } from 'lucide-react';
import { CustomParameterEditor } from './CustomParameterEditor';
import { ParameterPreviewSystem } from './ParameterPreviewSystem';
import { useParameterConfig } from '../hooks/useParameterConfig';
import { toast } from 'sonner';

interface ParameterManagementHubProps {
  providerId: string;
  className?: string;
}

export const ParameterManagementHub: React.FC<ParameterManagementHubProps> = ({
  providerId,
  className = '',
}) => {
  const [activeTab, setActiveTab] = useState('editor');
  const parameterConfig = useParameterConfig();
  // Template manager removed as requested

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
        toast.success('Parameter configuration exported successfully');
      }
    } catch (error) {
      console.error('Failed to export config:', error);
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
          toast.success('Parameter configuration imported successfully');
        } catch (error) {
          console.error('Failed to import config:', error);
          toast.error('Failed to import configuration');
        }
      }
    };
    input.click();
  };

  const getConfigSummary = () => {
    const { headerParameters, bodyParameters } = parameterConfig.state.config;
    const headerCount = Object.keys(headerParameters).length;
    const bodyCount = Object.keys(bodyParameters).length;
    const totalCount = headerCount + bodyCount;

    return {
      total: totalCount,
      headers: headerCount,
      body: bodyCount,
    };
  };

  const summary = getConfigSummary();

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">
            Parameter Management
          </h2>
          <p className="text-sm text-muted-foreground">
            Configure custom parameters for provider: {providerId}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="outline" className="flex items-center gap-1">
            <Settings2 className="h-3 w-3" />
            {summary.total} parameters
          </Badge>

          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportConfig}
              className="flex items-center gap-1"
            >
              <Download className="h-4 w-4" />
              Export
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleImportConfig}
              className="flex items-center gap-1"
            >
              <Upload className="h-4 w-4" />
              Import
            </Button>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Headers
                </p>
                <p className="text-2xl font-bold">{summary.headers}</p>
              </div>
              <Settings2 className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Body Parameters
                </p>
                <p className="text-2xl font-bold">{summary.body}</p>
              </div>
              <Settings2 className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>

        {/* Templates stats card removed as requested */}
      </div>

      <Separator />

      {/* Main Content Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="editor" className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Parameter Editor
          </TabsTrigger>
          <TabsTrigger value="preview" className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Preview
          </TabsTrigger>
        </TabsList>

        <TabsContent value="editor" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5" />
                Parameter Configuration
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CustomParameterEditor providerId={providerId} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Templates tab content removed as requested */}

        <TabsContent value="preview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Parameter Preview
              </CardTitle>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ParameterManagementHub;
