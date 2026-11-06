import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import TimecodeInput from '../proofread/TimecodeInput';
import { formatTimecode, parseTimecode } from '../../lib/timecode';

function Harness({ initial = '417.2' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TimecodeInput
        aria-label="Start time"
        value={value}
        onChange={setValue}
      />
      <output aria-label="Draft">{value}</output>
    </>
  );
}

test.each([
  ['00:06:57.200', 417.2],
  ['00:06:58,080', 418.08],
  ['6:57.2', 417.2],
  ['417.2', 417.2],
  ['0', 0],
  [' 01:02:03.045 ', 3723.045],
  ['100:00:00.000', 360000],
])('parses %s into %s seconds', (text, seconds) => {
  expect(parseTimecode(text)).toBe(seconds);
});

test.each([
  '',
  ' ',
  '00:60:00.000',
  '00:00:60.000',
  '-1',
  '1e3',
  '0x10',
  'NaN',
  'Infinity',
  '00:06:',
  '00:00:03.0001',
  '00:00:03junk',
  '9999999999999999999999999',
])('rejects invalid time %s', (text) => {
  expect(parseTimecode(text)).toBeNull();
});

test('formats millisecond carry and retains long durations', () => {
  expect(formatTimecode(417.2)).toBe('00:06:57.200');
  expect(formatTimecode(59.9996)).toBe('00:01:00.000');
  expect(formatTimecode(3599.9996)).toBe('01:00:00.000');
  expect(formatTimecode(360000)).toBe('100:00:00.000');
});

test('displays old second-based drafts as timecodes and preserves partial edits', () => {
  render(<Harness />);
  const input = screen.getByRole('textbox', { name: 'Start time' });
  expect(input).toHaveValue('00:06:57.200');
  fireEvent.change(input, { target: { value: '00:06:' } });
  expect(input).toHaveValue('00:06:');
  expect(screen.getByLabelText('Draft')).toHaveTextContent('00:06:');
  fireEvent.blur(input);
  expect(input).toHaveValue('00:06:');
  fireEvent.change(input, { target: { value: '6:58,08' } });
  expect(input).toHaveValue('6:58,08');
  fireEvent.blur(input);
  expect(input).toHaveValue('00:06:58.080');
  expect(screen.getByLabelText('Draft')).toHaveTextContent('00:06:58.080');
});

test('allows pasting seconds without reformatting mid-keystroke and clears without restoring the previous value', () => {
  render(<Harness />);
  const input = screen.getByRole('textbox', { name: 'Start time' });
  fireEvent.change(input, { target: { value: '418.08' } });
  expect(input).toHaveValue('418.08');
  fireEvent.blur(input);
  expect(input).toHaveValue('00:06:58.080');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(input).toHaveValue('');
  expect(screen.getByLabelText('Draft')).toBeEmptyDOMElement();
});

test('updates when an external draft is restored', () => {
  const onChange = jest.fn();
  const { rerender } = render(
    <TimecodeInput aria-label="Start time" value="417.2" onChange={onChange} />,
  );
  rerender(
    <TimecodeInput
      aria-label="Start time"
      value="1604.11"
      onChange={onChange}
    />,
  );
  expect(screen.getByRole('textbox', { name: 'Start time' })).toHaveValue(
    '00:26:44.110',
  );
  expect(onChange).not.toHaveBeenCalled();
});
