/**
 * The plan export's cache file: one at a time, and removable on its own so
 * account deletion can clear it (`account-deletion.ts`).
 */

import { deletePlanExportFile, writePlanExportFile } from '../plan-export-file';

const mockDisk = new Map<string, string>();

jest.mock('expo-file-system', () => {
  class MockDirectory {
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return [...mockDisk.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    delete() {
      for (const path of [...mockDisk.keys()]) {
        if (path.startsWith(`${this.uri}/`)) mockDisk.delete(path);
      }
    }
    create() {}
  }
  class MockFile {
    uri: string;
    constructor(dir: { uri: string }, name: string) {
      this.uri = `${dir.uri}/${name}`;
    }
    writeSync(contents: string) {
      mockDisk.set(this.uri, contents);
    }
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { cache: { uri: 'file:///cache' } } };
});

beforeEach(() => mockDisk.clear());

describe('writePlanExportFile', () => {
  it('replaces the previous export rather than keeping both', () => {
    const earlier = writePlanExportFile('a.gpx', 'old');
    const later = writePlanExportFile('b.ics', 'new');

    expect(later).toBe('file:///cache/plan-export/b.ics');
    expect(mockDisk.has(earlier)).toBe(false);
    expect(mockDisk.get(later)).toBe('new');
  });
});

describe('deletePlanExportFile', () => {
  it('removes the last export and nothing outside its folder', () => {
    const uri = writePlanExportFile('plan.gpx', 'gpx');
    mockDisk.set('file:///cache/comment-export/c.json', '{}');

    deletePlanExportFile();

    expect(mockDisk.has(uri)).toBe(false);
    expect(mockDisk.get('file:///cache/comment-export/c.json')).toBe('{}');
  });

  it('is a no-op when there is no export', () => {
    expect(() => deletePlanExportFile()).not.toThrow();
  });
});
