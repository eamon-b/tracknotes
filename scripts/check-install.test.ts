import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { installDrift, PACKAGE_DIRS } from './check-install.mjs';

const ROOT = path.resolve(__dirname, '..');

describe('installDrift', () => {
  const lock = {
    '': { version: '1.0.0' },
    'node_modules/prettier': { version: '3.9.10' },
    'node_modules/@scope/pkg': { version: '2.0.0' },
    'node_modules/a/node_modules/b': { version: '1.2.3' },
  };

  it('is empty when every pinned package is installed at its version', () => {
    const { '': _root, ...installed } = lock;
    expect(installDrift(lock, installed)).toEqual([]);
  });

  it('names a package the lockfile pins and the install lacks', () => {
    const { 'node_modules/prettier': _prettier, ...installed } = lock;
    expect(installDrift(lock, installed)).toEqual(['prettier: not installed (lockfile has 3.9.10)']);
  });

  it('names a package installed at another version, by its own name when nested or scoped', () => {
    const installed = {
      ...lock,
      'node_modules/@scope/pkg': { version: '1.9.0' },
      'node_modules/a/node_modules/b': { version: '1.0.0' },
    };
    expect(installDrift(lock, installed)).toEqual([
      '@scope/pkg: 1.9.0 installed, lockfile has 2.0.0',
      'b: 1.0.0 installed, lockfile has 1.2.3',
    ]);
  });

  it('skips optional packages: only this platform’s binary is ever installed', () => {
    const withBinaries = { ...lock, 'node_modules/@esbuild/darwin-arm64': { version: '0.25.0', optional: true } };
    const { '': _root, ...installed } = lock;
    expect(installDrift(withBinaries, installed)).toEqual([]);
  });

  it('tells a git dependency at an older commit from the pinned one', () => {
    const pinned = {
      'node_modules/te-araroa-data': {
        version: '1.0.0',
        resolved: 'git+ssh://git@github.com/eamon-b/te-araroa-data.git#aaaaaaa1111111',
      },
    };
    const older = {
      'node_modules/te-araroa-data': {
        version: '1.0.0',
        resolved: 'git+ssh://git@github.com/eamon-b/te-araroa-data.git#bbbbbbb2222222',
      },
    };
    expect(installDrift(pinned, pinned)).toEqual([]);
    expect(installDrift(pinned, older)).toEqual(['te-araroa-data: installed from bbbbbbb, lockfile has aaaaaaa']);
  });
});

describe('PACKAGE_DIRS', () => {
  it('lists every directory that has its own lockfile', () => {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (fs.existsSync(path.join(ROOT, dir, 'package-lock.json'))) found.push(dir);
      if (depth === 0) return;
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (dir === '.' && ['public', 'dist', 'data', 'aus-map-data'].includes(entry.name)) continue;
        walk(dir === '.' ? entry.name : `${dir}/${entry.name}`, depth - 1);
      }
    };
    walk('.', 2);
    expect(found.sort()).toEqual([...PACKAGE_DIRS].sort());
  });
});
