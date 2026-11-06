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

  it('keeps a kana voicing mark on its letter, so き does not find ぎ', () => {
    expect(foldForMatch('ガ')).toBe('ガ');
    expect(nameMatches('ぎふ', 'き')).toBe(false);
    expect(nameMatches('ぎふ', 'ぎ')).toBe(true);
    // The decomposed form a pasted name might arrive in still matches.
    expect(nameMatches('ぎふ', 'ぎ'.normalize('NFD'))).toBe(true);
  });

  it('folds letters NFD leaves whole', () => {
    expect(nameMatches('Søndre Øyer', 'sondre oyer')).toBe(true);
    expect(nameMatches('Łódź', 'lodz')).toBe(true);
    expect(nameMatches('Straße', 'STRASSE')).toBe(true);
    expect(nameMatches('Ærø', 'aero')).toBe(true);
    expect(nameMatches('Đà Lạt', 'da lat')).toBe(true);
  });

  it('folds curly quotes, dashes and runs of whitespace to what a keyboard types', () => {
    expect(nameMatches('Heysen’s Rest Bed & Breakfast', "heysen's")).toBe(true);
    expect(nameMatches("Heysen's Rest", 'heysen’s')).toBe(true);
    expect(nameMatches('Discovery Parks – Hahndorf', 'parks - hahn')).toBe(true);
    expect(nameMatches('Kirihata　Hut', 'kirihata hut')).toBe(true);
    expect(nameMatches('Lake  Hāwea', 'lake hawea')).toBe(true);
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
