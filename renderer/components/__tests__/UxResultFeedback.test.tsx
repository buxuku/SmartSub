import { fireEvent, render, screen } from '@testing-library/react';
import DubbingActionBar from '../dubbing/DubbingActionBar';
import ToolboxFinishBar from '../toolbox/common/ToolboxFinishBar';

jest.mock('next/router', () => ({
  useRouter: () => ({ query: {}, push: jest.fn() }),
}));
jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: object) =>
      `${key}${values ? JSON.stringify(values) : ''}`,
  }),
}));

test('generated but overlong audio leads to timing review, not resynthesis', () => {
  const review = jest.fn();
  const start = jest.fn();
  render(
    <DubbingActionBar
      onReviewTiming={review}
      dub={
        {
          summary: {
            total: 5,
            generated: 5,
            done: 0,
            overlong: 5,
            failed: 0,
            needsUpdate: 0,
          },
          charEstimate: {
            totalRows: 5,
            totalChars: 100,
            pendingRows: 0,
            pendingChars: 0,
          },
          canStart: true,
          canExport: false,
          start,
        } as any
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'reviewTiming' }));
  expect(review).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: 'resumeDubbing' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'export' })).toBeDisabled();
});

test.each([
  [100, 125, 'statsIncreased'],
  [100, 75, 'stats'],
  [100, 100, 'statsUnchanged'],
])(
  'size feedback reports actual changes (%s → %s)',
  (originalSize, compressedSize, key) => {
    render(
      <ToolboxFinishBar
        outputPath="/out.mp4"
        stats={{
          originalSize: Number(originalSize),
          compressedSize: Number(compressedSize),
          savedPercent: 0,
        }}
      />,
    );
    expect(
      screen.getByText(new RegExp(`^finishBar.${key}\\{`)),
    ).toBeInTheDocument();
    if (originalSize !== compressedSize)
      expect(screen.getByText(/"saved":25/)).toBeInTheDocument();
  },
);
