/**
 * The MainActivity.kt edit behind `plugins/with-share-intent.js`, kept apart
 * from `expo/config-plugins` (whose index pulls in the iOS tooling) so Jest can
 * load it.
 *
 * The blocks go in through `mergeContents`, tagged and hashed like
 * expo-splash-screen's edit to the same file: a change to them replaces the old
 * block on the next prebuild, without `--clean`.
 */

const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const { addImports } = require('@expo/config-plugins/build/android/codeMod');

const TAG = 'tracknotes-share-intent';

const IMPORTS = [
  'android.content.Intent',
  'android.net.Uri',
  'android.os.Build',
  'android.os.Parcelable',
  'android.provider.OpenableColumns',
];

/**
 * Shared types that are only ever a GPX, so any file of them is promoted. The
 * generic ones in the SEND filter (`application/octet-stream`, `application/json`,
 * `text/xml`, `application/xml`) are promoted only when the provider's display
 * name ends in one of {@link SHARED_NAME_SUFFIXES} — the same gate the VIEW
 * filters put on a path, which a SEND cannot carry.
 */
const PRECISE_SHARE_TYPES = ['application/gpx+xml'];
const SHARED_NAME_SUFFIXES = ['.gpx', '.tracknotes.json'];

const kotlinList = (items) => items.map((s) => JSON.stringify(s)).join(', ');

const ON_CREATE = '    promoteSharedStream(intent)';

const HELPERS = `
  override fun onNewIntent(intent: Intent) {
    promoteSharedStream(intent)
    super.onNewIntent(intent)
  }

  /**
   * "Share to Tracknotes": React Native only reports an ACTION_VIEW's data URI,
   * so a SEND carrying a GPX in EXTRA_STREAM becomes the VIEW of that URI.
   * Anything unexpected in the intent leaves it as it was — never a crash in
   * onCreate, since any app can send this exported activity a SEND.
   */
  private fun promoteSharedStream(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_SEND) return
    try {
      // The typed getParcelableExtra is unreliable on API 33 (androidx's
      // IntentCompat uses it only from 34), and the untyped one is an unchecked
      // cast, hence \`as? Uri\`.
      val stream: Uri = (
        if (Build.VERSION.SDK_INT >= 34) {
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? Uri
        }
      ) ?: return
      if (!isSharedTrailFile(stream, intent.type)) return
      intent.action = Intent.ACTION_VIEW
      intent.setDataAndType(stream, intent.type)
    } catch (e: Exception) {
      // Leave the intent alone: the app opens on its own screen.
    }
  }

  private fun isSharedTrailFile(stream: Uri, type: String?): Boolean {
    if (type != null && type.lowercase() in listOf(${kotlinList(PRECISE_SHARE_TYPES)})) return true
    val name = sharedDisplayName(stream)?.lowercase() ?: return false
    return listOf(${kotlinList(SHARED_NAME_SUFFIXES)}).any { name.endsWith(it) }
  }

  private fun sharedDisplayName(stream: Uri): String? =
    try {
      contentResolver
        .query(stream, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    } catch (e: Exception) {
      null
    }
`;

/** The MainActivity.kt source with the share hand-off added. Idempotent. */
function addShareIntent(src) {
  let out = addImports(src, IMPORTS, false);

  if (!/^[ \t]*super\.onCreate\(/m.test(out)) {
    throw new Error(`[${TAG}] MainActivity has no super.onCreate( call to hook.`);
  }
  out = mergeContents({
    tag: `${TAG}-oncreate`,
    src: out,
    newSrc: ON_CREATE,
    anchor: /^[ \t]*super\.onCreate\(/,
    offset: 0,
    comment: '//',
  }).contents;

  // The class's closing brace: the one `}` at the start of a line.
  if (!/^}\s*$/m.test(out)) {
    throw new Error(`[${TAG}] MainActivity has no class body.`);
  }
  out = mergeContents({
    tag: `${TAG}-helpers`,
    src: out,
    newSrc: HELPERS,
    anchor: /^}\s*$/,
    offset: 0,
    comment: '//',
  }).contents;

  return out;
}

module.exports = { addShareIntent, TAG, PRECISE_SHARE_TYPES, SHARED_NAME_SUFFIXES };
