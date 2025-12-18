import { useState, useRef, useEffect } from 'react';
import ReactPlayer from 'react-player';
import { Subtitle } from './useSubtitles';

// 格式化时间为 MM:SS 格式
export const formatTime = (seconds: number): string => {
  if (!seconds && seconds !== 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export const useVideoPlayer = (
  mergedSubtitles: Subtitle[],
  currentSubtitleIndex: number,
  setCurrentSubtitleIndex: (index: number) => void,
) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const playerRef = useRef<ReactPlayer>(null);

  // 根据当前播放时间查找活跃字幕
  useEffect(() => {
    if (currentTime >= 0 && mergedSubtitles.length > 0) {
      const index = mergedSubtitles.findIndex(
        (sub) =>
          sub.startTimeInSeconds <= currentTime &&
          sub.endTimeInSeconds > currentTime,
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

  // 播放器进度更新
  const handleProgress = ({ playedSeconds }) => {
    setCurrentTime(playedSeconds);
  };

  const togglePlay = () => {
    setIsPlaying(!isPlaying);
  };

  // 点击字幕跳转到对应时间点
  const handleSubtitleClick = (index: number) => {
    if (index >= 0 && index < mergedSubtitles.length) {
      // 无论是否有视频，都要更新当前字幕索引
      setCurrentSubtitleIndex(index);

      // 如果有视频播放器，跳转到对应时间点
      if (playerRef.current) {
        const startTime = mergedSubtitles[index]?.startTimeInSeconds ?? 0;
        playerRef.current.seekTo(startTime);
      }
    }
  };

  // 跳转到下一个字幕
  const goToNextSubtitle = () => {
    const nextIndex = Math.min(
      currentSubtitleIndex + 1,
      mergedSubtitles.length - 1,
    );
    if (nextIndex !== currentSubtitleIndex && nextIndex >= 0) {
      handleSubtitleClick(nextIndex);
    }
  };

  // 跳转到上一个字幕
  const goToPreviousSubtitle = () => {
    const prevIndex = Math.max(currentSubtitleIndex - 1, 0);
    if (prevIndex !== currentSubtitleIndex) {
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

  // 播放速度控制
  const changePlaybackRate = (delta: number) => {
    const newRate = Math.max(0.25, Math.min(2, playbackRate + delta));
    setPlaybackRate(newRate);
  };

  return {
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
  };
};
