-- Trail Maps comments API — water-report observation time to the day
-- (issue #248).
--
-- A comment's `observed_at` (the time the hiker says they saw the water) is
-- now held and published only to the day: midnight UTC of the UTC date it
-- falls on, e.g. `2026-10-30T00:00:00.000Z` (`observedDayIso` in
-- src/validation.ts). This coarsens the rows written before that.
--
-- Every stored value was written by `Date.prototype.toISOString` (UTC, `Z`),
-- so the UTC date is everything before the `T`; that also holds for the
-- extended `+YYYYYY`/`-YYYYYY` years `toISOString` writes outside 0000-9999.
-- Re-running it changes nothing.
--
-- A live row whose value changes gets a new `updated_at`, so the trail-wide
-- `?since=` feed hands it to phones again and their cached copies are
-- coarsened too. Tombstones are coarsened without being re-sent.

UPDATE comments
SET
  updated_at = CASE
    WHEN deleted_at IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE updated_at
  END,
  observed_at = substr(observed_at, 1, instr(observed_at, 'T') - 1) || 'T00:00:00.000Z'
WHERE observed_at IS NOT NULL
  AND instr(observed_at, 'T') > 1
  AND observed_at <> substr(observed_at, 1, instr(observed_at, 'T') - 1) || 'T00:00:00.000Z';
