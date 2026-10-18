/** Types for http-mbtiles.mjs (plain JavaScript so e2e-tile-check.mjs runs without a build). */

/** Bytes [start, end] inclusive of the file. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

export type RecordValue = null | number | string | Uint8Array;

export function httpRangeReader(url: string, fetchFn?: typeof fetch): RangeReader;
export function parseRecord(payload: Uint8Array): RecordValue[];
export function tableColumns(sql: string): Array<{ name: string; rowidAlias: boolean }>;
export function indexColumns(sql: string): string[];
export function readZoomTiles(
  read: RangeReader,
  zoom: number
): Promise<Array<{ x: number; y: number; data: Uint8Array }>>;
