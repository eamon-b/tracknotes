/**
 * The MainActivity patch behind "Share to Tracknotes". The fixture is the
 * SDK 54 template's MainActivity, trimmed to what the patch touches.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addShareIntent } = require('../lib/share-intent-source') as {
  addShareIntent: (src: string) => string;
};

const TEMPLATE = `package com.tracknotes.app

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

describe('addShareIntent', () => {
  const out = addShareIntent(TEMPLATE);

  it('imports Intent and Uri after the package line', () => {
    expect(out).toMatch(/^package com\.tracknotes\.app\n[\s\S]*import android\.content\.Intent\n/);
    expect(out).toContain('import android.net.Uri\n');
  });

  it('rewrites the launch intent before React Native reads it', () => {
    const hook = out.indexOf('promoteSharedStream(intent)');
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(out.indexOf('super.onCreate('));
  });

  it('rewrites a new intent too, inside the class body', () => {
    expect(out).toMatch(
      /override fun onNewIntent\(intent: Intent\) \{\n\s+promoteSharedStream\(intent\)\n\s+super\.onNewIntent\(intent\)/,
    );
    expect(out.trimEnd().endsWith('}')).toBe(true);
    expect(out.indexOf('onNewIntent')).toBeGreaterThan(out.indexOf('getMainComponentName'));
  });

  it('turns only a SEND carrying a stream into a VIEW of that stream', () => {
    expect(out).toContain('if (intent == null || intent.action != Intent.ACTION_SEND) return');
    expect(out).toContain('Intent.EXTRA_STREAM');
    expect(out).toContain('intent.action = Intent.ACTION_VIEW');
    expect(out).toContain('intent.setDataAndType(stream, intent.type)');
  });

  it('is idempotent', () => {
    expect(addShareIntent(out)).toBe(out);
  });

  it('refuses a MainActivity it cannot hook', () => {
    expect(() => addShareIntent('package x\n\nclass MainActivity {}\n')).toThrow(/super\.onCreate/);
  });
});
