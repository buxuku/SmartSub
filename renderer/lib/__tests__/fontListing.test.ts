import {
  fontMatchesQuery,
  organizeFonts,
  type FontOption,
} from '../fontListing';
import { readRecentFonts, rememberRecentFont } from '../recentFonts';

const fonts: FontOption[] = [
  { name: 'Zeta Display', available: true },
  { name: 'Arial', available: true, rank: 24 },
  {
    name: 'Heiti SC',
    displayName: '黑体-简',
    localizedNames: ['黑体-简', '黑體-簡'],
    available: true,
    rank: 6,
  },
  { name: 'Alpha Mono', available: true },
  { name: 'Gone', available: false, reason: 'missing' },
  { name: 'Doc Font', available: true, embeddedId: 'doc-1' },
  {
    name: 'Songti SC',
    displayName: '宋体-简',
    localizedNames: ['宋体-简'],
    available: true,
    rank: 9,
  },
];
const names = (rows: ReturnType<typeof organizeFonts>) =>
  rows.map((row) => (row.kind === 'header' ? `#${row.group}` : row.font.name));

it('groups embedded, recent, common, other and unavailable fonts in that order', () => {
  expect(
    names(organizeFonts(fonts, { recent: ['Alpha Mono'], query: '' })),
  ).toEqual([
    '#embedded',
    'Doc Font',
    '#recent',
    'Alpha Mono',
    '#common',
    'Heiti SC',
    'Songti SC',
    'Arial',
    '#other',
    'Zeta Display',
    '#unavailable',
    'Gone',
  ]);
});

it('ignores recent fonts that are no longer installed and does not repeat them', () => {
  const rows = organizeFonts(fonts, {
    recent: ['Gone', 'Heiti SC', 'Nope'],
    query: '',
  });
  expect(names(rows)).toEqual([
    '#embedded',
    'Doc Font',
    '#recent',
    'Heiti SC',
    '#common',
    'Songti SC',
    'Arial',
    '#other',
    'Alpha Mono',
    'Zeta Display',
    '#unavailable',
    'Gone',
  ]);
});

it('omits empty groups', () => {
  expect(
    names(
      organizeFonts([{ name: 'Only', available: true }], {
        recent: [],
        query: '',
      }),
    ),
  ).toEqual(['#other', 'Only']);
});

it('searches by English name, localized name, pinyin and initials', () => {
  const heiti = fonts[2];
  expect(fontMatchesQuery(heiti, 'heiti')).toBe(true);
  expect(fontMatchesQuery(heiti, '黑体')).toBe(true);
  expect(fontMatchesQuery(heiti, '黑體')).toBe(true);
  expect(fontMatchesQuery(heiti, 'heitijian')).toBe(true);
  expect(fontMatchesQuery(heiti, 'hei ti')).toBe(true);
  expect(fontMatchesQuery(heiti, 'htj')).toBe(true);
  expect(fontMatchesQuery(heiti, 'song')).toBe(false);
  expect(fontMatchesQuery(fonts[0], '')).toBe(true);
  expect(fontMatchesQuery(fonts[0], 'ZETA')).toBe(true);
  expect(fontMatchesQuery(fonts[1], 'ht')).toBe(false);
});

it('filters rows by query while keeping headers only for groups with matches', () => {
  expect(names(organizeFonts(fonts, { recent: [], query: '宋体' }))).toEqual([
    '#common',
    'Songti SC',
  ]);
  expect(names(organizeFonts(fonts, { recent: [], query: 'zeta' }))).toEqual([
    '#other',
    'Zeta Display',
  ]);
  expect(names(organizeFonts(fonts, { recent: [], query: 'gone' }))).toEqual([
    '#unavailable',
    'Gone',
  ]);
  expect(organizeFonts(fonts, { recent: [], query: 'nothing' })).toEqual([]);
});

it('persists recent fonts newest-first without duplicates and caps the list', () => {
  window.localStorage.clear();
  for (let index = 0; index < 12; index++) rememberRecentFont(`Font ${index}`);
  rememberRecentFont('Font 5');
  const recent = readRecentFonts();
  expect(recent[0]).toBe('Font 5');
  expect(recent).toHaveLength(8);
  expect(new Set(recent).size).toBe(8);
});

it('survives corrupted or unavailable storage', () => {
  window.localStorage.setItem('smartsub:recentFonts', '{nope');
  expect(readRecentFonts()).toEqual([]);
  const spy = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('quota');
    });
  expect(() => rememberRecentFont('X')).not.toThrow();
  spy.mockRestore();
});
