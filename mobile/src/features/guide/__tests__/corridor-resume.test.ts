import { corridorResume } from '../corridor-resume';

const PROGRESS = { bufferKm: 10, sourceVersion: 'fp1' };

describe('corridorResume', () => {
  it('has nothing to say without an interrupted build', () => {
    expect(corridorResume(false, null, 5, 'fp1')).toEqual({ resumable: false, warning: null });
  });

  it('resumes only the same width over the same route', () => {
    expect(corridorResume(true, PROGRESS, 10, 'fp1')).toEqual({ resumable: true, warning: null });
  });

  it('warns that another width discards the interrupted tiles, and names the one that keeps them', () => {
    const result = corridorResume(true, PROGRESS, 5, 'fp1');
    expect(result.resumable).toBe(false);
    expect(result.warning).toMatch(/Starting at 5 km discards the interrupted download at 10 km/);
    expect(result.warning).toMatch(/Choose 10 km to resume it/);
  });

  it('warns when the route changed since, whatever the width', () => {
    const result = corridorResume(true, PROGRESS, 10, 'fp2');
    expect(result.resumable).toBe(false);
    expect(result.warning).toMatch(/route has changed/);
  });

  it('never promises a resume it cannot check', () => {
    const result = corridorResume(true, null, 10, 'fp1');
    expect(result.resumable).toBe(false);
    expect(result.warning).toMatch(/discards the interrupted download/);
  });
});
