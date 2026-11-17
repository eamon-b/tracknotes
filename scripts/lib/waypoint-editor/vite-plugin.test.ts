import { describe, expect, it } from 'vitest';
import {
  hostAllowed,
  isWarningLine,
  npmRunCommand,
  originAllowed,
  otherRebuild,
  parseHostHeader,
  rebuildLockPath,
  registryChanges,
  requestObject,
  requestRefusal,
  routeSegments,
  warningLines,
  writeAllowed,
  type BuildLine,
  type RequestGuardOptions,
} from './vite-plugin';

const LOCAL: RequestGuardOptions = { allowRemote: false, allowedHosts: [] };
const REMOTE: RequestGuardOptions = { allowRemote: true, allowedHosts: [] };

describe('parseHostHeader', () => {
  it('splits a host from its port and says what kind it is', () => {
    expect(parseHostHeader('localhost')).toEqual({ hostname: 'localhost', kind: 'name' });
    expect(parseHostHeader('LocalHost:5173')).toEqual({ hostname: 'localhost', kind: 'name' });
    expect(parseHostHeader('127.0.0.1:5173')).toEqual({ hostname: '127.0.0.1', kind: 'ipv4' });
    expect(parseHostHeader('[::1]:5173')).toEqual({ hostname: '::1', kind: 'ipv6' });
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '::1', kind: 'ipv6' });
  });

  it('refuses anything that is not a bare host with an optional port', () => {
    for (const host of [
      undefined,
      '',
      ':5173',
      'localhost:',
      'localhost:port',
      'localhost:5173:5173',
      'localhost.',
      '.localhost',
      'a..localhost',
      'localhost:5173@attacker.example',
      'attacker.example/localhost',
      'http://localhost:5173',
      'localhost attacker.example',
      'localhost,attacker.example',
      '::1',
      '[::1',
      '[localhost]',
      '[::1]x',
      'x'.repeat(400),
    ]) {
      expect(parseHostHeader(host), String(host)).toBeNull();
    }
  });
});

describe('hostAllowed', () => {
  it('accepts the loopback names, with or without a port and in any case', () => {
    for (const host of [
      'localhost',
      'localhost:5173',
      'LOCALHOST:5173',
      'Localhost',
      '127.0.0.1',
      '127.0.0.1:5173',
      '127.8.9.10:5173',
      '[::1]',
      '[::1]:5173',
      '[0:0:0:0:0:0:0:1]:5173',
      'editor.localhost:5173',
      // `.localhost` never leaves the machine (RFC 6761), whatever sits in front of it.
      'attacker.example.localhost:5173',
    ]) {
      expect(hostAllowed(host, LOCAL), host).toBe(true);
      expect(hostAllowed(host, REMOTE), host).toBe(true);
    }
  });

  it('refuses a DNS-rebinding name, and names dressed up as localhost', () => {
    for (const host of [
      'attacker.example',
      'attacker.example:5173',
      'localhost.attacker.example',
      'localhost.attacker.example:5173',
      '127.0.0.1.attacker.example:5173',
      'notlocalhost:5173',
      'localhost.:5173',
      'localhost:5173@attacker.example',
      'xn--lcalhost-9za:5173',
      // Not loopback literals: a browser sends the dotted form, and these could be names.
      '2130706433:5173',
      '127.1:5173',
      '0x7f.0.0.1:5173',
    ]) {
      expect(hostAllowed(host, LOCAL), host).toBe(false);
      expect(hostAllowed(host, REMOTE), host).toBe(false);
    }
  });

  it('refuses a missing or empty Host', () => {
    for (const options of [LOCAL, REMOTE]) {
      expect(hostAllowed(undefined, options)).toBe(false);
      expect(hostAllowed('', options)).toBe(false);
    }
  });

  it('accepts another IP literal only in remote mode', () => {
    for (const host of ['192.168.1.20:5173', '10.0.0.5', '0.0.0.0:5173', '[fe80::1]:5173', '[::ffff:127.0.0.1]:5173']) {
      expect(hostAllowed(host, LOCAL), host).toBe(false);
      expect(hostAllowed(host, REMOTE), host).toBe(true);
    }
  });

  it("accepts a name in Vite's server.allowedHosts only in remote mode, and never every name", () => {
    const allowedHosts = ['laptop.lan', '.tailnet.example'];
    for (const host of ['laptop.lan:5173', 'LAPTOP.LAN', 'tailnet.example', 'box.tailnet.example:5173']) {
      expect(hostAllowed(host, { allowRemote: true, allowedHosts }), host).toBe(true);
      expect(hostAllowed(host, { allowRemote: false, allowedHosts }), host).toBe(false);
    }
    for (const host of ['other.lan', 'laptop.lan.attacker.example', 'eviltailnet.example', 'attacker.example']) {
      expect(hostAllowed(host, { allowRemote: true, allowedHosts }), host).toBe(false);
    }
    // `allowedHosts: true` switches Vite's own check off; it does not make every name the editor's.
    expect(hostAllowed('attacker.example:5173', { allowRemote: true, allowedHosts: true })).toBe(false);
    expect(hostAllowed('192.168.1.20:5173', { allowRemote: true, allowedHosts: true })).toBe(true);
    expect(hostAllowed('localhost:5173', { allowRemote: true, allowedHosts: true })).toBe(true);
  });
});

