import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import StepGuide from '@/components/StepGuide';
import { Video, FileText, FolderOpen, PenLine, Save } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  PendingFile,
  DetectedSubtitle,
  createPendingFileFromVideo,
  createPendingFileFromSubtitle,
  classifySubtitleLang,
} from '@/lib/proofreadUtils';
import path from 'path';
import { useProofreadAction } from '../../hooks/useProofreadAction';
import { ProofreadActionStatus } from './ProofreadActionStatus';

interface ProofreadImportProps {
  onImportComplete: (files: PendingFile[], type: 'video' | 'subtitle') => void;
}

export default function ProofreadImport({
  onImportComplete,
}: ProofreadImportProps) {
  const { t } = useTranslation('home');
  const action = useProofreadAction();

  const importFiles = (type: 'video' | 'subtitle') => {
    let selection: { canceled?: boolean; filePaths: string[] } | undefined;
    void action.run(
      async (invoke) => {
        selection ||= await invoke('selectFiles', { type, multiple: true });
        if (selection?.canceled) return [];
        if (!Array.isArray(selection?.filePaths))
          throw new Error('INVALID_FILE_SELECTION');
        return Promise.all(
          Array.from(new Set(selection.filePaths)).map((file) =>
            type === 'video'
              ? createPendingFileFromVideo(file, { strict: true })
              : createPendingFileFromSubtitle(file, true, { strict: true }),
          ),
        );
      },
      (files) => {
        if (files.length) onImportComplete(files, type);
      },
    );
  };

  // 导入视频文件
  const handleImportVideos = () => importFiles('video');

  // 导入字幕文件
  const handleImportSubtitles = () => importFiles('subtitle');

  // 导入文件夹（智能检测）
  const handleImportFolder = () => {
    let result: { canceled?: boolean; directoryPath?: string } | undefined;
    void action.run(
      async (invoke) => {
        result ||= await invoke('selectDirectory');
        if (result?.canceled) return null;
        if (!result?.directoryPath)
          throw new Error('INVALID_DIRECTORY_SELECTION');

        // 智能扫描目录
        const scanResult = await invoke('smartScanDirectory', {
          directoryPath: result.directoryPath,
          strict: true,
        });

        if (scanResult?.success !== true)
          throw new Error(scanResult?.error || t('scanFailed'));

        const { videos, subtitles } = scanResult.data;
        if (!Array.isArray(videos) || !Array.isArray(subtitles))
          throw new Error('INVALID_DIRECTORY_SCAN_RESPONSE');

        if (videos.length === 0 && subtitles.length === 0) {
          throw new Error(t('noFilesFound'));
        }

        // 智能检测：如果有视频，按视频模式处理
        if (videos.length > 0) {
          // 使用工具函数创建 PendingFile
          const files = await Promise.all(
            videos.map((videoPath: string) =>
              createPendingFileFromVideo(videoPath, { strict: true }),
            ),
          );

          return { files, type: 'video' as const };
        } else {
          // 没有视频，按字幕模式处理
          const allSubtitles: DetectedSubtitle[] = [];
          // 取用户任务语向，用于判定每个字幕是原文还是译文
          const userConfig = await invoke('getUserConfig');

          for (const filePath of subtitles) {
            const langResult = await invoke('detectLanguage', {
              filePath,
            });
            if (langResult?.success !== true)
              throw new Error(langResult?.error || 'INVALID_LANGUAGE_RESPONSE');
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
          const matchResult = await invoke('matchSubtitleFiles', {
            files: subtitles,
          });
          if (matchResult?.success !== true || !Array.isArray(matchResult.data))
            throw new Error(
              matchResult?.error || 'INVALID_SUBTITLE_MATCH_RESPONSE',
            );

          const files: PendingFile[] = [];
          const matchedPaths = new Set<string>();

          if (matchResult.success && matchResult.data.length > 0) {
            for (const match of matchResult.data) {
              if (
                !match ||
                typeof match.baseName !== 'string' ||
                (!match.source && !match.target) ||
                [match.source, match.target].some(
                  (file) =>
                    file !== undefined &&
                    (typeof file !== 'string' ||
                      !subtitles.includes(file) ||
                      matchedPaths.has(file)),
                ) ||
                match.source === match.target
              )
                throw new Error('INVALID_SUBTITLE_MATCH_RESPONSE');
              if (match.source || match.target) {
                if (match.source) matchedPaths.add(match.source);
                if (match.target) matchedPaths.add(match.target);
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
                            filePath: match.source || match.target,
                            type: 'source' as const,
                            language: match.source
                              ? match.sourceLanguage
                              : match.targetLanguage,
                            confidence: 90,
                          },
                          ...(match.source && match.target
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
                  selectedSource: match.source || match.target,
                  selectedTarget: match.source ? match.target : undefined,
                  sourceLanguage: match.source
                    ? match.sourceLanguage
                    : match.targetLanguage,
                  targetLanguage: match.source
                    ? match.targetLanguage
                    : undefined,
                  status: 'pending',
                });
              }
            }
          }

          // More than two language variants may share a basename. Keep every
          // unpaired file as an independent item instead of hiding it in a menu.
          for (const subtitle of allSubtitles) {
            if (matchedPaths.has(subtitle.filePath)) continue;
            files.push({
              id: uuidv4(),
              fileName: path.basename(
                subtitle.filePath,
                path.extname(subtitle.filePath),
              ),
              detectedSubtitles: [{ ...subtitle, type: 'source' }],
              selectedSource: subtitle.filePath,
              sourceLanguage: subtitle.language,
              status: 'pending',
            });
          }

          if (!files.length) throw new Error(t('noFilesFound'));
          return { files, type: 'subtitle' as const };
        }
      },
      (result) => {
        if (result) onImportComplete(result.files, result.type);
      },
    );
  };

  // 统一三步引导（P0 动线统一，与任务/配音/合成页同形态）；三种导入方式收敛为行动按钮组
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProofreadActionStatus {...action} />
      <div className="min-h-0 flex-1 overflow-auto">
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
              <Button
                disabled={action.busy}
                onClick={handleImportVideos}
                title={t('importVideosDesc')}
              >
                <Video className="h-4 w-4" />
                {t('importVideos')}
              </Button>
              <Button
                variant="secondary"
                onClick={handleImportSubtitles}
                disabled={action.busy}
                title={t('importSubtitlesDesc')}
              >
                <FileText className="h-4 w-4" />
                {t('importSubtitles')}
              </Button>
              <Button
                variant="secondary"
                onClick={handleImportFolder}
                disabled={action.busy}
                title={t('importFolderDesc')}
              >
                <FolderOpen className="h-4 w-4" />
                {t('importFolder')}
              </Button>
            </div>
          }
          dropHint={t('importMethodDescription')}
        />
      </div>
    </div>
  );
}
