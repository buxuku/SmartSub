import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ProviderForm } from '../ProviderForm';
import { PROVIDER_TYPES } from '../../../types';

jest.mock('next-i18next', () => ({
  // Real English strings, so a missing key shows up as a raw source id.
  useTranslation: () => {
    const strings = require('../../public/locales/en/translateControl.json');
    return {
      t: (key: string, options?: { defaultValue?: string }) =>
        key.split('.').reduce<any>((node, part) => node?.[part], strings) ??
        options?.defaultValue ??
        key,
    };
  },
}));

const autoFree = PROVIDER_TYPES.find((type) => type.id === 'autoFree')!;
const chainField = autoFree.fields.find(
  (field) => field.key === 'fallbackChain',
)!;

function renderChain(chain: string) {
  const onChange = jest.fn();
  const { container } = render(
    <ProviderForm
      fields={[chainField]}
      values={{ fallbackChain: chain }}
      onChange={onChange}
      showPassword={{}}
      onTogglePassword={() => {}}
      providerId="autoFree"
    />,
  );
  return { onChange, container };
}

test('the chain editor offers Youdao and appends it when added', () => {
  const { onChange } = renderChain('bingFree,googleFree,deeplx');

  fireEvent.click(
    screen.getByRole('button', { name: 'Youdao Translate (Free)' }),
  );

  expect(onChange).toHaveBeenCalledWith(
    'fallbackChain',
    'bingFree,googleFree,deeplx,youdaoFree',
  );
});

test('Youdao in the chain can be moved down and removed', () => {
  const { onChange } = renderChain('youdaoFree,bingFree');

  expect(
    screen.queryByRole('button', { name: 'Youdao Translate (Free)' }),
  ).not.toBeInTheDocument();
  // the first row cannot move up, the others can
  const [firstUp] = screen.getAllByRole('button', { name: 'Move up' });
  expect(firstUp).toBeDisabled();

  fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
  expect(onChange).toHaveBeenLastCalledWith(
    'fallbackChain',
    'bingFree,youdaoFree',
  );

  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
  expect(onChange).toHaveBeenLastCalledWith('fallbackChain', 'bingFree');
});

test('the default chain lists Youdao first and leaves nothing to add', () => {
  const { container } = renderChain(String(chainField.defaultValue));

  const text = container.textContent ?? '';
  const positions = [
    'Youdao Translate (Free)',
    'Bing Translate (Free)',
    'Google Translate (Free)',
    'DeepLX',
  ].map((name) => text.indexOf(name));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  // every source already sits in the chain, so no "add" button remains
  expect(
    screen.queryAllByRole('button', { name: /\(Free\)|DeepLX/ }),
  ).toHaveLength(0);
});
