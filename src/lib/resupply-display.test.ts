/**
 * The words the web and the phone share for a resupply option.
 *
 * The description cases used to be reachable only through the jsdom Resupply-tab
 * test; they live here now because the helper is platform-neutral and the
 * abbreviation rule is the part most likely to be broken by a "simplification".
 */

import { describe, it, expect } from 'vitest';
import {
  accessSummary,
  firstSentence,
  legDistanceText,
  legRidesText,
  legEndpointNames,
  legSideTripText,
  resupplyGroupName,
  resupplyOptionShortName,
  resupplySummaryText,
  STORE_KIND_LABELS,
  stopAccessText,
  storeLabel,
} from './resupply-display';
import type { ResupplySummary } from './resupply-plan';

const km = (value: number): string => `${value.toFixed(1)} km`;
const kg = (value: number): string => `${value.toFixed(1)} kg`;
/** What the phone would pass under an imperial unit setting. */
const mi = (value: number): string => `${(value * 0.621371).toFixed(1)} mi`;

describe('firstSentence', () => {
  it('stops at the first terminator', () => {
    expect(firstSentence('General store and post office. Closed Sundays.')).toBe('General store and post office.');
    expect(firstSentence('Is there water? Sometimes.')).toBe('Is there water?');
    expect(firstSentence('Closed! Ring ahead.')).toBe('Closed!');
  });

  it('does not cut the description short at a dotted abbreviation', () => {
    expect(firstSentence('Store beside U.S. 50 with a hiker box. Closed Mondays.')).toBe(
      'Store beside U.S. 50 with a hiker box.'
    );
    expect(firstSentence('Camp below Mt. Sonder. Water 200 m north.')).toBe('Camp below Mt. Sonder.');
    expect(firstSentence('Water approx. 3 km on. Treat it.')).toBe('Water approx. 3 km on.');
  });

  it('reads a run of initials as one name', () => {
    expect(firstSentence('Named for J. R. R. Tolkien by the club. Bunks for six.')).toBe(
      'Named for J. R. R. Tolkien by the club.'
    );
    expect(firstSentence('Hut built by A. B. Paterson. Tank water.')).toBe('Hut built by A. B. Paterson.');
  });

  it('ends a sentence at a lone capital letter', () => {
    expect(firstSentence('Water from tank B. Camp is beside it.')).toBe('Water from tank B.');
    expect(firstSentence('Use tank B. it is cleaner.')).toBe('Use tank B.');
    expect(firstSentence('Take track A.')).toBe('Take track A.');
  });

  it('reads the prose out of a generator’s |-separated metadata', () => {
    expect(
      firstSentence('mi 1947.3 (SOBO mi 1947.3) | off. mi 1955.8 | CO | Leave the CDT here for Salida. Hitch east.')
    ).toBe('Leave the CDT here for Salida.');
  });

  it('returns the whole text when nothing terminates it', () => {
    expect(firstSentence('Hitch east from the pass')).toBe('Hitch east from the pass');
    expect(firstSentence('  padded  ')).toBe('padded');
  });

  it('is empty for an empty or metadata-only description', () => {
    expect(firstSentence('')).toBe('');
    expect(firstSentence(' | | ')).toBe('');
  });
});

describe('accessSummary', () => {
  it('names the distance and how you get there', () => {
    expect(accessSummary({ offTrailKm: 22, accessMode: 'hitch' }, km)).toBe('22.0 km hitch');
    expect(accessSummary({ offTrailKm: 4.5, accessMode: 'shuttle' }, km)).toBe('4.5 km shuttle');
  });

  it('falls back to "off trail" when the mode is unknown or on-trail', () => {
    expect(accessSummary({ offTrailKm: 3 }, km)).toBe('3.0 km off trail');
    // An on-trail place with a distance is a contradiction in the data; the
    // distance is the thing the hiker walks, so it wins.
    expect(accessSummary({ offTrailKm: 3, accessMode: 'on-trail' }, km)).toBe('3.0 km off trail');
  });

  it('says "on trail" with no distance, and nothing at all when there is nothing to say', () => {
    expect(accessSummary({ accessMode: 'on-trail' }, km)).toBe('on trail');
    expect(accessSummary({}, km)).toBe('');
    expect(accessSummary({ offTrailKm: 0, accessMode: 'foot' }, km)).toBe('foot');
  });

  it('formats through the caller’s units', () => {
    expect(accessSummary({ offTrailKm: 22.5, accessMode: 'hitch' }, mi)).toBe('14.0 mi hitch');
  });

  it('names the side trip walked to the place', () => {
    expect(
      accessSummary(
        {
          offTrailKm: 0.9,
          accessMode: 'foot',
          accessRoute: { name: 'S3.7 Spur to Cudlee Creek', ascentM: 38, descentM: 39 },
        },
        km
      )
    ).toBe('0.9 km on foot via S3.7 Spur to Cudlee Creek');
  });
});

