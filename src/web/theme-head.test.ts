import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { THEME_HEAD_MARKER, THEME_PREPAINT_SCRIPT, hasThemeHeadMarker, inlineThemeHead } from './theme-head';

const webDir = resolve(__dirname);
const read = (rel: string) => readFileSync(resolve(webDir, rel), 'utf-8');

/** Every hand-written top-level page Vite builds (`vite.config.ts` inputs). */
const topLevelPages = readdirSync(webDir).filter(name => name.endsWith('.html'));

describe('theme head', () => {
  it('covers every top-level page', () => {
    // A new page without the marker would paint in the system theme first.
    expect(topLevelPages.length).toBeGreaterThanOrEqual(10);
    for (const page of topLevelPages) {
      const html = read(page);
      expect(hasThemeHeadMarker(html), page).toBe(true);
      expect(html.indexOf(THEME_HEAD_MARKER), page).toBeLessThan(html.indexOf('</head>'));
      // The marker is the only copy: no page carries its own pre-paint script.
      expect(html, page).not.toContain('tracknotes-theme');
    }
  });

  it('replaces the marker with the pre-paint script and the theme module, indented', () => {
    const page = '<head>\n  <title>x</title>\n  <!-- @theme-head -->\n</head>';
    const html = inlineThemeHead(page, './theme.ts');
    expect(html).not.toContain(THEME_HEAD_MARKER);
    expect(html).toContain('  <script>\n    (function () {\n      var root = document.documentElement;');
    expect(html).toContain('  <script type="module" src="./theme.ts"></script>\n</head>');
    // The inline script comes before the module, so it runs before first paint.
    expect(html.indexOf("localStorage.getItem('tracknotes-theme')")).toBeLessThan(html.indexOf('type="module"'));
  });

  it('leaves a page without the marker alone', () => {
    const page = '<head><title>x</title></head>';
    expect(inlineThemeHead(page, './theme.ts')).toBe(page);
  });

  it('applies the saved choice over the system setting when run', () => {
    const script = THEME_PREPAINT_SCRIPT.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>$/, '');
    const root = document.documentElement;
    delete root.dataset.theme;
    delete root.dataset.themePref;
    localStorage.setItem('tracknotes-theme', 'light');
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('dark') })) as typeof window.matchMedia;
    try {
      new Function(script)();
      expect(root.dataset.theme).toBe('light');
      expect(root.dataset.themePref).toBe('light');
      expect(root.classList.contains('js')).toBe(true);

      localStorage.removeItem('tracknotes-theme');
      new Function(script)();
      expect(root.dataset.theme).toBe('dark');
      expect(root.dataset.themePref).toBe('system');
    } finally {
      window.matchMedia = realMatchMedia;
      localStorage.removeItem('tracknotes-theme');
    }
  });

  it('matches the copy the bundled trail templates carry inline', () => {
    // build-trails.ts writes those pages before Vite sees them, so they keep
    // the script in the template; it must not drift from the shared one.
    const expected = inlineThemeHead(`  ${THEME_HEAD_MARKER}`, '../../theme.ts');
    for (const template of [
      'trails/trail-template.html',
      'trails/plan-template.html',
      'trails/climate-template.html',
      'trails/resupply-template.html',
    ]) {
      expect(read(template), template).toContain(expected);
    }
  });
});
