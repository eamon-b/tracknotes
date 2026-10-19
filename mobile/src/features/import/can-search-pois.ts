/**
 * Which guides the on-phone OpenStreetMap search (`poi-search.ts`) is offered
 * for: only one imported on this phone (`u_…`). A bundled trail's POIs come
 * from the build and a community route's file is replaced whenever its owner
 * edits it, so neither is searched here. Its own module so the map can ask
 * without importing the search and the file store behind it.
 */
export function canSearchPois(trailId: string): boolean {
  return trailId.startsWith('u_');
}
