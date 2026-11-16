import { describe, expect, it } from 'vitest';
import {
  decodeXmlText,
  detectJsonLayout,
  editCaltopoMarker,
  editJsonPreservingLayout,
  encodeXmlText,
  findCaltopoMarker,
  findGpxWaypoint,
  jsonValueSpan,
  listGpxWaypoints,
  renameKeepingPrefix,
  setGpxWaypointName,
  setGpxWaypointPosition,
} from './sources';

const GPX = [
  '<?xml version="1.0"?>',
  '<gpx version="1.1"><metadata><name><![CDATA[Test]]></name></metadata>',
  '  <wpt lat="-36.5" lon="148.25"><ele>10</ele><name>C Upper Hut</name><desc>Tank &amp; table</desc><type>hut</type></wpt>',
  '  <wpt lat="-36.6" lon="148.3"><name>Pass</name></wpt>',
  "  <wpt lat='-36.6' lon='148.3'><name>Town (access: Pass)</name></wpt>",
  '  <wpt lat="-36.7" lon="148.4"/>',
  '  <trk><trkseg><trkpt lat="-36.5" lon="148.25"/></trkseg></trk>',
  '</gpx>',
].join('\n');

describe('XML text', () => {
  it('decodes entities and CDATA', () => {
    expect(decodeXmlText('Tom&apos;s &amp; Jo&#39;s &#x2013;')).toBe("Tom's & Jo's –");
    expect(decodeXmlText('<![CDATA[a & b]]>')).toBe('a & b');
  });

  it("encodes in the file's own apostrophe style", () => {
    expect(encodeXmlText("Tom's <hut> & co", '<gpx/>')).toBe("Tom's &lt;hut&gt; &amp; co");
    expect(encodeXmlText("Tom's", '<name>Jo&apos;s</name>')).toBe('Tom&apos;s');
  });
});

describe('GPX waypoints', () => {
  const spans = listGpxWaypoints(GPX);

  it('lists every <wpt>, empty ones and single-quoted attributes included', () => {
    expect(spans.map(s => [s.name, s.lat, s.lon])).toEqual([
      ['C Upper Hut', -36.5, 148.25],
      ['Pass', -36.6, 148.3],
      ['Town (access: Pass)', -36.6, 148.3],
      ['', -36.7, 148.4],
    ]);
    expect(spans[0].desc).toBe('Tank & table');
    expect(spans[0].type).toBe('hut');
  });

  it('finds a waypoint by its exact coordinates, using the name only to break a tie', () => {
    expect(findGpxWaypoint(spans, { lat: -36.5, lon: 148.25, name: 'Upper Hut' })?.name).toBe('C Upper Hut');
    expect(findGpxWaypoint(spans, { lat: -36.6, lon: 148.3, name: 'Town (access: Pass)' })?.name).toBe(
      'Town (access: Pass)'
    );
    expect(findGpxWaypoint(spans, { lat: -36.6, lon: 148.3, name: 'Somewhere else' })).toBeNull();
    expect(findGpxWaypoint(spans, { lat: -36.50001, lon: 148.25, name: 'Upper Hut' })).toBeNull();
  });

  it('moves one waypoint by rewriting only its lat/lon attributes', () => {
    const out = setGpxWaypointPosition(GPX, spans[2], -36.61234567, 148.31);
    const changed = out.split('\n').filter((line, i) => line !== GPX.split('\n')[i]);
    expect(changed).toEqual(['  <wpt lat="-36.612346" lon="148.31"><name>Town (access: Pass)</name></wpt>']);
  });

  it('renames one waypoint, adding a <name> to one that had none', () => {
    const renamed = setGpxWaypointName(GPX, spans[0], "C Smith's Hut");
    expect(renamed).toContain("<name>C Smith's Hut</name><desc>Tank &amp; table</desc>");
    expect(renamed.length - GPX.length).toBe("C Smith's Hut".length - 'C Upper Hut'.length);
    expect(setGpxWaypointName(GPX, spans[3], 'Spring')).toContain(
      '<wpt lat="-36.7" lon="148.4"><name>Spring</name></wpt>'
    );
  });

  it('keeps the type prefix through a rename', () => {
    expect(renameKeepingPrefix('C Upper Hut', 'Upper Hut', 'Lower Hut')).toBe('C Lower Hut');
    expect(renameKeepingPrefix('WT: Tank', 'Tank', 'Rain tank')).toBe('WT: Rain tank');
    expect(renameKeepingPrefix('Pass', 'Pass', 'Saddle')).toBe('Saddle');
  });
});

