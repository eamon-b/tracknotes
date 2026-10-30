/**
 * The terms every public contribution is made under: comments (with their
 * water reports and photos), shared hiker waypoints and community routes are
 * dedicated to the public domain under CC0 (`docs/content-legal-posture.md`,
 * decision 1) and posted under the terms of service (`docs/terms-of-service.md`,
 * published as `public/terms.html`), with the privacy policy linked beside
 * them as the notice at collection (decision 3, APP 5). One wording, so the
 * phone's composer, its waypoint and route-share forms and the web's
 * route-share form say the same thing.
 */

/**
 * The web site (the Vercel deploy of `public/`, at tracknotes.info). The store listings link these pages, so the
 * origin must match theirs; store review flags a mismatch.
 */
const SITE_ORIGIN = 'https://tracknotes.info';

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

/**
 * "The privacy policy says what is stored and who can see it." — shown under
 * {@link contributionLicenceLine}, split so a UI can make "privacy policy" a
 * link to {@link PRIVACY_POLICY_URL}.
 */
export function contributionPrivacyLine(): { before: string; link: string; after: string } {
  return { before: 'The ', link: 'privacy policy', after: ' says what is stored and who can see it.' };
}
