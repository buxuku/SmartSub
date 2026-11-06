import { subtitleVirtualRange } from '../subtitleVirtualRange';

test('compact rows retain ten spare rows; expanded editors retain two per side', () => {
  const range = { startIndex: 100, endIndex: 105, count: 10000, overscan: 10 };
  expect(subtitleVirtualRange(range, () => false)).toEqual(
    Array.from({ length: 26 }, (_, i) => i + 90),
  );
  expect(subtitleVirtualRange(range, () => true)).toEqual(
    Array.from({ length: 10 }, (_, i) => i + 98),
  );
});

test('mixed heights preserve every visible row and never exceed the full compact buffer', () => {
  const range = { startIndex: 100, endIndex: 105, count: 10000, overscan: 10 };
  const result = subtitleVirtualRange(range, (index) => index < 100);
  expect(result).toEqual(Array.from({ length: 18 }, (_, i) => i + 98));
  for (let i = 100; i <= 105; i++) expect(result).toContain(i);
});

test('first/last rows, short filtered lists and zero overscan stay within bounds', () => {
  expect(
    subtitleVirtualRange(
      { startIndex: 0, endIndex: 1, count: 3, overscan: 10 },
      () => false,
    ),
  ).toEqual([0, 1, 2]);
  expect(
    subtitleVirtualRange(
      { startIndex: 9998, endIndex: 9999, count: 10000, overscan: 10 },
      () => true,
    ),
  ).toEqual([9996, 9997, 9998, 9999]);
  expect(
    subtitleVirtualRange(
      { startIndex: 2, endIndex: 3, count: 10, overscan: 0 },
      () => true,
    ),
  ).toEqual([2, 3]);
});
