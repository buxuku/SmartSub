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

it('lets callers tint the indicator and keeps the primary colour by default', () => {
  const { rerender } = render(<Progress value={40} />);
  expect(screen.getByRole('progressbar').firstChild).toHaveClass('bg-primary');
  rerender(<Progress value={40} indicatorClassName="bg-success" />);
  const indicator = screen.getByRole('progressbar').firstChild;
  expect(indicator).toHaveClass('bg-success');
  expect(indicator).not.toHaveClass('bg-primary');
  expect(screen.getByRole('progressbar')).not.toHaveAttribute(
    'indicatorclassname',
  );
});
