/**
 * Config plugin: "Share to Tracknotes" on Android.
 *
 * The share sheet launches us with `ACTION_SEND` and the file in
 * `Intent.EXTRA_STREAM`, but React Native's Linking (and so `expo-linking`'s
 * `useURL`) only reports an intent's *data* URI, and only for `ACTION_VIEW`
 * (`IntentModule.getInitialURL`, `ReactHostImpl.onNewIntent`). So the SEND
 * filters in `app.json` put Tracknotes in the share sheet and the file never
 * reached `features/import/incoming-file.ts`.
 *
 * This patches `MainActivity` to rewrite an `ACTION_SEND` that carries a stream
 * into the `ACTION_VIEW` of that URI, before React Native reads the intent —
 * in `onCreate` for a cold start and in `onNewIntent` for a running app. From
 * there it is the same path as "Open with": `classifyIncomingUrl` claims the
 * `content://` URI and `stageIncomingFile` copies it into the cache. The read
 * grant survives the rewrite: Android grants it on the URI (the sender's
 * `EXTRA_STREAM` is migrated into the intent's ClipData), not on the action.
 *
 * A SEND with no stream (shared text) is left alone and ignored, as before.
 * Native code, so it needs a new dev build.
 */

const { withMainActivity } = require('expo/config-plugins');
const { addShareIntent, TAG } = require('./lib/share-intent-source');

const withShareIntent = (config) =>
  withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error(`[${TAG}] expects a Kotlin MainActivity.`);
    }
    cfg.modResults.contents = addShareIntent(cfg.modResults.contents);
    return cfg;
  });

module.exports = withShareIntent;