describe('resupplySummaryText', () => {
  const summary = (over: Partial<ResupplySummary> = {}): ResupplySummary => ({
    stops: 4,
    longestKm: 10,
    longestDays: 2,
    totalFoodKg: 3.4,
    hasData: true,
    ...over,
  });

  it('reads as the web datasheet subtitle does', () => {
    expect(resupplySummaryText(summary(), km, kg)).toBe(
      '4 stops · longest carry 10.0 km / 2 days · 3.4 kg food in total'
    );
  });

  it('names the full carry when there are no stops', () => {
    expect(resupplySummaryText(summary({ stops: 0, longestKm: 120, longestDays: 5, totalFoodKg: 3.4 }), km, kg)).toBe(
      'No resupply stops · full carry 120.0 km / 5 days · 3.4 kg food'
    );
  });

  it('is singular for one stop and one day', () => {
    expect(resupplySummaryText(summary({ stops: 1, longestDays: 1 }), km, kg)).toBe(
      '1 stop · longest carry 10.0 km / 1 day · 3.4 kg food in total'
    );
  });

  it('formats through the caller’s units', () => {
    expect(resupplySummaryText(summary(), mi, v => `${(v * 2.20462).toFixed(1)} lb`)).toBe(
      '4 stops · longest carry 6.2 mi / 2 days · 7.5 lb food in total'
    );
  });
});

describe('leg and stop distances, trail and off trail apart', () => {
  it('adds the off-trail walk to the trail km only when there is one', () => {
    expect(legDistanceText({ distanceKm: 52.3, offTrailWalkKm: 0 }, km)).toBe('52.3 km');
    expect(legDistanceText({ distanceKm: 52.3, offTrailWalkKm: 4 }, km)).toBe('52.3 km + 4.0 km off trail');
    expect(legDistanceText({ distanceKm: 52.3, offTrailWalkKm: 4 }, mi)).toBe('32.5 mi + 2.5 mi off trail');
  });

  it('lists the rides a leg does not walk', () => {
    expect(legRidesText({ rides: [] }, km)).toBe('');
    expect(
      legRidesText(
        {
          rides: [
            { km: 24.1, mode: 'hitch', end: 'from' },
            { km: 0.7, end: 'to' },
          ],
        },
        km
      )
    ).toBe('24.1 km hitch out · 0.7 km off trail in, not walked');
  });

  it('says what lies beyond the turn-off on the way to a stop', () => {
    expect(stopAccessText(undefined, km)).toBe('');
    const walk = { place: 'A', walkKm: 2, walkAscentM: 0, walkDescentM: 0, rideKm: 0 };
    expect(stopAccessText(walk, km)).toBe('+ 2.0 km off trail');
    expect(stopAccessText({ ...walk, walkKm: 0, rideKm: 35, rideMode: 'hitch' }, km)).toBe('+ 35.0 km hitch');
  });
});

describe('storeLabel', () => {
  it('words each store kind', () => {
    expect(storeLabel({ store: 'full' })).toBe('Full resupply');
    expect(storeLabel({ store: 'limited' })).toBe('Small store');
    expect(storeLabel({ store: 'meals' })).toBe('Meals / parcel only');
    expect(storeLabel({ store: 'none' })).toBe('No shop');
    expect(Object.keys(STORE_KIND_LABELS)).toEqual(['full', 'limited', 'meals', 'none']);
  });

  it('says "Box only" for a place with no shop that holds a box', () => {
    expect(storeLabel({ store: 'none', acceptsBoxes: true })).toBe('Box only');
    expect(storeLabel({ store: 'none', acceptsBoxes: false })).toBe('No shop');
    // A box at a shop is still the shop.
    expect(storeLabel({ store: 'limited', acceptsBoxes: true })).toBe('Small store');
  });

  it('says nothing when the data does not', () => {
    expect(storeLabel({})).toBeNull();
    expect(storeLabel({ acceptsBoxes: true })).toBeNull();
  });
});

describe('legSideTripText', () => {
  it('names the side trip a leg includes', () => {
    expect(legSideTripText({ sideTripKm: 2.8, toName: 'Salida' }, km)).toBe('incl. 2.8 km to Salida and back');
    expect(legSideTripText({ sideTripKm: 0, toName: 'Salida' }, km)).toBe('');
  });

  it('takes a shorter name, or none for a stop not decided yet', () => {
    const leg = { sideTripKm: 0.4, toName: 'A / B (access: C)' };
    expect(legSideTripText(leg, km, 'Monarch Crest Store')).toBe('incl. 0.4 km to Monarch Crest Store and back');
    expect(legSideTripText(leg, km, null)).toBe('incl. 0.4 km off trail and back');
  });
});

