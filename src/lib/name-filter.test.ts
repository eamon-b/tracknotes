import { describe, expect, it } from 'vitest';
import {
  filterByName,
  filterGroupsByName,
  foldForMatch,
  groupMatchesName,
  nameMatches,
  nameQuery,
} from './name-filter';

describe('foldForMatch', () => {
  it('lower-cases and strips accents and macrons', () => {
    expect(foldForMatch('Ōhau Café')).toBe('ohau cafe');
    expect(foldForMatch('Pārāwai')).toBe('parawai');
  });

  it('leaves scripts without combining marks alone', () => {
    expect(foldForMatch('霊山寺')).toBe('霊山寺');
  });
});

describe('nameQuery', () => {
  it('trims and folds', () => {
    expect(nameQuery('  TE Ánau ')).toBe('te anau');
    expect(nameQuery('   ')).toBe('');
  });
});

describe('nameMatches', () => {
  it('matches a substring whatever the case or accents', () => {
    expect(nameMatches('Lake Ōhau Lodge', 'ohau')).toBe(true);
    expect(nameMatches('Café de Paris', 'CAFÉ')).toBe(true);
    expect(nameMatches('Cafe de Paris', 'café')).toBe(true);
    expect(nameMatches('Salida', 'chama')).toBe(false);
  });

  it('treats an empty query as no filter', () => {
    expect(nameMatches('Salida', '')).toBe(true);
    expect(nameMatches(undefined, '  ')).toBe(true);
  });

  it('never matches a missing name to a real query', () => {
    expect(nameMatches(undefined, 'a')).toBe(false);
    expect(nameMatches(null, 'a')).toBe(false);
  });
});

describe('filterByName', () => {
  const items = [{ name: 'Twizel' }, { name: 'Lake Ōhau' }, { name: undefined }, { name: 'Ohau Hut' }];

  it('keeps the matching items in order', () => {
    expect(filterByName(items, 'ohau', i => i.name)).toEqual([{ name: 'Lake Ōhau' }, { name: 'Ohau Hut' }]);
  });

  it('returns a copy of everything for an empty query', () => {
    const all = filterByName(items, '', i => i.name);
    expect(all).toEqual(items);
    expect(all).not.toBe(items);
  });
});

describe('filterGroupsByName', () => {
  const groups = [
    { label: 'Monarch Pass (US 50)', options: [{ name: 'Salida' }, { name: 'Poncha Springs' }] },
    { label: null, options: [{ name: 'Leadville' }] },
    { label: 'Cumbres Pass', options: [{ name: 'Chama' }, { name: 'Antonito' }] },
  ];

  it('keeps every place under a turn-off whose name matches', () => {
    expect(filterGroupsByName(groups, 'monarch')).toEqual([groups[0]]);
  });

  it('otherwise keeps only the matching places of a group', () => {
    expect(filterGroupsByName(groups, 'chama')).toEqual([{ ...groups[2], options: [{ name: 'Chama' }] }]);
  });

  it('drops groups with nothing matching, and keeps all for an empty query', () => {
    expect(filterGroupsByName(groups, 'zzz')).toEqual([]);
    expect(filterGroupsByName(groups, ' ')).toEqual(groups);
  });
});

describe('groupMatchesName', () => {
  const group = { label: 'Cumbres Pass', options: [{ name: 'Chama' }, { name: 'Antoñito' }] };

  it('matches on the turn-off or any place, accents ignored', () => {
    expect(groupMatchesName(group, 'cumbres')).toBe(true);
    expect(groupMatchesName(group, 'antonito')).toBe(true);
    expect(groupMatchesName(group, 'salida')).toBe(false);
    expect(groupMatchesName({ options: [{ name: 'Salida' }] }, 'sal')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(groupMatchesName(group, '')).toBe(true);
  });
});
