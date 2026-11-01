/**
 * The export file must be complete when `writeCommentExportFile` returns,
 * because the caller hands its URI straight to the share sheet. The fake below
 * keeps the SDK 58 shape: `write` finishes later, `writeSync` before it returns.
 */

import { commentExportFileName, writeCommentExportFile } from '../comment-export-file';

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
    create() {
      mockDisk.set(this.uri, '');
    }
    writeSync(contents: string) {
      mockDisk.set(this.uri, contents);
    }
    write(contents: string) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          mockDisk.set(this.uri, contents);
          resolve();
        }, 0);
      });
    }
  }
  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

beforeEach(() => mockDisk.clear());

describe('writeCommentExportFile', () => {
  it('has the whole export on disk by the time it returns the URI', () => {
    const uri = writeCommentExportFile('{"comments":[]}', '2026-10-31T20:47:19.000Z');

    expect(uri).toBe('file:///cache/comment-export/tracknotes-comments-2026-10-31.json');
    expect(mockDisk.get(uri)).toBe('{"comments":[]}');
  });

  it('replaces the previous export rather than keeping both', () => {
    const earlier = writeCommentExportFile('old', '2026-10-30T00:00:00.000Z');
    const later = writeCommentExportFile('new', '2026-10-31T00:00:00.000Z');

    expect(mockDisk.has(earlier)).toBe(false);
    expect(mockDisk.get(later)).toBe('new');
  });
});

describe('commentExportFileName', () => {
  it('dates the file from the ISO export time', () => {
    expect(commentExportFileName('2026-10-31T20:47:19.000Z')).toBe(
      'tracknotes-comments-2026-10-31.json',
    );
  });
});
