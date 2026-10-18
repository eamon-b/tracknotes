/**
 * Read the contour elevations out of a Mapbox Vector Tile, and judge whether a
 * z9 tile is tiered (scripts/tile-pipeline.ts CONTOUR_TIERS: only the 100 m
 * lines start at z9).
 *
 * Plain JavaScript and Node built-ins only, like scripts/e2e-tile-check.mjs,
 * which runs in CI without `npm ci`.
 */

import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';

/** Protobuf varint at `pos`: [value, next position]. */
function readVarint(buf, pos) {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, pos];
    scale *= 128;
    if (scale > 2 ** 63) throw new Error('varint too long');
  }
}

/** The fields of one protobuf message: [{ field, wire, value | bytes }]. */
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      out.push({ field, wire, value });
    } else if (wire === 1) {
      out.push({ field, wire, bytes: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      out.push({ field, wire, bytes: buf.subarray(pos, pos + length) });
      pos += length;
    } else if (wire === 5) {
      out.push({ field, wire, bytes: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`bad wire type ${wire}`);
    }
    if (pos > buf.length) throw new Error('field overruns the message');
  }
  return out;
}

/** A vector tile Value message → number | string | boolean. */
function decodeValue(buf) {
  for (const f of fields(buf)) {
    const view = f.bytes && new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.length);
    switch (f.field) {
      case 1: return new TextDecoder().decode(f.bytes);
      case 2: return view.getFloat32(0, true);
      case 3: return view.getFloat64(0, true);
      case 4: // int64: two's complement in a varint
      case 5: return f.value >= 2 ** 63 ? f.value - 2 ** 64 : f.value;
      case 6: return f.value % 2 === 0 ? f.value / 2 : -(f.value + 1) / 2;
      case 7: return f.value !== 0;
    }
  }
  return null;
}

function packedVarints(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let value;
    [value, pos] = readVarint(buf, pos);
    out.push(value);
  }
  return out;
}

/**
 * The `elevation` of every feature in the tile's `layerName` layer (a feature
 * without one gives null). `tile` may be gzipped, as tippecanoe stores it.
 */
export function contourElevations(tile, layerName = 'contour') {
  let buf = tile instanceof Uint8Array ? tile : new Uint8Array(tile);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(gunzipSync(buf));
  const elevations = [];
  let layers = 0;
  for (const layerField of fields(buf)) {
    if (layerField.field !== 3 || layerField.wire !== 2) continue;
    const layer = fields(layerField.bytes);
    const name = layer.find(f => f.field === 1);
    if (!name || new TextDecoder().decode(name.bytes) !== layerName) continue;
    layers++;
    const keys = layer.filter(f => f.field === 3).map(f => new TextDecoder().decode(f.bytes));
    const values = layer.filter(f => f.field === 4).map(f => decodeValue(f.bytes));
    const elevationKey = keys.indexOf('elevation');
    for (const featureField of layer.filter(f => f.field === 2)) {
      const tags = fields(featureField.bytes).filter(f => f.field === 2).flatMap(f => packedVarints(f.bytes));
      let elevation = null;
      for (let i = 0; i + 1 < tags.length; i += 2) {
        if (tags[i] === elevationKey) elevation = values[tags[i + 1]] ?? null;
      }
      elevations.push(elevation);
    }
  }
  return { layers, elevations };
}

/**
 * Whether a z9 contour tile is tiered: it has the contour layer, and every
 * feature in it is a 100 m line (the only tier that starts at z9). Returns
 * `{ ok, features, offInterval, reason? }`; `offInterval` counts the features
 * whose elevation is missing or not a multiple of 100.
 */
export function checkZ9Tiered(tile, { interval = 100 } = {}) {
  const { layers, elevations } = contourElevations(tile);
  if (layers === 0) return { ok: false, features: 0, offInterval: 0, reason: 'no contour layer' };
  const offInterval = elevations.filter(e => typeof e !== 'number' || e % interval !== 0).length;
  if (offInterval > 0) {
    const sample = [...new Set(elevations.filter(e => typeof e !== 'number' || e % interval !== 0))].slice(0, 5);
    return {
      ok: false,
      features: elevations.length,
      offInterval,
      reason: `${offInterval} of ${elevations.length} features are not ${interval} m lines (e.g. ${sample.join(', ')})`,
    };
  }
  return { ok: true, features: elevations.length, offInterval: 0 };
}
