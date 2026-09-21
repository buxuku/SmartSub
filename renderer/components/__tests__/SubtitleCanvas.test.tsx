import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import SubtitleCanvas from '../subtitleMerge/SubtitleCanvas';
import { getDefaultStyle } from '../subtitleMerge/constants';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

it('captures the native anchor once and retains it through repeated keyboard moves', () => {
  const onUpdateStyle = jest.fn();
  const props = {
    style: getDefaultStyle(),
    text: 'Layers',
    width: 640,
    height: 400,
    safeArea: 'none' as const,
    renderedPositionY: 25,
    disabled: false,
    onUpdateStyle,
    onPreview: jest.fn(),
  };
  const { getByRole, rerender } = render(<SubtitleCanvas {...props} />);
  fireEvent.keyDown(getByRole('button'), { key: 'ArrowDown' });
  expect(onUpdateStyle).toHaveBeenLastCalledWith({
    positionY: 25.25,
    positionReferenceY: 25,
  });
  rerender(
    <SubtitleCanvas
      {...props}
      style={{ ...props.style, ...onUpdateStyle.mock.calls[0][0] }}
      renderedPositionY={25.25}
    />,
  );
  fireEvent.keyDown(getByRole('button'), { key: 'ArrowDown', shiftKey: true });
  expect(onUpdateStyle).toHaveBeenLastCalledWith({
    positionY: 27.75,
    positionReferenceY: 25,
  });
});

it('keeps numeric position edits using the document anchor and disables manipulation in soft mode', () => {
  const onUpdateStyle = jest.fn();
  const props = {
    style: { ...getDefaultStyle(), positionY: 50 },
    text: 'Layers',
    width: 640,
    height: 400,
    safeArea: 'none' as const,
    renderedPositionY: 75,
    disabled: false,
    onUpdateStyle,
    onPreview: jest.fn(),
  };
  const { getByRole, queryByRole, rerender } = render(
    <SubtitleCanvas {...props} />,
  );
  fireEvent.keyDown(getByRole('button'), { key: 'ArrowUp' });
  expect(onUpdateStyle).toHaveBeenLastCalledWith({
    positionY: 49.75,
    positionReferenceY: undefined,
  });
  rerender(<SubtitleCanvas {...props} disabled />);
  expect(queryByRole('button')).toBeNull();
});
