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
import { toast } from 'sonner';

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
      const result: Subtitle[] = await window.ipc.invoke('readSubtitleFile', {
        filePath,
      });
      return result;
    } catch (error) {
      console.error('Error reading subtitle file:', error);
      return [];
    }
  };

  // 处理双语字幕，拆分为原文和翻译

  // 加载文件
  const loadFiles = async () => {
    try {
      // 获取文件路径
      const {
        filePath,
        srtFile,
        tempSrtFile,
        translatedSrtFile,
        tempTranslatedSrtFile,
      } = file;
      const directory = path.dirname(filePath);
      const fileName = path.basename(filePath, path.extname(filePath));

      // 如果不是字幕文件，直接使用作为视频文件
      if (!isSubtitleFile(filePath)) {
        setVideoPath(filePath);
      }

      // 确定原始字幕文件路径
      let originalSrtFilePath = null;
      let translatedSrtFilePath = null;

      // 根据任务类型确定使用哪个原始字幕文件
      if (taskType === 'generateOnly') {
        originalSrtFilePath =
          srtFile || path.join(directory, `${fileName}.srt`);
        setHasTranslationFile(false);
      } else {
        // 对于需要翻译的任务，优先使用临时原始字幕文件
        originalSrtFilePath =
          tempSrtFile || srtFile || path.join(directory, `${fileName}.srt`);

        // 翻译字幕直接使用tempTranslatedSrtFile
        if (tempTranslatedSrtFile) {
          translatedSrtFilePath = tempTranslatedSrtFile;
          setHasTranslationFile(true);
        } else if (translatedSrtFile) {
          translatedSrtFilePath = translatedSrtFile;
          setHasTranslationFile(true);
        }
      }

      console.log('Paths:', {
        originalSrtFilePath,
        translatedSrtFilePath,
      });

      // 读取原始字幕文件
      let originalSubtitles = [];
      let translatedSubtitles = [];

      if (originalSrtFilePath) {
        originalSubtitles = await readSubtitleFile(originalSrtFilePath);
        console.log('原始字幕:', originalSubtitles);
      }

      // 读取翻译字幕文件（如果存在）
      if (shouldShowTranslation && translatedSrtFilePath) {
        translatedSubtitles = await readSubtitleFile(translatedSrtFilePath);
        console.log('翻译字幕:', translatedSubtitles);
      }

      // 合并字幕，匹配相同的时间码
      if (originalSubtitles.length > 0) {
        // 创建翻译字幕的时间码映射，提高查找效率
        const translatedMap = new Map();
        translatedSubtitles.forEach((sub) => {
          translatedMap.set(sub.startEndTime, sub);
        });

        // 创建合并的字幕数据
        const merged = originalSubtitles.map((sub, index) => {
          // 直接从Map中获取对应时间码的翻译字幕
          const translated =
            translatedMap.get(sub.startEndTime) ||
            (index < translatedSubtitles.length
              ? translatedSubtitles[index]
              : null);

          return {
            ...sub,
            sourceContent: sub.content.join('\n'),
            targetContent: translated ? translated.content.join('\n') : '',
            isEditing: false,
          };
        });

        setMergedSubtitles(merged);
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
      const { srtFile, tempSrtFile, translatedSrtFile, tempTranslatedSrtFile } =
        file;

      // 保存原始字幕
      if (srtFile && formData.sourceSrtSaveOption !== 'noSave') {
        console.log('保存原始字幕', srtFile);
        window.ipc.invoke('saveSubtitleFile', {
          filePath: srtFile,
          subtitles: mergedSubtitles,
          contentType: 'source',
        });
      }
      if (tempSrtFile) {
        console.log('保存临时原始字幕', tempSrtFile);
        window.ipc.invoke('saveSubtitleFile', {
          filePath: tempSrtFile,
          subtitles: mergedSubtitles,
          contentType: 'source',
        });
      }

      // 保存翻译字幕（只在需要显示翻译内容且有翻译内容时）
      if (shouldShowTranslation) {
        // 保存到翻译字幕文件
        if (translatedSrtFile) {
          window.ipc.invoke('saveSubtitleFile', {
            filePath: translatedSrtFile,
            subtitles: mergedSubtitles,
            contentType: formData.translateContent,
          });
        }

        // 如果有指定的临时翻译文件且不同于主翻译文件，也保存一份
        if (tempTranslatedSrtFile) {
          window.ipc.invoke('saveSubtitleFile', {
            filePath: tempTranslatedSrtFile,
            subtitles: mergedSubtitles,
            contentType: 'onlyTranslate',
          });
        }
      }
      toast.success(t('subtitleSavedSuccess'));
    } catch (error) {
      console.error('Error saving subtitles:', error);
      toast.error(t('saveFailed'));
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
