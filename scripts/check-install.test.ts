import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkPackageDir, installDrift, isExpected, isRunAsScript, PACKAGE_DIRS } from './check-install.mjs';

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

  const linux = { os: 'linux', cpu: 'x64', libc: 'glibc' };

  it('skips optional packages for another platform: npm installs only this one’s binary', () => {
    const withBinaries = {
      ...lock,
      'node_modules/@esbuild/darwin-arm64': { version: '0.25.0', optional: true, os: ['darwin'], cpu: ['arm64'] },
      'node_modules/@rollup/rollup-linux-x64-musl': {
        version: '4.0.0',
        optional: true,
        os: ['linux'],
        cpu: ['x64'],
        libc: ['musl'],
      },
      'node_modules/@emnapi/runtime': { version: '1.0.0', optional: true },
    };
    const { '': _root, ...installed } = lock;
    expect(installDrift(withBinaries, installed, { platform: linux })).toEqual([]);
  });

  it('names this platform’s own optional binary when it is missing', () => {
    const withBinary = {
      ...lock,
      'node_modules/@rollup/rollup-linux-x64-gnu': {
        version: '4.0.0',
        optional: true,
        os: ['linux'],
        cpu: ['x64'],
        libc: ['glibc'],
      },
    };
    const { '': _root, ...installed } = lock;
    expect(installDrift(withBinary, installed, { platform: linux })).toEqual([
      '@rollup/rollup-linux-x64-gnu: not installed (lockfile has 4.0.0)',
    ]);
  });

  it('names a package whose folder is gone or holds another version, though npm’s record lists it', () => {
    const { '': _root, ...installed } = lock;
    const onDisk: Record<string, string> = {
      'node_modules/@scope/pkg': '1.0.0',
      'node_modules/a/node_modules/b': '1.2.3',
    };
    expect(installDrift(lock, installed, { platform: linux, folderVersion: key => onDisk[key] })).toEqual([
      'prettier: its folder (node_modules/prettier) is missing, lockfile has 3.9.10',
      '@scope/pkg: 1.0.0 in node_modules/@scope/pkg/package.json, lockfile has 2.0.0',
    ]);
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

describe('isExpected', () => {
  const linuxArm = { os: 'linux', cpu: 'arm64', libc: 'musl' };

  it('expects required packages and never links', () => {
    expect(isExpected({}, linuxArm)).toBe(true);
    expect(isExpected({ link: true }, linuxArm)).toBe(false);
  });

  it('matches os, cpu and libc, negations included', () => {
    expect(isExpected({ optional: true, os: ['linux'], cpu: ['arm64'], libc: ['musl'] }, linuxArm)).toBe(true);
    expect(isExpected({ optional: true, os: ['linux'], cpu: ['arm64'], libc: ['glibc'] }, linuxArm)).toBe(false);
    expect(isExpected({ optional: true, os: ['!win32'] }, linuxArm)).toBe(true);
    expect(isExpected({ optional: true, cpu: ['!arm64'] }, linuxArm)).toBe(false);
    expect(isExpected({ optional: true, libc: ['glibc'] }, { os: 'darwin', cpu: 'arm64' })).toBe(false);
  });
});

describe('checkPackageDir', () => {
  it('reads each package’s folder as well as npm’s record', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-install-'));
    try {
      const packages = { '': { version: '1.0.0' }, 'node_modules/left-pad': { version: '1.3.0' } };
      fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages }));
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ packages }));
      expect(checkPackageDir(root, '.')).toEqual([
        'left-pad: its folder (node_modules/left-pad) is missing, lockfile has 1.3.0',
      ]);
      fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'));
      fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'package.json'), '{"version":"1.3.0"}');
      expect(checkPackageDir(root, '.')).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isRunAsScript', () => {
  const script = path.join(ROOT, 'scripts', 'check-install.mjs');

  it('recognises the script reached through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-install-link-'));
    try {
      const link = path.join(dir, 'check-install.mjs');
      fs.symlinkSync(script, link);
      expect(isRunAsScript(link, script)).toBe(true);
      expect(isRunAsScript(path.join(ROOT, 'scripts', 'check-install.test.ts'), script)).toBe(false);
      expect(isRunAsScript(undefined, script)).toBe(false);
      // run through the symlink, it checks a directory with no lockfile and says so
      expect(() => execFileSync(process.execPath, [link, 'no-such-dir'], { stdio: 'pipe' })).toThrow(
        /no package-lock\.json in no-such-dir/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
