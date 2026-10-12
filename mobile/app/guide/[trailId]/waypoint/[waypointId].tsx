/**
 * Waypoint detail screen.
 *
 * Resolves the tapped waypoint from the active guide, then layers on the
 * offline-first comments block (`features/comments/CommentsSection` — the feed,
 * the composer with its water-flow chips and photo attach, reports, shared
 * with the POI screen) and a favorite heart backed by the local favorites store.
 *
 * A waypoint the trail offers as a resupply option also carries the hiker's own
 * plan: a banner when it is one of their ticked stops, and a toggle to add or
 * drop it. The first tap from an untouched trail makes a plan with every other
 * option still ticked — planning one town should not unplan the rest. A turn-off
 * planned by the place it serves says so in the banner and offers no toggle:
 * nothing was ticked here to untick (`useWaypointResupplyPlan`).
 *
 * The curated waypoint description rides the comments sync channel and overrides
 * the near-empty bundled one.
 *
 * Below the stats sits the one place a *hidden* POI is ever visible: when
 * `@lib/poi-dedup` flagged an OpenStreetMap record as describing this same
 * place, its tags are offered in a collapsed "From OpenStreetMap" section. That
 * is local trail data, so it works for an imported guide too.
 *
 * A waypoint can be on one of the trail's alternates as well as on the main
 * route — the Today screen and the plan open those too. Its place relative to
 * the alternates gets a card (`plan/waypoint-alternates`): the alternate it is
 * on, one that leaves or rejoins the main route here, or the one the plan takes
 * past it. Each says where the alternate leaves and rejoins the main route and
 * offers the planner's "Take this alternate" / "Stay on the main route". A
 * place on an alternate the plan takes can be a stop, and its trip is measured
 * along the route as planned; on one it does not take, neither.
 *
 * A waypoint a hiker added (`@lib/user-waypoints`) says so under its name: its
 * own ("only on this phone" or shared), with Edit, or another hiker's shared
 * one, with Report. A private one has no comments — nobody else can see it.
 *
 * None of that channel exists for a user-imported guide (`services/server-trails`):
 * its ids are local-only, so the comments block collapses to a one-line note
 * and no SQLite read or request is issued for it. The favorite heart, the stats
 * and the check-in share are purely local and keep working.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { accessSummary } from '@lib/resupply-display';
import { isAccessMode } from '@lib/types';
import { waypointTypeLabel } from '@lib/waypoint-taxonomy';
import { userWaypointInfo } from '@lib/user-waypoints';
import { OSM_ATTRIBUTION, poiOsmUrl, summarisePoiTags } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import { useTheme } from '../../../../src/theme';
import { KeyboardAwareScrollView } from '../../../../src/navigation/KeyboardAwareScrollView';
import { glyphSizes, radii, spacing, typography } from '../../../../src/tokens';
import { useSettingsStore, type Units } from '../../../../src/state/settings-store';
import type { TrailJsonWaypoint } from '../../../../src/services/trail-assets';
import { useGuide } from '../../../../src/features/guide/GuideContext';
import { useGuidePositionContext } from '../../../../src/features/guide/GuidePositionContext';
import { LinkifiedText } from '../../../../src/features/guide/LinkifiedText';
import { ShareIconButton } from '../../../../src/features/share/ShareIconButton';
import { useCheckInShare } from '../../../../src/features/share/use-check-in-share';
import { waypointColor } from '../../../../src/features/elevation/waypoint-category';
import {
  duplicatePoisFor,
  isPlaceOffTrail,
  waypointOffTrailMeters,
} from '../../../../src/features/guide/waypoint-detail';
import { TripCard } from '../../../../src/features/guide/TripCard';
import { requestMapTarget } from '../../../../src/features/guide/map-target';
import { offTrailDistance } from '../../../../src/features/guide/OffTrailBadge';
import {
  findStop,
  isTrailEnd,
  overnightCandidates,
  setNights,
  setStopBooked,
  setStopNote,
  toggleStop,
} from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import {
  editPlanOnRoute,
  mainKmToRoute,
  planToRoute,
  setPlanAlternate,
} from '@lib/plan-alternates';
import { toActiveKm } from '@lib/plan-direction';
import {
  plannableTrail,
  routeKmOfFix,
  usePlanRoute,
} from '../../../../src/features/plan/use-plan-route';
import {
  findGuideWaypoint,
  waypointAlternates,
} from '../../../../src/features/plan/waypoint-alternates';
import { WaypointAlternateCard } from '../../../../src/features/plan/WaypointAlternateCard';
import { useIdentityStore } from '../../../../src/state/identity-store';
import { selectIsFavorite, useFavoritesStore } from '../../../../src/state/favorites-store';
import { useWaypointResupplyPlan } from '../../../../src/features/plan/use-planned-resupply';
import { selectPlan, usePlansStore } from '../../../../src/state/plans-store';
import { StopEditor } from '../../../../src/features/plan/StopEditor';
import { StopContextCard } from '../../../../src/features/plan/StopContextCard';
import { PlanGlanceSheet } from '../../../../src/features/plan/PlanGlanceSheet';
import { stopContextIfStopped } from '../../../../src/features/plan/plan-glance';
import { usePlanGlance } from '../../../../src/features/plan/use-plan-glance';
import {
  planDirectionOf,
  stopCandidateOf,
  stopKeyOf,
  toggleTargetOf,
} from '../../../../src/features/plan/plan-stops';
import { isServerKnown } from '../../../../src/services/server-trails';
import { getDatabase } from '../../../../src/db/database';
import * as outboxRepo from '../../../../src/db/outbox-repo';
import * as waypointMetaRepo from '../../../../src/db/waypoint-meta-repo';
import { CommentsSection } from '../../../../src/features/comments/CommentsSection';
import { ReportDialog } from '../../../../src/features/comments/ReportDialog';
import { onSyncChange } from '../../../../src/sync/sync-events';
import { reportUserWaypoint } from '../../../../src/sync/waypoint-sync';
import {
  selectUserWaypoint,
  useUserWaypointsStore,
} from '../../../../src/state/user-waypoints-store';

export default function WaypointDetailScreen() {
  const { trailId, waypointId } = useLocalSearchParams<{
    trailId: string;
    waypointId: string;
  }>();
  const { colors } = useTheme();
  const router = useRouter();
  const { trail, direction } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const guidePosition = useGuidePositionContext();
  const { currentKm, position, status } = guidePosition;
  const shareCheckIn = useCheckInShare();

  // The main route's waypoints, then every alternate's: the route as planned
  // can take the hiker to either.
  const found = useMemo(() => findGuideWaypoint(trail, waypointId), [trail, waypointId]);
  const waypoint = found?.waypoint ?? null;
  const onAlternate = found !== null && found.alternateIndex !== null;
  // Before the not-found return below: a hook cannot sit after it.

  // The comments channel needs BOTH a server-side trail (imported guides have
  // none) and a stable waypoint id. Null here switches the whole block off:
  // no SQLite read, no pull, no composer.
  const serverKnown = isServerKnown(trailId);
  // A hiker's private waypoint is invisible to everyone else, so a comment on
  // it would be a public note on a place nobody can find.
  const hikerWaypoint = waypoint ? userWaypointInfo(waypoint) : null;
  const userWaypoint = useUserWaypointsStore(selectUserWaypoint(trailId, waypoint?.id));
  const commentWaypointId =
    serverKnown && hikerWaypoint?.visibility !== 'private' ? (waypoint?.id ?? null) : null;
  const [reportingWaypoint, setReportingWaypoint] = useState(false);
  const [waypointReported, setWaypointReported] = useState(false);
  // A share the server refused for good (the daily limit, a ban) stays queued
  // as failed; say so, or the hiker believes everyone can see it.
  const [shareFailure, setShareFailure] = useState<string | null>(null);
  const watchShare = hikerWaypoint?.mine === true && hikerWaypoint.visibility === 'shared';
  useEffect(() => {
    if (!watchShare || !waypoint?.id) return;
    const id = waypoint.id;
    let cancelled = false;
    const read = () => {
      getDatabase()
        .then((db) => outboxRepo.lastFailure(db, 'waypoint', id))
        .then((error) => {
          // Stored as `code: message`; the message is the server's words.
          if (!cancelled) setShareFailure(error ? error.slice(error.indexOf(': ') + 2) : null);
        })
        .catch(() => {});
    };
    read();
    const off = onSyncChange((change) => {
      if (change.trailId === trailId) read();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [watchShare, waypoint?.id, trailId]);

  const identityStatus = useIdentityStore((s) => s.status);
  const session = useIdentityStore((s) => s.session);
  const isFav = useFavoritesStore(selectIsFavorite(trailId, waypointId));
  const toggleFavorite = useFavoritesStore((s) => s.toggle);

  // --- Resupply plan -------------------------------------------------------
  // One read for both halves: what the banner says, and what a tap does. Only a
  // waypoint the trail offers as an option gets a toggle at all, and a turn-off
  // planned by the place it serves gets the banner without one — it was never
  // ticked, so there is nothing here to untick.
  //
  // Both this and the "Stop here" toggle below can be the first edit a trail's
  // plan ever gets, so both carry the same defaults the Plan screen mints with.
  const planDefaults = useMemo(
    () => ({ name: trail.config.name, direction: planDirectionOf(direction) }),
    [trail.config.name, direction],
  );
  const {
    isPlanned,
    plannedVia,
    isSelected,
    toggle: toggleResupply,
  } = useWaypointResupplyPlan(trailId, trail, waypoint?.id, planDefaults);

  // The plan's view of THIS waypoint. The guide trail is direction-applied and
  // a stop is stored NOBO-absolute, so the conversion goes through the same
  // helper the Plan screen's list uses (`plan-stops`) — deriving it here a
  // second time is how the two screens would come to disagree about which stop
  // a tap means.
  const plan = usePlansStore(selectPlan(trailId));
  const hydratePlan = usePlansStore((s) => s.hydrate);
  const applyPlanEdit = usePlansStore((s) => s.apply);
  useEffect(() => {
    void hydratePlan(trailId);
  }, [hydratePlan, trailId]);

  // The plan's route: once it takes an alternate, stops are edited in km along
  // that route (`@lib/plan-alternates`), as on the Plan screen. A waypoint on a
  // stretch an alternate bypasses is not on the route, so it offers no stop.
  const { route, trail: routeTrail, baseTrail } = usePlanRoute(plan);
  // A place on an alternate is on the route only while the plan takes it; then
  // it is one of the route trail's waypoints, already in route km.
  const routeWaypoint = useMemo(
    () =>
      onAlternate && waypoint?.id
        ? (routeTrail.waypoints.find((w) => w.id === waypoint.id) ?? null)
        : null,
    [onAlternate, waypoint, routeTrail],
  );
  const stopCandidate = useMemo(() => {
    if (!waypoint) return null;
    const planDirection = planDirectionOf(direction);
    if (onAlternate) {
      return routeWaypoint
        ? stopCandidateOf(routeWaypoint, planDirection, route.totalDistance)
        : null;
    }
    const candidate = stopCandidateOf(waypoint, planDirection, trail.track.totalDistance);
    const routeKm = mainKmToRoute(route, candidate.noboKm);
    if (routeKm === null) return null;
    // Both km of the candidate move to the route's scale: `noboKm` for the
    // document, `activeKm` for the days the glance measures along the route.
    return {
      ...candidate,
      noboKm: routeKm,
      activeKm: toActiveKm(routeKm, planDirection, route.totalDistance),
    };
  }, [waypoint, direction, trail.track.totalDistance, route, onAlternate, routeWaypoint]);
  const routePlan = useMemo(() => (plan ? planToRoute(plan, route) : undefined), [plan, route]);
  const planStop =
    routePlan && stopCandidate ? findStop(routePlan, stopKeyOf(stopCandidate)) : undefined;
  // `toggleStop` refuses a stop at either end of the trail, and this screen has
  // no plan notice to show the refusal on, so the toggle is not offered there.
  // A stop already sitting at an end (an older plan) can still be taken out.
  const canToggleStop =
    stopCandidate !== null &&
    (planStop !== undefined || !isTrailEnd(stopCandidate.noboKm, route.totalDistance));
  const editPlan = useCallback(
    (fn: (p: PlanDocument) => PlanDocument) => {
      void applyPlanEdit(
        trailId,
        (p) => editPlanOnRoute(p, plannableTrail(baseTrail), fn),
        planDefaults,
      );
    },
    [applyPlanEdit, planDefaults, trailId, baseTrail],
  );
  // The alternates this place is on, at the junctions of, or bypassed by.
  const alternateCards = useMemo(
    () => (found ? waypointAlternates(trail, baseTrail, route, found) : []),
    [found, trail, baseTrail, route],
  );
  const setAlternate = useCallback(
    (name: string, take: boolean) => {
      void applyPlanEdit(
        trailId,
        (p) => setPlanAlternate(p, plannableTrail(baseTrail), name, take),
        planDefaults,
      );
    },
    [applyPlanEdit, trailId, baseTrail, planDefaults],
  );
  const openPlace = useCallback(
    (id: string) =>
      router.push({
        pathname: '/guide/[trailId]/waypoint/[waypointId]',
        params: { trailId, waypointId: id },
      }),
    [router, trailId],
  );
  // The hiker's km on the route as planned, for the trip to a place on a taken
  // alternate (the guide's own km is along the main route).
  const routeFixKm = useMemo(
    () => (routeWaypoint ? routeKmOfFix(guidePosition, route, routeTrail) : null),
    [routeWaypoint, guidePosition, route, routeTrail],
  );

  const toggleThisStop = useCallback(() => {
    if (!stopCandidate) return;
    editPlan((p) =>
      toggleStop(p, toggleTargetOf(stopCandidate), { totalKm: route.totalDistance }),
    );
  }, [editPlan, stopCandidate, route.totalDistance]);

  // The days either side of this place — as planned when it is a stop, as they
  // would be with it added when it is a place to sleep that is not one yet — so
  // ticking a campsite shows what it did to the days right here, without a
  // trip to the planner. Water, junctions and the like can still be made a stop
  // with the ⛺, but get no "if you stop here" card: it would be on every one.
  // The glance measures along the route as planned, so the what-if is run on
  // the same route trail, with the candidate's route km.
  const glance = usePlanGlance();
  const [glanceOpen, setGlanceOpen] = useState(false);
  const isOvernightPlace = useMemo(
    () => (waypoint ? overnightCandidates([waypoint]).length > 0 : false),
    [waypoint],
  );
  const isStop = planStop !== undefined;
  const showStopContext = stopCandidate !== null && (isStop || (canToggleStop && isOvernightPlace));
  const stopContext = useMemo(
    () =>
      showStopContext && stopCandidate
        ? stopContextIfStopped(routeTrail, glance.plan, stopCandidate, isStop, glance.options)
        : null,
    [showStopContext, stopCandidate, routeTrail, glance.plan, glance.options, isStop],
  );

  // The curated description arrives over the comments sync channel and
  // overrides the near-empty bundled one. The feed's own pull lands it.
  const [syncedDescription, setSyncedDescription] = useState<string | null>(null);
  useEffect(() => {
    if (!commentWaypointId) return;
    let active = true;
    const read = () => {
      getDatabase()
        .then((db) => waypointMetaRepo.getDescription(db, trailId, commentWaypointId))
        .then(
          (text) => {
            if (active) setSyncedDescription(text);
          },
          () => {},
        );
    };
    read();
    const off = onSyncChange((change) => {
      if (change.trailId == null || change.trailId === trailId) read();
    });
    return () => {
      active = false;
      off();
    };
  }, [trailId, commentWaypointId]);

  useEffect(() => {
    void useFavoritesStore.getState().hydrate(trailId);
  }, [trailId]);

  // How far the place itself is from the line, so the trip card never calls a
  // lodging two kilometres off the route "here".
  const placeOffTrailM = useMemo(() => {
    if (!waypoint) return null;
    if (onAlternate) {
      return routeWaypoint ? waypointOffTrailMeters(waypoint, routeTrail.track.points) : null;
    }
    return waypointOffTrailMeters(waypoint, trail.track.points);
  }, [waypoint, trail, onAlternate, routeWaypoint, routeTrail]);

  if (!waypoint) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Waypoint' }} />
        <Text style={[styles.notFoundTitle, { color: colors.textPrimary }]}>
          Waypoint not found
        </Text>
      </View>
    );
  }

  const marker = waypointColor(waypoint.type, colors);
  const description = syncedDescription ?? waypoint.description;
  const accessLine = accessLineFor(waypoint, units);
  const duplicatePois = duplicatePoisFor(trail, waypoint.id);
  const km = waypoint.totalDistance ?? 0;
  const onCard = alternateCards.find((a) => a.role === 'on');
  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: waypoint.name }} />
      <KeyboardAwareScrollView
        style={[styles.flex, { backgroundColor: colors.background }]}
        contentContainerStyle={styles.content}
      >
        {/* How far, and how much up and down, from where the hiker stands.
            A place on an alternate is measured along the route as planned, so
            only once the plan takes it. */}
        {!onAlternate ? (
          <TripCard
            placeKm={km}
            placeOffTrailM={placeOffTrailM}
            placeAccessMode={isAccessMode(waypoint.accessMode) ? waypoint.accessMode : undefined}
          />
        ) : routeWaypoint ? (
          <TripCard
            placeKm={routeWaypoint.totalDistance ?? 0}
            placeOffTrailM={placeOffTrailM}
            placeAccessMode={isAccessMode(waypoint.accessMode) ? waypoint.accessMode : undefined}
            along={{ trail: routeTrail, currentKm: routeFixKm }}
          />
        ) : null}

        {/* Hero header */}
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <View style={[styles.typeChip, { backgroundColor: marker }]}>
              <Text style={[styles.typeChipText, { color: colors.textInverse }]} numberOfLines={1}>
                {waypointTypeLabel(waypoint.type)}
              </Text>
            </View>
            <View style={styles.heroActions}>
              <ShareIconButton
                color={colors.textSecondary}
                accessibilityLabel="Share check-in"
                onPress={() => {
                  const hasFix =
                    (status === 'fix' || status === 'off-trail') && position != null;
                  void shareCheckIn({
                    trailName: trail.config.name,
                    totalKm: trail.track.totalDistance,
                    units,
                    waypoint: {
                      name: waypoint.name,
                      km,
                      lat: waypoint.lat,
                      lon: waypoint.lon,
                    },
                    gps:
                      hasFix && position != null && currentKm != null
                        ? {
                            lat: position.lat,
                            lon: position.lon,
                            currentKm,
                            offTrail: status === 'off-trail',
                          }
                        : null,
                  });
                }}
              />
              {stopCandidate && canToggleStop && (
                <StopHereToggle isStop={isStop} onPress={toggleThisStop} />
              )}
              <FavoriteHeart
                filled={isFav}
                onPress={() => void toggleFavorite(trailId, waypointId)}
              />
            </View>
          </View>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{waypoint.name}</Text>
          {isPlanned && (
            <View style={[styles.plannedBanner, { borderColor: colors.resupplyPlanned }]}>
              <Text style={[styles.plannedBannerText, { color: colors.resupplyPlanned }]}>
                {/* A turn-off is planned by the place it serves, so say which:
                    that is where the hiker changes it. */}
                {plannedVia ? `Planned stop for ${plannedVia}` : 'Planned resupply stop'}
              </Text>
            </View>
          )}
          {hikerWaypoint && (
            <View style={styles.hikerRow}>
              <Text style={[styles.accessLine, styles.flex, { color: colors.textSecondary }]}>
                {hikerWaypoint.mine
                  ? hikerWaypoint.visibility === 'shared'
                    ? 'Added by you · shared with everyone'
                    : 'Added by you · only on this phone'
                  : `Added by ${hikerWaypoint.authorName ?? 'a hiker'} · not checked by Tracknotes`}
              </Text>
              {hikerWaypoint.mine ? (
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/waypoint-edit',
                      params: { trailId, id: waypointId },
                    })
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Edit waypoint"
                  style={({ pressed }) => [styles.hikerAction, pressed && styles.pressed]}
                >
                  <Text style={[styles.hikerActionText, { color: colors.accent }]}>Edit</Text>
                </Pressable>
              ) : userWaypoint && !waypointReported ? (
                <Pressable
                  onPress={() => setReportingWaypoint(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Report waypoint"
                  style={({ pressed }) => [styles.hikerAction, pressed && styles.pressed]}
                >
                  <Text style={[styles.hikerActionText, { color: colors.textSecondary }]}>
                    Report
                  </Text>
                </Pressable>
              ) : waypointReported ? (
                <Text style={[styles.accessLine, { color: colors.textSecondary }]}>Reported</Text>
              ) : null}
            </View>
          )}
          {watchShare && shareFailure ? (
            <Text style={[styles.accessLine, { color: colors.danger }]} accessibilityRole="alert">
              {`Not shared yet: ${shareFailure}`}
            </Text>
          ) : null}
          {/* Curated descriptions arrive over the sync channel; the bundled
              trail JSON is the fallback. */}
          {description ? (
            <LinkifiedText
              text={description}
              style={[styles.description, { color: colors.textSecondary }]}
            />
          ) : null}
          {/* How far off the route the place is, and how you get there — the
              same words the picker uses (@lib/resupply-display). */}
          {accessLine ? (
            <Text style={[styles.accessLine, { color: colors.textSecondary }]}>{accessLine}</Text>
          ) : null}
        </View>

        {toggleResupply && (
          <Pressable
            onPress={toggleResupply}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            style={({ pressed }) => [
              styles.planButton,
              { borderColor: colors.resupplyPlanned },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.planButtonText, { color: colors.resupplyPlanned }]}>
              {isSelected ? 'Remove from resupply plan' : 'Plan resupply here'}
            </Text>
          </Pressable>
        )}

        {/* Stats row */}
        <View style={styles.stats}>
          {onCard ? (
            onCard.kmAlong !== null && (
              <Stat label="Along the alternate" value={formatDistance(onCard.kmAlong, units)} />
            )
          ) : (
            <Stat label="Distance" value={formatDistance(km, units)} />
          )}
          {waypoint.elevation != null && (
            <Stat label="Elevation" value={formatElevation(waypoint.elevation, units)} />
          )}
          {/* The km above is where the route passes the place; a walk (or
              ride) beyond that is called out in the off-trail colour. */}
          {placeOffTrailM != null && isPlaceOffTrail(placeOffTrailM) && (
            <Stat
              label="Off the route"
              value={offTrailDistance(placeOffTrailM, units)}
              tint={colors.offTrail}
            />
          )}
        </View>

        {/* Back to the guide, on the map, centred on the place — the web
            datasheet's "show on map". Its own position, so a place off the
            route is shown where it is, not where the route passes it. */}
        <Pressable
          onPress={() => {
            requestMapTarget(trailId, { lat: waypoint.lat, lon: waypoint.lon });
            router.dismissTo({ pathname: '/guide/[trailId]', params: { trailId } });
          }}
          accessibilityRole="button"
          accessibilityLabel="Show on map"
          style={({ pressed }) => [
            styles.planButton,
            { borderColor: colors.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.planButtonText, { color: colors.accent }]}>Show on map</Text>
        </Pressable>

        {/* Its alternates: where each leaves and rejoins the main route, and
            the planner's choice to take it or stay on the main route. */}
        {alternateCards.map((alternate) => (
          <WaypointAlternateCard
            key={`${alternate.role}:${alternate.name}`}
            alternate={alternate}
            units={units}
            currentWaypointId={waypoint.id}
            onAlternate={setAlternate}
            onOpenPlace={openPlace}
          />
        ))}

        {/* The place in the plan: the day that ends here and the one that
            leaves from it, and for a stop its nights / note / booked — the
            same controls as the Plan screen's Stops list, one component, so
            "2 nights" means the same in both. */}
        {showStopContext && stopCandidate && (
          <StopContextCard
            isStop={isStop}
            context={stopContext}
            units={units}
            onStopHere={isStop ? undefined : toggleThisStop}
            onViewPlan={() => setGlanceOpen(true)}
          >
            {planStop && (
              <StopEditor
                stop={planStop}
                onNights={(nights) =>
                  editPlan((p) => setNights(p, stopKeyOf(stopCandidate), nights))
                }
                onNote={(note) => editPlan((p) => setStopNote(p, stopKeyOf(stopCandidate), note))}
                onBooked={(booked) =>
                  editPlan((p) => setStopBooked(p, stopKeyOf(stopCandidate), booked))
                }
              />
            )}
          </StopContextCard>
        )}

        {/* The OSM records this waypoint's place duplicates — hidden everywhere
            else in the app, surfaced here for the fields OSM has and the
            curated waypoint doesn't. */}
        {duplicatePois.length > 0 && <OsmDuplicates pois={duplicatePois} />}

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        <CommentsSection
          trailId={trailId}
          waypointId={commentWaypointId}
          waypointType={waypoint.type}
          // A hiker's private waypoint is invisible to everyone else, so a
          // comment on it would be a public note on a place nobody can find.
          unavailableText={
            hikerWaypoint?.visibility === 'private'
              ? 'This waypoint is only on your phone, so it has no comments. Share it to let other hikers comment.'
              : undefined
          }
        />
      </KeyboardAwareScrollView>

      {reportingWaypoint && userWaypoint && (
        <ReportDialog
          commentId={userWaypoint.id}
          title="Report this waypoint"
          registered={identityStatus === 'registered'}
          onCancel={() => setReportingWaypoint(false)}
          onSubmit={async ({ reason, detail, displayName }) => {
            if (!session) {
              if (!displayName) return; // guarded by the dialog's name step
              await useIdentityStore.getState().register(displayName);
            }
            await reportUserWaypoint({ waypoint: userWaypoint, reason, detail });
            setWaypointReported(true);
            setReportingWaypoint(false);
          }}
        />
      )}

      <PlanGlanceSheet
        visible={glanceOpen}
        onClose={() => setGlanceOpen(false)}
        glance={glance}
        units={units}
        onOpenPlanner={() =>
          router.push({ pathname: '/guide/[trailId]/plan', params: { trailId } })
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// "From OpenStreetMap" — the duplicate-POI payoff
// ---------------------------------------------------------------------------

/**
 * Collapsed by default: this is supplementary, uncurated data about a place the
 * trail already describes, so it must not compete with the curated description
 * or push the comments off the first screen.
 */
function OsmDuplicates({ pois }: { pois: TrailPOI[] }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.osmSection}>
      <Pressable
        onPress={() => setExpanded((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel="From OpenStreetMap"
        accessibilityState={{ expanded }}
        hitSlop={spacing.xs}
        style={({ pressed }) => [styles.osmHeader, pressed && styles.pressed]}
      >
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
          From OpenStreetMap
        </Text>
        <Text style={[styles.osmChevron, { color: colors.textSecondary }]}>
          {expanded ? '\u25be' : '\u25b8'}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.osmBody}>
          {pois.map((poi) => (
            <OsmRecord key={`${poi.type}-${poi.id}`} poi={poi} />
          ))}
          <Text style={[styles.osmCaption, { color: colors.textSecondary }]}>
            {`${OSM_ATTRIBUTION} \u00b7 this OSM record describes the same place`}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * One OSM element: its worthwhile tags, then a link out.
 *
 * A record whose tags are all uninteresting still gets the link — "there is an
 * OSM element here, go look" is the minimum useful answer.
 */
function OsmRecord({ poi }: { poi: TrailPOI }) {
  const { colors } = useTheme();
  const lines = summarisePoiTags(poi.tags);

  return (
    <View
      style={[styles.osmRecord, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      {lines.map((line) => (
        <OsmTagLine
          key={`${line.label}-${line.value}`}
          label={line.label}
          value={line.value}
          href={line.href}
        />
      ))}
      <OsmLink url={poiOsmUrl(poi)} label="Open in OpenStreetMap" />
    </View>
  );
}

/**
 * A label/value row. Only a line the shared guards handed back an `href` for is
 * tappable: an OSM `website` tag is free text and could just as easily hold
 * `javascript:`, so nothing else here ever reaches `Linking.openURL`.
 */
function OsmTagLine({ label, value, href }: { label: string; value: string; href?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.osmLine}>
      <Text style={[styles.osmLabel, { color: colors.textSecondary }]}>{label}</Text>
      {href ? (
        <OsmLink url={href} label={value} style={styles.osmValueCell} />
      ) : (
        <Text style={[styles.osmValue, styles.osmValueCell, { color: colors.textPrimary }]}>
          {value}
        </Text>
      )}
    </View>
  );
}

function OsmLink({
  url,
  label,
  style,
}: {
  url: string;
  label: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => void Linking.openURL(url)}
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={spacing.xs}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      <Text style={[styles.osmValue, { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
}


// ---------------------------------------------------------------------------
// Plan stop toggle
// ---------------------------------------------------------------------------

/**
 * "Stop here" / "Remove stop", beside the heart.
 *
 * A glyph rather than a labelled button because it sits in a three-icon row in
 * the hero; the words live on the accessibility label, which is also what a
 * Maestro flow taps.
 */
function StopHereToggle({ isStop, onPress }: { isStop: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={isStop ? 'Remove stop' : 'Stop here'}
      accessibilityState={{ selected: isStop }}
      hitSlop={spacing.sm}
      style={({ pressed }) => [styles.heart, pressed && styles.pressed]}
    >
      <Text
        style={[styles.heartIcon, { color: isStop ? colors.waypointCamp : colors.textSecondary }]}
      >
        ⛺
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Favorite heart
// ---------------------------------------------------------------------------

function FavoriteHeart({ filled, onPress }: { filled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={filled ? 'Remove from favorites' : 'Add to favorites'}
      accessibilityState={{ selected: filled }}
      hitSlop={spacing.sm}
      style={({ pressed }) => [styles.heart, pressed && styles.pressed]}
    >
      <Text style={[styles.heartIcon, { color: filled ? colors.waypointFavorite : colors.textSecondary }]}>
        {filled ? '♥' : '♡'}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Stat chip
// ---------------------------------------------------------------------------

/**
 * "22.5 km hitch from Chief Mountain border crossing · accepts boxes" — where a
 * place actually is when it is not on the route. Empty for an on-route
 * waypoint, which is most of them, and then nothing is rendered.
 */
function accessLineFor(waypoint: TrailJsonWaypoint, units: Units): string {
  const summary = accessSummary(waypoint, (km) => formatDistance(km, units));
  if (summary === '') return '';
  const where = waypoint.accessName ? `${summary} from ${waypoint.accessName}` : summary;
  return waypoint.acceptsBoxes ? `${where} · accepts boxes` : where;
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.stat, { backgroundColor: colors.surface, borderColor: tint ?? colors.border }]}
    >
      <Text style={[styles.statLabel, { color: tint ?? colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: tint ?? colors.textPrimary }]}>{value}</Text>
    </View>
  );
}



const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFoundTitle: { ...typography.displaySmall },

  hero: { gap: spacing.sm },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  typeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    maxWidth: '70%',
  },
  typeChipText: { ...typography.dataSmall },
  name: { ...typography.displaySmall },
  description: { ...typography.body },
  accessLine: { ...typography.bodySmall },
  hikerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  hikerAction: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  hikerActionText: { ...typography.titleSmall },

  plannedBanner: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  plannedBannerText: { ...typography.dataSmall, fontWeight: '600' },
  planButton: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  planButtonText: { ...typography.titleSmall },

  heart: { padding: spacing.xs },
  heartIcon: { fontSize: glyphSizes.xxl },
  pressed: { opacity: 0.6 },

  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stat: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    minWidth: 90,
  },
  statLabel: { ...typography.caption },
  statValue: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },

  osmSection: { gap: spacing.sm },
  osmHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  osmChevron: { ...typography.bodySmall },
  osmBody: { gap: spacing.sm },
  osmRecord: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  osmLine: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  osmLabel: { ...typography.caption, flexBasis: '38%', flexShrink: 0 },
  osmValue: { ...typography.bodySmall },
  osmValueCell: { flex: 1 },
  osmCaption: { ...typography.caption },

  divider: { height: StyleSheet.hairlineWidth },
  sectionTitle: { ...typography.titleLarge },

});
