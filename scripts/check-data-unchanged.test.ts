import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectOutputs, defaultSnapshotDir, parseArgs } from './check-data-unchanged.js';

describe('parseArgs', () => {
  const root = '/repo';

  it('compares against the default snapshot, rebuilding first', () => {
    expect(parseArgs([], root)).toEqual({
      baseline: false,
      ref: 'origin/main',
      current: false,
      build: true,
      snapshotDir: defaultSnapshotDir(root),
    });
  });

  it('takes a baseline ref, the current tree, or a snapshot directory', () => {
    expect(parseArgs(['--baseline', '--ref', 'HEAD~1'], root)).toMatchObject({ baseline: true, ref: 'HEAD~1' });
    expect(parseArgs(['--baseline', '--current'], root)).toMatchObject({ baseline: true, current: true });
    expect(parseArgs(['--no-build', '--snapshot', '/tmp/snap'], root)).toMatchObject({
      build: false,
      snapshotDir: '/tmp/snap',
    });
  });

  it('rejects unknown, valueless and contradictory arguments', () => {
    expect(() => parseArgs(['--baselin'], root)).toThrow(/unknown argument/);
    expect(() => parseArgs(['--baseline', '--ref'], root)).toThrow(/needs a value/);
    expect(() => parseArgs(['--current'], root)).toThrow(/go with --baseline/);
    expect(() => parseArgs(['--baseline', '--current', '--ref', 'HEAD'], root)).toThrow(/alternatives/);
  });

  it('gives each checkout its own snapshot', () => {
    expect(defaultSnapshotDir('/a')).not.toBe(defaultSnapshotDir('/b'));
    expect(defaultSnapshotDir('/a')).toBe(defaultSnapshotDir('/a'));
  });
});

describe('collectOutputs', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-data-unchanged-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string, content: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it('reads the generated, app and page outputs and the registry, and not the page sources', () => {
    write('public/data/generated/index.json', '[]');
    write('public/data/generated/demo.json', '{}');
    write('mobile/assets/trails/demo.json', '{}');
    write('src/web/trails/demo/index.html', '<html>');
    write('src/web/trails/trail-template.html', 'template');
    write('src/web/trails/trail-viewer.ts', 'code');
    write('data/waypoint-ids.json', '{}');
    expect([...collectOutputs(root).keys()].sort()).toEqual([
      'generated/demo.json',
      'generated/index.json',
      'mobile/demo.json',
      'pages/demo/index.html',
      'waypoint-ids.json',
    ]);
  });
});
