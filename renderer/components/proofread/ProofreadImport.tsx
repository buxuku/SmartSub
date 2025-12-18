import React, { useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Video, FileText, FolderOpen } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'sonner';

interface PendingFile {
  id: string;
  videoPath?: string;
  fileName: string;
  detectedSubtitles: Array<{
    filePath: string;
    type: 'source' | 'translated' | 'unknown';
    language?: string;
    confidence: number;
  }>;
  selectedSource?: string;
  selectedTarget?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  status: 'pending' | 'proofreading' | 'completed';
}

interface ProofreadImportProps {
  onImportComplete: (files: PendingFile[], type: 'video' | 'subtitle') => void;
}

export default function ProofreadImport({
  onImportComplete,
}: ProofreadImportProps) {
  const { t } = useTranslation('home');

  // 导入视频文件
  const handleImportVideos = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('selectFiles', {
        type: 'video',
        multiple: true,
      });

      if (!result || result.canceled || result.filePaths.length === 0) return;

      const files: PendingFile[] = [];

      for (const videoPath of result.filePaths) {
        // 检测关联的字幕
        const detectResult = await window.ipc.invoke('detectSubtitles', {
          videoPath,
        });

        const detectedSubtitles = detectResult.success
          ? detectResult.data.detectedSubtitles
          : [];

        // 按置信度排序，选择最佳的源字幕和翻译字幕
        const sourceSubtitles = detectedSubtitles
          .filter((s: any) => s.type === 'source' || s.type === 'unknown')
          .sort((a: any, b: any) => b.confidence - a.confidence);
        const translatedSubtitles = detectedSubtitles
          .filter((s: any) => s.type === 'translated')
          .sort((a: any, b: any) => b.confidence - a.confidence);

        files.push({
          id: uuidv4(),
          videoPath,
          fileName: videoPath.split('/').pop() || '',
          detectedSubtitles,
          selectedSource: sourceSubtitles[0]?.filePath,
          selectedTarget: translatedSubtitles[0]?.filePath,
          sourceLanguage: sourceSubtitles[0]?.language,
          targetLanguage: translatedSubtitles[0]?.language,
          status: 'pending',
        });
      }

      if (files.length > 0) {
        onImportComplete(files, 'video');
      }
    } catch (error) {
      console.error('Failed to import videos:', error);
    }
  }, [onImportComplete]);

  // 导入字幕文件
  const handleImportSubtitles = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('selectFiles', {
        type: 'subtitle',
        multiple: true,
      });

      if (!result || result.canceled || result.filePaths.length === 0) return;

      // 检测每个文件的语言
      const allSubtitles: Array<{
        filePath: string;
        type: 'source' | 'translated' | 'unknown';
        language?: string;
        confidence: number;
      }> = [];

      for (const filePath of result.filePaths) {
        const langResult = await window.ipc.invoke('detectLanguage', {
          filePath,
        });
        const lang = langResult.success ? langResult.data?.code : undefined;
        // 英语作为源字幕，其他作为翻译字幕
        const type = lang === 'en' ? 'source' : lang ? 'translated' : 'unknown';
        allSubtitles.push({
          filePath,
          type: type as 'source' | 'translated' | 'unknown',
          language: lang,
          confidence: lang ? 90 : 80,
        });
      }

      // 匹配字幕对
      const matchResult = await window.ipc.invoke('matchSubtitleFiles', {
        files: result.filePaths,
      });

      const files: PendingFile[] = [];

      if (matchResult.success && matchResult.data.length > 0) {
        // 有匹配结果，按匹配分组
        for (const match of matchResult.data) {
          // 找到这个匹配组相关的所有字幕
          const relatedSubtitles = allSubtitles.filter(
            (s) => s.filePath === match.source || s.filePath === match.target,
          );

          files.push({
            id: uuidv4(),
            fileName: match.baseName,
            // 包含所有导入的字幕，让用户可以选择
            detectedSubtitles: allSubtitles,
            selectedSource: match.source,
            selectedTarget: match.target,
            sourceLanguage: match.sourceLanguage,
            targetLanguage: match.targetLanguage,
            status: 'pending',
          });
        }
      } else {
        // 无法匹配，创建一个条目，包含所有字幕供选择
        const sourceSubtitle =
          allSubtitles.find((s) => s.type === 'source') || allSubtitles[0];
        const targetSubtitle = allSubtitles.find(
          (s) =>
            s.type === 'translated' && s.filePath !== sourceSubtitle?.filePath,
        );

        files.push({
          id: uuidv4(),
          fileName:
            sourceSubtitle?.filePath
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '') || 'Subtitles',
          detectedSubtitles: allSubtitles,
          selectedSource: sourceSubtitle?.filePath,
          selectedTarget: targetSubtitle?.filePath,
          sourceLanguage: sourceSubtitle?.language,
          targetLanguage: targetSubtitle?.language,
          status: 'pending',
        });
      }

      if (files.length > 0) {
        onImportComplete(files, 'subtitle');
      }
    } catch (error) {
      console.error('Failed to import subtitles:', error);
    }
  }, [onImportComplete]);

  // 导入文件夹（智能检测）
  const handleImportFolder = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('selectDirectory');
      if (!result || result.canceled || !result.directoryPath) return;

      // 智能扫描目录
      const scanResult = await window.ipc.invoke('smartScanDirectory', {
        directoryPath: result.directoryPath,
      });

      if (!scanResult.success) {
        toast.error(t('scanFailed') || '扫描目录失败');
        return;
      }

      const { videos, subtitles } = scanResult.data;

      if (videos.length === 0 && subtitles.length === 0) {
        toast.info(t('noFilesFound') || '未找到视频或字幕文件');
        return;
      }

      const files: PendingFile[] = [];

      // 智能检测：如果有视频，按视频模式处理
      if (videos.length > 0) {
        for (const videoPath of videos) {
          const detectResult = await window.ipc.invoke('detectSubtitles', {
            videoPath,
          });
          const detectedSubtitles = detectResult.success
            ? detectResult.data.detectedSubtitles
            : [];

          const sourceSubtitles = detectedSubtitles
            .filter((s: any) => s.type === 'source' || s.type === 'unknown')
            .sort((a: any, b: any) => b.confidence - a.confidence);
          const translatedSubtitles = detectedSubtitles
            .filter((s: any) => s.type === 'translated')
            .sort((a: any, b: any) => b.confidence - a.confidence);

          files.push({
            id: uuidv4(),
            videoPath,
            fileName: videoPath.split('/').pop() || '',
            detectedSubtitles,
            selectedSource: sourceSubtitles[0]?.filePath,
            selectedTarget: translatedSubtitles[0]?.filePath,
            sourceLanguage: sourceSubtitles[0]?.language,
            targetLanguage: translatedSubtitles[0]?.language,
            status: 'pending',
          });
        }

        if (files.length > 0) {
          onImportComplete(files, 'video');
        }
      } else {
        // 没有视频，按字幕模式处理
        const allSubtitles: Array<{
          filePath: string;
          type: 'source' | 'translated' | 'unknown';
          language?: string;
          confidence: number;
        }> = [];

        for (const filePath of subtitles) {
          const langResult = await window.ipc.invoke('detectLanguage', {
            filePath,
          });
          const lang = langResult.success ? langResult.data?.code : undefined;
          const type =
            lang === 'en' ? 'source' : lang ? 'translated' : 'unknown';
          allSubtitles.push({
            filePath,
            type: type as 'source' | 'translated' | 'unknown',
            language: lang,
            confidence: lang ? 90 : 80,
          });
        }

        // 匹配字幕对
        const matchResult = await window.ipc.invoke('matchSubtitleFiles', {
          files: subtitles,
        });

        if (matchResult.success && matchResult.data.length > 0) {
          for (const match of matchResult.data) {
            if (match.source) {
              const baseName = match.baseName.toLowerCase();
              const relatedSubtitles = allSubtitles.filter((s) => {
                const fileName =
                  s.filePath.split('/').pop()?.toLowerCase() || '';
                return (
                  fileName.includes(baseName) ||
                  baseName.includes(fileName.replace(/\.[^.]+$/, ''))
                );
              });

              files.push({
                id: uuidv4(),
                fileName: match.baseName,
                detectedSubtitles:
                  relatedSubtitles.length > 0
                    ? relatedSubtitles
                    : [
                        {
                          filePath: match.source,
                          type: 'source' as const,
                          language: match.sourceLanguage,
                          confidence: 90,
                        },
                        ...(match.target
                          ? [
                              {
                                filePath: match.target,
                                type: 'translated' as const,
                                language: match.targetLanguage,
                                confidence: 90,
                              },
                            ]
                          : []),
                      ],
                selectedSource: match.source,
                selectedTarget: match.target,
                sourceLanguage: match.sourceLanguage,
                targetLanguage: match.targetLanguage,
                status: 'pending',
              });
            }
          }
        }

        if (files.length > 0) {
          onImportComplete(files, 'subtitle');
        }
      }
    } catch (error) {
      console.error('Failed to import folder:', error);
    }
  }, [onImportComplete, t]);

  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-xl font-semibold mb-2">
          {t('selectImportMethod') || '选择导入方式'}
        </h2>
        <p className="text-muted-foreground">
          {t('importMethodDescription') || '导入视频或字幕文件开始批量校对'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl mx-auto">
        <Card
          className="cursor-pointer hover:bg-accent transition-colors border-2 hover:border-primary"
          onClick={handleImportVideos}
        >
          <CardHeader className="text-center pb-2">
            <Video className="w-12 h-12 mx-auto text-primary" />
            <CardTitle className="text-lg">
              {t('importVideos') || '导入视频'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            {t('importVideosDesc') || '导入视频文件，自动检测关联字幕'}
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:bg-accent transition-colors border-2 hover:border-primary"
          onClick={handleImportSubtitles}
        >
          <CardHeader className="text-center pb-2">
            <FileText className="w-12 h-12 mx-auto text-primary" />
            <CardTitle className="text-lg">
              {t('importSubtitles') || '导入字幕'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            {t('importSubtitlesDesc') || '直接导入字幕文件进行校对'}
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:bg-accent transition-colors border-2 hover:border-primary"
          onClick={handleImportFolder}
        >
          <CardHeader className="text-center pb-2">
            <FolderOpen className="w-12 h-12 mx-auto text-primary" />
            <CardTitle className="text-lg">
              {t('importFolder') || '导入文件夹'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            {t('importFolderDesc') || '扫描文件夹，批量导入字幕文件'}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
