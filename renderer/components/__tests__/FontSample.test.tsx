import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { FontSample } from '../subtitleMerge/FontSelector';
import { acquireFontSample } from '../../lib/fontSampleCache';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const installed = new Set<FontFace>();
const observers = new Map<Element, IntersectionObserverCallback>();
let load: jest.Mock;
let invoke: jest.Mock;
beforeEach(() => {
  installed.clear();
  observers.clear();
  load = jest.fn(function (this: FontFace) {
    return Promise.resolve(this);
  });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: (font: FontFace) => installed.add(font),
      delete: (font: FontFace) => installed.delete(font),
    },
  });
  global.FontFace = class {
    constructor(
      public family: string,
      public source: string | ArrayBuffer,
    ) {}
    load() {
      return load.call(this);
    }
  } as any;
  global.IntersectionObserver = class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) {
      observers.set(element, this.callback);
    }
    disconnect() {
      observers.forEach((callback, element) => {
        if (callback === this.callback) observers.delete(element);
      });
    }
  } as any;
  invoke = jest
    .fn()
    .mockResolvedValue({ success: true, data: { data: [1, 2, 3] } });
  window.ipc = { invoke } as any;
});
const visibility = (element: Element, visible: boolean) =>
  act(() =>
    observers.get(element)!(
      [{ isIntersecting: visible } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );

it('loads visible samples only, releases offscreen faces, and releases everything on unmount', async () => {
  const { container, unmount } = render(
    <FontSample font={{ name: 'Visible', available: true }} />,
  );
  const sample = container.querySelector('[data-font-sample]')!;
  expect(invoke).not.toHaveBeenCalled();
  visibility(sample, true);
  await waitFor(() =>
    expect(sample).toHaveAttribute('data-font-loaded', 'true'),
  );
  expect(installed.size).toBe(1);
  visibility(sample, false);
  expect(installed.size).toBe(0);
  expect(sample).toHaveAttribute('data-font-loaded', 'false');
  visibility(sample, true);
  await waitFor(() => expect(installed.size).toBe(1));
  unmount();
  expect(installed.size).toBe(0);
  expect(observers.size).toBe(0);
});

it('shares a face until its final visible consumer releases it', async () => {
  const source = { name: 'Shared', fullName: 'Shared Regular' };
  const first = acquireFontSample(source),
    second = acquireFontSample(source);
  expect(await first.promise).toBe(await second.promise);
  expect(load).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  first.release();
  first.release();
  expect(installed.size).toBe(1);
  second.release();
  expect(installed.size).toBe(0);
});

it('does not install fonts whose request finished after the consumer released or switched documents', async () => {
  let release!: (value: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const old = acquireFontSample({
    name: 'Embedded',
    subtitlePath: '/old.ass',
    embeddedId: 'old',
  });
  old.release();
  const next = acquireFontSample({
    name: 'Embedded',
    subtitlePath: '/new.ass',
    embeddedId: 'new',
  });
  const nextFamily = await next.promise;
  release({ success: true, data: { data: [4, 5, 6] } });
  const oldFamily = await old.promise;
  expect(oldFamily).not.toBe(nextFamily);
  expect(Array.from(installed).map((font) => font.family)).toEqual([
    nextFamily,
  ]);
  next.release();
  expect(installed.size).toBe(0);
});

it('falls back from local faces to binary and retries failed loads without poisoning subsequent consumers', async () => {
  load.mockRejectedValueOnce(new Error('Local font hidden'));
  const first = acquireFontSample({
    name: 'Fallback',
    fullName: 'Hidden Full Name',
    postscriptName: 'HiddenPS',
  });
  await first.promise;
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(installed.size).toBe(1);
  first.release();
  invoke.mockResolvedValueOnce({ success: false });
  const broken = acquireFontSample({ name: 'Retry' });
  await expect(broken.promise).rejects.toThrow('Font unavailable');
  const retry = acquireFontSample({ name: 'Retry' });
  await retry.promise;
  broken.release();
  expect(installed.size).toBe(1);
  retry.release();
  expect(installed.size).toBe(0);
});
