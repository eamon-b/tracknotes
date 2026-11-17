import { describe, expect, it } from 'vitest';
import {
  addCaltopoFolder,
  decodeXmlText,
  detectJsonLayout,
  editCaltopoMarker,
  editJsonPreservingLayout,
  encodeXmlText,
  findCaltopoMarker,
  findGpxWaypoint,
  folderTitlesForType,
  insertGpxWaypoint,
  jsonValueSpan,
  listGpxWaypoints,
  nearestCaltopoMarker,
  newFolderTitle,
  readCaltopoExport,
  removeCaltopoFeature,
  removeGpxWaypoint,
  renameKeepingPrefix,
  setCaltopoMarkerFolder,
  setGpxWaypointName,
  setGpxWaypointPosition,
  setGpxWaypointType,
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

describe('GPX types, new and removed waypoints', () => {
  const spans = listGpxWaypoints(GPX);

  it('replaces a <type> in place, and adds one in the line style of the <wpt>', () => {
    const retyped = setGpxWaypointType(GPX, spans[0], 'campsite');
    expect(retyped).toBe(GPX.replace('<type>hut</type>', '<type>campsite</type>'));
    expect(setGpxWaypointType(GPX, spans[1], 'road-crossing')).toBe(
      GPX.replace('<name>Pass</name></wpt>', '<name>Pass</name><type>road-crossing</type></wpt>')
    );
    expect(setGpxWaypointType(GPX, spans[3], 'water')).toContain(
      '<wpt lat="-36.7" lon="148.4"><type>water</type></wpt>'
    );
  });

  const MULTI = [
    '<gpx version="1.1">',
    '  <wpt lat="1" lon="2">',
    '    <name>East Glacier Park</name>',
    '    <link href="https://example.com/" />',
    '    <extensions>',
    '      <tn:offTrailKm>0.8</tn:offTrailKm>',
    '    </extensions>',
    '  </wpt>',
    '  <wpt lat="3" lon="4">',
    '    <name>No.1 Ryozenji</name>',
    '    <type>poi</type>',
    '    <desc>Temple 1.</desc>',
    '  </wpt>',
    '  <trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n');

  it("adds a <type> on its own line before <extensions>, never reading a <link>'s", () => {
    const multi = listGpxWaypoints(MULTI);
    expect(multi[0].type).toBeUndefined();
    expect(setGpxWaypointType(MULTI, multi[0], 'resupply')).toContain(
      '    <link href="https://example.com/" />\n    <type>resupply</type>\n    <extensions>'
    );
  });

  it('inserts a new <wpt> after the last one, in the style and child order the file uses', () => {
    const multi = insertGpxWaypoint(MULTI, { lat: -36.1234567, lon: 148.5, name: "Jo's Tank", type: 'water-tank' });
    expect(multi).toContain(
      '    <desc>Temple 1.</desc>\n  </wpt>\n  <wpt lat="-36.123457" lon="148.5">\n    <name>Jo\'s Tank</name>\n    <type>water-tank</type>\n  </wpt>\n  <trk>'
    );
    const oneLine = insertGpxWaypoint(GPX, { lat: 1, lon: 2, name: 'A & B', type: 'hut', desc: 'Two <rooms>.' });
    expect(oneLine).toContain(
      '  <wpt lat="-36.7" lon="148.4"/>\n  <wpt lat="1" lon="2"><name>A &amp; B</name><desc>Two &lt;rooms&gt;.</desc><type>hut</type></wpt>\n  <trk>'
    );
    const caltopo = '<gpx><wpt lat="1" lon="2"><name>C Flat</name></wpt><trk/></gpx>';
    expect(insertGpxWaypoint(caltopo, { lat: 3, lon: 4, name: 'Tank', type: 'water-tank' })).toBe(
      '<gpx><wpt lat="1" lon="2"><name>C Flat</name></wpt><wpt lat="3" lon="4"><name>Tank</name><type>water-tank</type></wpt><trk/></gpx>'
    );
    expect(insertGpxWaypoint('<gpx>\n  <trk/>\n</gpx>', { lat: 3, lon: 4, name: 'Tank', type: 'water' })).toBe(
      '<gpx>\n  <wpt lat="3" lon="4"><name>Tank</name><type>water</type></wpt>\n  <trk/>\n</gpx>'
    );
  });

  it('removes a <wpt> with the spacing before it, and inserting then removing gives the file back', () => {
    expect(removeGpxWaypoint(GPX, spans[1])).toBe(
      GPX.replace('\n  <wpt lat="-36.6" lon="148.3"><name>Pass</name></wpt>', '')
    );
    const added = insertGpxWaypoint(GPX, { lat: 1, lon: 2, name: 'Tank', type: 'water' });
    const span = listGpxWaypoints(added).find(s => s.name === 'Tank')!;
    expect(removeGpxWaypoint(added, span)).toBe(GPX);
  });
});

describe('CalTopo folders', () => {
  const GEOJSON =
    '{"features":[' +
    '{"geometry":null,"id":"f1","type":"Feature","properties":{"title":"Campsites","class":"Folder"}},' +
    '{"geometry":null,"id":"f2","type":"Feature","properties":{"title":"Main route","class":"Folder"}},' +
    '{"geometry":{"coordinates":[148.25,-36.5,0,0],"type":"Point"},"id":"m1","type":"Feature","properties":{"title":"C Flat","class":"Marker","folderId":"f1"}},' +
    '{"geometry":{"coordinates":[148.3,-36.6,0,0],"type":"Point"},"id":"m2","type":"Feature","properties":{"title":"W Creek","class":"Marker","folderId":"f2"}},' +
    '{"geometry":{"coordinates":[148.4,-36.7,0,0],"type":"Point"},"id":"m3","type":"Feature","properties":{"title":"Omeo","class":"Marker"}}' +
    '],"type":"FeatureCollection"}';

  it('types markers as the build does: a known folder first, then the title', () => {
    const parsed = readCaltopoExport(GEOJSON)!;
    expect(parsed.markers.map(m => [m.cleanedName, m.type, m.typedByFolder, m.folderTitle])).toEqual([
      ['Flat', 'campsite', true, 'Campsites'],
      ['Creek', 'water', false, 'Main route'],
      ['Omeo', 'town', false, undefined],
    ]);
    expect(nearestCaltopoMarker(parsed.markers, { lat: -36.6, lon: 148.3, name: 'Creek' })?.index).toBe(3);
    expect(readCaltopoExport('not json')).toBeNull();
  });

  it('knows which folder titles mean a type', () => {
    expect(folderTitlesForType('water-tank')).toEqual(['water tanks']);
    expect(newFolderTitle('water-tank')).toBe('Water tanks');
    expect(newFolderTitle('town-access')).toBeNull();
  });

  it('moves a marker into a folder, replacing or adding its folderId and nothing else', () => {
    expect(setCaltopoMarkerFolder(GEOJSON, 'x.json', { index: 3, title: 'W Creek' }, 'f1')).toBe(
      GEOJSON.replace('"W Creek","class":"Marker","folderId":"f2"', '"W Creek","class":"Marker","folderId":"f1"')
    );
    expect(setCaltopoMarkerFolder(GEOJSON, 'x.json', { index: 4, title: 'Omeo' }, 'f1')).toBe(
      GEOJSON.replace('"Omeo","class":"Marker"}', '"Omeo","class":"Marker","folderId":"f1"}')
    );
    expect(() => setCaltopoMarkerFolder(GEOJSON, 'x.json', { index: 2, title: 'Omeo' }, 'f1')).toThrow(
      /no longer where it was read/
    );
  });

  it('adds a folder first in the features, shaped like CalTopo’s', () => {
    const out = addCaltopoFolder(GEOJSON, 'x.json', { id: 'f9', title: 'Water tanks' });
    expect(out).toBe(
      GEOJSON.replace(
        '{"features":[',
        '{"features":[{"geometry":null,"id":"f9","type":"Feature","properties":{"title":"Water tanks","class":"Folder"}},'
      )
    );
    expect(readCaltopoExport(out)!.folders.map(f => f.title)).toEqual(['Water tanks', 'Campsites', 'Main route']);
  });

  it('removes a marker feature with the comma that joined it, wherever it sits', () => {
    const middle = removeCaltopoFeature(GEOJSON, 'x.json', { index: 3, title: 'W Creek' });
    expect(JSON.parse(middle).features.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2', 'm1', 'm3']);
    expect(middle).toBe(GEOJSON.replace(/\{"geometry":\{"coordinates":\[148\.3[^]*?"folderId":"f2"\}\},/, ''));
    const last = removeCaltopoFeature(GEOJSON, 'x.json', { index: 4, title: 'Omeo' });
    expect(last.endsWith('"folderId":"f2"}}],"type":"FeatureCollection"}')).toBe(true);
    expect(JSON.parse(last).features).toHaveLength(4);
  });
});
