import { launchTrailId } from '../current-hike';

describe('launchTrailId', () => {
  it('opens the current trail when the phone still lists it', () => {
    expect(launchTrailId('heysen', ['aawt', 'heysen'], false)).toBe('heysen');
  });

  it('stays on the list with no current trail', () => {
    expect(launchTrailId(null, ['aawt'], false)).toBeNull();
  });

  it('stays on the list when the current trail is gone', () => {
    expect(launchTrailId('u_deleted', ['aawt'], false)).toBeNull();
  });

  it('stays on the list when the launch was for something else', () => {
    expect(launchTrailId('heysen', ['heysen'], true)).toBeNull();
  });
});