/** The CDT's Monarch Pass, as the data names it. */
const monarch = {
  key: 'w_crest',
  km: 3098.6,
  label: 'Monarch Pass (US 50)',
  options: [
    { id: 'w_crest', name: 'Monarch Pass (Monarch Crest Store)' },
    { id: 'w_salida', name: 'Salida (access: Monarch Pass (US 50))' },
    { id: 'w_poncha', name: 'Poncha Springs (access: Monarch Pass (US 50))' },
  ],
};

describe('resupplyOptionShortName', () => {
  it('drops what the group header already says', () => {
    expect(monarch.options.map(option => resupplyOptionShortName(option, monarch))).toEqual([
      'Monarch Crest Store',
      'Salida',
      'Poncha Springs',
    ]);
    const ghost = {
      label: 'CDT primary route nearest Ghost Ranch (Chama River rim)',
      options: [
        { name: 'Ghost Ranch (access: CDT primary route nearest Ghost Ranch (Chama River rim))' },
        { name: 'Abiquiu (access: CDT primary route nearest Ghost Ranch (Chama River rim))' },
      ],
    };
    expect(ghost.options.map(option => resupplyOptionShortName(option, ghost))).toEqual(['Ghost Ranch', 'Abiquiu']);
  });

  it('keeps the full name where there is no group header to lean on', () => {
    const alone = { label: 'Monarch Pass (US 50)', options: [{ name: 'Salida (access: Monarch Pass (US 50))' }] };
    expect(resupplyOptionShortName(alone.options[0], alone)).toBe('Salida (access: Monarch Pass (US 50))');
  });

  it('never shortens a name to nothing, or a prefix that is not the group place', () => {
    const group = { label: 'Mill Road', options: [{ name: '(access: Mill Road)' }, { name: 'Millbrook (Store)' }] };
    expect(resupplyOptionShortName(group.options[0], group)).toBe('(access: Mill Road)');
    expect(resupplyOptionShortName(group.options[1], group)).toBe('Millbrook (Store)');
  });
});

describe('resupplyGroupName', () => {
  it('is the turn-off, else the places', () => {
    expect(resupplyGroupName(monarch)).toBe('Monarch Pass (US 50)');
    expect(resupplyGroupName({ label: null, options: [{ name: 'Kerikeri turnoff' }, { name: 'Kerikeri' }] })).toBe(
      'Kerikeri turnoff / Kerikeri'
    );
  });
});

describe('legEndpointNames', () => {
  const groups = [{ key: 'w_bv', km: 3000, label: null, options: [{ id: 'w_bv', name: 'Buena Vista' }] }, monarch];
  const joined = monarch.options.map(option => option.name).join(' / ');

  it('names an undecided stop for its group, at either end', () => {
    const into = { fromName: 'Buena Vista', fromKm: 3000, toName: joined, toKm: 3098.6 };
    expect(legEndpointNames(into, groups, undefined)).toEqual({
      from: 'Buena Vista',
      to: 'Monarch Pass (US 50) (not decided)',
      toDecided: false,
    });
    const outOf = { fromName: joined, fromKm: 3098.6, toName: 'Trail End', toKm: 4000 };
    expect(legEndpointNames(outOf, groups, undefined).from).toBe('Monarch Pass (US 50) (not decided)');

    // Two of three still ticked is still not decided.
    const two = 'Salida (access: Monarch Pass (US 50)) / Poncha Springs (access: Monarch Pass (US 50))';
    const leg = { fromName: 'Buena Vista', fromKm: 3000, toName: two, toKm: 3098.6 };
    expect(legEndpointNames(leg, groups, ['w_bv', 'w_salida', 'w_poncha']).to).toBe(
      'Monarch Pass (US 50) (not decided)'
    );
  });

  it('keeps the name of a decided stop and of the trail ends', () => {
    const leg = { fromName: 'Buena Vista', fromKm: 3000, toName: monarch.options[1].name, toKm: 3098.6 };
    expect(legEndpointNames(leg, groups, ['w_bv', 'w_salida'])).toEqual({
      from: 'Buena Vista',
      to: 'Salida (access: Monarch Pass (US 50))',
      toDecided: true,
    });
    // The trail start, at the km of an undecided group, is still the trail start.
    const atStart = [{ ...monarch, km: 0 }];
    const first = { fromName: 'Trail Start', fromKm: 0, toName: 'Trail End', toKm: 10 };
    expect(legEndpointNames(first, atStart, undefined).from).toBe('Trail Start');
  });
});