describe('JSON layout', () => {
  it('recognises the layouts the trail files use, and refuses one it cannot reproduce', () => {
    expect(detectJsonLayout('{"a":[1,2]}')).toEqual({ indent: 0, trailingNewline: false, asciiOnly: false });
    expect(detectJsonLayout('{\n  "a": "–"\n}\n')).toEqual({ indent: 2, trailingNewline: true, asciiOnly: false });
    expect(detectJsonLayout('{"a":"\\u2013"}')).toEqual({ indent: 0, trailingNewline: false, asciiOnly: true });
    expect(detectJsonLayout('{ "a": [1, 2] }')).toBeNull();
    expect(() => editJsonPreservingLayout('{ "a": 1 }', 'x.json', () => {})).toThrow(/cannot be reproduced/);
  });

  it('finds a value by path without parsing the rest', () => {
    const text = '{"features":[{"id":"a","g":{"c":[1,2]}},{"id":"b \\"q\\"","g":{"c":[3, 4, 0]}}]}';
    const span = jsonValueSpan(text, ['features', 1, 'g', 'c']);
    expect(span && text.slice(span.start, span.end)).toBe('[3, 4, 0]');
    const id = jsonValueSpan(text, ['features', 1, 'id']);
    expect(id && text.slice(id.start, id.end)).toBe('"b \\"q\\""');
    expect(jsonValueSpan(text, ['features', 2])).toBeNull();
  });
});

describe('CalTopo markers', () => {
  // Mixed escaping, as in Heysen's export: no serialiser reproduces it.
  const GEOJSON =
    '{"features":[' +
    '{"geometry":null,"id":"f1","type":"Feature","properties":{"title":"Huts","class":"Folder"}},' +
    '{"geometry":{"coordinates":[148.25,-36.5,0,0],"type":"Point"},"id":"m1","type":"Feature","properties":{"title":"C Upper Hut","class":"Marker","folderId":"f1","description":"Old \\u2013 hut"}},' +
    '{"geometry":{"coordinates":[149,-37,0,0],"type":"Point"},"id":"m2","type":"Feature","properties":{"title":"Upper Hut","class":"Marker","description":"Raw – dash"}}' +
    '],"type":"FeatureCollection"}';

  it('picks the nearest marker with the same cleaned name', () => {
    const marker = findCaltopoMarker(GEOJSON, { lat: -36.5, lon: 148.25, name: 'Upper Hut' });
    expect(marker).toMatchObject({ index: 1, title: 'C Upper Hut', description: 'Old – hut' });
  });

  it('moves and retitles it in place, leaving every other byte alone', () => {
    const marker = findCaltopoMarker(GEOJSON, { lat: -36.5, lon: 148.25, name: 'Upper Hut' })!;
    const out = editCaltopoMarker(GEOJSON, 'test.json', marker, { lat: -36.51, lon: 148.26, title: 'C Lower Hut' });
    expect(out).toBe(
      GEOJSON.replace('[148.25,-36.5,0,0]', '[148.26,-36.51,0,0]').replace('"C Upper Hut"', '"C Lower Hut"')
    );
  });

  it('refuses when the marker is no longer where it was read', () => {
    const marker = findCaltopoMarker(GEOJSON, { lat: -36.5, lon: 148.25, name: 'Upper Hut' })!;
    expect(() => editCaltopoMarker(GEOJSON, 'test.json', { ...marker, index: 2 }, { title: 'X' })).toThrow(
      /no longer where it was read/
    );
  });
});
