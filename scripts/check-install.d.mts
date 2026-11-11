/** Types for check-install.mjs (plain JavaScript so it runs when the install it checks is broken). */

interface LockEntry {
  version?: string;
  resolved?: string;
  optional?: boolean;
  link?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

export interface Platform {
  os: string;
  cpu: string;
  libc?: string;
}

export const PACKAGE_DIRS: string[];

export function currentPlatform(): Platform;

export function isExpected(want: LockEntry, platform: Platform): boolean;

export function installDrift(
  lock: Record<string, LockEntry>,
  installed: Record<string, LockEntry>,
  options?: { platform?: Platform; folderVersion?: (key: string) => string | undefined }
): string[];

export function checkPackageDir(root: string, dir: string): string[];

export function isRunAsScript(argv1: string | undefined, modulePath: string): boolean;
