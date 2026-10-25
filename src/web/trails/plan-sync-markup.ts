/**
 * The sync arm's dialogs — linking this browser to the phone, and the share
 * link — in one copy for every page that syncs a plan.
 *
 * `inlinePlanShell` (`scripts/lib/plan-shell.ts`) fills them into
 * `plan-shell.html` at its `{{PLAN_SYNC_DIALOGS}}` placeholder, so the planner
 * pages carry them as static markup; the resupply page, which has no shell,
 * mounts them at runtime with {@link mountPlanSyncDialogs} before it starts
 * `initPlanSync`. `plan-sync.ts` looks both up by id and removes them when the
 * site was built without VITE_API_BASE_URL.
 *
 * The first line carries no indentation of its own: the placeholder it
 * replaces supplies it.
 */
export const PLAN_SYNC_DIALOGS_HTML = `<dialog id="link-dialog" class="link-dialog">
      <form id="link-form">
        <h2 class="link-title">Sync this plan</h2>
        <div id="link-unlinked">
          <p class="link-help">
            On your phone open Settings &rarr; Linked browsers &rarr; Link a browser,
            then enter the code here.
          </p>
          <label class="link-field" for="link-code">Code</label>
          <input type="text" id="link-code" class="link-input" maxlength="11"
            autocomplete="off" autocapitalize="characters" spellcheck="false"
            placeholder="XXXXXXXX" />
          <label class="link-field" for="link-label">Name this browser</label>
          <input type="text" id="link-label" class="link-input" maxlength="60" />
          <p id="link-error" class="link-error" hidden></p>
        </div>
        <div id="link-linked" hidden>
          <p class="link-help">
            Linked as <strong id="link-display-name"></strong>. Changes to this plan
            sync with your phone.
          </p>
          <button type="button" id="link-unlink" class="link-danger">Unlink this browser</button>
        </div>
        <div class="link-actions">
          <button type="button" id="link-cancel" class="plan-header-btn">Close</button>
          <button type="submit" id="link-submit" class="plan-header-btn is-primary">Link</button>
        </div>
      </form>
    </dialog>

    <div id="share-panel" class="share-panel" hidden>
      <p class="share-help">Anyone with this link can read this plan.</p>
      <div class="share-row">
        <input type="text" id="share-url" class="link-input" readonly />
        <button type="button" id="share-copy" class="plan-header-btn">Copy</button>
      </div>
      <p id="share-note" class="share-note" hidden></p>
      <div class="share-row share-row-end">
        <button type="button" id="share-unshare" class="link-danger">Stop sharing</button>
        <button type="button" id="share-close" class="plan-header-btn">Close</button>
      </div>
    </div>`;

/** Append the dialogs to `parent` (the page body), once. */
export function mountPlanSyncDialogs(parent: HTMLElement): void {
  if (document.getElementById('link-dialog')) return;
  parent.insertAdjacentHTML('beforeend', PLAN_SYNC_DIALOGS_HTML);
}
