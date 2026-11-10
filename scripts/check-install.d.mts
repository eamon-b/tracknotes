/** Types for check-install.mjs (plain JavaScript so it runs when the install it checks is broken). */

interface LockEntry {
  version?: string;
  resolved?: string;
  optional?: boolean;
  link?: boolean;
}

export const PACKAGE_DIRS: string[];

export function installDrift(lock: Record<string, LockEntry>, installed: Record<string, LockEntry>): string[];

export function checkPackageDir(root: string, dir: string): string[];
