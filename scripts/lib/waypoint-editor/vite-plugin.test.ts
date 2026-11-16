import { describe, expect, it } from 'vitest';
import { registryChanges, writeAllowed } from './vite-plugin';

describe('writeAllowed', () => {
  it('needs the editor header, and no foreign origin', () => {
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1' })).toBe(true);
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1', origin: 'http://localhost:5173' })).toBe(
      true
    );
    expect(writeAllowed({ host: 'localhost:5173' })).toBe(false);
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1', origin: 'https://evil.example' })).toBe(
      false
    );
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1', origin: 'null' })).toBe(false);
  });
});

describe('registryChanges', () => {
  it('reports ids a build minted or retired, not ones it refreshed', () => {
    const entry = (id: string, extra = {}) => ({ id, name: id, type: 'hut', lat: 0, lon: 0, ...extra });
    const before = { demo: [entry('w_a'), entry('w_b'), entry('w_c', { retired: true as const })] };
    const after = {
      demo: [
        entry('w_a', { lat: 1 }),
        entry('w_b', { retired: true as const }),
        entry('w_c', { retired: true as const }),
        entry('w_d'),
      ],
    };
    expect(registryChanges(before, after)).toEqual({
      minted: [{ trailId: 'demo', id: 'w_d', name: 'w_d', type: 'hut' }],
      retired: [{ trailId: 'demo', id: 'w_b', name: 'w_b', type: 'hut' }],
    });
  });
});
