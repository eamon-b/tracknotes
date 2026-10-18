/**
 * The MainActivity patch behind "Share to Tracknotes". The fixture is the
 * SDK 54 template's MainActivity, trimmed to what the patch touches.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addShareIntent, PRECISE_SHARE_TYPES, SHARED_NAME_SUFFIXES } = require(
  '../lib/share-intent-source',
) as {
  addShareIntent: (src: string) => string;
  PRECISE_SHARE_TYPES: string[];
  SHARED_NAME_SUFFIXES: string[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appJson = require('../../app.json') as {
  expo: { android: { intentFilters: { action: string; data: { mimeType?: string }[] }[] } };
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

  it('imports what the helpers use, once each', () => {
    for (const name of [
      'android.content.Intent',
      'android.net.Uri',
      'android.os.Build',
      'android.os.Parcelable',
      'android.provider.OpenableColumns',
    ]) {
      expect(out.split(`import ${name}\n`)).toHaveLength(2);
    }
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
    expect(out).toContain('intent.action = Intent.ACTION_VIEW');
    expect(out).toContain('intent.setDataAndType(stream, intent.type)');
  });

  it('never casts the stream unchecked, and never lets a bad intent throw', () => {
    // Typed API only from 34; below, the untyped read is a safe cast.
    expect(out).toContain('Build.VERSION.SDK_INT >= 34');
    expect(out).toContain('getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? Uri');
    expect(out).not.toMatch(/getParcelableExtra<Uri>/);
    expect(out).toMatch(/try \{[\s\S]*intent\.action = Intent\.ACTION_VIEW[\s\S]*\} catch \(e: Exception\)/);
  });

  it('gates a generic type on the shared file name', () => {
    expect(out).toContain('listOf("application/gpx+xml")');
    expect(out).toContain('listOf(".gpx", ".tracknotes.json")');
    expect(out).toContain('OpenableColumns.DISPLAY_NAME');
  });

  it('is idempotent, and replaces an older generated block', () => {
    expect(addShareIntent(out)).toBe(out);
    // A block written by an older version of the plugin: different body, so
    // a different hash in its header.
    const stale = out
      .replace(/(tracknotes-share-intent-helpers - .*sync-)[0-9a-f]+/, '$10000')
      .replace('super.onNewIntent(intent)', 'super.onNewIntent(intent) // old');
    const again = addShareIntent(stale);
    expect(again).not.toContain('// old');
    expect(again.split('override fun onNewIntent')).toHaveLength(2);
  });

  it('refuses a MainActivity it cannot hook', () => {
    expect(() => addShareIntent('package x\n\nclass MainActivity {}\n')).toThrow(/super\.onCreate/);
  });
});

describe('the SEND filter', () => {
  const send = appJson.expo.android.intentFilters.find((f) => f.action === 'SEND')!;
  const types = send.data.map((d) => d.mimeType);

  it('claims nothing the plugin cannot gate', () => {
    // Every SEND type is either a GPX for sure or name-gated by the plugin.
    expect(types.length).toBeGreaterThan(0);
    expect(PRECISE_SHARE_TYPES.every((t) => types.includes(t))).toBe(true);
    expect(SHARED_NAME_SUFFIXES).toContain('.gpx');
  });
});
