/**
 * Battery-aware GPS tracking service.
 *
 * Ported near-verbatim from the old app. Provides:
 *  - Two tracking profiles (standard 30 s / 10 m High, saver 120 s / 25 m
 *    Balanced), switched on battery level while a session runs, with
 *    30 % / 35 % hysteresis so a level hovering near the threshold can't flap.
 *  - A single shared foreground OS watch that fans out to every subscriber, so
 *    independent screens can track simultaneously without tearing each other's
 *    session down.
 *
 * Foreground only: the app never tracks with the app in the background, and
 * asks for no background location permission.
 *
 * Permission results are compared against string literals ('granted'/'denied')
 * rather than the `Location.PermissionStatus` enum so the module behaves
 * identically under the real SDK and the lightweight test mock.
 */

import * as Location from 'expo-location';
import * as Battery from 'expo-battery';

// ---------------------------------------------------------------------------
// Tracking profiles (battery-aware tiers)
// ---------------------------------------------------------------------------

export type TrackingProfile = 'standard' | 'saver';

/** Battery fraction below which the saver profile is selected. */
export const AUTO_SAVER_BATTERY_THRESHOLD = 0.3;

/**
 * Battery fraction at/above which tracking returns from saver to standard.
 * Higher than the entry threshold so a level hovering around 30 % can't flap
 * the profile back and forth (hysteresis).
 */
export const AUTO_SAVER_EXIT_BATTERY_THRESHOLD = 0.35;

interface ProfileOptions {
  accuracy: Location.LocationAccuracy;
  timeInterval: number;
  distanceInterval: number;
}

export const TRACKING_PROFILES: Record<TrackingProfile, ProfileOptions> = {
  /** High accuracy, 30 s / 10 m cadence. */
  standard: {
    accuracy: Location.Accuracy.High,
    timeInterval: 30000,
    distanceInterval: 10,
  },
  /** Battery saver: balanced accuracy, 120 s / 25 m cadence. */
  saver: {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 120000,
    distanceInterval: 25,
  },
};

let activeProfile: TrackingProfile = 'standard';

/** The profile the current/next tracking session runs with. */
export function getActiveTrackingProfile(): TrackingProfile {
  return activeProfile;
}

export interface LocationUpdate {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  /** Course-over-ground heading in degrees, valid while moving. */
  heading: number | null;
  /** Ground speed in m/s (gates whether `heading` can be trusted). */
  speed: number | null;
  timestamp: number;
}

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

function toPermissionStatus(status: string): PermissionStatus {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}

function toUpdate(loc: Location.LocationObject): LocationUpdate {
  return {
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    altitude: loc.coords.altitude,
    accuracy: loc.coords.accuracy,
    heading: loc.coords.heading,
    speed: loc.coords.speed,
    timestamp: loc.timestamp,
  };
}

// Foreground tracking fans out to all subscribers over a single OS watch.
type ForegroundLocationCallback = (update: LocationUpdate) => void;
const foregroundSubscribers = new Set<ForegroundLocationCallback>();
let subscription: Location.LocationSubscription | null = null;
let subscriptionStarting: Promise<void> | null = null;

/** Request foreground location permission. */
export async function requestLocationPermission(): Promise<PermissionStatus> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return toPermissionStatus(status);
}

/** Check current permission status without prompting. */
export async function getLocationPermissionStatus(): Promise<PermissionStatus> {
  const getter = Location.getForegroundPermissionsAsync;
  if (typeof getter !== 'function') return 'undetermined';
  const { status } = await getter();
  return toPermissionStatus(status);
}

/** Create the shared OS watch using the active tracking profile. */
function startWatch(): Promise<void> {
  subscriptionStarting = Location.watchPositionAsync(
    TRACKING_PROFILES[activeProfile],
    (location) => {
      const update = toUpdate(location);
      for (const cb of foregroundSubscribers) cb(update);
    },
  ).then(
    (sub) => {
      subscription = sub;
      subscriptionStarting = null;
      // Everyone unsubscribed while the watch was starting — tear it down.
      if (foregroundSubscribers.size === 0) {
        sub.remove();
        subscription = null;
      }
    },
    (err) => {
      // Clear the in-flight marker so the next start attempt can create a fresh
      // watch — a retained rejected promise would wedge tracking for the rest
      // of the app session.
      subscriptionStarting = null;
      throw err;
    },
  );
  return subscriptionStarting;
}

