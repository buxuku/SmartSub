import React from 'react';
import { render, screen } from '@testing-library/react';
import { Progress } from '../ui/progress';

it('exposes determinate values and updates them with the visual indicator', () => {
  const { rerender } = render(<Progress value={23} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '23',
  );
  expect(screen.getByRole('progressbar').firstChild).toHaveStyle({
    transform: 'translateX(-77%)',
  });
  rerender(<Progress value={100} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '100',
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'data-state',
    'complete',
  );
  rerender(<Progress value={null} />);
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
});
