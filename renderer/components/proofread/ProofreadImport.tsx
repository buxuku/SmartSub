import React, { useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import StepGuide from '@/components/StepGuide';
import { Video, FileText, FolderOpen, PenLine, Save } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'sonner';
import {
  PendingFile,
  DetectedSubtitle,
  createPendingFileFromVideo,
  createPendingFileFromSubtitle,
  selectBestSubtitles,
  classifySubtitleLang,
} from '@/lib/proofreadUtils';
import path from 'path';

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

      // 使用工具函数创建 PendingFile
      const files = await Promise.all(
        result.filePaths.map((videoPath: string) =>
          createPendingFileFromVideo(videoPath),
        ),
      );

      if (files.length > 0) {
        onImportComplete(files, 'video');
      }
    } catch (error) {
      console.error('Failed to import videos:', error);
      toast.error(t('importVideosFailed'));
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

      // 使用工具函数创建 PendingFile
      const files = await Promise.all(
        result.filePaths.map((filePath: string) =>
          createPendingFileFromSubtitle(filePath),
        ),
      );

      if (files.length > 0) {
        onImportComplete(files, 'subtitle');
      }
    } catch (error) {
      console.error('Failed to import subtitles:', error);
      toast.error(t('importSubtitlesFailed'));
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
        toast.error(t('scanFailed'));
        return;
      }

      const { videos, subtitles } = scanResult.data;

      if (videos.length === 0 && subtitles.length === 0) {
        toast.info(t('noFilesFound'));
        return;
      }

      // 智能检测：如果有视频，按视频模式处理
      if (videos.length > 0) {
        // 使用工具函数创建 PendingFile
        const files = await Promise.all(
          videos.map((videoPath: string) =>
            createPendingFileFromVideo(videoPath),
          ),
        );

        if (files.length > 0) {
          onImportComplete(files, 'video');
        }
      } else {
        // 没有视频，按字幕模式处理
        const allSubtitles: DetectedSubtitle[] = [];
        // 取用户任务语向，用于判定每个字幕是原文还是译文
        const userConfig = await window.ipc.invoke('getUserConfig');

        for (const filePath of subtitles) {
          const langResult = await window.ipc.invoke('detectLanguage', {
            filePath,
          });
          const lang = langResult.success ? langResult.data?.code : undefined;
          const type = classifySubtitleLang(
            lang,
            userConfig?.sourceLanguage,
            userConfig?.targetLanguage,
          );
          allSubtitles.push({
            filePath,
            type,
            language: lang,
            confidence: lang ? 90 : 80,
          });
        }

        // 匹配字幕对
        const matchResult = await window.ipc.invoke('matchSubtitleFiles', {
          files: subtitles,
        });

        const files: PendingFile[] = [];

        if (matchResult.success && matchResult.data.length > 0) {
          for (const match of matchResult.data) {
            if (match.source) {
              const baseName = match.baseName.toLowerCase();
              const relatedSubtitles = allSubtitles.filter((s) => {
                const fileName = path.basename(s.filePath).toLowerCase();
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
      toast.error(t('importFolderFailed'));
    }
  }, [onImportComplete, t]);

  // 统一三步引导（P0 动线统一，与任务/配音/合成页同形态）；三种导入方式收敛为行动按钮组
  return (
    <StepGuide
      steps={[
        {
          icon: Video,
          title: t('guide.step1'),
          desc: t('guide.step1Desc'),
        },
        {
          icon: PenLine,
          title: t('guide.step2'),
          desc: t('guide.step2Desc'),
        },
        {
          icon: Save,
          title: t('guide.step3'),
          desc: t('guide.step3Desc'),
        },
      ]}
      actions={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={handleImportVideos} title={t('importVideosDesc')}>
            <Video className="h-4 w-4" />
            {t('importVideos')}
          </Button>
          <Button
            variant="secondary"
            onClick={handleImportSubtitles}
            title={t('importSubtitlesDesc')}
          >
            <FileText className="h-4 w-4" />
            {t('importSubtitles')}
          </Button>
          <Button
            variant="secondary"
            onClick={handleImportFolder}
            title={t('importFolderDesc')}
          >
            <FolderOpen className="h-4 w-4" />
            {t('importFolder')}
          </Button>
        </div>
      }
      dropHint={t('importMethodDescription')}
    />
  );
}
