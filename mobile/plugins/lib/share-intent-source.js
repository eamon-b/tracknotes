/**
 * The MainActivity.kt edit behind `plugins/with-share-intent.js`, kept free of
 * `expo/config-plugins` so Jest can load it.
 */

const TAG = 'tracknotes-share-intent';

const IMPORTS = ['import android.content.Intent', 'import android.net.Uri', 'import android.os.Build'];

const HELPER = `
  // ${TAG}: Share to Tracknotes — see mobile/plugins/with-share-intent.js
  override fun onNewIntent(intent: Intent) {
    promoteSharedStream(intent)
    super.onNewIntent(intent)
  }

  private fun promoteSharedStream(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_SEND) return
    val stream: Uri = (
      if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      }
    ) ?: return
    intent.action = Intent.ACTION_VIEW
    intent.setDataAndType(stream, intent.type)
  }
`;

/** The MainActivity.kt source with the share hand-off added. Idempotent. */
function addShareIntent(src) {
  if (src.includes(TAG)) return src;

  let out = src;
  const missing = IMPORTS.filter((line) => !out.includes(`${line}\n`));
  if (missing.length > 0) {
    out = out.replace(/^(package [^\n]+\n)/, `$1\n${missing.join('\n')}\n`);
  }

  const onCreate = /^([ \t]*)super\.onCreate\(/m.exec(out);
  if (!onCreate) {
    throw new Error(`[${TAG}] MainActivity has no super.onCreate( call to hook.`);
  }
  const indent = onCreate[1];
  out =
    out.slice(0, onCreate.index) +
    `${indent}// ${TAG}: a shared file arrives as the VIEW of its URI\n` +
    `${indent}promoteSharedStream(intent)\n` +
    out.slice(onCreate.index);

  const close = out.lastIndexOf('}');
  if (close === -1) throw new Error(`[${TAG}] MainActivity has no class body.`);
  return `${out.slice(0, close)}${HELPER}${out.slice(close)}`;
}

module.exports = { addShareIntent, TAG };
