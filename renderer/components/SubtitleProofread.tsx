import React, { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import ReactPlayer from 'react-player';
import { useTranslation } from 'next-i18next';
import { isSubtitleFile } from 'lib/utils';
import {
  Save,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  FastForward,
  Rewind,
  FileVideo,
} from 'lucide-react';
import path from 'path';
import { IFiles } from '../../types';

// 类型定义
interface SubtitleFileResponse {
  content?: string;
  error?: string;
}

// 字幕格式接口
interface Subtitle {
  id: string;
  startEndTime: string;
  content: string[];
  sourceContent?: string;
  targetContent?: string;
  startTimeInSeconds?: number;
  endTimeInSeconds?: number;
}

// 将时间码转换为秒数
const timeToSeconds = (timeString: string): number => {
  const pattern = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/;
  const match = timeString.match(pattern);

  if (!match) return 0;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const milliseconds = parseInt(match[4], 10);

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
};

// 解析字幕文件内容
const parseSubtitles = (data: string[]): Subtitle[] => {
  const subtitles: Subtitle[] = [];
  let currentSubtitle: Subtitle | null = null;

  for (let i = 0; i < data.length; i++) {
    const line = data[i]?.trim();
    if (!line) continue;

    if (
      /^\d+$/.test(line) &&
      ((i + 1 < data.length && data[i + 1]?.trim().includes('-->')) ||
        (i + 1 < data.length &&
          !data[i + 1]?.trim() &&
          i + 2 < data.length &&
          data[i + 2]?.trim().includes('-->')))
    ) {
      if (currentSubtitle) {
        subtitles.push(currentSubtitle);
      }
      currentSubtitle = {
        id: line,
        startEndTime: '',
        content: [],
      };
    } else if (line.includes('-->')) {
      if (currentSubtitle) {
        currentSubtitle.startEndTime = line;
        // 提取开始和结束时间并转换为秒
        const [startTime, endTime] = line.split(' --> ');
        currentSubtitle.startTimeInSeconds = timeToSeconds(startTime);
        currentSubtitle.endTimeInSeconds = timeToSeconds(endTime);
      }
    } else if (currentSubtitle) {
      currentSubtitle.content.push(line);
    }
  }

  if (currentSubtitle) {
    subtitles.push(currentSubtitle);
  }

  return subtitles;
};

// 格式化字幕内容为SRT格式
const formatSubtitleToSrt = (subtitles: Subtitle[]): string => {
  return subtitles
    .map((subtitle) => {
      return `${subtitle.id}\n${subtitle.startEndTime}\n${subtitle.content.join('\n')}\n`;
    })
    .join('\n');
};

// 格式化时间为 MM:SS 格式
const formatTime = (seconds: number): string => {
  if (!seconds && seconds !== 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

interface SubtitleProofreadProps {
  file: IFiles;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskType: string;
  formData: any;
}

const SubtitleProofread: React.FC<SubtitleProofreadProps> = ({
  file,
  open,
  onOpenChange,
  taskType,
  formData,
}) => {
  const { t } = useTranslation('home');
  console.log(file, 'files--33');
  const [mergedSubtitles, setMergedSubtitles] = useState<
    (Subtitle & { isEditing?: boolean })[]
  >([]);
  const [videoPath, setVideoPath] = useState<string>('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSubtitleIndex, setCurrentSubtitleIndex] = useState(-1);
  const [videoInfo, setVideoInfo] = useState({ fileName: '', extension: '' });
  const [hasTranslationFile, setHasTranslationFile] = useState(false);
  const playerRef = useRef<ReactPlayer>(null);

  // 是否需要显示翻译内容
  const shouldShowTranslation = taskType !== 'generateOnly';

  useEffect(() => {
    if (file && open) {
      loadFiles();
    }
  }, [file, open]);

  // 根据当前播放时间查找活跃字幕
  useEffect(() => {
    if (currentTime > 0 && mergedSubtitles.length > 0) {
      const index = mergedSubtitles.findIndex(
        (sub) =>
          sub.startTimeInSeconds <= currentTime &&
          sub.endTimeInSeconds >= currentTime,
      );

      if (index !== -1 && index !== currentSubtitleIndex) {
        setCurrentSubtitleIndex(index);
        // 滚动到当前字幕
        const element = document.getElementById(`subtitle-${index}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  }, [currentTime, mergedSubtitles]);

  // 获取视频文件信息
  useEffect(() => {
    if (videoPath) {
      const fileName = path.basename(videoPath, path.extname(videoPath));
      const extension = path.extname(videoPath).replace('.', '');
      setVideoInfo({ fileName, extension });
    }
  }, [videoPath]);

  // 播放速度控制
  const [playbackRate, setPlaybackRate] = useState(1);
  const changePlaybackRate = (delta: number) => {
    const newRate = Math.max(0.25, Math.min(2, playbackRate + delta));
    setPlaybackRate(newRate);
  };

  // 读取字幕文件
  const readSubtitleFile = async (filePath: string): Promise<Subtitle[]> => {
    try {
      const result: SubtitleFileResponse = await window.ipc.invoke(
        'readSubtitleFile',
        { filePath },
      );
      if (!result.error && result.content) {
        return parseSubtitles(result.content.split('\n'));
      }
      return [];
    } catch (error) {
      console.error('Error reading subtitle file:', error);
      return [];
    }
  };

  // 处理双语字幕，拆分为原文和翻译
  const processBilingualSubtitles = (
    subtitles: Subtitle[],
  ): { sourceSubtitles: Subtitle[]; targetSubtitles: Subtitle[] } => {
    return subtitles
      .map((sub) => {
        // 检测双语字幕：如果一个字幕项包含空行，可能是双语分隔
        const contentLines = sub.content;
        let sourceLines = [];
        let targetLines = [];

        if (contentLines.length > 0) {
          // 寻找空行作为分隔符
          const emptyLineIndex = contentLines.findIndex(
            (line) => line.trim() === '',
          );

          if (
            emptyLineIndex !== -1 &&
            emptyLineIndex < contentLines.length - 1
          ) {
            // 根据formData.translateContent的配置决定哪部分是原文，哪部分是翻译
            if (formData?.translateContent === 'sourceAndTranslate') {
              // 原文在前，翻译在后
              sourceLines = contentLines.slice(0, emptyLineIndex);
              targetLines = contentLines.slice(emptyLineIndex + 1);
            } else {
              // 翻译在前，原文在后
              targetLines = contentLines.slice(0, emptyLineIndex);
              sourceLines = contentLines.slice(emptyLineIndex + 1);
            }
          } else {
            // 没找到明确分隔，假设全部是翻译内容
            targetLines = contentLines;
          }
        }

        return {
          sourceSubtitle: {
            ...sub,
            content: sourceLines,
          },
          targetSubtitle: {
            ...sub,
            content: targetLines,
          },
        };
      })
      .reduce(
        (acc, item) => {
          acc.sourceSubtitles.push(item.sourceSubtitle);
          acc.targetSubtitles.push(item.targetSubtitle);
          return acc;
        },
        { sourceSubtitles: [], targetSubtitles: [] },
      );
  };

  // 加载文件
  const loadFiles = async () => {
    try {
      // 获取文件路径
      const { filePath, srtFile, tempSrtFile, translatedSrtFile } = file;
      const directory = path.dirname(filePath);
      const fileName = path.basename(filePath, path.extname(filePath));

      // 如果不是字幕文件，直接使用作为视频文件
      if (!isSubtitleFile(filePath)) {
        setVideoPath(filePath);
      }

      // 确定是否需要翻译内容（基于taskType和formData.translateContent）
      const isDoubleLangSubtitle =
        formData?.translateContent === 'sourceAndTranslate' ||
        formData?.translateContent === 'translateAndSource';
      const needsTranslation = shouldShowTranslation && !isDoubleLangSubtitle;

      // 确定原始字幕和翻译字幕的文件路径
      let originalSrtFilePath = null;
      let translatedSrtFilePath = null;

      // 根据任务类型和配置选择正确的字幕文件
      if (taskType === 'generateOnly') {
        // 仅生成字幕，只需要读取原始字幕
        originalSrtFilePath =
          srtFile || path.join(directory, `${fileName}.srt`);
        setHasTranslationFile(false);
      } else {
        // 对于生成并翻译或仅翻译的任务
        originalSrtFilePath =
          tempSrtFile || srtFile || path.join(directory, `${fileName}.srt`);

        if (isDoubleLangSubtitle) {
          // 如果是双语字幕，只需要读取翻译后的文件
          originalSrtFilePath = translatedSrtFile;
          setHasTranslationFile(false);
        } else if (translatedSrtFile) {
          // 有翻译文件，设置翻译字幕路径
          translatedSrtFilePath = translatedSrtFile;
          setHasTranslationFile(true);
        }
      }

      console.log('Paths:', {
        originalSrtFilePath,
        translatedSrtFilePath,
        isDoubleLangSubtitle,
      });

      // 读取原始字幕文件
      if (originalSrtFilePath) {
        const subtitles = await readSubtitleFile(originalSrtFilePath);
        console.log('原始字幕:', subtitles);

        if (subtitles.length > 0) {
          // 检查原始字幕是否是双语字幕
          const originalIsDoubleLang =
            isDoubleLangSubtitle ||
            subtitles.some(
              (sub) =>
                sub.content.some((line) => line.trim() === '') &&
                sub.content.length > 2,
            );

          if (originalIsDoubleLang) {
            // 处理原始文件中的双语字幕，拆分为源和目标字幕
            console.log('处理双语字幕');
            const { sourceSubtitles, targetSubtitles } =
              processBilingualSubtitles(subtitles);

            // 创建合并的字幕数据
            const merged = sourceSubtitles.map((sub, index) => ({
              ...sub,
              sourceContent: sub.content.join('\n'),
              targetContent: targetSubtitles[index].content.join('\n'),
              isEditing: false,
            }));

            setMergedSubtitles(merged);
            setHasTranslationFile(true);
          } else if (needsTranslation && translatedSrtFilePath) {
            // 处理常规翻译场景：分别读取原文和翻译文件
            const translatedSubs = await readSubtitleFile(
              translatedSrtFilePath,
            );
            console.log('翻译字幕:', translatedSubs);

            // 合并字幕，匹配相同的时间码
            const merged = subtitles.map((sub, index) => {
              const translated =
                translatedSubs.find(
                  (ts) => ts.startEndTime === sub.startEndTime,
                ) || translatedSubs[index];
              return {
                ...sub,
                sourceContent: sub.content.join('\n'),
                targetContent: translated ? translated.content.join('\n') : '',
                isEditing: false,
              };
            });

            setMergedSubtitles(merged);
          } else {
            // 不需要处理翻译字幕或没有翻译文件
            const merged = subtitles.map((sub) => ({
              ...sub,
              sourceContent: sub.content.join('\n'),
              targetContent: '',
              isEditing: false,
            }));

            setMergedSubtitles(merged);
          }
        }
      }
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  // 更新字幕内容
  const handleSubtitleChange = (
    index: number,
    field: 'sourceContent' | 'targetContent',
    value: string,
  ) => {
    const newSubtitles = [...mergedSubtitles];
    newSubtitles[index][field] = value;
    // 更新content数组
    newSubtitles[index].content =
      field === 'sourceContent'
        ? value.split('\n')
        : newSubtitles[index].content;
    setMergedSubtitles(newSubtitles);
  };

  // 保存字幕文件
  const handleSave = async () => {
    try {
      // 获取文件路径
      const { filePath, srtFile, tempSrtFile, translatedSrtFile } = file;
      const directory = path.dirname(filePath);
      const fileName = path.basename(filePath, path.extname(filePath));

      // 确定是否是双语字幕配置
      const isDoubleLangSubtitle =
        formData?.translateContent === 'sourceAndTranslate' ||
        formData?.translateContent === 'translateAndSource';

      // 更新原始字幕
      const updatedOriginalSubtitles = mergedSubtitles.map((sub) => ({
        id: sub.id,
        startEndTime: sub.startEndTime,
        content: sub.sourceContent.split('\n'),
        startTimeInSeconds: sub.startTimeInSeconds,
        endTimeInSeconds: sub.endTimeInSeconds,
      }));

      // 确定原始字幕和翻译字幕的保存路径
      let originalSrtFilePath = null;
      let translatedSrtFilePath = null;

      if (taskType === 'generateOnly') {
        // 仅生成字幕，只需要保存原始字幕
        originalSrtFilePath =
          srtFile || path.join(directory, `${fileName}.srt`);
      } else {
        // 对于生成并翻译或仅翻译的任务
        originalSrtFilePath =
          tempSrtFile || srtFile || path.join(directory, `${fileName}.srt`);

        if (translatedSrtFile) {
          // 使用文件对象中的翻译字幕路径
          translatedSrtFilePath = translatedSrtFile;
        }
      }

      // 将字幕转换为SRT格式
      const originalSrtContent = formatSubtitleToSrt(updatedOriginalSubtitles);

      // 处理双语字幕的情况
      if (isDoubleLangSubtitle && translatedSrtFilePath) {
        // 对于双语字幕，我们只需要保存翻译字幕文件，但内容包含双语内容
        // 先将源内容和目标内容合并到翻译字幕内容中
        const doubleLangSubtitles = mergedSubtitles.map((sub) => {
          let content = [];
          if (formData?.translateContent === 'sourceAndTranslate') {
            // 先原文后翻译
            content = [...sub.sourceContent.split('\n')];
            if (sub.targetContent && sub.targetContent.trim() !== '') {
              content.push(''); // 添加空行分隔
              content = [...content, ...sub.targetContent.split('\n')];
            }
          } else {
            // 先翻译后原文
            content = sub.targetContent ? sub.targetContent.split('\n') : [];
            if (
              sub.sourceContent &&
              sub.sourceContent.trim() !== '' &&
              content.length > 0
            ) {
              content.push(''); // 添加空行分隔
              content = [...content, ...sub.sourceContent.split('\n')];
            }
          }
          return {
            id: sub.id,
            startEndTime: sub.startEndTime,
            content: content,
            startTimeInSeconds: sub.startTimeInSeconds,
            endTimeInSeconds: sub.endTimeInSeconds,
          };
        });

        const doubleLangSrtContent = formatSubtitleToSrt(doubleLangSubtitles);

        // 保存双语字幕
        window.ipc.send('saveSubtitleFile', {
          filePath: translatedSrtFilePath,
          content: doubleLangSrtContent,
        });
      } else {
        // 非双语情况，分别保存原始字幕和翻译字幕

        // 保存原始字幕
        if (originalSrtFilePath) {
          window.ipc.send('saveSubtitleFile', {
            filePath: originalSrtFilePath,
            content: originalSrtContent,
          });
        }

        // 保存翻译字幕（只在需要显示翻译内容且有翻译文件时）
        if (shouldShowTranslation && translatedSrtFilePath) {
          const updatedTranslatedSubtitles = mergedSubtitles.map((sub) => ({
            id: sub.id,
            startEndTime: sub.startEndTime,
            content: sub.targetContent ? sub.targetContent.split('\n') : [],
            startTimeInSeconds: sub.startTimeInSeconds,
            endTimeInSeconds: sub.endTimeInSeconds,
          }));

          const translatedSrtContent = formatSubtitleToSrt(
            updatedTranslatedSubtitles.filter((sub) => sub.content.length > 0),
          );

          window.ipc.send('saveSubtitleFile', {
            filePath: translatedSrtFilePath,
            content: translatedSrtContent,
          });
        }
      }

      // 显示成功消息
      window.ipc.send('message', { type: 'success', message: '字幕保存成功' });
    } catch (error) {
      console.error('Error saving subtitles:', error);
      window.ipc.send('message', { type: 'error', message: '保存字幕失败' });
    }
  };

  // 播放器进度更新
  const handleProgress = ({ playedSeconds }) => {
    setCurrentTime(playedSeconds);
  };

  const togglePlay = () => {
    setIsPlaying(!isPlaying);
  };

  // 点击字幕跳转到对应时间点
  const handleSubtitleClick = (index: number) => {
    if (playerRef.current && mergedSubtitles[index]?.startTimeInSeconds) {
      playerRef.current.seekTo(mergedSubtitles[index].startTimeInSeconds);
    }
  };

  // 跳转到下一个或上一个字幕
  const goToNextSubtitle = () => {
    if (currentSubtitleIndex < mergedSubtitles.length - 1) {
      const nextIndex = currentSubtitleIndex + 1;
      handleSubtitleClick(nextIndex);
    }
  };

  const goToPreviousSubtitle = () => {
    if (currentSubtitleIndex > 0) {
      const prevIndex = currentSubtitleIndex - 1;
      handleSubtitleClick(prevIndex);
    }
  };

  // 快进快退
  const seekVideo = (seconds: number) => {
    if (playerRef.current) {
      const currentTime = playerRef.current.getCurrentTime();
      playerRef.current.seekTo(currentTime + seconds);
    }
  };

  // 计算字幕统计信息
  const getSubtitleStats = () => {
    const total = mergedSubtitles.length;
    const withTranslation = shouldShowTranslation
      ? mergedSubtitles.filter(
          (sub) => sub.targetContent && sub.targetContent.trim() !== '',
        ).length
      : 0;
    const percent =
      total > 0 && shouldShowTranslation
        ? Math.round((withTranslation / total) * 100)
        : 0;

    return { total, withTranslation, percent };
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('subtitleProofread') || '字幕校对'}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 flex-1 overflow-hidden">
          {/* 左侧：视频播放器和控制区域 */}
          <div className="flex flex-col">
            <div className="relative aspect-video bg-black mb-2">
              {videoPath ? (
                <ReactPlayer
                  ref={playerRef}
                  url={`media://${encodeURIComponent(videoPath)}`}
                  width="100%"
                  height="100%"
                  playing={isPlaying}
                  controls={true}
                  playbackRate={playbackRate}
                  onProgress={handleProgress}
                  onDuration={setDuration}
                  progressInterval={100}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                  未找到视频文件
                </div>
              )}
            </div>

            {/* 视频信息和播放控制区域 */}
            <div className="flex flex-col gap-2">
              {/* 当前字幕预览 */}
              <div className="p-2 border rounded-md bg-muted/30">
                <div className="flex justify-between items-center mb-1">
                  <div className="text-sm">当前字幕</div>
                  <div className="text-xs text-gray-500">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </div>
                </div>

                {currentSubtitleIndex >= 0 &&
                mergedSubtitles[currentSubtitleIndex] ? (
                  <div>
                    <div className="text-xs text-gray-500">
                      {mergedSubtitles[currentSubtitleIndex].startEndTime}
                    </div>
                    {mergedSubtitles[currentSubtitleIndex].sourceContent && (
                      <div className="mb-1 p-1 bg-background rounded border-l-2 border-primary text-sm">
                        {mergedSubtitles[currentSubtitleIndex].sourceContent}
                      </div>
                    )}
                    {shouldShowTranslation &&
                      hasTranslationFile &&
                      mergedSubtitles[currentSubtitleIndex].targetContent && (
                        <div className="p-1 bg-background rounded border-l-2 border-secondary text-sm">
                          {mergedSubtitles[currentSubtitleIndex].targetContent}
                        </div>
                      )}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500 p-2">无当前字幕</div>
                )}
              </div>

              {/* 视频控制按钮区域 */}
              <div className="p-2 border rounded-md bg-muted/30">
                <div className="text-sm mb-2">播放控制</div>
                <div className="flex justify-between items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => seekVideo(-5)}
                  >
                    <Rewind className="h-3 w-3" />
                    <span className="sr-only">后退5秒</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={goToPreviousSubtitle}
                  >
                    <SkipBack className="h-3 w-3" />
                    <span className="sr-only">上一句</span>
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={togglePlay}
                    className="flex-1"
                  >
                    {isPlaying ? (
                      <Pause className="h-3 w-3 mr-1" />
                    ) : (
                      <Play className="h-3 w-3 mr-1" />
                    )}
                    {isPlaying ? '暂停' : '播放'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={goToNextSubtitle}
                  >
                    <SkipForward className="h-3 w-3" />
                    <span className="sr-only">下一句</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => seekVideo(5)}
                  >
                    <FastForward className="h-3 w-3" />
                    <span className="sr-only">前进5秒</span>
                  </Button>
                </div>

                <div className="flex justify-between items-center mt-2">
                  <div className="text-sm">
                    播放速度: {playbackRate.toFixed(2)}x
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => changePlaybackRate(-0.25)}
                      disabled={playbackRate <= 0.25}
                    >
                      -
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPlaybackRate(1)}
                    >
                      1x
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => changePlaybackRate(0.25)}
                      disabled={playbackRate >= 2}
                    >
                      +
                    </Button>
                  </div>
                </div>
              </div>

              {/* 文件信息和字幕统计 */}
              <div className="p-2 border rounded-md bg-muted/30">
                <div className="text-sm mb-1">文件信息</div>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <div className="flex items-center gap-1">
                    <FileVideo className="h-3 w-3" />
                    <span className="truncate" title={videoInfo.fileName}>
                      {videoInfo.fileName || '未知'} (
                      {videoInfo.extension || '未知'})
                    </span>
                  </div>
                  <div>时长: {formatTime(duration)}</div>
                </div>
                <Separator className="my-2" />
                <div className="text-sm mb-1">字幕统计</div>
                <div className="grid grid-cols-3 gap-1 text-xs">
                  <div>总数: {getSubtitleStats().total}</div>
                  {shouldShowTranslation && (
                    <>
                      <div>已翻译: {getSubtitleStats().withTranslation}</div>
                      <div>完成率: {getSubtitleStats().percent}%</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 右侧：字幕列表 */}
          <ScrollArea className="border rounded-md">
            <div className="p-2">
              {mergedSubtitles.map((subtitle, index) => (
                <div
                  key={`${subtitle.id}-${index}`}
                  id={`subtitle-${index}`}
                  className={`mb-2 p-2 rounded-md ${currentSubtitleIndex === index ? 'bg-accent' : 'bg-card hover:bg-accent/50'}`}
                  onClick={() => handleSubtitleClick(index)}
                >
                  <div className="flex justify-between items-center mb-1">
                    <div className="text-xs text-gray-500">
                      #{subtitle.id} · {subtitle.startEndTime}
                    </div>
                  </div>

                  {subtitle.sourceContent && (
                    <Textarea
                      className="min-h-[40px] mb-1 text-sm"
                      value={subtitle.sourceContent}
                      onChange={(e) =>
                        handleSubtitleChange(
                          index,
                          'sourceContent',
                          e.target.value,
                        )
                      }
                      placeholder={t('originalSubtitle') || '原文字幕'}
                    />
                  )}

                  {/* 只在需要显示翻译内容时显示翻译字幕框 */}
                  {shouldShowTranslation && (
                    <Textarea
                      className={`text-sm ${subtitle.targetContent ? 'min-h-[40px]' : 'min-h-[30px]'}`}
                      value={subtitle.targetContent || ''}
                      onChange={(e) =>
                        handleSubtitleChange(
                          index,
                          'targetContent',
                          e.target.value,
                        )
                      }
                      placeholder={t('translatedSubtitle') || '翻译字幕'}
                    />
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave}>
            <Save className="h-4 w-4 mr-2" />
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SubtitleProofread;