describe('originAllowed', () => {
  it("accepts no Origin, or the server's own", () => {
    expect(originAllowed({ host: 'localhost:5173' })).toBe(true);
    expect(originAllowed({ host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(true);
    expect(originAllowed({ host: 'LOCALHOST:5173', origin: 'http://localhost:5173' })).toBe(true);
    expect(originAllowed({ host: '[::1]:5173', origin: 'http://[::1]:5173' })).toBe(true);
  });

  it('refuses another origin, another port of this machine included', () => {
    expect(originAllowed({ host: 'localhost:5173', origin: 'https://evil.example' })).toBe(false);
    expect(originAllowed({ host: 'localhost:5173', origin: 'http://localhost:3000' })).toBe(false);
    expect(originAllowed({ host: 'localhost:5173', origin: 'http://127.0.0.1:5173' })).toBe(false);
    expect(originAllowed({ host: 'localhost:5173', origin: 'null' })).toBe(false);
    expect(originAllowed({ origin: 'http://localhost:5173' })).toBe(false);
  });
});

describe('writeAllowed', () => {
  it('needs the editor header, and no foreign origin', () => {
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1' })).toBe(true);
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1', origin: 'http://localhost:5173' })).toBe(
      true
    );
    expect(writeAllowed({ host: 'localhost:5173' })).toBe(false);
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1', origin: 'https://evil.example' })).toBe(
      false
    );
    expect(writeAllowed({ host: 'localhost:5173', 'x-waypoint-editor': '1', origin: 'null' })).toBe(false);
  });
});

describe('requestRefusal', () => {
  const page = { host: 'localhost:5173', origin: 'http://localhost:5173', 'x-waypoint-editor': '1' };
  const from = (method: string, headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({
    method,
    headers,
    remoteAddress,
  });

  it("lets the editor page's own requests through", () => {
    expect(requestRefusal(from('GET', { host: 'localhost:5173' }), LOCAL)).toBeNull();
    expect(requestRefusal(from('POST', page), LOCAL)).toBeNull();
    expect(requestRefusal(from('DELETE', page, '::1'), LOCAL)).toBeNull();
    expect(requestRefusal(from('POST', page, '::ffff:127.0.0.1'), LOCAL)).toBeNull();
  });

  it('refuses a DNS-rebinding page: loopback, same-origin, the header set, but its own name as Host', () => {
    const rebound = {
      host: 'attacker.example:5173',
      origin: 'http://attacker.example:5173',
      'x-waypoint-editor': '1',
    };
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(requestRefusal(from(method, rebound), LOCAL), method).toMatch(/only to localhost/);
      expect(requestRefusal(from(method, rebound), REMOTE), method).toMatch(/only to localhost, an IP address/);
    }
    expect(requestRefusal(from('GET', { host: 'attacker.example:5173' }), LOCAL)).toMatch(/only to localhost/);
  });

  it('refuses a request with no Host', () => {
    expect(requestRefusal(from('GET', {}), LOCAL)).toMatch(/only to localhost/);
    expect(requestRefusal(from('POST', { 'x-waypoint-editor': '1' }), REMOTE)).toMatch(/only to localhost/);
  });

  it('refuses an Origin that is not the Host, on reads as on writes', () => {
    const otherPort = { host: 'localhost:5173', origin: 'http://localhost:3000', 'x-waypoint-editor': '1' };
    expect(requestRefusal(from('GET', otherPort), LOCAL)).toMatch(/own page/);
    expect(requestRefusal(from('POST', otherPort), LOCAL)).toMatch(/own page/);
    // A preflight from another origin gets no CORS headers from here, only this refusal.
    expect(requestRefusal(from('OPTIONS', { host: 'localhost:5173', origin: 'https://evil.example' }), LOCAL)).toMatch(
      /own page/
    );
  });

  it('refuses a write without the editor header', () => {
    const noHeader = { host: 'localhost:5173', origin: 'http://localhost:5173' };
    expect(requestRefusal(from('POST', noHeader), LOCAL)).toMatch(/Writes/);
    expect(requestRefusal(from('DELETE', noHeader), LOCAL)).toMatch(/Writes/);
    expect(requestRefusal(from('GET', noHeader), LOCAL)).toBeNull();
  });

  it('refuses another machine unless remote mode is on, and then still checks the Host', () => {
    const lan = { host: '192.168.1.20:5173', origin: 'http://192.168.1.20:5173', 'x-waypoint-editor': '1' };
    expect(requestRefusal(from('POST', lan, '192.168.1.7'), LOCAL)).toMatch(/only this machine/);
    expect(
      requestRefusal({ method: 'GET', headers: { host: 'localhost:5173' }, remoteAddress: undefined }, LOCAL)
    ).toMatch(/only this machine/);
    expect(requestRefusal(from('POST', lan, '192.168.1.7'), REMOTE)).toBeNull();
    expect(
      requestRefusal(from('POST', { ...lan, host: 'attacker.example:5173' }, '192.168.1.7'), REMOTE)
    ).not.toBeNull();
    // An IP-literal Host from this machine is refused without remote mode.
    expect(requestRefusal(from('POST', lan), LOCAL)).toMatch(/only to localhost/);
  });
});

describe('routeSegments', () => {
  it('decodes each segment', () => {
    expect(routeSegments('/trails/great%20walk/waypoints/w_1')).toEqual(['trails', 'great walk', 'waypoints', 'w_1']);
    expect(routeSegments('/')).toEqual([]);
  });

  it('answers a malformed escape with 400, not a URIError', () => {
    expect(() => routeSegments('/trails/%zz')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('requestObject', () => {
  it('passes a JSON object through', () => {
    const body = { expected: { name: 'Hut' }, name: 'New hut' };
    expect(requestObject(body)).toBe(body);
    expect(requestObject(body, true)).toBe(body);
    expect(requestObject({})).toEqual({});
  });

  it('answers anything else with 400', () => {
    for (const body of [null, undefined, 'text', 7, true, [], [{}]]) {
      expect(() => requestObject(body), JSON.stringify(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it('needs an object under "expected" where the route reads one', () => {
    for (const body of [{}, { expected: null }, { expected: 'x' }, { expected: [] }]) {
      expect(() => requestObject(body, true), JSON.stringify(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('registryChanges', () => {
  it('reports ids a build minted or retired, not ones it refreshed', () => {
    const entry = (id: string, extra = {}) => ({ id, name: id, type: 'hut', lat: 0, lon: 0, ...extra });
    const before = { demo: [entry('w_a'), entry('w_b'), entry('w_c', { retired: true as const })] };
    const after = {
      demo: [
        entry('w_a', { lat: 1 }),
        entry('w_b', { retired: true as const }),
        entry('w_c', { retired: true as const }),
        entry('w_d'),
      ],
    };
    expect(registryChanges(before, after)).toEqual({
      minted: [{ trailId: 'demo', id: 'w_d', name: 'w_d', type: 'hut' }],
      retired: [{ trailId: 'demo', id: 'w_b', name: 'w_b', type: 'hut' }],
    });
  });
});

/** `O|` stdout, `E|` stderr: one line per row, as the build's two streams delivered them. */
function buildLines(tagged: string): BuildLine[] {
  return tagged
    .split('\n')
    .filter(row => /^[OE]\|/.test(row))
    .map(row => ({ stream: row[0] === 'E' ? 'stderr' : 'stdout', text: row.slice(2) }));
}

describe('warningLines', () => {
  // Captured from `npm run build:trails` with each line tagged by its stream,
  // after adding a campsite 22 m from Thorsborne's "Nina Bay": the start of the
  // log, the trail's block and the end, with the checkout's path shortened to
  // /repo. Nothing in it matches the words "warn", "error" or "failed".
  const MINTING_BUILD = `
O|
O|> tracknotes@1.0.0 build:trails
O|> tsx scripts/build-trails.ts
O|
O|Trail Build Script
O|==================
O|
O|Found 21 trail directories
O|
O|Validating trail data...
O|All trails validated successfully.
O|
O|  ✓ Generated /repo/src/web/trails/te_araroa/resupply.html
O|Processing: thorsborne
O|  Classified: 1 main
E|  ! thorsborne: new campsite "Nina Bay overflow camp" is within 100 m of "Nina Bay" (22 m); if it is the same place under another name, drop one of them
O|  ✓ Applied 8 curated waypoint description(s) from descriptions.json
O|  ✓ Written to /repo/public/data/generated/thorsborne.json
O|    Distance: 28.8 km
O|    Elevation: +644m / -646m
O|    Waypoints: 9 on-trail, 0 off-trail
O|    POIs: 7 (OpenStreetMap), 5 hidden as duplicates of waypoints
O|  ✓ Generated /repo/src/web/trails/thorsborne/index.html
O|  ✓ Generated /repo/src/web/trails/three_passes/resupply.html
O|
O|Trail index written to /repo/public/data/generated/index.json
O|Waypoint-id registry written to /repo/data/waypoint-ids.json (2866 entries, 140 retired)
E|
E|1 new waypoint id(s) were minted beside another waypoint of the same type. This build is the only one that reports them, so check each before committing /repo/data/waypoint-ids.json:
E|  ! thorsborne: new campsite "Nina Bay overflow camp" is within 100 m of "Nina Bay" (22 m); if it is the same place under another name, drop one of them
`;

  it("reports the build's id-minting warnings, each time it prints them, and no ordinary line", () => {
    const minted =
      '  ! thorsborne: new campsite "Nina Bay overflow camp" is within 100 m of "Nina Bay" (22 m); if it is the same place under another name, drop one of them';
    expect(warningLines(buildLines(MINTING_BUILD))).toEqual([
      minted,
      '1 new waypoint id(s) were minted beside another waypoint of the same type. This build is the only one that reports them, so check each before committing /repo/data/waypoint-ids.json:',
      minted,
    ]);
  });

  // Captured the same way from a build that stops at validation (the Te Araroa GPX not synced).
  const FAILED_BUILD = `
O|
O|> tracknotes@1.0.0 build:trails
O|> tsx scripts/build-trails.ts
O|
O|Trail Build Script
O|==================
O|
O|Found 21 trail directories
O|
O|Validating trail data...
E|
E|Validation errors found:
E|  - te_araroa: data/trails/te_araroa/te-araroa-sobo.gpx is missing. Run \`npm run sync:te-araroa\`.
E|
E|Fix these errors before building.
`;

  it('reports why a build stopped', () => {
    expect(warningLines(buildLines(FAILED_BUILD))).toEqual([
      'Validation errors found:',
      '  - te_araroa: data/trails/te_araroa/te-araroa-sobo.gpx is missing. Run `npm run sync:te-araroa`.',
      'Fix these errors before building.',
    ]);
  });

  it('reports everything on stderr, whatever its marker, and nothing blank', () => {
    // The other forms the build warns in (build-trails.ts, trail-ingest.ts), all through console.warn.
    const stderr = [
      '  ! demo: trail.json has no "country"; the trail list will show it under "Other"',
      '  ⚠ 2 curated description(s) matched no waypoint: w_1, w_2',
      '  Warning: revisitedWaypoints lists "Hut", which the route no longer passes twice. Remove it from trail.json.',
      'alternate "High route": no junction within 500 m',
      'access for "Town" (w_3) ignored: the place is 900m from the route and 4000m from its junction, beyond its 2 km walk',
      '  ✗ Error processing demo: Error: boom',
      '    at buildTrail (/repo/src/lib/trail-ingest.ts:1:1)',
    ];
    for (const text of stderr) expect(isWarningLine('stderr', text), text).toBe(true);
    expect(isWarningLine('stderr', '')).toBe(false);
    expect(isWarningLine('stderr', '   ')).toBe(false);
  });

  it("reports a stdout line only when it opens with one of the build's warning markers", () => {
    // build-trails.ts prints these two with console.log.
    expect(isWarningLine('stdout', '  Warning: Could not parse GeoJSON: Unexpected token')).toBe(true);
    expect(isWarningLine('stdout', '  Warning: Specified geojsonFile not found: markers.json')).toBe(true);
    expect(isWarningLine('stdout', '  ⚠ pois.json duplicates match no POI: node/1')).toBe(true);
    expect(isWarningLine('stdout', '  ! demo: new hut "A" is within 100 m of "B" (5 m)')).toBe(true);
    for (const text of [
      '  ✓ Written to /repo/public/data/generated/failed-creek-track.json',
      'Processing: warning_track',
      '    POIs: 7 (OpenStreetMap), 5 hidden as duplicates of waypoints',
      '      filtered as noise: 19 bus-stop, 3 minor-shelter',
      '  Note: Trail template not found, skipping HTML generation',
      '  errors: 0',
      'Wrote 21 trails + index.json to /repo/mobile/assets/trails',
      '',
    ]) {
      expect(isWarningLine('stdout', text), text).toBe(false);
    }
  });
});

describe('npmRunCommand', () => {
  it('starts npm directly, and through a shell with one fixed command line on Windows', () => {
    expect(npmRunCommand('build:trails', 'linux')).toEqual({
      command: 'npm',
      args: ['run', 'build:trails'],
      shell: false,
    });
    expect(npmRunCommand('build:mobile-trails', 'darwin').shell).toBe(false);
    expect(npmRunCommand('build:mobile-trails', 'win32')).toEqual({
      command: 'npm run build:mobile-trails',
      args: [],
      shell: true,
    });
  });
});

describe('the rebuild lock', () => {
  const startedAt = '2026-01-01T00:00:00.000Z';
  const now = Date.parse(startedAt) + 60_000;
  const alive =
    (...pids: number[]) =>
    (pid: number) =>
      pids.includes(pid);

  it('is one file per checkout, outside it', () => {
    expect(rebuildLockPath('/repo/a')).toBe(rebuildLockPath('/repo/a/'));
    expect(rebuildLockPath('/repo/a')).not.toBe(rebuildLockPath('/repo/b'));
    expect(rebuildLockPath('/repo/a').startsWith('/repo/')).toBe(false);
  });

  it("marks another dev server's running rebuild", () => {
    const lock = { owner: 100, child: 200, startedAt };
    expect(otherRebuild(lock, 300, alive(100, 200), now)).toBe(lock);
    // Between two steps there is no child, and the owner is still at it.
    expect(otherRebuild({ owner: 100, startedAt }, 300, alive(100), now)).not.toBeNull();
  });

  it('marks a build step that outlived the dev server that started it', () => {
    expect(otherRebuild({ owner: 100, child: 200, startedAt }, 300, alive(200), now)).not.toBeNull();
    // The dead server's pid has since been given to this process.
    expect(otherRebuild({ owner: 300, child: 200, startedAt }, 300, alive(200, 300), now)).not.toBeNull();
  });

  it('is not held by no lock, by this process, by dead processes or by an old lock', () => {
    expect(otherRebuild(null, 300, alive(100), now)).toBeNull();
    expect(otherRebuild({ owner: 300, startedAt }, 300, alive(300), now)).toBeNull();
    expect(otherRebuild({ owner: 100, child: 200, startedAt }, 300, alive(), now)).toBeNull();
    const later = Date.parse(startedAt) + 31 * 60_000;
    expect(otherRebuild({ owner: 100, child: 200, startedAt }, 300, alive(100, 200), later)).toBeNull();
    expect(otherRebuild({ owner: 100, startedAt: 'not a date' }, 300, alive(100), now)).toBeNull();
  });
});