/**
 * Start continuous foreground location tracking. Multiple callers may subscribe;
 * the OS watch is created once and shared. A failed start rejects and leaves
 * `callback` unsubscribed.
 */
export async function startLocationTracking(callback: ForegroundLocationCallback): Promise<void> {
  foregroundSubscribers.add(callback);
  if (!subscription && !subscriptionStarting) {
    // Observed through `subscriptionStarting` below; this handle would only
    // report the same rejection a second time, unhandled.
    startWatch().catch(() => undefined);
  }
  try {
    await subscriptionStarting;
  } catch (err) {
    // A failed start leaves no watch to feed the callback: unsubscribe it, or
    // it would stay in the set and receive a later caller's fixes as if its own
    // start had worked.
    foregroundSubscribers.delete(callback);
    reconcileAutoBattery();
    throw err;
  }
  reconcileAutoBattery();
}

/**
 * Switch the tracking profile. A live foreground watch restarts with the new
 * cadence — subscribers keep receiving updates uninterrupted. Restart failure
 * reverts to the previous profile so subscribers are never stranded without a
 * watch.
 */
export async function setTrackingProfile(profile: TrackingProfile): Promise<void> {
  if (profile === activeProfile) return;
  const previous = activeProfile;
  activeProfile = profile;

  if (subscriptionStarting) {
    try {
      await subscriptionStarting;
    } catch {
      /* failed start — nothing to restart */
    }
  }

  if (subscription && foregroundSubscribers.size > 0) {
    subscription.remove();
    subscription = null;
    try {
      await startWatch();
    } catch (err) {
      activeProfile = previous;
      try {
        await startWatch();
      } catch {
        // Restore failed too — leave state clean for the next start attempt.
      }
      throw err;
    }
  }
}

/**
 * Stop continuous foreground tracking.
 * With a callback: unsubscribes only that caller; the OS watch stops once the
 * last subscriber is gone. Without a callback: stops everything.
 */
export async function stopLocationTracking(callback?: ForegroundLocationCallback): Promise<void> {
  if (callback) {
    foregroundSubscribers.delete(callback);
  } else {
    foregroundSubscribers.clear();
  }
  if (foregroundSubscribers.size === 0 && subscription) {
    subscription.remove();
    subscription = null;
  }
  reconcileAutoBattery();
}

// ---------------------------------------------------------------------------
// Battery watcher (live profile switching with hysteresis)
// ---------------------------------------------------------------------------

let batteryListener: Battery.Subscription | null = null;

/** True while a session is (being) tracked. */
function trackingActive(): boolean {
  return subscription != null || subscriptionStarting != null || foregroundSubscribers.size > 0;
}

/** Apply the battery policy to a level (with hysteresis). */
function handleBatteryLevel(level: number): void {
  if (level < 0) return; // unknown — leave the current profile alone
  if (activeProfile === 'saver') {
    if (level >= AUTO_SAVER_EXIT_BATTERY_THRESHOLD) {
      setTrackingProfile('standard').catch(() => {});
    }
  } else if (level < AUTO_SAVER_BATTERY_THRESHOLD) {
    setTrackingProfile('saver').catch(() => {});
  }
}

/**
 * Attach the battery listener exactly when it should be running (a live
 * session) and detach it otherwise. Idempotent. Guarded against SDK/test
 * environments that do not expose the battery listener API.
 */
function reconcileAutoBattery(): void {
  const canListen = typeof Battery.addBatteryLevelListener === 'function';
  const shouldListen = canListen && trackingActive();
  if (shouldListen && !batteryListener) {
    batteryListener = Battery.addBatteryLevelListener(({ batteryLevel }) => {
      handleBatteryLevel(batteryLevel);
    });
    // The listener only fires on change, so seed it with the current level.
    Battery.getBatteryLevelAsync()
      .then(handleBatteryLevel)
      .catch(() => {});
  } else if (!shouldListen && batteryListener) {
    batteryListener.remove();
    batteryListener = null;
  }
}
