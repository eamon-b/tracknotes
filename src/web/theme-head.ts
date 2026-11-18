/**
 * The one copy of the `<head>` markup that applies the saved light/dark choice
 * before first paint, for the hand-written top-level pages (`index.html`,
 * `upload.html`, `my-plan.html`, …).
 *
 * Each of those pages carries a `<!-- @theme-head -->` marker line in its
 * `<head>`, and the `theme-head` plugin in `vite.config.ts` replaces it with
 * {@link themeHeadHtml} at dev and build time: a small inline script that sets
 * `<html data-theme data-theme-pref>` (and the `js` class) synchronously, then
 * `theme.ts` as a module, which keeps them in sync afterwards and renders any
 * `[data-theme-toggle]` slot. A page that relied on a viewer module importing
 * `theme.ts` instead painted in the system theme first and switched once the
 * bundle ran.
 *
 * The bundled trail templates (`trails/*-template.html`) carry the same script
 * inline, because `scripts/build-trails.ts` writes their pages before Vite
 * sees them; `theme-head.test.ts` holds them to {@link THEME_PREPAINT_SCRIPT}.
 *
 * Free of `fs` and of DOM globals: the Vite config imports it.
 */

/** The marker line a page carries where the theme head goes. */
export const THEME_HEAD_MARKER = '<!-- @theme-head -->';

/** Matches the marker on a line of its own, with any indentation. */
const MARKER_LINE = /^([^\S\n]*)<!-- @theme-head -->[^\S\n]*$/m;

/**
 * The inline pre-paint script, as it appears (two-space indented) in each
 * page's `<head>`. The storage key matches `theme.ts`.
 */
export const THEME_PREPAINT_SCRIPT = `<!-- Applies the saved theme before first paint so the page never flashes. See theme.ts. -->
<script>
  (function () {
    var root = document.documentElement;
    root.classList.add('js');
    var pref = 'system';
    try { pref = localStorage.getItem('tracknotes-theme') || 'system'; } catch (e) { /* storage disabled */ }
    if (pref !== 'light' && pref !== 'dark') pref = 'system';
    root.dataset.themePref = pref;
    root.dataset.theme = pref === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
  })();
</script>`;

/**
 * The pre-paint script followed by the `theme.ts` module tag.
 * `themeModuleSrc` is the path to `theme.ts` relative to the page
 * (`./theme.ts` for a page at the top of `src/web/`).
 */
export function themeHeadHtml(themeModuleSrc: string): string {
  return `${THEME_PREPAINT_SCRIPT}\n<script type="module" src="${themeModuleSrc}"></script>`;
}

/** True when a page has the marker line. */
export function hasThemeHeadMarker(pageHtml: string): boolean {
  return MARKER_LINE.test(pageHtml);
}

/**
 * Replace a page's `@theme-head` marker line with {@link themeHeadHtml},
 * indented to the marker's own indentation. A page without the marker is
 * returned unchanged.
 */
export function inlineThemeHead(pageHtml: string, themeModuleSrc: string): string {
  return pageHtml.replace(MARKER_LINE, (_line, indent: string) =>
    themeHeadHtml(themeModuleSrc)
      .split('\n')
      .map(line => indent + line)
      .join('\n')
  );
}
