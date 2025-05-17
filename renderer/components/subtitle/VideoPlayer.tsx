import React from 'react';
import ReactPlayer from 'react-player';
import { useTranslation } from 'next-i18next';

interface VideoPlayerProps {
  videoPath: string;
  playerRef: React.RefObject<ReactPlayer>;
  isPlaying: boolean;
  playbackRate: number;
  subtitleTracks?: Array<{
    kind: string;
    src: string;
    srcLang: string;
    default?: boolean;
    label: string;
  }>;
  togglePlay: () => void;
  goToNextSubtitle: () => void;
  goToPreviousSubtitle: () => void;
  seekVideo: (seconds: number) => void;
  handleProgress: (state: { playedSeconds: number }) => void;
  setDuration: (duration: number) => void;
  changePlaybackRate: (delta: number) => void;
  setPlaybackRate: (rate: number) => void;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoPath,
  playerRef,
  isPlaying,
  playbackRate,
  subtitleTracks,
  handleProgress,
  setDuration,
}) => {
  const { t } = useTranslation('home');
  return (
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
            key={subtitleTracks?.[0]?.label}
            config={{
              file: {
                tracks: subtitleTracks,
              },
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500">
            {t('videoNotFound')}
          </div>
        )}
      </div>

      {/* 视频控制按钮区域 */}
      {/* <div className="p-2 border rounded-md bg-muted/30">
        <div className="text-sm mb-2">{t('playbackControls')}</div>
        <div className="flex justify-between items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => seekVideo(-5)}
          >
            <Rewind className="h-3 w-3" />
            <span className="sr-only">{t('rewind5Seconds')}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={goToPreviousSubtitle}
          >
            <SkipBack className="h-3 w-3" />
            <span className="sr-only">{t('previousSubtitle')}</span>
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
            {isPlaying ? t('pause') : t('play')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={goToNextSubtitle}
          >
            <SkipForward className="h-3 w-3" />
            <span className="sr-only">{t('nextSubtitle')}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => seekVideo(5)}
          >
            <FastForward className="h-3 w-3" />
            <span className="sr-only">{t('forward5Seconds')}</span>
          </Button>
        </div>

        <div className="flex justify-between items-center mt-2">
          <div className="text-sm">
            {t('playbackSpeed')}: {playbackRate.toFixed(2)}x
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
      </div> */}
    </div>
  );
};

export default VideoPlayer;
