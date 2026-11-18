import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { voiceHints } from './description-voice';

describe('voiceHints', () => {
  it('flags addressing and instructing the walker', () => {
    const matches = voiceHints('You should treat the water. Treat it.').map(h => h.match);
    expect(matches).toEqual(expect.arrayContaining(['You', 'should', 'Treat']));
  });

  it('leaves the house voice alone', () => {
    expect(voiceHints('A tank beside the hut, filled from the roof. The creek below is untreated.')).toEqual([]);
  });

  it('notices a missing full stop and doubled spaces', () => {
    expect(voiceHints('A hut.  With a tank').map(h => h.match)).toEqual(['double space', 'ending']);
  });
});

describe('the live description editor’s imports', () => {
  // admin-descriptions.html ships on the deployed site; admin-waypoints.html is
  // dev-only. A module the deployed page imports from the local editor ties its
  // production bundle to that module and everything it imports.
  it('take nothing from the local waypoint editor', () => {
    const importsOf = (file: string): string[] =>
      [...fs.readFileSync(path.join(__dirname, file), 'utf-8').matchAll(/from '(\.[^']+)'/g)].map(m => m[1]);
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        const next = path.normalize(path.join(path.dirname(file), `${spec}.ts`));
        if (fs.existsSync(path.join(__dirname, next))) walk(next);
      }
    };
    walk('admin-descriptions.ts');
    expect([...seen]).toContain('description-voice.ts');
    expect([...seen].filter(file => /admin-waypoints/.test(file))).toEqual([]);
    // And it does not itself pull the local editor in.
    expect(importsOf('description-voice.ts')).toEqual([]);
  });
});
