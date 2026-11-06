import React from 'react';
import { render, waitFor } from '@testing-library/react';
import VideoPlayer from '../subtitle/VideoPlayer';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('react-player', () => {
  const React = require('react');
  return React.forwardRef(function MockPlayer(props: any, _ref: any) {
    const media = React.useRef(null);
    React.useEffect(() => {
      props.onReady({ getInternalPlayer: () => media.current });
    }, []);
    return <video ref={media} data-testid="player" />;
  });
});

test('late and replaced tracks update the same media element and clean up independently', async () => {
  const props = {
    videoPath: '/video.mp4',
    playerRef: React.createRef<any>(),
    isPlaying: false,
    playbackRate: 1,
    togglePlay: jest.fn(),
    goToNextSubtitle: jest.fn(),
    goToPreviousSubtitle: jest.fn(),
    seekVideo: jest.fn(),
    handleProgress: jest.fn(),
    setDuration: jest.fn(),
    changePlaybackRate: jest.fn(),
    setPlaybackRate: jest.fn(),
  };
  // jsdom does not implement HTMLTrackElement.track.
  Object.defineProperty(HTMLTrackElement.prototype, 'track', {
    configurable: true,
    get: () => ({ mode: 'disabled' }),
  });
  const track = {
    kind: 'subtitles',
    src: 'blob:first',
    srcLang: 'en',
    label: 'English',
    default: true,
  };
  const view = render(<VideoPlayer {...props} subtitleTracks={[]} />);
  const media = view.getByTestId('player') as HTMLVideoElement;
  media.currentTime = 12;
  view.rerender(<VideoPlayer {...props} subtitleTracks={[track]} />);
  await waitFor(() =>
    expect(media.querySelector('track')?.src).toBe('blob:first'),
  );
  expect(media.querySelector('track')?.default).toBe(true);
  view.rerender(
    <VideoPlayer
      {...props}
      subtitleTracks={[{ ...track, src: 'blob:retry' }]}
    />,
  );
  await waitFor(() =>
    expect(media.querySelector('track')?.src).toBe('blob:retry'),
  );
  expect(view.getByTestId('player')).toBe(media);
  expect(media.currentTime).toBe(12);
  expect(media.querySelectorAll('track')).toHaveLength(1);
  view.unmount();
  expect(media.querySelectorAll('track')).toHaveLength(0);
  delete (HTMLTrackElement.prototype as any).track;
});
