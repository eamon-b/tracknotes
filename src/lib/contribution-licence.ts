/**
 * The terms every public contribution is made under: comments (with their
 * water reports and photos), shared hiker waypoints and community routes are
 * dedicated to the public domain under CC0 (`docs/content-legal-posture.md`
 * §8.1) and posted under the terms of service (`docs/terms-of-service.md`,
 * published as `public/terms.html`). One wording, so the phone's composer, its
 * waypoint form and any web form say the same thing.
 */

/** The Vercel deploy of `public/terms.html`, beside the privacy policy. */
export const TERMS_URL = 'https://trail-maps.vercel.app/terms.html';

/** The licence's own page, for a link on the "CC0" in the line. */
export const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

/**
 * "By posting, you release your comment into the public domain (CC0) and
 * agree to the terms of service." — split so a UI can make the last words a
 * link to {@link TERMS_URL}.
 */
export function contributionLicenceLine(
  verb: 'posting' | 'sharing',
  what: string,
): { before: string; link: string; after: string } {
  const lead = verb === 'posting' ? 'By posting' : 'By sharing';
  return {
    before: `${lead}, you release ${what} into the public domain (CC0) and agree to the `,
    link: 'terms of service',
    after: '.',
  };
}
