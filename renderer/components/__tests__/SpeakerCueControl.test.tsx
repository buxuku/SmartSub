import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SpeakerCueControl from '../proofread/SpeakerCueControl';
import type { Subtitle } from '../../hooks/useSubtitles';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      `${key}${values?.name ? ` ${values.name}` : ''}`,
  }),
}));

test('role picker stays open while toggling multiple assignments and clicking its content', () => {
  const rowClick = jest.fn();
  function Harness() {
    const [cue, setCue] = useState<Subtitle>({
      id: '1',
      content: ['Hello'],
      sourceContent: 'Hello',
      startEndTime: '00:00:00,000 --> 00:00:01,000',
      speakerIds: [1, 2],
      primarySpeakerId: 1,
    });
    return (
      <div onClick={rowClick}>
        <SpeakerCueControl
          subtitle={cue}
          index={0}
          speakers={[
            { id: 1, displayName: 'One', color: '#f00' },
            { id: 2, displayName: 'Two', color: '#00f' },
          ]}
          onChange={(_, speakerIds, primarySpeakerId) =>
            setCue({ ...cue, speakerIds, primarySpeakerId })
          }
          onCreate={() => 3}
        />
      </div>
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'speakers.editCue' });
  fireEvent.click(trigger);
  const second = screen.getByRole('checkbox', {
    name: 'speakers.toggleAssignment Two',
  });
  fireEvent.click(second);
  expect(second).not.toBeChecked();
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.click(second);
  expect(second).toBeChecked();
  fireEvent.click(screen.getByText('speakers.assignCue'));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(rowClick).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
