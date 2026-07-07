/**
 * 预览播放器（media:// 本地协议）：视频渲染等比缩放画面;
 * 纯音频（导入音频 / 音频任务跳转）渲染紧凑播放条,不占大黑块。
 * 进度回报给行列表双向联动。
 */
import React, {
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import ReactPlayer from 'react-player';
import { isAudioPath } from 'lib/utils';

export interface DubbingPlayerHandle {
  seekToMs: (ms: number) => void;
}

interface DubbingPlayerProps {
  videoPath: string;
  onProgressMs: (ms: number) => void;
}

const DubbingPlayer = forwardRef<DubbingPlayerHandle, DubbingPlayerProps>(
  function DubbingPlayer({ videoPath, onProgressMs }, ref) {
    const playerRef = useRef<ReactPlayer>(null);

    useImperativeHandle(ref, () => ({
      seekToMs: (ms: number) => {
        playerRef.current?.seekTo(ms / 1000, 'seconds');
      },
    }));

    const handleProgress = useCallback(
      (state: { playedSeconds: number }) => {
        onProgressMs(Math.round(state.playedSeconds * 1000));
      },
      [onProgressMs],
    );

    // 纯音频：紧凑播放条（无视频画面,不渲染黑色占位块）
    if (isAudioPath(videoPath)) {
      return (
        <div className="rounded-md bg-muted/30 p-1.5">
          <ReactPlayer
            ref={playerRef}
            url={`media://${encodeURIComponent(videoPath)}`}
            width="100%"
            height="54px"
            controls
            progressInterval={100}
            onProgress={handleProgress}
            config={{ file: { forceAudio: true } }}
          />
        </div>
      );
    }

    return (
      <div className="flex h-[32vh] items-center justify-center bg-black">
        <ReactPlayer
          ref={playerRef}
          url={`media://${encodeURIComponent(videoPath)}`}
          width="100%"
          height="100%"
          controls
          progressInterval={100}
          onProgress={handleProgress}
          config={{
            file: {
              attributes: {
                // 等比缩放：video 元素在容器内 contain,不拉伸变形
                style: {
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                },
              },
            },
          }}
        />
      </div>
    );
  },
);

export default DubbingPlayer;
