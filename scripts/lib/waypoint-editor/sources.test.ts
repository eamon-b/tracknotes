import { describe, expect, it } from 'vitest';
import {
  addCaltopoFolder,
  decodeXmlText,
  detectJsonLayout,
  editCaltopoMarker,
  editJsonPreservingLayout,
  elevationDecimals,
  encodeXmlText,
  findCaltopoMarker,
  findGpxWaypoint,
  folderTitlesForType,
  formatElevation,
  gpxWaypointBuildName,
  gpxWaypointElevationStyle,
  insertGpxWaypoint,
  jsonValueSpan,
  listGpxWaypoints,
  nearestCaltopoMarker,
  newFolderTitle,
  readCaltopoExport,
  removeCaltopoFeature,
  removeGpxWaypoint,
  renameJsonArrayString,
  renameKeepingPrefix,
  setCaltopoMarkerFolder,
  setGpxWaypointDesc,
  setGpxWaypointElevation,
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

  it('finds a waypoint by its exact coordinates and the name the build shows, a lone candidate included', () => {
    expect(findGpxWaypoint(spans, { lat: -36.5, lon: 148.25, name: 'Upper Hut' })?.name).toBe('C Upper Hut');
    // Another waypoint's <wpt> is never claimed for standing where this one stood.
    expect(findGpxWaypoint(spans, { lat: -36.5, lon: 148.25, name: 'Lower Hut' })).toBeNull();
    expect(findGpxWaypoint(spans, { lat: -36.5, lon: 148.25, name: 'Hut' })).toBeNull();
    expect(findGpxWaypoint(spans, { lat: -36.7, lon: 148.4, name: 'Unnamed' })?.start).toBe(spans[3].start);
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
    expect(renameKeepingPrefix('C Upper Hut', 'Lower Hut')).toBe('C Lower Hut');
    expect(renameKeepingPrefix('WT: Tank', 'Rain tank')).toBe('WT: Rain tank');
    expect(renameKeepingPrefix('Pass', 'Saddle')).toBe('Saddle');
  });

  it('changes only the name part, whatever the prefix style and the whitespace around it', () => {
    // Every prefix style in the bundled GPX files and CalTopo exports.
    const styles: [string, string][] = [
      ['C Camp', 'C '],
      ['C: Camp', 'C: '],
      ['WT: Camp', 'WT: '],
      ['WT:Camp', 'WT:'],
      ['WT Camp', 'WT '],
      ['W Camp', 'W '],
      ['H Camp', 'H '],
      ['T: Camp', 'T: '],
      ['T Camp', 'T '],
      ['TH Camp', 'TH '],
      ['CP Camp', 'CP '],
      ['R Camp', 'R '],
      ['F Camp', 'F '],
      ['S Camp', 'S '],
      ['E Camp', 'E '],
      ['Camp', ''],
    ];
    const around: [string, string][] = [
      ['', ''],
      [' ', ''],
      ['', ' '],
      ['\n    ', '\n  '],
    ];
    for (const [raw, prefix] of styles) {
      for (const [lead, trail] of around) {
        expect(renameKeepingPrefix(`${lead}${raw}${trail}`, 'New Ck')).toBe(`${lead}${prefix}New Ck${trail}`);
      }
    }
    // The AAWT's marker, with its trailing space, and Larapinta's, with a leading one.
    expect(renameKeepingPrefix('W Gurrangorambla Creek ', 'Gurrangorambla Ck')).toBe('W Gurrangorambla Ck ');
    expect(renameKeepingPrefix(' C: Brinkley Bluff', 'Brinkley')).toBe(' C: Brinkley');
    // A name that only ends like the old one is not a prefix and a name.
    expect(renameKeepingPrefix('Dry Creek', 'Ck')).toBe('Ck');
  });

  it('keeps the whitespace a <name> has around its text, in the GPX too', () => {
    const gpx =
      '<gpx><wpt lat="1" lon="2"><name> C: Brinkley Bluff</name></wpt>' +
      '<wpt lat="3" lon="4"><name>W Creek </name></wpt></gpx>';
    const [bluff, creek] = listGpxWaypoints(gpx);
    expect(setGpxWaypointName(gpx, bluff, renameKeepingPrefix(bluff.name, 'Brinkley'))).toBe(
      gpx.replace(' C: Brinkley Bluff', ' C: Brinkley')
    );
    expect(setGpxWaypointName(gpx, creek, renameKeepingPrefix(creek.name, 'Ck'))).toBe(
      gpx.replace('W Creek ', 'W Ck ')
    );
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

  it('replaces a <desc> in place, adds one after the <name> in the line style of the <wpt>, and removes one', () => {
    expect(setGpxWaypointDesc(GPX, spans[0], 'Tank <only>')).toBe(
      GPX.replace('<desc>Tank &amp; table</desc>', '<desc>Tank &lt;only&gt;</desc>')
    );
    expect(setGpxWaypointDesc(GPX, spans[0], '')).toBe(GPX.replace('<desc>Tank &amp; table</desc>', ''));
    const added = setGpxWaypointDesc(GPX, spans[1], 'A low saddle.');
    expect(added).toBe(GPX.replace('<name>Pass</name></wpt>', '<name>Pass</name><desc>A low saddle.</desc></wpt>'));
    // Adding then removing gives the file back, and removing what is not there changes nothing.
    expect(setGpxWaypointDesc(added, listGpxWaypoints(added)[1], '')).toBe(GPX);
    expect(setGpxWaypointDesc(GPX, spans[1], '')).toBe(GPX);
    expect(setGpxWaypointDesc(GPX, spans[3], 'Bare.')).toContain(
      '<wpt lat="-36.7" lon="148.4"><desc>Bare.</desc></wpt>'
    );

    const multi = listGpxWaypoints(MULTI);
    const multiAdded = setGpxWaypointDesc(MULTI, multi[0], 'A town.');
    expect(multiAdded).toContain(
      '    <name>East Glacier Park</name>\n    <desc>A town.</desc>\n    <link href="https://example.com/" />'
    );
    expect(setGpxWaypointDesc(multiAdded, listGpxWaypoints(multiAdded)[0], '')).toBe(MULTI);
    expect(setGpxWaypointDesc(MULTI, multi[1], '')).toContain('    <type>poi</type>\n  </wpt>');
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

describe('GPX waypoint elevations', () => {
  // The bundled open-data files' style: every <wpt> on one line, <ele> first, one decimal.
  const WITH_ELE = [
    '<gpx version="1.1">',
    '  <wpt lat="-33.1" lon="151.1"><ele>745.0</ele><name>Drinking water</name><type>water</type></wpt>',
    '  <wpt lat="-33.2" lon="151.2"><ele>13.4</ele><name>Warners Bay</name><desc>Shops.</desc><type>town</type></wpt>',
    '  <trk><trkseg><trkpt lat="-33.1" lon="151.1"><ele>745</ele></trkpt></trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n');
  // A device's style: one child per line, <ele> first, whole metres, a height of its own in <extensions>.
  const MULTI_ELE = [
    '<gpx version="1.1">',
    '  <wpt lat="48.1" lon="-113.1">',
    '    <ele> 1309 </ele>',
    '    <name>Crazy Cook</name>',
    '    <extensions><x:ele>9999</x:ele><ele>8888</ele></extensions>',
    '  </wpt>',
    '  <wpt lat="48.2" lon="-113.2">',
    '    <name>Spring</name>',
    '    <extensions><ele>7777</ele></extensions>',
    '  </wpt>',
    '</gpx>',
    '',
  ].join('\n');

  it("reads a <wpt>'s own <ele> as written, never one inside <extensions>", () => {
    expect(listGpxWaypoints(WITH_ELE).map(s => s.ele)).toEqual(['745.0', '13.4']);
    expect(listGpxWaypoints(MULTI_ELE).map(s => s.ele)).toEqual(['1309', undefined]);
    expect(listGpxWaypoints(GPX).map(s => s.ele)).toEqual(['10', undefined, undefined, undefined]);
  });

  it('counts and writes decimals, keeping trailing zeros and never a negative zero', () => {
    expect([elevationDecimals('745.0'), elevationDecimals(' 1309 '), elevationDecimals('-3.25')]).toEqual([1, 0, 2]);
    expect([elevationDecimals(''), elevationDecimals('1e3'), elevationDecimals('high')]).toEqual([null, null, null]);
    expect(formatElevation(745.04, 1)).toBe('745.0');
    expect(formatElevation(811.5, 0)).toBe('812');
    expect(formatElevation(-0.04, 1)).toBe('0.0');
    expect(formatElevation(-12.345, 2)).toBe('-12.35');
  });

  it("says a file's <wpt>s carry an <ele> when at least half of them do, in the decimals most use", () => {
    expect(gpxWaypointElevationStyle(listGpxWaypoints(WITH_ELE))).toEqual({ decimals: 1 });
    // One of two: half is enough. One of four (the fixture at the top): not.
    expect(gpxWaypointElevationStyle(listGpxWaypoints(MULTI_ELE))).toEqual({ decimals: 0 });
    expect(gpxWaypointElevationStyle(listGpxWaypoints(GPX))).toBeNull();
    expect(gpxWaypointElevationStyle([])).toBeNull();
    const span = (ele?: string) => ({
      start: 0,
      end: 0,
      lat: 0,
      lon: 0,
      latText: '0',
      lonText: '0',
      name: '',
      ...(ele === undefined ? {} : { ele }),
    });
    // The CDT mixes whole metres with one decimal: the commoner wins, the finer on a tie.
    expect(gpxWaypointElevationStyle([span('1309'), span('1284.9'), span('2011.3')])).toEqual({ decimals: 1 });
    expect(gpxWaypointElevationStyle([span('1309'), span('1284.9')])).toEqual({ decimals: 1 });
    expect(gpxWaypointElevationStyle([span('unknown'), span()])).toEqual({ decimals: 1 });
  });

  it('rewrites an <ele> in place and nothing else, and never adds one', () => {
    const spans = listGpxWaypoints(WITH_ELE);
    expect(setGpxWaypointElevation(WITH_ELE, spans[0], '802.3')).toBe(
      WITH_ELE.replace('<ele>745.0</ele>', '<ele>802.3</ele>')
    );
    expect(setGpxWaypointElevation(WITH_ELE, spans[1], '9.0')).toBe(
      WITH_ELE.replace('<ele>13.4</ele>', '<ele>9.0</ele>')
    );
    const multi = listGpxWaypoints(MULTI_ELE);
    // The spacing inside the element is the file's, and the <ele>s in <extensions> are not this one.
    expect(setGpxWaypointElevation(MULTI_ELE, multi[0], '1412')).toBe(
      MULTI_ELE.replace('<ele> 1309 </ele>', '<ele> 1412 </ele>')
    );
    expect(setGpxWaypointElevation(MULTI_ELE, multi[1], '1412')).toBe(MULTI_ELE);
    expect(setGpxWaypointElevation(GPX, listGpxWaypoints(GPX)[1], '5')).toBe(GPX);
  });

  it('writes a new <wpt> with its <ele> where the last <wpt> has it, and first when that one has none', () => {
    const tank = { lat: -33.3, lon: 151.3, name: 'Tank', type: 'water-tank' };
    expect(insertGpxWaypoint(WITH_ELE, { ...tank, ele: '812.3' })).toBe(
      WITH_ELE.replace(
        '<type>town</type></wpt>\n',
        '<type>town</type></wpt>\n  <wpt lat="-33.3" lon="151.3"><ele>812.3</ele><name>Tank</name><type>water-tank</type></wpt>\n'
      )
    );
    // The last <wpt> of this file has no <ele>: GPX 1.1 puts it first.
    expect(insertGpxWaypoint(MULTI_ELE, { ...tank, ele: '640' })).toContain(
      '  </wpt>\n  <wpt lat="-33.3" lon="151.3">\n    <ele>640</ele>\n    <name>Tank</name>\n    <type>water-tank</type>\n  </wpt>\n</gpx>'
    );
    // A file that writes it after the name keeps it after the name.
    const after = '<gpx><wpt lat="1" lon="2"><name>Flat</name><ele>5</ele><type>hut</type></wpt><trk/></gpx>';
    expect(insertGpxWaypoint(after, { ...tank, ele: '7' })).toContain(
      '<wpt lat="-33.3" lon="151.3"><name>Tank</name><ele>7</ele><type>water-tank</type></wpt><trk/>'
    );
    // Without one, none is written, as before.
    expect(insertGpxWaypoint(WITH_ELE, tank)).toContain(
      '<wpt lat="-33.3" lon="151.3"><name>Tank</name><type>water-tank</type></wpt>'
    );
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

describe('the file’s own style', () => {
  // Heysen's: every <wpt> on one line, but a <desc> that runs over several.
  const HEYSEN = [
    '<gpx>',
    '<wpt lat="-31.1" lon="138.3"><name>Parachilna</name></wpt>',
    '<wpt lat="-31.1328" lon="138.3974"><name>Prairie Hotel</name><desc>Hotel/Pub',
    '',
    'More info: https://example.com/</desc></wpt>',
    '<trk/>',
    '</gpx>',
  ].join('\n');

  it('writes a new <wpt> on one line when the last one only has a multi-line <desc>', () => {
    expect(insertGpxWaypoint(HEYSEN, { lat: -31.2, lon: 138.4, name: 'Tank', type: 'water-tank' })).toBe(
      HEYSEN.replace(
        '</desc></wpt>\n',
        '</desc></wpt>\n<wpt lat="-31.2" lon="138.4"><name>Tank</name><type>water-tank</type></wpt>\n'
      )
    );
  });

  // The open-data files': six decimals, trailing zeros kept.
  const PADDED = [
    '<gpx>',
    '  <wpt lat="-33.855100" lon="151.213190"><ele>4.0</ele><name>Circular Quay</name><type>trailhead</type></wpt>',
    '  <wpt lat="-33.820400" lon="150.021000"><ele>787.4</ele><name>Jenolan Caves</name><type>trailhead</type></wpt>',
    '  <trk/>',
    '</gpx>',
  ].join('\n');

  it('pads a coordinate to six decimals where every <wpt> in the file does, and strips zeros elsewhere', () => {
    expect(
      insertGpxWaypoint(PADDED, { lat: -33.9, lon: 151.21319, name: 'Tank', type: 'water', ele: '5.0' })
    ).toContain(
      '  <wpt lat="-33.900000" lon="151.213190"><ele>5.0</ele><name>Tank</name><type>water</type></wpt>\n  <trk/>'
    );
    const spans = listGpxWaypoints(PADDED);
    expect(spans[0]).toMatchObject({ lat: -33.8551, lon: 151.21319 });
    expect(setGpxWaypointPosition(PADDED, spans[0], -33.8552, 151.2)).toBe(
      PADDED.replace('lat="-33.855100" lon="151.213190"', 'lat="-33.855200" lon="151.200000"')
    );
    // One <wpt> written short and the file is not padded.
    const mixed = PADDED.replace('lon="150.021000"', 'lon="150.021"');
    expect(setGpxWaypointPosition(mixed, listGpxWaypoints(mixed)[0], -33.8552, 151.2)).toContain(
      '<wpt lat="-33.8552" lon="151.2"><ele>4.0</ele>'
    );
  });

  it('writes CRLF into a CRLF file', () => {
    const crlf = ['<gpx>', '  <wpt lat="1" lon="2">', '    <name>A</name>', '  </wpt>', '  <trk/>', '</gpx>', ''].join(
      '\r\n'
    );
    const out = insertGpxWaypoint(crlf, { lat: 3, lon: 4, name: 'B', type: 'hut' });
    expect(out).toBe(
      crlf.replace(
        '  </wpt>\r\n',
        '  </wpt>\r\n  <wpt lat="3" lon="4">\r\n    <name>B</name>\r\n    <type>hut</type>\r\n  </wpt>\r\n'
      )
    );
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('reading a GPX as the build does', () => {
  it('ignores a <wpt> inside a comment, and a tag inside a comment or CDATA within one', () => {
    const gpx =
      '<gpx><!-- <wpt lat="9" lon="9"><name>Old</name></wpt> -->' +
      '<wpt lat="1" lon="2"><!-- <name>Was</name> --><name>Now</name>' +
      '<desc><![CDATA[See <type>x</type> & </wpt>]]></desc></wpt>' +
      '<wpt lat="3" lon="4"><name>Next</name></wpt></gpx>';
    const spans = listGpxWaypoints(gpx);
    expect(spans.map(s => [s.name, s.lat, s.type, s.desc])).toEqual([
      ['Now', 1, undefined, 'See <type>x</type> & </wpt>'],
      ['Next', 3, undefined, undefined],
    ]);
    // Edits land on the real element, not on the commented-out text.
    expect(setGpxWaypointName(gpx, spans[0], 'Later')).toBe(gpx.replace('<name>Now</name>', '<name>Later</name>'));
    expect(setGpxWaypointType(gpx, spans[0], 'hut')).toBe(
      gpx.replace(']]></desc></wpt>', ']]></desc><type>hut</type></wpt>')
    );
  });

  it('refuses a <wpt> without a usable lat or lon, as the build does', () => {
    expect(() => listGpxWaypoints('<gpx><wpt lon="2"><name>A</name></wpt></gpx>')).toThrow(/Missing lat/);
    expect(() => listGpxWaypoints('<gpx><wpt lat="1" lon=""><name>A</name></wpt></gpx>')).toThrow(/Missing lon/);
    expect(() => listGpxWaypoints('<gpx><wpt lat="north" lon="2"><name>A</name></wpt></gpx>')).toThrow(/Invalid lat/);
    expect(() => listGpxWaypoints('<gpx><wpt lat="91" lon="2"/></gpx>')).toThrow(/Out-of-range lat/);
    expect(listGpxWaypoints('<gpx><wpt lat=" 1 " lon="2"/></gpx>')[0]).toMatchObject({ lat: 1, lon: 2 });
  });

  it('reads a <name> and a <type> untrimmed, and names an unnamed <wpt> as the build does', () => {
    const gpx =
      '<gpx><wpt lat="1" lon="2"><name> C Flat </name><type> hut </type></wpt>' +
      '<wpt lat="3" lon="4"><name>   </name><type></type></wpt><wpt lat="5" lon="6"/></gpx>';
    const spans = listGpxWaypoints(gpx);
    expect(spans.map(s => [s.name, s.type])).toEqual([
      [' C Flat ', ' hut '],
      ['   ', undefined],
      ['', undefined],
    ]);
    // The build: classifyWaypoint(name || 'Unnamed').cleanedName, on the text as it stands.
    expect(spans.map(s => gpxWaypointBuildName(s.name))).toEqual(['Flat', '', 'Unnamed']);
  });
});

describe('a string in a JSON array', () => {
  // trail.json as Prettier leaves it: no serialiser reproduces the short arrays.
  const TRAIL =
    '{\n  "id": "demo",\n  "states": ["A", "B"],\n  "revisitedWaypoints": [\n    "Lobuche",\n    "Namche Bazaar"\n  ]\n}\n';
  const rename = (key: string, from: string, to: string, keep = false) =>
    renameJsonArrayString(TRAIL, 'trail.json', key, from, to, keep);

  it('replaces it in place, leaving every other byte alone', () => {
    expect(rename('revisitedWaypoints', 'Lobuche', 'Lobuche Village')).toBe(
      TRAIL.replace('"Lobuche"', '"Lobuche Village"')
    );
    expect(rename('revisitedWaypoints', 'Gokyo', 'Gokyo Lakes')).toBeNull();
    expect(rename('nothing', 'Lobuche', 'X')).toBeNull();
  });

  it('adds the new name after the old one when another waypoint still has the old, spaced like its neighbours', () => {
    expect(rename('revisitedWaypoints', 'Namche Bazaar', 'Namche', true)).toBe(
      TRAIL.replace('"Namche Bazaar"', '"Namche Bazaar",\n    "Namche"')
    );
    expect(rename('states', 'A', 'C', true)).toBe(TRAIL.replace('["A", "B"]', '["A", "C", "B"]'));
  });

  it('drops the old name when the new one is already listed', () => {
    expect(rename('revisitedWaypoints', 'Lobuche', 'Namche Bazaar')).toBe(TRAIL.replace('"Lobuche",\n    ', ''));
    expect(rename('revisitedWaypoints', 'Namche Bazaar', 'Lobuche')).toBe(TRAIL.replace(',\n    "Namche Bazaar"', ''));
    expect(rename('revisitedWaypoints', 'Lobuche', 'Namche Bazaar', true)).toBeNull();
  });
});
