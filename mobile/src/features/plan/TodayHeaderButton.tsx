/**
 * The guide header's "Today" button: shown only while the plan has a walking
 * day (or a rest day) dated today, so it appears on the trail and stays out of
 * the way while a hike is still being planned.
 */

import React from 'react';
import { useRouter } from 'expo-router';
import { HeaderIconButton } from '../../navigation/HeaderIconButton';
import { useHasPlanToday } from './use-today-plan';

export function TodayHeaderButton({ trailId }: { trailId: string }) {
  const router = useRouter();
  // The light check: the button needs only "is there a day today", not the
  // day's rows and POIs the Today screen lists.
  const hasToday = useHasPlanToday();
  if (!hasToday) return null;
  return (
    <HeaderIconButton
      name="calendar-today"
      accessibilityLabel="Today's plan"
      onPress={() => router.push({ pathname: '/guide/[trailId]/today', params: { trailId } })}
    />
  );
}
