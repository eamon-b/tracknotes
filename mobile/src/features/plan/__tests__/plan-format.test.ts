import {
  dryStretchBadge,
  formatDays,
  formatFoodPerDay,
  formatFoodWeight,
  formatHours,
} from '../plan-format';

describe('plan-format', () => {
  it('formats hours to one decimal with a unit', () => {
    expect(formatHours(8)).toBe('8.0 h');
    expect(formatHours(7.25)).toBe('7.3 h');
  });

  it('formats day counts with singular/plural', () => {
    expect(formatDays(1)).toBe('≈ 1 day');
    expect(formatDays(3)).toBe('≈ 3 days');
  });

  it('formats food weight in kg to one decimal for metric units', () => {
    expect(formatFoodWeight(2, 'km')).toBe('2.0 kg');
    expect(formatFoodWeight(1.36, 'km')).toBe('1.4 kg');
  });

  it('formats food weight in lb to one decimal for imperial units', () => {
    expect(formatFoodWeight(2, 'mi')).toBe('4.4 lb');
    expect(formatFoodWeight(1, 'mi')).toBe('2.2 lb');
  });
});

describe('dryStretchBadge', () => {
  it('names the threshold in the hiker\'s unit', () => {
    expect(dryStretchBadge(15, 'km')).toBe('Dry ≥ 15 km');
    expect(dryStretchBadge(15, 'mi')).toBe('Dry ≥ 9.3 mi');
  });

  it('names the hiker\'s own threshold, not a fixed one', () => {
    expect(dryStretchBadge(25, 'km')).toBe('Dry ≥ 25 km');
  });

  it('keeps the decimal of a threshold set in miles, so it names the figure flagged against', () => {
    expect(dryStretchBadge(16.1, 'km')).toBe('Dry ≥ 16.1 km');
  });
});

describe('formatFoodPerDay', () => {
  it('shows grams for metric and ounces for imperial', () => {
    expect(formatFoodPerDay(680, 'km')).toBe('680 g');
    expect(formatFoodPerDay(680, 'mi')).toBe('24.0 oz');
  });
});
