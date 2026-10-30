/**
 * The terms every public contribution is made under: comments (with their
 * water reports and photos), shared hiker waypoints and community routes are
 * dedicated to the public domain under CC0 (`docs/content-legal-posture.md`,
 * decision 1) and posted under the terms of service (`docs/terms-of-service.md`,
 * published as `public/terms.html`). One wording, so the phone's composer, its
 * waypoint form and any web form say the same thing.
 */

/**
 * The Vercel deploy of `public/`. The store listings link these pages, so the
 * origin must match theirs; store review flags a mismatch.
 */
const SITE_ORIGIN = 'https://trail-maps.vercel.app';

/** `public/privacy.html`, linked from the phone's Settings → About. */
export const PRIVACY_POLICY_URL = `${SITE_ORIGIN}/privacy.html`;

/** `public/terms.html`, beside the privacy policy. */
export const TERMS_URL = `${SITE_ORIGIN}/terms.html`;

/**
 * "By posting, you release your comment into the public domain (CC0) and
 * agree to the terms of service." — split so a UI can make the last words a
 * link to {@link TERMS_URL}.
 */
export function contributionLicenceLine(
  verb: 'posting' | 'sharing',
  what: string
): { before: string; link: string; after: string } {
  const lead = verb === 'posting' ? 'By posting' : 'By sharing';
  return {
    before: `${lead}, you release ${what} into the public domain (CC0) and agree to the `,
    link: 'terms of service',
    after: '.',
  };
}
