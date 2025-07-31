import React, { useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Save } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { IFiles } from '../../types';

// 导入自定义Hook
import { useSubtitles } from '../hooks/useSubtitles';
import { useVideoPlayer } from '../hooks/useVideoPlayer';

// 导入子组件
import VideoPlayer from './subtitle/VideoPlayer';
import CurrentSubtitle from './subtitle/CurrentSubtitle';
import VideoInfo from './subtitle/VideoInfo';
import SubtitleList from './subtitle/SubtitleList';

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

  // 使用自定义Hook获取字幕相关状态和方法
  const {
    mergedSubtitles,
    videoPath,
    currentSubtitleIndex,
    setCurrentSubtitleIndex,
    videoInfo,
    hasTranslationFile,
    shouldShowTranslation,
    subtitleTracksForPlayer,
    handleSubtitleChange,
    handleSave,
    getSubtitleStats,
    isTranslationFailed,
    getFailedTranslationIndices,
    goToNextFailedTranslation,
    goToPreviousFailedTranslation,
  } = useSubtitles(file, open, taskType, formData);

  // 使用自定义Hook获取视频播放器相关状态和方法
  const {
    currentTime,
    duration,
    setDuration,
    isPlaying,
    playbackRate,
    playerRef,
    handleProgress,
    togglePlay,
    handleSubtitleClick,
    goToNextSubtitle,
    goToPreviousSubtitle,
    seekVideo,
    changePlaybackRate,
    setPlaybackRate,
  } = useVideoPlayer(
    mergedSubtitles,
    currentSubtitleIndex,
    setCurrentSubtitleIndex,
  );

  // 用于同步状态和调试
  useEffect(() => {
    if (mergedSubtitles.length > 0) {
      console.log(
        `加载了 ${mergedSubtitles.length} 条字幕，当前索引: ${currentSubtitleIndex}`,
      );
    }
  }, [mergedSubtitles.length, currentSubtitleIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl h-[920px] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('subtitleProofread')}</DialogTitle>
          <DialogDescription>
            Review and edit translated subtitles with video playback support.
          </DialogDescription>
        </DialogHeader>

        <div
          className={`grid gap-2 flex-1 overflow-hidden ${taskType === 'translateOnly' ? 'grid-cols-1' : 'grid-cols-2'}`}
        >
          {/* 左侧：视频播放器和控制区域 */}
          {taskType !== 'translateOnly' && (
            <div className="flex flex-col">
              {/* 视频播放器组件 */}
              <VideoPlayer
                videoPath={videoPath}
                playerRef={playerRef}
                isPlaying={isPlaying}
                playbackRate={playbackRate}
                togglePlay={togglePlay}
                goToNextSubtitle={goToNextSubtitle}
                goToPreviousSubtitle={goToPreviousSubtitle}
                seekVideo={seekVideo}
                handleProgress={handleProgress}
                setDuration={setDuration}
                changePlaybackRate={changePlaybackRate}
                setPlaybackRate={setPlaybackRate}
                subtitleTracks={subtitleTracksForPlayer}
              />

              {/* 当前字幕预览组件 */}
              <CurrentSubtitle
                currentSubtitleIndex={currentSubtitleIndex}
                currentTime={currentTime}
                duration={duration}
                mergedSubtitles={mergedSubtitles}
                shouldShowTranslation={shouldShowTranslation}
                hasTranslationFile={hasTranslationFile}
              />

              {/* 视频信息和字幕统计组件 */}
              <VideoInfo
                fileName={videoInfo.fileName}
                extension={videoInfo.extension}
                duration={duration}
                subtitleStats={getSubtitleStats()}
                shouldShowTranslation={shouldShowTranslation}
              />
            </div>
          )}

          {/* 右侧：字幕列表组件 */}
          <SubtitleList
            mergedSubtitles={mergedSubtitles}
            currentSubtitleIndex={currentSubtitleIndex}
            shouldShowTranslation={shouldShowTranslation}
            handleSubtitleClick={handleSubtitleClick}
            handleSubtitleChange={handleSubtitleChange}
            isTranslationFailed={isTranslationFailed}
            getFailedTranslationIndices={getFailedTranslationIndices}
            goToNextFailedTranslation={goToNextFailedTranslation}
            goToPreviousFailedTranslation={goToPreviousFailedTranslation}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave}>
            <Save className="h-4 w-4 mr-2" />
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SubtitleProofread;
