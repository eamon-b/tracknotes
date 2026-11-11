# Deploys and scheduled jobs in GitHub Actions

Five workflows deploy or publish from `main` after a merge, so none of these is a manual step any more.
The site is not among them: Vercel builds `main` on push.

| Workflow | Runs on a push to `main` that changes | Does | Environment |
| --- | --- | --- | --- |
| `deploy-comments-api.yml` | `workers/comments-api/**`, `src/lib/**` (the worker bundles `@lib`) | tests and `tsc`, `migrate:remote`, `deploy`, then `scripts/probe-comments-api.sh` | `production` |
| `deploy-tile-workers.yml` | `contours/worker/**` | the worker's tests and `tsc`, `wrangler deploy` (tiles.contour-map-tiles.net) and `wrangler deploy --env app` (tiles.tracknotes.info), then both `/health` | `production` |
| `publish-trail-data.yml` | `mobile/assets/trails/**` | a dry run of `publish:trail-data`, then, once approved, the publish and `--check` | `production-data` |
| `upload-descriptions.yml` | `data/trails/*/descriptions.json` | a dry run of `upload:descriptions` against the live API, then, once approved, the upload | `production-data` |
| `deploy-contours-site.yml` | `contours/site/**` | `wrangler pages deploy` to the `aus-contour-tiles` Pages project (contour-map-tiles.net), then checks the page answers | `production` |

A fifth, `staging-comments-api.yml`, deploys a same-repo PR that touches `workers/comments-api/**` to the **staging** comments API (its own Worker, D1 and R2; `docs/architecture/workers.md`, "staging") with the staging-only secrets below, never production's.

Each also has *Run workflow* (Actions → the workflow), for a re-deploy or a first run;
it runs from `main` only.
A change to a workflow file alone does not trigger it: use *Run workflow* to try one.

## How they behave

