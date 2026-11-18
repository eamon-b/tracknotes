import * as Location from 'expo-location';
import {
  getActiveTrackingProfile,
  startLocationTracking,
  stopLocationTracking,
  type LocationUpdate,
} from '../location-service';

const watch = Location.watchPositionAsync as jest.Mock;

type WatchCallback = (location: Location.LocationObject) => void;

function fix(latitude: number): Location.LocationObject {
  return {
    coords: {
      latitude,
      longitude: 138,
      altitude: null,
      accuracy: 5,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: 1,
  };
}

afterEach(async () => {
  await stopLocationTracking();
  watch.mockReset();
  watch.mockImplementation(() => Promise.resolve({ remove: jest.fn() }));
});

describe('startLocationTracking', () => {
  it('fans one OS watch out to every subscriber', async () => {
    let emit!: WatchCallback;
    watch.mockImplementation((_opts: unknown, cb: WatchCallback) => {
      emit = cb;
      return Promise.resolve({ remove: jest.fn() });
    });
    const a = jest.fn();
    const b = jest.fn();
    await startLocationTracking(a);
    await startLocationTracking(b);
    emit(fix(-35));

    expect(watch).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ latitude: -35 }));
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ latitude: -35 }));
    expect(getActiveTrackingProfile()).toBe('standard');
  });

  it('unsubscribes the callback of a start that failed', async () => {
    watch.mockImplementationOnce(() => Promise.reject(new Error('location off')));
    const failed = jest.fn<void, [LocationUpdate]>();
    await expect(startLocationTracking(failed)).rejects.toThrow('location off');

    // A later caller's watch must not feed the failed caller's callback.
    let emit!: WatchCallback;
    watch.mockImplementation((_opts: unknown, cb: WatchCallback) => {
      emit = cb;
      return Promise.resolve({ remove: jest.fn() });
    });
    const later = jest.fn<void, [LocationUpdate]>();
    await startLocationTracking(later);
    emit(fix(-36));

    expect(later).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('stops the OS watch when the last subscriber leaves', async () => {
    const remove = jest.fn();
    watch.mockImplementation(() => Promise.resolve({ remove }));
    const a = jest.fn();
    const b = jest.fn();
    await startLocationTracking(a);
    await startLocationTracking(b);
    await stopLocationTracking(a);
    expect(remove).not.toHaveBeenCalled();
    await stopLocationTracking(b);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
