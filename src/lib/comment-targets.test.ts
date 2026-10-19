import { describe, expect, it } from 'vitest';
import { commentTargetFitsTrail, commentTargetKind } from './comment-targets';
import { mintImportedWaypointIds } from './gpx-import';
import { poiCommentId } from './poi-display';
import { userWaypointId } from './user-waypoints';
import type { TrailConfig, TrailWaypoint } from './trail-types';

describe('commentTargetKind', () => {
  it('names each kind by its form', () => {
    expect(commentTargetKind('w_00176641')).toBe('curated');
    expect(commentTargetKind('uw_0a1b2c3d4e5f')).toBe('community');
    expect(commentTargetKind('uw_0a1b2c3d4e5f_2')).toBe('community');
    expect(commentTargetKind(userWaypointId('6f1c2a7e-1b2c-4d3e-8f90-123456789abc'))).toBe('shared');
    expect(commentTargetKind(poiCommentId({ type: 'node', id: 42 }))).toBe('osm');
  });

  it('takes what an import mints for its waypoints as a community id', () => {
    const waypoints = [
      { name: 'Creek camp', lat: -37.1, lon: 145.2 },
      { name: 'Lookout', lat: -37.2, lon: 145.3 },
    ] as TrailWaypoint[];
    for (const id of mintImportedWaypointIds(waypoints, { id: 'u_abc123' } as TrailConfig)) {
      expect(commentTargetKind(id)).toBe('community');
    }
  });

  it('names nothing for anything else', () => {
    for (const id of ['spring-01', 'w_0017664', 'w_0017664A', 'uw_', 'uw_ABC', 'uw_abc_x', 'osm_area_1', 'osm_node_01', '', null, 7]) {
      expect(commentTargetKind(id)).toBeNull();
    }
  });
});

describe('commentTargetFitsTrail', () => {
  it('keeps curated ids to curated trails and a route’s own ids to community routes', () => {
    expect(commentTargetFitsTrail('curated', 'curated')).toBe(true);
    expect(commentTargetFitsTrail('curated', 'community')).toBe(false);
    expect(commentTargetFitsTrail('community', 'community')).toBe(true);
    expect(commentTargetFitsTrail('community', 'curated')).toBe(false);
    for (const trail of ['curated', 'community'] as const) {
      expect(commentTargetFitsTrail('shared', trail)).toBe(true);
      expect(commentTargetFitsTrail('osm', trail)).toBe(true);
    }
  });
});