The workers deploy without a reviewer: the same tests as the *Tests* workflow run first, in the deploy job, and an unapplied migration or an undeployed route is the failure this exists to prevent (#141).
Trail data and descriptions reach every installed app, so each waits for a reviewer.
Its `plan` job runs the dry run without credentials and puts it in the run's summary;
nothing to publish means no `publish` job and nothing to approve.
Approve under the run's *Review deployments*, which the GitHub mobile app shows too.

A run deploys `main` as it is when the run starts, not the commit that triggered it.
Its first job reads `main`'s head (the GitHub API) and checks that out: a run that queued behind another, or a re-run of an old one, deploys the newest code rather than putting older code back, and a merge after it that did not touch the trigger paths (so started no run of its own) cannot leave it undeployed.
Its summary names the commit it deployed, and a run whose `main` has moved on says so there and in a notice.
The data workflows pass the commit their `plan` job resolved to the `publish` or `upload` job, so what is approved is exactly what was planned.
Runs of one workflow never overlap (`concurrency`, not cancelled in progress); a newer queued run replaces an older queued one, which is fine, since it deploys a `main` that includes it.
`publish:trail-data` also re-checks its own guards against the live catalog at publish time (a rollback, a checkout that does not contain the live publish's commit, a dropped trail), so a late approval cannot publish over a newer publish.
Its `plan` job first rebuilds the trail data (`sync:te-araroa`, `build:trails`, `build:mobile-trails`) and fails if that changes anything, since those guards compare against the live catalog, not against the sources.
`--hold` is an input of *Run workflow*: to hold a trail back from a push's publish (a new trail not ready for every installed app, #289), reject that run's deployment, then *Run workflow* with `hold` set.

Every merge that touches `src/lib/` redeploys the comments API (and runs `migrate:remote`, usually a no-op), since the worker bundles `@lib`; most of those deploys change nothing, and are not a fault.

**Migrations are additive.**
*Deploy comments API* applies pending migrations and then deploys, so between the two the running worker is the old code on the new schema.
Every migration must keep the deployed worker working: add tables, columns and indexes (expand), and remove what the old code reads only in a later release, once no deployed worker reads it (contract).
The deploy job refuses any pending migration that drops or renames anything (a SQLite table rebuild, as `0008` was, does both), and the run fails before applying it.
Apply such a migration by hand, at a moment you choose: from `main`, `cd workers/comments-api && npm run migrate:remote && npm run deploy`, then `scripts/probe-comments-api.sh`, then re-run the workflow, which then finds nothing to apply.

Credentials are passed only to the steps that call Cloudflare or the API, never to `npm ci` or the tests.

What still needs a person:

- A failed run. The *Deploy comments API* summary lists the probes; a probe that fails after a deploy means the deploy happened but a route is missing.
  *Deploy tile workers* deploys the dataset's Worker and then the app's, with no rollback: if the second fails, the two run different code until a re-run succeeds.
- A destructive migration (above), applied by hand.
- When a migration adds routes, add a probe to `scripts/probe-comments-api.sh`.
- Approving trail data and description runs.
- A worker change and the description or trail data change that needs it, merged together: the workflows run side by side, so approve the data run only once *Deploy comments API*'s `deploy` job has succeeded.

## Scheduled jobs

These run on a schedule (UTC), and each has *Run workflow* too.
A failed scheduled run emails whoever last changed its schedule, so a red run is the reminder.

| Workflow | When | Does | Needs a person when |
| --- | --- | --- | --- |
| `moderation-queue.yml` | daily | counts the reported or flagged posts waiting for an admin (`scripts/moderation-queue.ts`, the rule the moderation page highlights with, `@lib/moderation-attention`), and fails while any wait, so the alert is GitHub's failed-run email (private: the repository and its issues are public, so it posts nowhere, and its summary has counts only). It installs nothing (`node scripts/moderation-queue.ts`, on Node's type stripping), and its admin token sits in its own `moderation` environment | it is red: decide them on the moderation page |
| `te-araroa-data.yml` | weekly, Tuesday | when te-araroa-data's `main` has moved past the commit `package-lock.json` pins, runs `npm update te-araroa-data` and the trail rebuild, and opens or updates a PR from `automation/te-araroa-data`. It does nothing while that branch already takes the latest build, and fails rather than overwrite a commit someone else added to the branch. Its token is used for the push alone, never stored in the checkout | the PR is open: review the rebuilt Te Araroa data, add the `data/waypoint-ids.json` migration if upstream changed a waypoint's `type`, and merge it (*Publish trail data* follows) |
| `r2-cleanup.yml` | weekly, Thursday | dry runs of `cleanup:tiles` (superseded pack files) and `cleanup:tiles -- --trail-data` (superseded trail files), listed in the summary | to delete: *Run workflow* with `delete` ticked, then approve `production-data`; the delete job shares *Publish trail data*'s `publish-trail-data` concurrency group, so it never runs alongside a publish (while it waits for approval, a publish waits behind it, and the other way round). It re-plans against the bucket before deleting, and re-reads the live catalog before each trail file, keeping one a publish has meanwhile listed again |
| `dependency-audit.yml` | monthly, the 3rd | `npm run audit:deps` (`npm audit` over all four packages, failing only on a high or critical advisory with a non-breaking fix), and under `mobile/` `npx expo install --check` and `npx expo-doctor` | it is red: `npm audit fix`, or `npx expo install --fix` in `mobile/` then the device check in `mobile/CLAUDE.md` |

Dependabot (`.github/dependabot.yml`) opens update PRs monthly: one grouped PR per package for minor and patch updates, one per major, and one for the Actions versions.
It leaves the Expo SDK's packages to `npx expo install`, and te-araroa-data and gpx-tools to their own updates.
Under `mobile/` the audit lists advisories whose only "fix" npm offers is an older Expo SDK (an advisory in `@expo/cli`) without failing: only the next SDK upgrade clears those.

## Setup

The environments are under Settings → Environments, and the repository secrets under Settings → Secrets and variables → Actions.
Restrict each one's *Deployment branches and tags* to `main`, so no other branch's workflow can read its secrets.

**`production`** (the workers and the contours site), no required reviewers:

- `CLOUDFLARE_API_TOKEN`: a token from Cloudflare's *Edit Cloudflare Workers* template, plus *Account → D1 → Edit* (migrations) and *Account → Cloudflare Pages → Edit* (the contours site), limited to the account, with zone resources `tracknotes.info` and `contour-map-tiles.net` (the Workers' custom domains).
- `CLOUDFLARE_ACCOUNT_ID`.

