import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageProblem, syncedRouteProblem } from './te-araroa-package.js';

const LOCKED = 'git+ssh://git@github.com/eamon-b/te-araroa-data.git#9147a04484ff72d89362b69414a9a12fac48e8ba';
const OTHER = 'git+ssh://git@github.com/eamon-b/te-araroa-data.git#d73a42dd2f33a6ea743b53335ca7fc9328d60726';

let root: string;

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function lock(resolved: string): string {
  return JSON.stringify({ packages: { 'node_modules/te-araroa-data': { version: '1.0.0', resolved } } });
}

/** A checkout with the package installed at the locked commit and synced. */
function healthyCheckout(): void {
  write('package-lock.json', lock(LOCKED));
  write('node_modules/.package-lock.json', lock(LOCKED));
  write('node_modules/te-araroa-data/package.json', '{}');
  write('node_modules/te-araroa-data/out/te-araroa-sobo.gpx', '<gpx>v45</gpx>');
  write('data/trails/te_araroa/te-araroa-sobo.gpx', '<gpx>v45</gpx>');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-araroa-package-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('packageProblem', () => {
  it('passes the locked install', () => {
    healthyCheckout();
    expect(packageProblem(root)).toBeNull();
  });

  it("does not look in a parent directory's node_modules", () => {
    // A worktree under .claude/worktrees/ sits inside the main checkout, whose
    // node_modules Node's resolution would find.
    healthyCheckout();
    const nested = path.join(root, '.claude/worktrees/agent');
    fs.mkdirSync(nested, { recursive: true });
    expect(packageProblem(nested)).toMatch(/not installed in this checkout.*npm ci/);
  });

  it('names npm ci when the install is from another commit than the lockfile', () => {
    healthyCheckout();
    write('node_modules/.package-lock.json', lock(OTHER));
    expect(packageProblem(root)).toBe(
      'te-araroa-data is installed from d73a42d but package-lock.json pins 9147a04. Run `npm ci`.'
    );
  });

  it('leaves a local path install alone (trying an upstream change)', () => {
    healthyCheckout();
    write('node_modules/.package-lock.json', lock('../te-araroa-data'));
    expect(packageProblem(root)).toBeNull();
  });

  it('flags a package without its committed outputs', () => {
    healthyCheckout();
    fs.rmSync(path.join(root, 'node_modules/te-araroa-data/out'), { recursive: true });
    expect(packageProblem(root)).toMatch(/has no out\/te-araroa-sobo\.gpx/);
  });
});

describe('syncedRouteProblem', () => {
  it('passes a synced copy of the installed route', () => {
    healthyCheckout();
    expect(syncedRouteProblem(root)).toBeNull();
  });

  it('names sync:te-araroa when the copy is missing', () => {
    healthyCheckout();
    fs.rmSync(path.join(root, 'data/trails/te_araroa/te-araroa-sobo.gpx'));
    expect(syncedRouteProblem(root)).toBe(
      'data/trails/te_araroa/te-araroa-sobo.gpx is missing. Run `npm run sync:te-araroa`.'
    );
  });

  it('names sync:te-araroa when the copy is from another install', () => {
    healthyCheckout();
    write('data/trails/te_araroa/te-araroa-sobo.gpx', '<gpx>v44</gpx>');
    expect(syncedRouteProblem(root)).toMatch(/differs from the installed te-araroa-data.*npm run sync:te-araroa/);
  });

  it('reports a package problem before a sync problem', () => {
    healthyCheckout();
    fs.rmSync(path.join(root, 'node_modules/te-araroa-data'), { recursive: true });
    expect(syncedRouteProblem(root)).toMatch(/npm ci/);
  });
});