**`production-data`** (trail data and descriptions), with yourself as a required reviewer:

- `CLOUDFLARE_API_TOKEN`: a token with *Account → Workers R2 Storage → Edit*, limited to the account (`publish:trail-data` puts objects with `wrangler r2 object put`).
- `CLOUDFLARE_ACCOUNT_ID`.
- `TRACKNOTES_ADMIN_TOKEN`: the comments API's admin bearer token.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: an R2 API token's S3 keys with *Object Read & Write* on `tracknotes-data`, for *R2 cleanup*'s deletes.

**`moderation`** (the daily moderation check only), no required reviewers, and nothing in it but:

- `TRACKNOTES_ADMIN_TOKEN`: the comments API's admin bearer token, which the check reads the queue with.
  It is kept out of `production`, whose deploy jobs run on every merge (Dependabot's included) after an `npm ci`, and the check itself installs no package.
  The comments API has only the one, full-power admin token (delete, ban, reporter identities), while the check needs only to read the queue: a read-only or counts-only admin token, or route, would be the right thing to put here once the API has one.
  The check downloads the moderation listings (post text, display names, reports) to GitHub's runner and keeps only the counts, so `docs/privacy-policy.md` names GitHub Actions; keep it in step if the check changes.

**Repository secrets** (no environment, so scheduled runs need no approval):

- `CLOUDFLARE_ACCOUNT_ID`, for the R2 endpoint in *R2 cleanup*'s dry run.
- `R2_READ_ACCESS_KEY_ID` and `R2_READ_SECRET_ACCESS_KEY`: an R2 API token's S3 keys with *Object Read only* on `tracknotes-data`, for that dry run.
- `AUTOMATION_TOKEN` (optional): a fine-grained personal access token for this repository with *Contents* and *Pull requests* read and write. *Te Araroa data* pushes and opens its PR with it, so the PR runs CI. A PR opened with the workflow's own token runs no workflows, so without it the PR has no checks, and GitHub must be allowed to open it at all (Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests*).

**`staging`** (the staging comments API, for PR branches, so not restricted to `main`; repository secrets of the same names work too), no required reviewers:

- `CLOUDFLARE_STAGING_API_TOKEN`: its own token, never the production one, with *Account → Workers Scripts → Edit* and *Account → D1 → Edit*, limited to the account, no zone resources (staging is on `workers.dev`; add *Account → Account Settings → Read* if `wrangler deploy` asks for it).
  Cloudflare cannot limit a token to one Worker or database, so this token could still deploy over production's Worker: any collaborator who can push a branch can run a workflow with it, so give it a short expiry.
- `CLOUDFLARE_ACCOUNT_ID`.
- Optional repository variables: `STAGING_SITE_BASE` (a preview origin for share links) and `STAGING_API_BASE_URL` (the staging URL, if reading it from the deploy output ever fails).

Give each token an expiry you will notice, and replace it in the environment before then.
A personal `wrangler login` still works for anything run by hand.

## Running by hand

The commands in the runbooks still work from a checkout (`docs/mobile-test-build.md` "Full release", `docs/trail-data-updates.md`, `docs/architecture/build-scripts.md`).
Deploy only from `main`, as the workflows do.
